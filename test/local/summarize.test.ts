/**
 * The real handler against DynamoDB Local: real Query paging, real cursors, and the
 * Step Functions loop played out by hand (call, check cursor, call again).
 */
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { freshTable, TABLE, waitFor } from '../support/local';
import { Settings, summarize, SummarizeInput, SummarizeOutput, TooManyRoundsError } from '../../app/src/summarize';

const ddb = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(ddb);

const settings: Settings = { tableName: TABLE, timeZone: 'America/New_York', pageSize: 100, maxRounds: 5, reserveMs: 0 };

async function seed(day: string, count: number): Promise<void> {
  const statuses = ['PAID', 'PAID', 'PAID', 'REFUNDED'];
  for (let start = 0; start < count; start += 25) {
    const items = [];
    for (let i = start; i < Math.min(count, start + 25); i++) {
      items.push({ PutRequest: { Item: { pk: `DAY#${day}`, sk: `ORDER#${String(i).padStart(6, '0')}`, status: statuses[i % 4], amountCents: 100 + i } } });
    }
    await doc.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items } }));
  }
}

/** Plays the MorePages? loop: keep calling while there is a cursor. */
async function runLoop(first: SummarizeInput, pagesPerRound: number): Promise<SummarizeOutput[]> {
  const outputs: SummarizeOutput[] = [];
  let input: SummarizeInput = first;
  for (;;) {
    let pages = 0;
    // Pretend time runs out after `pagesPerRound` pages in each invocation.
    const out = await summarize(input, () => (++pages < pagesPerRound ? 60_000 : 0), settings);
    outputs.push(out);
    if (out.cursor === null) return outputs;
    input = out;
  }
}

beforeAll(async () => {
  await waitFor('DynamoDB Local', () => ddb.send(new ListTablesCommand({})));
  await freshTable(ddb);
  await seed('2026-10-14', 250);
  await seed('2026-10-13', 7); // the day before must not leak into the count
  await seed('2026-10-15', 3); // nor the day after
});

afterAll(() => ddb.destroy());

test('one invocation reads all 3 pages of 250 orders when it has time', async () => {
  const [out, ...rest] = await runLoop({ scheduledTime: '2026-10-15T07:30:00Z' }, 1000);
  expect(rest).toHaveLength(0);
  // 250 orders: i % 4 === 3 is REFUNDED (62 of them), the rest PAID (188).
  // Amounts 100..349 sum to 250 x 100 + (0 + ... + 249) = 25,000 + 31,125 = 56,125.
  expect(out).toEqual({
    day: '2026-10-14',
    totals: { orders: 250, amountCents: 56_125, byStatus: { PAID: 188, REFUNDED: 62 }, pages: 3 },
    cursor: null,
    round: 1,
  });
});

test('one page per round takes 3 rounds and gives the same totals', async () => {
  const outs = await runLoop({ day: '2026-10-14' }, 1);
  expect(outs.map((o) => o.round)).toEqual([1, 2, 3]);
  expect(outs.at(-1)!.totals).toEqual({ orders: 250, amountCents: 56_125, byStatus: { PAID: 188, REFUNDED: 62 }, pages: 3 });
});

test('a round limit lower than the work needed fails instead of looping', async () => {
  const strict = { ...settings, maxRounds: 2 };
  const one = await summarize({ day: '2026-10-14' }, () => 0, strict);
  const two = await summarize(one, () => 0, strict);
  expect(two.cursor).not.toBeNull();
  await expect(summarize(two, () => 0, strict)).rejects.toThrow(TooManyRoundsError);
});

test('a day with no orders gives zero totals in one page', async () => {
  const [out] = await runLoop({ day: '2026-01-01' }, 1000);
  expect(out).toMatchObject({ totals: { orders: 0, amountCents: 0, byStatus: {}, pages: 1 }, cursor: null });
});

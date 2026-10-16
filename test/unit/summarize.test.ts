import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { previousDay, reportDay } from '../../app/src/days';
import { decodeCursor, encodeCursor, Settings, summarize, TooManyRoundsError } from '../../app/src/summarize';

const ddb = mockClient(DynamoDBDocumentClient);
const settings: Settings = { tableName: 'orders', timeZone: 'America/New_York', pageSize: 2, maxRounds: 3, reserveMs: 1000 };
const plenty = () => 60_000;

beforeEach(() => ddb.reset());

describe('which day a run reports on', () => {
  test('the 03:30 New York run on 8 March 2026 (07:30 UTC) reports on 7 March', () => {
    expect(reportDay('2026-03-08T07:30:00Z', 'America/New_York')).toBe('2026-03-07');
  });

  test('the day comes from the scheduled time, so 23:30 UTC is still the same New York day', () => {
    expect(reportDay('2026-10-15T23:30:00Z', 'America/New_York')).toBe('2026-10-14');
    expect(reportDay('2026-10-15T23:30:00Z', 'UTC')).toBe('2026-10-14');
    expect(reportDay('2026-10-15T23:30:00Z', 'Asia/Kolkata')).toBe('2026-10-15');
  });

  test('previousDay crosses months, years and leap days', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  test('bad input is refused', () => {
    expect(() => reportDay('yesterday', 'UTC')).toThrow('not a date');
    expect(() => previousDay('2026-3-1')).toThrow('YYYY-MM-DD');
  });
});

describe('summarize', () => {
  test('reads every page in one invocation when there is time', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ status: 'PAID', amountCents: 500 }, { status: 'PAID', amountCents: 250 }], LastEvaluatedKey: { pk: 'DAY#2026-10-14', sk: 'ORDER#2' } })
      .resolvesOnce({ Items: [{ status: 'REFUNDED', amountCents: -250 }] });
    const out = await summarize({ scheduledTime: '2026-10-15T07:30:00Z' }, plenty, settings);
    expect(out).toEqual({
      day: '2026-10-14',
      totals: { orders: 3, amountCents: 500, byStatus: { PAID: 2, REFUNDED: 1 }, pages: 2 },
      cursor: null,
      round: 1,
    });
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ pk: 'DAY#2026-10-14', sk: 'ORDER#2' });
  });

  test('a run that starts days late still reports on the day before its scheduled time', async () => {
    // Pretend the run starts on 20 March, long after the 8 March slot (retries, a backlog).
    jest.useFakeTimers({ now: new Date('2026-03-20T15:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      ddb.on(QueryCommand).resolves({ Items: [] });
      const out = await summarize({ scheduledTime: '2026-03-08T07:30:00Z' }, plenty, settings);
      expect(out.day).toBe('2026-03-07');
      expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'DAY#2026-03-07' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('hands back a cursor when time runs short, and the next round continues from it', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ status: 'PAID', amountCents: 1 }], LastEvaluatedKey: { pk: 'DAY#2026-10-14', sk: 'ORDER#9' } });
    const first = await summarize({ day: '2026-10-14' }, () => 500, settings);
    expect(first.cursor).not.toBeNull();
    expect(first.round).toBe(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [{ status: 'PAID', amountCents: 2 }] });
    const second = await summarize(first, plenty, settings);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExclusiveStartKey).toEqual({ pk: 'DAY#2026-10-14', sk: 'ORDER#9' });
    expect(second).toMatchObject({ cursor: null, round: 2, totals: { orders: 2, amountCents: 3, pages: 2 } });
  });

  test('stops with TooManyRounds after maxRounds, so a run can never loop forever', async () => {
    await expect(summarize({ day: '2026-10-14', round: 3, cursor: null }, plenty, settings)).rejects.toThrow(TooManyRoundsError);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test('an unknown status is counted as UNKNOWN, not trusted as a key', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ status: '__proto__' }, { status: 'paid; drop' }, {}] });
    const out = await summarize({ day: '2026-10-14' }, plenty, settings);
    expect(out.totals.byStatus).toEqual({ UNKNOWN: 3 });
  });

  test('refuses input it did not produce', async () => {
    await expect(summarize({}, plenty, settings)).rejects.toThrow('needs scheduledTime or day');
    await expect(summarize({ day: '2026-13-45' }, plenty, settings)).rejects.toThrow('YYYY-MM-DD');
    await expect(summarize({ day: '2026-10-14', totals: { orders: -1 } as never }, plenty, settings)).rejects.toThrow('totals');
  });
});

describe('cursor', () => {
  test('round-trips', () => {
    const key = { pk: 'DAY#2026-10-14', sk: 'ORDER#7' };
    expect(decodeCursor(encodeCursor(key), '2026-10-14')).toEqual(key);
  });

  test('cannot point at another day or carry extra keys', () => {
    expect(() => decodeCursor(encodeCursor({ pk: 'DAY#2026-10-13', sk: 'x' }), '2026-10-14')).toThrow('not valid');
    expect(() => decodeCursor(encodeCursor({ pk: 'DAY#2026-10-14', sk: 'x', extra: 1 }), '2026-10-14')).toThrow('not valid');
    expect(() => decodeCursor('%%%', '2026-10-14')).toThrow('not valid');
  });
});

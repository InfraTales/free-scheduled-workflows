/**
 * The synthesized state machine on Step Functions Local.
 *
 * Summarize is mocked (test/local/MockConfigFile.json). SaveReport is not: Step Functions
 * Local sends the real PutItem, with its condition expression, to DynamoDB Local. For
 * every run we also check that the transition counter predicts the same number of states
 * entered and retries that the engine's own history shows.
 *
 * AWS calls Step Functions Local "unsupported" and short of feature parity. This
 * definition only uses JSONPath, Choice, Retry, Catch, intrinsic functions and a DynamoDB
 * task, which it handles.
 */
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreateStateMachineCommand,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  HistoryEvent,
  ListStateMachinesCommand,
  SFNClient,
  StartExecutionCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { freshTable, TABLE, waitFor } from '../support/local';
import { NightlyStack } from '../../infra/lib/nightly-stack';
import { definitionFromTemplate } from '../../tools/definition';
import { countTransitions, RunProfile } from '../../tools/transitions/counter';

const sfnClient = new SFNClient({});
const ddb = new DynamoDBClient({});
const doc = DynamoDBDocumentClient.from(ddb);
let machineArn = '';

const stack = new NightlyStack(new cdk.App(), 'Local', { dstCheckYears: [2026] });
const template = Template.fromStack(stack).toJSON() as Parameters<typeof definitionFromTemplate>[0];
const tableId = Object.keys(template.Resources).find((id) => template.Resources[id]!.Type === 'AWS::DynamoDB::Table')!;
const definition = definitionFromTemplate(template, { refs: { [tableId]: TABLE } });

async function run(testCase: string, input: object): Promise<{ status: string; events: HistoryEvent[] }> {
  const { executionArn } = await sfnClient.send(
    new StartExecutionCommand({ stateMachineArn: `${machineArn}#${testCase}`, input: JSON.stringify(input) }),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const d = await sfnClient.send(new DescribeExecutionCommand({ executionArn }));
    if (d.status !== 'RUNNING') {
      const h = await sfnClient.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 1000 }));
      return { status: d.status!, events: h.events ?? [] };
    }
    if (Date.now() > deadline) throw new Error(`${testCase} still running after 30 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** What the engine did: states entered (by name) and Lambda attempts beyond the first per state entry. */
function fromHistory(events: HistoryEvent[]) {
  const entered = events
    .filter((e) => e.type?.endsWith('StateEntered'))
    .map((e) => e.stateEnteredEventDetails!.name!);
  const lambdaAttempts = events.filter((e) => e.type === 'LambdaFunctionScheduled').length;
  const summarizeEntries = entered.filter((n) => n === 'Summarize').length;
  return { entered, retries: lambdaAttempts - summarizeEntries, transitions: entered.length + lambdaAttempts - summarizeEntries };
}

function expectCounterAgrees(events: HistoryEvent[], profile: RunProfile) {
  const engine = fromHistory(events);
  const predicted = countTransitions(definition, profile);
  expect(predicted.transitions).toBe(engine.transitions);
  return engine;
}

beforeAll(async () => {
  await waitFor('DynamoDB Local', () => ddb.send(new ListTablesCommand({})));
  await waitFor('Step Functions Local', () => sfnClient.send(new ListStateMachinesCommand({})));
  await freshTable(ddb);
  // The name must match MockConfigFile.json, so reuse the machine if an earlier run made it.
  const existing = await sfnClient.send(new ListStateMachinesCommand({}));
  const found = existing.stateMachines?.find((m) => m.name === 'NightlyDigest');
  if (found) {
    await sfnClient.send(new UpdateStateMachineCommand({ stateMachineArn: found.stateMachineArn, definition: JSON.stringify(definition) }));
    machineArn = found.stateMachineArn!;
  } else {
    const created = await sfnClient.send(
      new CreateStateMachineCommand({
        name: 'NightlyDigest',
        definition: JSON.stringify(definition),
        roleArn: 'arn:aws:iam::123456789012:role/local-placeholder',
        type: 'STANDARD',
      }),
    );
    machineArn = created.stateMachineArn!;
  }
});

afterAll(() => {
  sfnClient.destroy();
  ddb.destroy();
});

test('a normal night enters 3 states and writes the report to DynamoDB', async () => {
  const { status, events } = await run('OneRound', { scheduledTime: '2026-10-15T07:30:00Z' });
  expect(status).toBe('SUCCEEDED');
  const engine = expectCounterAgrees(events, {});
  expect(engine.entered).toEqual(['Summarize', 'MorePages?', 'SaveReport']);

  const report = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: 'REPORT#2026-10-14', sk: 'SUMMARY' } }));
  expect(report.Item).toMatchObject({ orders: 3, amountCents: 500 });
  expect(JSON.parse(report.Item!.byStatus as string)).toEqual({ PAID: 2, REFUNDED: 1 });
  expect(report.Item!.executionId).toContain(':NightlyDigest:');
});

test('running the same day again leaves the first report alone and ends in AlreadyReported', async () => {
  const before = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: 'REPORT#2026-10-14', sk: 'SUMMARY' } }));
  const { status, events } = await run('OneRound', { scheduledTime: '2026-10-15T07:30:00Z' });
  expect(status).toBe('SUCCEEDED');
  const engine = expectCounterAgrees(events, { errors: { SaveReport: 'DynamoDB.ConditionalCheckFailedException' } });
  expect(engine.entered).toEqual(['Summarize', 'MorePages?', 'SaveReport', 'AlreadyReported']);
  const after = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: 'REPORT#2026-10-14', sk: 'SUMMARY' } }));
  expect(after.Item).toEqual(before.Item);
});

test('a second round loops through MorePages? once: 5 transitions', async () => {
  const { status, events } = await run('TwoRounds', { scheduledTime: '2026-10-14T07:30:00Z' });
  expect(status).toBe('SUCCEEDED');
  const engine = expectCounterAgrees(events, { choices: { 'MorePages?': ['Summarize'] } });
  expect(engine.transitions).toBe(5);
  const report = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: 'REPORT#2026-10-13', sk: 'SUMMARY' } }));
  expect(report.Item).toMatchObject({ orders: 501 });
});

test('a throttled Lambda call is retried, and the retry is one more transition', async () => {
  const { status, events } = await run('ThrottledOnce', { scheduledTime: '2026-10-13T07:30:00Z' });
  expect(status).toBe('SUCCEEDED');
  const engine = expectCounterAgrees(events, { retries: { Summarize: 1 } });
  expect(engine.retries).toBe(1);
  expect(engine.transitions).toBe(4);
});

test('Lambda down for good: 2 retries, then JobFailed, and no report', async () => {
  const { status, events } = await run('LambdaDown', { scheduledTime: '2026-10-12T07:30:00Z' });
  expect(status).toBe('FAILED');
  const engine = expectCounterAgrees(events, { retries: { Summarize: 2 }, errors: { Summarize: 'Lambda.ServiceException' } });
  expect(engine.entered).toEqual(['Summarize', 'JobFailed']);
  expect(engine.retries).toBe(2);
  const report = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: 'REPORT#2026-10-11', sk: 'SUMMARY' } }));
  expect(report.Item).toBeUndefined();
}, 30_000);

test('our own error (TooManyRounds) is not retried', async () => {
  const { status, events } = await run('TooManyRounds', { day: '2026-10-01' });
  expect(status).toBe('FAILED');
  const engine = expectCounterAgrees(events, { errors: { Summarize: 'TooManyRounds' } });
  expect(engine.retries).toBe(0);
});

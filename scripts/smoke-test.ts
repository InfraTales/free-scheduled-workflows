/**
 * Checks a deployed stack end to end. Needs AWS credentials for the account you deployed to.
 *
 *   npm run smoke            (stack name defaults to FreeScheduledWorkflows)
 *
 * 1. Writes three test orders for 2000-01-01 (a day no real run will ever touch).
 * 2. Starts the workflow for that day and waits for it: expects SUCCEEDED and a report.
 * 3. Starts it again: expects SUCCEEDED via AlreadyReported, with the report unchanged.
 *    This is the check Step Functions Local can't make: the real DynamoDB error name.
 * 4. Reads the schedule back: time zone, flexible window, retry policy and DLQ.
 * Uses 2 executions (about 7 state transitions) of your 4,000 free a month.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetScheduleCommand, ListSchedulesCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { DescribeExecutionCommand, GetExecutionHistoryCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const stackName = process.argv[2] ?? 'FreeScheduledWorkflows';
const day = '2000-01-01';

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

async function main(): Promise<void> {
  const cfn = new CloudFormationClient({});
  const described = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const output = (key: string): string => {
    const value = described.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
    if (!value) throw new Error(`stack output ${key} not found`);
    return value;
  };
  const stateMachineArn = output('StateMachineArn');
  const tableName = output('TableName');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sfn = new SFNClient({});
  const reportKey = { pk: `REPORT#${day}`, sk: 'SUMMARY' };

  await doc.send(new DeleteCommand({ TableName: tableName, Key: reportKey }));
  await doc.send(new BatchWriteCommand({
    RequestItems: {
      [tableName]: [1, 2, 3].map((i) => ({ PutRequest: { Item: { pk: `DAY#${day}`, sk: `ORDER#smoke-${i}`, status: 'PAID', amountCents: 100 * i } } })),
    },
  }));

  async function runOnce(): Promise<{ status: string; states: string[] }> {
    const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify({ day }) }));
    for (let i = 0; i < 120; i++) {
      const d = await sfn.send(new DescribeExecutionCommand({ executionArn }));
      if (d.status !== 'RUNNING') {
        const h = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 200 }));
        const states = (h.events ?? []).filter((e) => e.type?.endsWith('StateEntered')).map((e) => e.stateEnteredEventDetails!.name!);
        return { status: d.status!, states };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('execution still running after 2 minutes');
  }

  const first = await runOnce();
  check(first.status === 'SUCCEEDED', `first run succeeded (${first.states.join(' -> ')})`);
  const report = (await doc.send(new GetCommand({ TableName: tableName, Key: reportKey }))).Item;
  check(report?.orders === 3 && report?.amountCents === 600, 'report has 3 orders and 600 cents');

  const second = await runOnce();
  check(second.status === 'SUCCEEDED' && second.states.at(-1) === 'AlreadyReported', `second run ended in AlreadyReported (${second.states.join(' -> ')})`);
  const again = (await doc.send(new GetCommand({ TableName: tableName, Key: reportKey }))).Item;
  check(JSON.stringify(again) === JSON.stringify(report), 'first report left unchanged');

  const scheduler = new SchedulerClient({});
  const listed = await scheduler.send(new ListSchedulesCommand({ NamePrefix: stackName }));
  const name = listed.Schedules?.[0]?.Name;
  check(name !== undefined, 'schedule found');
  const s = await scheduler.send(new GetScheduleCommand({ Name: name }));
  check(s.ScheduleExpressionTimezone === 'America/New_York', `time zone is ${s.ScheduleExpressionTimezone}`);
  check(s.FlexibleTimeWindow?.Mode === 'FLEXIBLE', 'flexible window on');
  check(s.Target?.DeadLetterConfig?.Arn !== undefined, 'dead-letter queue set');
  check(s.Target?.RetryPolicy?.MaximumRetryAttempts === 3, 'retry policy set');
  console.log('smoke test passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

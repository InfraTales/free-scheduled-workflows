import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeNagFindings } from '../../infra/lib/nag';
import { BUNDLE_DIR, NightlyStack } from '../../infra/lib/nightly-stack';
import { definitionFromTemplate } from '../../tools/definition';
import { countTransitions, FREE_TRANSITIONS } from '../../tools/transitions/counter';

const env = { account: '123456789012', region: 'us-east-1' };
const years = [2026, 2027, 2028];
const stack = new NightlyStack(new cdk.App(), 'Test', { env, alertEmail: 'ops@example.com', dstCheckYears: years });
const template = Template.fromStack(stack);
const json = template.toJSON() as never;
const only = (type: string) => {
  const all = Object.values<any>(template.findResources(type));
  expect(all).toHaveLength(1);
  return all[0];
};

describe('the schedule', () => {
  test('runs daily at 03:30 New York time, in a 15-minute flexible window', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(30 3 * * ? *)',
      ScheduleExpressionTimezone: 'America/New_York',
      FlexibleTimeWindow: { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 15 },
      State: 'ENABLED',
    });
  });

  test('retries 3 times for up to 2 hours, then writes to the dead-letter queue', () => {
    const target = only('AWS::Scheduler::Schedule').Properties.Target;
    expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 7200 });
    expect(target.DeadLetterConfig.Arn).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^ScheduleDlq/), 'Arn'] });
  });

  test('passes the scheduled time, not the start time, to the workflow', () => {
    const target = only('AWS::Scheduler::Schedule').Properties.Target;
    expect(JSON.parse(target.Input)).toEqual({ scheduledTime: '<aws.scheduler.scheduled-time>' });
    expect(target.Arn).toEqual({ Ref: expect.stringMatching(/^NightlyDigest/) });
  });

  test('the Scheduler role can start this one workflow and write to this one queue, nothing else', () => {
    const policies = Object.entries<any>(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('SchedulerRole'));
    expect(policies).toHaveLength(1);
    const statements = policies[0]![1].Properties.PolicyDocument.Statement;
    expect(statements).toEqual([
      { Action: 'states:StartExecution', Effect: 'Allow', Resource: { Ref: expect.stringMatching(/^NightlyDigest/) } },
      { Action: 'sqs:SendMessage', Effect: 'Allow', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^ScheduleDlq/), 'Arn'] } },
    ]);
  });

  test('the Scheduler role can only be assumed for schedules in this account', () => {
    const roles = Object.entries<any>(template.findResources('AWS::IAM::Role')).filter(([id]) => id.startsWith('SchedulerRole'));
    const condition = roles[0]![1].Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals;
    expect(condition['aws:SourceAccount']).toBe('123456789012');
  });

  test('the dead-letter queue is a standard queue, encrypted, TLS only, kept 14 days', () => {
    const q = only('AWS::SQS::Queue').Properties;
    expect(q.FifoQueue).toBeUndefined();
    expect(q.SqsManagedSseEnabled).toBe(true);
    expect(q.MessageRetentionPeriod).toBe(14 * 86400);
    const policy = only('AWS::SQS::QueuePolicy').Properties.PolicyDocument.Statement[0];
    expect(policy).toMatchObject({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } });
  });

  test('a 02:30 New York schedule is refused at synth, because one night a year has no 02:30', () => {
    expect(() => new NightlyStack(new cdk.App(), 'Gap', { env, schedule: { hour: 2 }, dstCheckYears: years })).toThrow(
      'daylight saving',
    );
  });

  test('a UTC schedule at 02:30 is fine', () => {
    const utc = new NightlyStack(new cdk.App(), 'Utc', { env, schedule: { timeZone: 'UTC', hour: 2 }, dstCheckYears: years });
    Template.fromStack(utc).hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpressionTimezone: 'UTC' });
  });
});

describe('the workflow', () => {
  test('is a Standard workflow with a 30-minute timeout and X-Ray tracing', () => {
    const sm = only('AWS::StepFunctions::StateMachine').Properties;
    expect(sm.StateMachineType).toBe('STANDARD');
    expect(sm.TracingConfiguration).toEqual({ Enabled: true });
    expect(definitionFromTemplate(json).TimeoutSeconds).toBe(1800);
  });

  test('logs errors only, without execution data', () => {
    const logging = only('AWS::StepFunctions::StateMachine').Properties.LoggingConfiguration;
    expect(logging).toMatchObject({ Level: 'ERROR', IncludeExecutionData: false });
  });

  test('retries only Lambda service errors, twice, with backoff', () => {
    const def = definitionFromTemplate(json) as any;
    expect(def.States.Summarize.Retry).toEqual([
      {
        ErrorEquals: [
          'Lambda.ClientExecutionTimeoutException',
          'Lambda.ServiceException',
          'Lambda.AWSLambdaException',
          'Lambda.SdkClientException',
          'Lambda.TooManyRequestsException',
        ],
        IntervalSeconds: 2,
        MaxAttempts: 2,
        BackoffRate: 2,
      },
    ]);
  });

  test('writes the report only if no report exists for that day', () => {
    const def = definitionFromTemplate(json) as any;
    expect(def.States.SaveReport.Parameters.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(def.States.SaveReport.Catch[0]).toMatchObject({
      ErrorEquals: [
        'DynamoDB.ConditionalCheckFailedException',
        'DynamoDb.ConditionalCheckFailedException',
        'Dynamodb.ConditionalCheckFailedException',
      ],
      Next: 'AlreadyReported',
    });
  });

  test('has no Map or Parallel state, so the cost per run does not grow with the data', () => {
    const def = definitionFromTemplate(json) as any;
    const types = Object.values<any>(def.States).map((s) => s.Type);
    expect(types).not.toContain('Map');
    expect(types).not.toContain('Parallel');
  });
});

describe('the transition budget', () => {
  const def = definitionFromTemplate(json);

  test('a normal night is 3 transitions, 93 in a 31-day month', () => {
    // A Map added anywhere would need an item count; 300 orders is a quiet night.
    const night = countTransitions(def, { defaultMapItems: 300 });
    expect(night.transitions).toBe(3);
    expect(night.transitions * 31).toBeLessThanOrEqual(FREE_TRANSITIONS);
  });

  test('even the worst night (5 rounds, every retry used, then a failing sixth try) fits 31 times in the free tier', () => {
    // MAX_ROUNDS is 5: the handler throws when round > 5, so rounds 1-5 finish and visit 6 fails.
    // Every visit, the failing one included, can use 2 transient-error retries.
    const worst = countTransitions(def, {
      defaultMapItems: 300,
      choices: { 'MorePages?': ['Summarize', 'Summarize', 'Summarize', 'Summarize', 'Summarize'] },
      retries: { Summarize: 2 },
      errors: { Summarize: { error: 'TooManyRounds', onVisit: 6 } },
    });
    expect(worst.outcome).toBe('failed');
    // 6 x (1 + 2 retries) + 5 MorePages? + JobFailed = 24
    expect(worst.transitions).toBe(24);
    expect(worst.transitions * 31).toBeLessThanOrEqual(FREE_TRANSITIONS);
  });

  test('MAX_ROUNDS on the function matches what the budget test assumes', () => {
    const fn = Object.values<any>(template.findResources('AWS::Lambda::Function'))[0];
    expect(fn.Properties.Environment.Variables.MAX_ROUNDS).toBe('5');
  });
});

describe('the function and the rest', () => {
  test('arm64, Node.js 24, JSON logs kept a month', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      LoggingConfig: Match.objectLike({ LogFormat: 'JSON', ApplicationLogLevel: 'INFO' }),
      Environment: { Variables: Match.objectLike({ TIME_ZONE: 'America/New_York' }) },
    });
    const groups = Object.values<any>(template.findResources('AWS::Logs::LogGroup'));
    for (const g of groups) expect(g.Properties.RetentionInDays).toBe(30);
  });

  test('the function may only Query the one table', () => {
    const policies = Object.entries<any>(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('SummarizeRole'));
    const statements = policies[0]![1].Properties.PolicyDocument.Statement;
    expect(statements[0]).toEqual({ Action: 'dynamodb:Query', Effect: 'Allow', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^Orders/), 'Arn'] } });
  });

  test('the table is provisioned at 5 RCU / 5 WCU, inside the always-free 25 / 25', () => {
    expect(only('AWS::DynamoDB::Table').Properties.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
  });

  test('three alarms, all wired to the alert topic', () => {
    const alarms = Object.values<any>(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(3);
    for (const a of alarms) expect(a.Properties.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^Alerts/) }]);
  });

  test('cdk-nag (AWS Solutions) has nothing left unacknowledged', () => {
    const app = new cdk.App();
    const nagged = new NightlyStack(app, 'Nag', { env, dstCheckYears: years });
    acknowledgeNagFindings(nagged);
    cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    const assembly = app.synth();
    const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
    for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
  });

  test('synth stops with a clear message when the bundle is missing', () => {
    const backup = `${BUNDLE_DIR}.bak-${process.pid}`;
    fs.renameSync(BUNDLE_DIR, backup);
    try {
      expect(() => new NightlyStack(new cdk.App(), 'NoBundle', { env, dstCheckYears: years })).toThrow('Run "npm run bundle" first');
    } finally {
      fs.renameSync(backup, BUNDLE_DIR);
    }
  });
});

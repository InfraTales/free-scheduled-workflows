import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { checkSchedule, DEFAULT_SCHEDULE, ScheduleConfig } from './schedule-config';
import { buildWorkflow } from './workflow';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'summarize');

export interface NightlyStackProps extends cdk.StackProps {
  schedule?: Partial<ScheduleConfig>;
  /** Email for alarms. Optional. */
  alertEmail?: string;
  /** Years to check the run time against daylight saving changes. Default: this year and the next two. */
  dstCheckYears?: number[];
}

export class NightlyStack extends cdk.Stack {
  readonly stateMachine: sfn.StateMachine;
  readonly schedule: scheduler.Schedule;
  readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: NightlyStackProps = {}) {
    super(scope, id, props);

    const config: ScheduleConfig = { ...DEFAULT_SCHEDULE, ...props.schedule };
    const thisYear = new Date().getUTCFullYear();
    checkSchedule(config, props.dstCheckYears ?? [thisYear, thisYear + 1, thisYear + 2]);

    if (!fs.existsSync(path.join(BUNDLE_DIR, 'index.js'))) {
      throw new Error(`${BUNDLE_DIR}/index.js is missing. Run "npm run bundle" first.`);
    }

    // ---------- data ----------
    // Orders live under pk DAY#<date>; the nightly report goes to pk REPORT#<date>.
    // Provisioned at 5/5 so the table sits inside DynamoDB's always-free 25 RCU / 25 WCU.
    const table = new dynamodb.Table(this, 'Orders', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      encryption: dynamodb.TableEncryption.DEFAULT, // AWS owned key: no KMS charges
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---------- the one Lambda function ----------
    const fnLogs = new logs.LogGroup(this, 'SummarizeLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fnRole = new iam.Role(this, 'SummarizeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Nightly summarize: query one table, write its own logs',
    });
    fnRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [table.tableArn] }),
    );
    fnRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [fnLogs.logGroupArn],
      }),
    );
    const summarize = new lambda.Function(this, 'SummarizeFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(BUNDLE_DIR),
      memorySize: 256,
      timeout: cdk.Duration.minutes(2),
      role: fnRole,
      logGroup: fnLogs,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      environment: {
        TABLE_NAME: table.tableName,
        TIME_ZONE: config.timeZone,
        PAGE_SIZE: '500',
        MAX_ROUNDS: '5',
        RESERVE_MS: '20000',
        NODE_OPTIONS: '--enable-source-maps',
      },
      description: 'Adds up one day of orders for the nightly report',
    });

    // ---------- the workflow ----------
    const sfnLogs = new logs.LogGroup(this, 'WorkflowLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.stateMachine = new sfn.StateMachine(this, 'NightlyDigest', {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(buildWorkflow(this, { summarize, table })),
      timeout: cdk.Duration.minutes(30),
      tracingEnabled: true,
      // ERROR keeps log volume tiny. ALL would log every state of every run.
      logs: { destination: sfnLogs, level: sfn.LogLevel.ERROR, includeExecutionData: false },
      comment: 'Nightly order digest. A normal night enters 3 states.',
    });

    // ---------- the schedule ----------
    this.deadLetterQueue = new sqs.Queue(this, 'ScheduleDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.schedule = new scheduler.Schedule(this, 'Nightly', {
      description: `Starts the nightly digest at ${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')} ${config.timeZone}`,
      schedule: scheduler.ScheduleExpression.cron({
        minute: String(config.minute),
        hour: String(config.hour),
        timeZone: cdk.TimeZone.of(config.timeZone),
      }),
      timeWindow:
        config.flexibleWindowMinutes > 0
          ? scheduler.TimeWindow.flexible(cdk.Duration.minutes(config.flexibleWindowMinutes))
          : scheduler.TimeWindow.off(),
      target: new targets.StepFunctionsStartExecution(this.stateMachine, {
        // The run reports on the day before the *scheduled* time, so a late start or a
        // retry still reports on the right day.
        input: scheduler.ScheduleTargetInput.fromObject({ scheduledTime: scheduler.ContextAttribute.scheduledTime }),
        retryAttempts: config.retryAttempts,
        maxEventAge: cdk.Duration.seconds(config.maxEventAgeSeconds),
        deadLetterQueue: this.deadLetterQueue,
      }),
    });

    // ---------- alarms (3 of the 10 free alarm metrics) ----------
    const topic = new sns.Topic(this, 'Alerts', { enforceSSL: true });
    if (props.alertEmail) topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const notify = new cwActions.SnsAction(topic);

    const alarms = [
      new cloudwatch.Alarm(this, 'RunFailed', {
        alarmDescription: 'A nightly run failed, timed out or was aborted',
        metric: new cloudwatch.MathExpression({
          expression: 'failed + timedOut + aborted',
          usingMetrics: {
            failed: this.stateMachine.metricFailed({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
            timedOut: this.stateMachine.metricTimedOut({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
            aborted: this.stateMachine.metricAborted({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
          },
          period: cdk.Duration.hours(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'ScheduleDlqNotEmpty', {
        alarmDescription: 'Scheduler gave up starting a run; the details are in the DLQ',
        metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Max' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // A schedule edited to rate(1 minute) by mistake would spend 3 x 1,440 = 4,320
      // transitions a day. Catch that on the first day, not on the bill.
      new cloudwatch.Alarm(this, 'TooManyRuns', {
        alarmDescription: 'More than 3 runs started in a day: check the schedule expression',
        metric: this.stateMachine.metricStarted({ period: cdk.Duration.days(1), statistic: 'Sum' }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(notify);

    new cdk.CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', { value: this.deadLetterQueue.queueUrl });
  }
}

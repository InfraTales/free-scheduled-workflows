/**
 * The nightly workflow, kept small on purpose. A normal night enters three states:
 *
 *   Summarize -> MorePages? -> SaveReport
 *
 * Every state entered is one state transition, and every retry is one more. Standard
 * workflows get 4,000 free transitions a month, so this design spends about 93 of them in
 * a 31-day month. See tools/transitions for the counter and the tests that hold it there.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

/**
 * Errors worth retrying: Lambda's own transient failures, never our code's errors.
 * The first four are the retrier in the Step Functions best-practices guide; the last is
 * the error Step Functions reports when Lambda throttles the call.
 */
export const LAMBDA_TRANSIENT_ERRORS = [
  'Lambda.ClientExecutionTimeoutException',
  'Lambda.ServiceException',
  'Lambda.AWSLambdaException',
  'Lambda.SdkClientException',
  'Lambda.TooManyRequestsException',
];

/**
 * The same DynamoDB error, spelled three ways. The Step Functions docs say optimized
 * integrations (like dynamodb:putItem) use the prefix "DynamoDB" and AWS SDK integrations
 * use "DynamoDb". Step Functions Local reports "Dynamodb". A Catch matches error names
 * exactly, so we list all three rather than bet on one.
 */
export const CONDITIONAL_CHECK_FAILED = [
  'DynamoDB.ConditionalCheckFailedException',
  'DynamoDb.ConditionalCheckFailedException',
  'Dynamodb.ConditionalCheckFailedException',
];

export interface WorkflowProps {
  summarize: lambda.IFunction;
  table: dynamodb.ITable;
}

export function buildWorkflow(scope: Construct, props: WorkflowProps): sfn.IChainable {
  const failed = new sfn.Fail(scope, 'JobFailed', {
    error: 'NightlyDigestFailed',
    causePath: '$.error.Cause',
  });

  const summarize = new tasks.LambdaInvoke(scope, 'Summarize', {
    lambdaFunction: props.summarize,
    // Call the function ARN directly: the whole state goes in, the return value comes out.
    payloadResponseOnly: true,
    // We add our own retry below, so CDK's default (6 attempts) doesn't hide transitions.
    retryOnServiceExceptions: false,
  });
  summarize.addRetry({
    errors: LAMBDA_TRANSIENT_ERRORS,
    interval: cdk.Duration.seconds(2),
    maxAttempts: 2,
    backoffRate: 2,
  });
  summarize.addCatch(failed, { errors: ['States.ALL'], resultPath: '$.error' });

  const saveReport = new tasks.DynamoPutItem(scope, 'SaveReport', {
    table: props.table,
    item: {
      pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format('REPORT#{}', sfn.JsonPath.stringAt('$.day'))),
      sk: tasks.DynamoAttributeValue.fromString('SUMMARY'),
      orders: tasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.format('{}', sfn.JsonPath.stringAt('$.totals.orders'))),
      amountCents: tasks.DynamoAttributeValue.numberFromString(
        sfn.JsonPath.format('{}', sfn.JsonPath.stringAt('$.totals.amountCents')),
      ),
      byStatus: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$.totals.byStatus'))),
      createdAt: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      executionId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.Id')),
    },
    // One report per day. A second run for the same day (a Scheduler retry, a manual
    // re-run) stops here instead of overwriting the first report.
    conditionExpression: 'attribute_not_exists(pk)',
    resultPath: sfn.JsonPath.DISCARD,
  });
  saveReport.addCatch(new sfn.Succeed(scope, 'AlreadyReported'), {
    errors: CONDITIONAL_CHECK_FAILED,
    resultPath: sfn.JsonPath.DISCARD,
  });
  saveReport.addCatch(failed, { errors: ['States.ALL'], resultPath: '$.error' });

  const morePages = new sfn.Choice(scope, 'MorePages?')
    .when(sfn.Condition.isNotNull('$.cursor'), summarize)
    .otherwise(saveReport);

  return summarize.next(morePages);
}

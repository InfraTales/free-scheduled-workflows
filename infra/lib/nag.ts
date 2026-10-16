import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';
import type { NightlyStack } from './nightly-stack';

/**
 * Every cdk-nag finding we accept, each scoped to one construct and given its reason.
 * Kept out of the stack so the stack reads as infrastructure only.
 */
export function acknowledgeNagFindings(stack: NightlyStack): void {
  const ack = (scope: IConstruct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });
  const find = (id: string): IConstruct => {
    const c = stack.node.tryFindChild(id);
    if (!c) throw new Error(`${id} not found; check the cdk-nag acknowledgements`);
    return c;
  };

  const fn = find('SummarizeFunction') as lambda.Function;
  const fnArn = stack.resolve(fn.functionArn) as { 'Fn::GetAtt': [string, string] };
  const policy = stack.stateMachine.role.node.findChild('DefaultPolicy');
  ack(
    policy,
    `AwsSolutions::AwsSolutions-IAM5[Resource::<${fnArn['Fn::GetAtt'][0]}.Arn>:*]`,
    'CDK grants lambda:InvokeFunction on the function and its versions/aliases (ARN:*). It is still one function.',
  );
  ack(
    policy,
    'AwsSolutions::AwsSolutions-IAM5[Resource::*]',
    'CloudWatch Logs delivery (logs:CreateLogDelivery and friends) and X-Ray PutTraceSegments do not support resource-level permissions.',
  );
  ack(
    stack.stateMachine,
    'AwsSolutions::AwsSolutions-SF1',
    'Logs at ERROR on purpose: ALL would log every state of every run, which costs log ingestion for no benefit. Execution history keeps every event for 90 days anyway.',
  );
  ack(
    stack.deadLetterQueue,
    'AwsSolutions::AwsSolutions-SQS3',
    'This queue is the dead-letter queue for the EventBridge Scheduler schedule. A DLQ for a DLQ adds nothing.',
  );
  ack(
    find('Orders'),
    'AwsSolutions::AwsSolutions-DDB3',
    'Demo data. Point-in-time recovery bills per GB-month, outside the free tier. Turn it on for data you need to keep.',
  );
}

# Security

## Roles

Each role can do one job.

| Role | Can do | Notes |
|---|---|---|
| Scheduler execution role | `states:StartExecution` on this state machine, `sqs:SendMessage` on the DLQ | The trust policy requires `aws:SourceAccount` (this account) and `aws:SourceArn` (the default schedule group), as the Scheduler docs recommend against the confused deputy problem |
| State machine role | Invoke the Summarize function, `dynamodb:PutItem` on the orders table, log delivery, X-Ray | CDK writes this from the definition |
| Summarize role | `dynamodb:Query` on the orders table, write to its own log group | No managed policies |

cdk-nag (AWS Solutions) runs on every synth and in a test. We acknowledge each finding we accept on its own construct, with the reason, in `infra/lib/nag.ts`:

- The state machine role has `lambda:InvokeFunction` on `<function ARN>:*`, which CDK adds so versions and aliases work. It's still one function.
- Log delivery and X-Ray need `Resource: *`. Those APIs don't support resource-level permissions.
- Step Functions logs at `ERROR` without execution data, not `ALL`. Execution history already keeps every event for 90 days, and `ALL` would log every state of every run.
- The DLQ has no DLQ of its own.
- The table has no point-in-time recovery, because it's demo data and recovery bills per GB-month. Turn it on for data you need.

## Data

- The table uses DynamoDB's AWS-owned encryption at rest.
- The DLQ uses SQS-managed encryption and refuses requests that aren't over TLS.
- The SNS alert topic refuses requests that aren't over TLS.
- Logs keep 30 days.

## Input the function trusts

The function takes its input from Step Functions, which takes it from Scheduler or from a person starting a run by hand. It checks it anyway:

- `day` must be a real `YYYY-MM-DD` date.
- A cursor must decode to a key inside the same day's partition, with only `pk` and `sk`. A crafted cursor can't move the query to another day.
- Totals carried between rounds must be whole, non-negative numbers, and status names must match `^[A-Z_]{1,32}$`. The function counts any other status as `UNKNOWN`.

## What we chose not to add

- A customer-managed AWS KMS key. It costs $1 a month, which breaks the $0 goal, and this data doesn't need its own key policy.
- A VPC. Nothing here listens on a network.

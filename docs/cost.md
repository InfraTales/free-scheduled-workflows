# Cost

Prices are for us-east-1 and come from the AWS Price List API (checked 2026-10-15). The free allowances belong to the whole account, so anything else you run there shares them.

## What one month uses

A 31-day month with one run a night and a quiet day of orders:

| Service | Used | Free each month | Price above that |
|---|---|---|---|
| EventBridge Scheduler | 31 invocations | 14,000,000 | $1.00 per million |
| Step Functions Standard | 93 transitions | 4,000 | $0.025 per 1,000 |
| Lambda (arm64, 256 MB) | 31 requests, a few GB-seconds | 1,000,000 requests, 400,000 GB-seconds | $0.20 per million requests |
| DynamoDB | 5 RCU, 5 WCU provisioned | 25 RCU, 25 WCU, 25 GB | see the DynamoDB pricing page |
| SQS (DLQ) | 0 messages on a good month | 1,000,000 requests | $0.40 per million |
| CloudWatch | 3 alarms, small logs | 10 alarms, 5 GB of logs | see the CloudWatch pricing page |

## The transition budget

Every state a run enters is one transition. Every retry is one more. The pricing page says so in both cases.

| Night | States entered | Transitions |
|---|---|---|
| Normal | Summarize, MorePages?, SaveReport | 3 |
| Summarize needed a second round | + Summarize, MorePages? | 5 |
| One Lambda retry | + 1 | 4 |
| Same day run twice | + AlreadyReported | 4 |
| Worst case: 5 rounds, 2 retries in each, then a failure | 5 x 3 Summarize, 4 MorePages?, JobFailed | 20 |

At 3 a night, 4,000 free transitions cover 1,333 runs a month. Even the worst case, every night, is 620.

## When splitting work into states stops being free

Transitions per month = states per run x runs per month. The free tier ends at 4,000.

| Design | Per run | Runs a month | Per month | Above free tier |
|---|---|---|---|---|
| This workflow, nightly | 3 | 31 | 93 | $0 |
| Six Lambda steps, nightly | 6 | 31 | 186 | $0 |
| Six Lambda steps, hourly | 6 | 744 | 4,464 | $0.01 |
| Map over 200 orders, nightly | 603 | 31 | 18,693 | $0.37 |
| Map over 100,000 orders, nightly | 300,003 | 31 | 9,300,093 | $232.40 |

The money above the free tier is small until a Map runs over your data. That's the design to avoid: the cost grows with the number of items, not with the number of runs. Do the per-item work inside one Lambda invocation, and keep states for things Step Functions does better than your code: retries with backoff, waiting, and a visible history of each run.

To check your own design, run `npm run count` with the steps in the README.

## Express workflows

Express workflows have no free tier. They bill $1.00 per million requests plus duration ($0.00001667 per GB-second for the first 3.6 million GB-seconds, in 64 MB chunks, rounded up to 100 ms). A job that runs once a night starts 31 times a month, so Standard's free transitions cost less. Express pays off for high-volume, short runs where transitions would add up.

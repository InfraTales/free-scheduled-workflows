# A nightly job on EventBridge Scheduler and Step Functions, inside the free tier

This repo runs a real nightly job for $0 a month. Amazon EventBridge Scheduler starts an AWS Step Functions Standard workflow at 03:30 New York time. The workflow adds up yesterday's orders in Amazon DynamoDB and saves a report.

The point is the budget. Standard workflows get 4,000 free state transitions a month, and every state a run enters is one transition. This workflow enters 3 states on a normal night, so a 31-day month costs 93. The repo also has a counter that works out that number for any state machine and schedule, so you can check a design before you deploy it.

It's written in AWS CDK (TypeScript). The tests run the real handler against DynamoDB Local and the synthesized state machine on Step Functions Local.

## How it fits together

1. **EventBridge Scheduler** fires `cron(30 3 * * ? *)` in `America/New_York`, with a 15-minute flexible window. If Step Functions refuses the start, Scheduler retries 3 times for up to 2 hours, then writes the event to an Amazon SQS dead-letter queue (DLQ).
2. It starts the workflow with `{"scheduledTime": "<aws.scheduler.scheduled-time>"}`. The run reports on the day before that time, so a late start still picks the right day.
3. **Summarize** (one AWS Lambda function) reads the day's orders page by page and adds them up. It loops inside one invocation, so pages cost no transitions.
4. **MorePages?** sends the run back to Summarize only if the function ran short of time. That's rare, and capped at 5 rounds.
5. **SaveReport** writes the report with a direct DynamoDB `PutItem`, no Lambda. The condition `attribute_not_exists(pk)` keeps one report per day. A repeat run ends in **AlreadyReported** instead of overwriting.

Three CloudWatch alarms watch it: a failed run, a message in the DLQ, and more than 3 runs in a day (a schedule edited to `rate(1 minute)` would spend 4,320 transitions a day).

## Count transitions before you deploy

Export the synthesized definition, then count a month:

```bash
npm run definition
npm run count -- --definition build/nightly-digest.asl.json \
  --schedule "cron(30 3 * * ? *)" --tz America/New_York --month 2026-03
```

A profile describes one run when it isn't the default path. The `examples/` folder has some:

```bash
npm run count -- --definition build/nightly-digest.asl.json --runs 31 --profile examples/profiles/two-retries.json
npm run count -- --definition examples/naive-map.asl.json --runs 31 --profile examples/profiles/200-orders.json
```

The second one is the same report written with a Map state over each order. At 200 orders a night it spends 603 transitions a run and 18,693 a month.

The counter follows the rules on the Step Functions pricing page: every state entered counts, every retry counts, an inline Map costs nothing to start each iteration, and a Distributed Map costs one transition per iteration. It also reports days when daylight saving time skips a cron run or lands it in the repeated hour.

## Daylight saving time

Scheduler skips a run whose local time doesn't exist (clocks spring forward) and runs a repeated time once (clocks fall back). A 02:30 job in New York misses one night a year. The stack checks the run time against the next three years and refuses to synthesize if any day falls in a change. Try `npm run synth -- -c hour=2` to see the error.

## Deploy

You need Node.js 24, AWS credentials, and a CDK-bootstrapped account.

```bash
npm ci
npm run check                                   # type check, lint, tests, synth with cdk-nag
npm run deploy -- -c alertEmail=you@example.com
npm run smoke                                   # 2 test runs against the real stack
```

Change the schedule with `-c timeZone=Europe/London -c hour=4 -c minute=15`. The smoke test seeds three orders for 2000-01-01, runs the workflow twice, and checks for one report and an `AlreadyReported` ending. It uses about 7 transitions.

## Tests

| Command | What runs | Needs |
|---|---|---|
| `npm test` | Unit tests (counter, cron, time zones, handler), CDK template tests, cdk-nag, bundle checks | Nothing |
| `npm run local:up` then `npm run test:local` | The handler against DynamoDB Local; the state machine on Step Functions Local, writing to DynamoDB Local | Docker |
| `npm run smoke` | Checks against your deployed stack | A deploy |

The local engines listen on host ports 8015 (DynamoDB) and 18015 (Step Functions). Step Functions Local mocks the Lambda function but sends the real `PutItem` to DynamoDB Local, so the condition expression runs on a real engine. For each run, a test checks that the counter predicts the same number of transitions as the engine's own history shows.

AWS lists Step Functions Local as unsupported. It ran every feature this workflow uses, with one difference we found: it names the DynamoDB error `Dynamodb.ConditionalCheckFailedException`, where the docs say `DynamoDB.` for optimized integrations. The workflow catches all three spellings. The smoke test checks the real one.

## Cost

$0 for the workflow on its own, assuming nothing else in the account uses the same free allowances. [docs/cost.md](docs/cost.md) has the numbers for each service and the point where splitting work into states stops being free.

## More docs

- [docs/cost.md](docs/cost.md): the transition budget and the other free tiers this uses
- [docs/security.md](docs/security.md): roles, encryption and what we chose not to add
- [docs/runbook.md](docs/runbook.md): what to do when an alarm fires, and how to re-run a day

---

MIT-0. Created by Rahul Ladumor / InfraTales.

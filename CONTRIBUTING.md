# Contributing

Thanks for helping. This repo shows how to keep a scheduled workflow inside the free tier, so every change has to keep the transition budget honest.

## Setup

You need Node.js 24 and npm. Docker is only needed for the local-engine tests.

```bash
npm ci
npm run check          # type check, lint, bundle, unit + infra tests, synth with cdk-nag
npm run local:up       # DynamoDB Local on 8015, Step Functions Local on 18015
npm run test:local
npm run local:down
```

## Layout

| Path | What's there |
|---|---|
| `app/src/summarize.ts` | The one Lambda handler |
| `infra/lib/workflow.ts` | The state machine |
| `infra/lib/nightly-stack.ts` | The CDK stack: schedule, DLQ, table, alarms |
| `infra/lib/schedule-config.ts` | Schedule defaults and the daylight saving check |
| `tools/transitions/` | The transition counter, cron evaluation and time zone helpers |
| `examples/` | Other designs and run profiles to try the counter on |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/local` | Tests against DynamoDB Local and Step Functions Local |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first. We break each safeguard once on purpose to check its test catches it.
- **A budget check.** If you add a state, the budget tests in `test/infra/stack.test.ts` say whether a 31-day month still fits in 4,000 transitions. Don't loosen them to make a change pass.
- **No Map over data.** Per-item work belongs inside the Lambda function.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales

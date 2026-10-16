# Runbook

## RunFailed: a nightly run failed, timed out or was aborted

1. Open the state machine in the Step Functions console and pick the failed execution. The graph shows which state failed, and the Fail state's cause carries the error message.
2. `TooManyRounds` means one day had more orders than 5 rounds could read. Raise `MAX_ROUNDS` on the function, or `PAGE_SIZE`, and re-run the day (below).
3. `Lambda.ServiceException` or `Lambda.TooManyRequestsException` after 2 retries means Lambda itself had trouble. Re-run the day once it's healthy.
4. Anything from SaveReport other than a conditional check failure is a DynamoDB problem: check throttling on the table first, since it's provisioned at 5 WCU.

## ScheduleDlqNotEmpty: Scheduler gave up starting a run

Scheduler only writes to the DLQ when it couldn't start the workflow at all, after 3 retries or 2 hours.

1. Read the message in the SQS console. The `ERROR_CODE` and `ERROR_MESSAGE` attributes say why. `SCHEDULED_TIME` says which night.
2. Common causes: someone deleted or renamed the state machine, or the Scheduler role lost `states:StartExecution`.
3. Fix the cause, re-run the day, then delete the message.

## TooManyRuns: more than 3 runs started in a day

Someone changed the schedule, or something else is starting executions. Check the schedule expression with `aws scheduler get-schedule`, and the execution list for who started what. At 3 transitions a run, an every-minute schedule spends 4,320 transitions a day.

## Re-run a day

Start an execution by hand with the day you want:

```bash
aws stepfunctions start-execution --state-machine-arn <StateMachineArn> --input '{"day":"2026-10-14"}'
```

If a report for that day already exists, the run ends in `AlreadyReported` and leaves it alone. To replace a report, delete the item `pk = REPORT#<day>`, `sk = SUMMARY` first.

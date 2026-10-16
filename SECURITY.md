# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- Each role does one job: Scheduler can start this one workflow and write to its DLQ; the function can only query its table.
- The Scheduler role trusts only schedules in this account and schedule group.
- The DLQ and alert topic refuse requests that aren't over TLS, and SQS encrypts the DLQ at rest.
- The function checks its input, so a hand-started run can't point the query at another day's data.

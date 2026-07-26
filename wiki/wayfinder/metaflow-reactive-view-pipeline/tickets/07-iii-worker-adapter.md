## Question

How should a v1 III adapter host Metaflow Operator Functions and durably enqueue reactive invocations while canonical policy, Run, validation, commit, and failure semantics stay inside Metaflow?

## Acceptance criteria

- Create an active `packages/adapters/iii-runtime` package that imports only v1 public owners.
- Register versioned Function identifiers and strict request/response formats; map III Worker/Function ids to compatible frozen Operators without redefining Operator.
- Use named `TriggerAction.Enqueue` queues for required downstream work, with explicit concurrency, retry, backoff, receipt, and DLQ behavior.
- Route every invocation through Automation and Execution ports; III handlers never construct committed output Views or mutate canonical state directly.
- Make worker registration, disconnect, queue receipt, retry, cancellation, and terminal failure observable and correlated with View/Automation/Run ids.
- Fail startup on incompatible engine/function/config versions; do not silently fall back to in-process execution.

## Verification method

- Test registration, schema mismatch, enqueue/receipt, duplicate delivery, retry, crash/restart, DLQ, cancellation, and Function plus Agent Operator execution.
- Run package boundary checks proving no archived owner is imported.

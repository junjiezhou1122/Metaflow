# Recursive View cascade safety

Reactive Derived Views reuse the ordinary post-commit path. There is no hidden
Worker loop or separate cascade runtime:

```text
View commit
  -> durable view.committed@1 event
  -> deterministic Automation matches
  -> atomic cascade fan-out admission
  -> ordinary Automation occurrence
  -> Execution Run
  -> Derived or Failure View commit
  -> next durable view.committed@1 event
```

Every attempt freezes one `ReactiveCascadeContext`: root correlation and event,
parent event and optional Run/attempt, exact View lineage, exact Automation and
Transformation revisions, Operator revision once bound, depth, fan-out index
and total, semantic transition fingerprints, aggregate attempts and cost, root
and attempt times, policy revision, and explicit replay linkage.

`SqliteReactiveCascadeLedger` atomically reserves a complete sibling fan-out
before any Operator invocation. It rejects mixed roots, partial replay, forged
parents, exact-lineage cycles, repeated semantic transitions, and limits on
depth, fan-out, aggregate attempts, aggregate cost, elapsed time, and shared
exact-Operator concurrency. `view.committed` Automations may target only exact
Transformation revisions, so an Operation cannot escape into a fresh root.

## Idempotency and recovery

Each layer owns one exact identity:

- the View outbox redelivers one stable event id;
- Automation occurrence reservation binds one key to one exact occurrence;
- III queue retries one descriptor envelope and stable message id;
- Execution binds one idempotency key to its frozen Run request;
- View commit binds output revisions and replay fingerprints atomically.

Changed evidence under an old identity fails. A Browser `event_id` is an exact
delivery identity; a later DOM snapshot creates a new occurrence and Automation
cooldown suppresses it without aliasing the new exact View to old evidence.
Explicit replay or repair creates a linked new attempt with a real terminal
parent; transport retry retains the existing attempt.

Reserved and running cascade attempts keep expiring leases. Recovery preserves
the exact Run and Operator. An abandoned ready/running Run is reconciled to one
Failure View without invoking its Worker again. If Execution committed output
but cascade finalization crashed, retry reads the stored successful Run and
finishes the ledger rather than rewriting success or executing twice.

## Terminal evidence

Limits and failures never terminate only in transport or ledger state:

- cycle, depth, fan-out, aggregate budget, and time stops enter Execution as a
  terminal cascade invocation;
- context denial and exact-Operator concurrency exhaustion enter Execution as
  typed pre-execution failures;
- timeout, cancellation, Worker crash, candidate rejection, stale base, and
  output commit failure use the normal Execution failure path;
- III DLQ inspection calls `ReactiveCascadeTerminalizer` before it updates the
  cascade ledger. The terminalizer asks Execution to preserve an existing
  success or create/reconcile canonical Failure evidence.

Execution commits the Run, attempt, output Views or Candidate Artifact plus
Failure View, relations, terminal trace, and `view.committed@1` outbox event in
one SQLite transaction. Operator concurrency exhaustion invokes no Worker but
still produces that canonical Run and Failure View. Infrastructure or protocol
errors are not reclassified as a limit and continue to fail fast.

## Verification

- `corepack pnpm test:reactive-cascade`: 7/7 passed, covering atomic diamond
  fan-out, generated acyclic chains, deliberate cycles, depth and aggregate
  budgets, exact recovery, shared Operator concurrency, duplicates, and forged
  replay.
- automation-execution adapter: 6/6 passed, including typed concurrency
  terminalization, abandoned Run reconciliation, and output-commit/finalize
  crash recovery without a second Worker execution.
- `corepack pnpm test:execution-runtime`: 16/16 passed.
- `corepack pnpm test:iii-runtime`: 9/9 passed, including DLQ canonical
  terminalization and preservation of an already successful Run.
- `corepack pnpm test`: 290 total, 289 passed, one opt-in live Screenpipe smoke
  skipped, zero failed.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: 108 modules and 285 dependencies, zero
  violations; package manifests passed.
- `corepack pnpm test:v1-vertical`: 1/1 passed.
- `git diff --check`: passed.

# Reactive View Pipeline Boundary

`packages/view` owns the strict transport-neutral `view.committed@1` event,
its policy-safe committed-View summary, and publisher/consumer ports. One event
represents the newly created exact revisions in one atomic commit batch and
freezes a stable replay identity, semantic batch id, physical transaction id,
commit time, and non-secret origin.

The event contains no Representation, Materialization contents, full policy,
credentials, or source payload. It admits only `normal` or `archive` retention.
Consumers must resolve and authorize exact Views through normal ports.

The future SQLite outbox must persist this event in the same transaction as
new View revisions. Rollback and exact idempotent replay create no event.
Publication begins after commit, redelivers the same event id until
acknowledged, and cannot roll back a source View. Privacy Forget must prevent
governed pending refs from dispatching.

Ownership remains:

```text
View Core       event contract and ports
SQLite adapter  atomic outbox and post-commit publication
Automation      deterministic matching and occurrence admission
III adapter     Worker, Function, queue, retry, receipt, and DLQ transport
Execution       policy, Operator execution, validation, Run, and output commit
```

III does not create a new Metaflow Worker domain object or own canonical
Views, Automations, Transformations, Runs, policy, or provenance.

## Verification

- `corepack pnpm test:view-commit-events`: 6/6 passed.
- `corepack pnpm test:boundaries`: 23/23 passed, including future III source
  and manifest rejection of archived owners plus the existing circular test.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: passed, 89 modules and 216 dependencies.

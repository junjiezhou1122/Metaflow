## Question

How should View Store and SQLite persist logical revisions, exact relations, Representations, Materializations, idempotent Raw View deliveries, and atomic compare-and-swap commits?

## Depends on

- Implement the minimum immutable View contract

## Acceptance criteria

- A storage-neutral View Store port supports commit, exact revision get, latest resolution, search, relation traversal, and Representation/Materialization lookup.
- SQLite implements atomic revision, relation, and capture-batch commits.
- Stale base revisions fail with a structured conflict; last-write-wins is impossible.
- Exact same-Connector delivery is idempotent; new state for a stable source object creates a revision; cross-Connector evidence is never silently collapsed.
- Derived Materializations can be rebuilt or replaced without changing semantic revision identity.
- Storage failures expose structured diagnostics and transaction context.

## Verification method

- Run adapter contract tests against SQLite.
- Exercise concurrent writers, rollback, same-source duplicate delivery, conflicting source evidence, cross-source similarity, restart durability, and Materialization rebuild cases.

# SQLite Transformation Repository

`@info/transformation-sqlite` is the local durable implementation of
`TransformationRepository`.

It stores immutable Transformation revisions separately from the current head.
Every commit uses `BEGIN IMMEDIATE` and compares `expected_revision` with the
persisted head before inserting a new revision and advancing that head. A stale
writer receives a structured `conflict`; there is no last-write-wins path.

Optional idempotency keys persist a canonical request fingerprint and exact
result revision. Replaying the same request returns that original revision even
after restart. Reusing the key with different content fails with
`idempotency_conflict`.

Reads are explicit:

- `get({ transformation_id, revision })` reads immutable history.
- `getLatest(transformation_id)` deliberately follows the moving head.

Migration, commit, rollback, and parse failures include operation, phase,
transaction id, Transformation identity, and SQLite code when available. A
schema version newer than the adapter supports fails during startup.

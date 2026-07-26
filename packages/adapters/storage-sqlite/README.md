# SQLite View Store Adapter

This package implements the storage-neutral `@info/view` repository port with
Node's built-in `node:sqlite` driver.

## Guarantees

- `BEGIN IMMEDIATE` plus compare-and-swap head updates prevent lost revisions.
- `commitBatch` admits revisions, exact relations, idempotency records, and
  initial Materializations in one transaction.
- Every transaction that creates a View revision writes one `view.committed@1`
  outbox event and its exact-ref index in that same transaction. Mixed replay
  batches list only newly created revisions; complete replay, conflict, and
  rollback create no event.
- `leaseEvents` polls by durable sequence and reclaims expired leases after a
  crash. Acknowledgement is idempotent; retry and poison retain structured
  failure state; explicit replay keeps the same event id. Publisher invocation
  happens through the transport-neutral View Core dispatcher after commit.
- idempotency keys store a canonical request fingerprint. Only exact replay is
  a duplicate; conflicting evidence fails with `idempotency_conflict`.
- Execution idempotency has its own durable key-to-Run index. Runtime can find
  the first frozen Run before moving selectors are resolved again, including
  after repository restart.
- connector-scoped capture identity binds one stable source or occurrence to a
  single View identity, preventing parallel revision chains.
- provenance and relation targets must resolve to committed or same-batch exact
  revisions.
- `get` is exact. `getLatest` and `resolveLatest` are explicit moving-head
  operations.
- File-backed graph projection opens a separate read-only WAL connection and
  pins one SQLite read transaction before traversal. An in-memory repository
  uses SQLite's backup API to create a uniquely named, query-only shared-memory
  snapshot held by the projection connection. Both strategies serve every
  relation page and node summary from one frozen adjacency snapshot without
  copying in-memory content to disk, so
  concurrent commits remain visible only to later projections without
  fracturing active keyset traversal.
- derived Materializations use generation compare-and-swap and never change the
  semantic View revision.
- Schema-declared search projection is written to SQLite FTS5 in the same
  transaction as the exact View revision. Queries use `unicode61`, safe AND
  token compilation, category-weighted BM25, and deterministic timestamp/id
  tie-breaking instead of scanning `view_json` with `LIKE`.
- `allow_local_search=false`, absent declarations, and source tombstones create
  no searchable document. Privacy Forget deletes projection and FTS rows before
  deleting the governed View payload.
- `reindexSearch` reserves a durable run before rebuilding. The rebuild is one
  atomic transaction, exact replay returns its frozen report, missing FTS rows
  are repaired, and a failed run retains structured status while the previous
  index remains queryable.
- Semantic Search is an explicit startup capability backed only by exact-pinned
  `sqlite-vec@0.1.9` (`vec_version() = v0.1.9`). Startup verifies the loadable
  package path, Node SQLite/FTS ABI, WAL, exact profile/provider/model,
  dimension, metric, and physical `vec0` table declaration. A stored profile
  cannot reopen without the same configuration.
- Node `24.x` is the executable runtime contract. `pnpm verify:semantic-deploy`
  creates a production-only deploy on the current host, loads the host-specific
  extension from that artifact, and verifies the bundled upstream MIT notice.
  Darwin arm64/x64, Linux arm64/x64, and Windows x64 packages are exact-pinned;
  only the current host tuple is claimed as executed by any one run.
- Only strict `metaflow.search.embedding@1` Derived Views are projected. Each
  mapping freezes its exact target View/location, normalized source digest,
  exact embedding evidence ref, provider/model profile, dimension, metric,
  Transformation Run, and inherited policy. Query scope refs and target kinds
  are prefiltered by `vec0` before distances can affect ranks.
- Physical row identity is `(profile_id, profile_revision, vector_rowid)`.
  The same rowid may exist in multiple profile tables; startup and retrieval
  validate exact profile and target metadata before evidence can resolve.
- Missing mappings or physical orphans reopen in an observable
  `reindex_required` maintenance state. Semantic retrieval, insertion, and
  deletion fail with that typed error until a new durable reindex transaction
  commits; replaying an older successful run cannot claim to repair new
  corruption. Profile or target metadata mismatch fails startup outright.
- Vector mapping and `vec0` insertion share the View `BEGIN IMMEDIATE`
  transaction. Privacy Forget deletes mappings and vector rows before governed
  payloads, and durable reindex reconstructs only from committed embedding
  Views while reporting and removing missing/orphan physical state without
  invoking an embedder.
- durable SQLite rejects `do_not_store` and `session` retention.
- schema upgrades run in a versioned `BEGIN IMMEDIATE` transaction. Legacy
  head and idempotency tables are rebuilt with current checks and foreign keys,
  then verified with `foreign_key_check` before the version advances.
- the previous empty `Materialization.metadata` default is removed losslessly
  during migration. Non-empty legacy metadata fails with the exact table, View
  identity, revision, phase, and migration transaction instead of being dropped.
- normalized manifest rows and idempotency fingerprints are regenerated from
  the migrated canonical View envelope; derived Materialization generations are
  preserved and never rewritten by migration.
- primary and alternative normalized rows must exactly match the immutable
  manifest; missing, extra, role-shifted, or content-divergent rows are corrupt
  data rather than an implicit alternative.
- failures include operation, phase, transaction id, affected View ids, and
  native SQLite code when available.
- a terminal failure transaction admits any bounded Candidate Artifact and its
  referring Failure View together with attempt, Run, and terminal trace state;
  rollback cannot leave an orphan artifact or false terminal state.
- Capture registration durably stores the frozen Connection and Connector
  manifest, opaque checkpoint, health, paused state, and in-flight count.
- Capture batch commit checks exact replay before checkpoint staleness, then
  commits all Raw View revisions, receipts, checkpoint, healthy state, and
  terminal trace in one transaction.
- Capture failure atomically releases the in-flight slot, records sanitized
  health and attempt evidence, and optionally creates a pending dead letter.
  Pause or backpressure before an attempt starts does not create one.
- Re-registering a connection after restart converts abandoned in-flight work
  into an explicit degraded health state and `connection.recovered` trace.
- Privacy Forget persists its frozen content-free plan and per-store receipts.
  A successful Core purge atomically deletes affected revisions, relations,
  Materializations, heads, capture identities, and View idempotency rows while
  permanently registering every purged `view_id` as retired.
- Privacy Forget removes any unacknowledged multi-View commit event touching a
  governed exact ref in the same Core purge transaction. Delivered audit may
  remain, but explicit replay fails because the exact View is unavailable.
- A retired View identity can never be committed again. View idempotency retry
  and persisted Capture batch replay both fail with structured policy evidence,
  so an old `view_id@revision` can never resolve to replacement content.
- If any Core deletion fails, the retirement registry and all Core cleanup roll
  back together. External cleanup acknowledgements and the failed request stay
  durable so a later retry is explicit and observable.

SQLite rows normalize revisions, heads, relations, Materializations, search
projection state, commit outbox state, and idempotency records while retaining
the validated View envelope and immutable event as canonical JSON. WAL, foreign
keys, busy timeout, and prepared statements are enabled.

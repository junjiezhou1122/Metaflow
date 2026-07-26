# View Core

`@info/view` defines Metaflow's recursive information unit and its
storage-neutral repository and privacy lifecycle ports.

## Boundary

Every View freezes an identity, immutable revision, Schema, Representation,
Materialization manifest, exact relations, provenance, policy, and time. A Raw
View preserves source evidence; a Derived View preserves the exact input View
revisions and Operator Run that formed it. Observation is a Raw View role, not
a separate persistence model.

Same-purpose evolution creates a new immutable revision. A new purpose or
Schema family creates a new View identity with exact `forked_from` lineage.
Repository reads are exact by default; moving-head access is always explicit.

## Deterministic search projection

A Schema may declare `search_projection@1`, a bounded list of RFC 6901-compatible
JSON Pointers (with `*` for array items) categorized as title, text, identifier,
URL, timestamp, or provenance.
Only those scalar source fields enter local full-text search. Missing optional
fields and empty strings contribute nothing; an invalid declared scalar, URL,
or timestamp rejects the complete View transaction.

`policy.allow_local_search` is independent from external-model and embedding
permission. An omitted legacy value means allowed; explicit false excludes that
exact revision from the local index and is inherited as a hard constraint.
External media remains a reference; OCR,
transcription, summary, semantic enrichment, and embeddings create Derived
Views through Transformations.

`query({ text })` is storage-neutral. `reindexSearch` exposes an idempotent,
durable rebuild operation without making SQLite or FTS part of the View Schema.

## Strict relation projection

A strict Schema may declare `relation_projection@1` to map a bounded
Representation entry array to managed envelope relations. View parsing derives
the expected exact target, relation type, and metadata for every entry and
requires the managed relation multiset to match exactly. This makes package
helpers ergonomic rather than authoritative: direct commit callers cannot omit
or contradict the declared relations.

## Reactive commit boundary

Every durable transaction that creates at least one View revision also creates
one policy-safe `view.committed@1` event. The event lists only newly created
exact refs, their role, Schema summary, and durable retention. Representation,
Materialization contents, full policy, credentials, and source payloads are not
event data.

`ViewCommittedOutbox` is the storage-neutral delivery port. It exposes ordered
leases, acknowledgement, retry or poison recording, exact event inspection,
and explicit replay. `ViewCommittedOutboxDispatcher` publishes only leased
post-commit events, preserves their stable ids across redelivery, records every
failure before throwing, and never calls Automation or III inside the View
transaction.

## Privacy lifecycle

Source deletion and privacy erasure are deliberately different:

- `buildSourceTombstone` appends a terminal Raw View revision and preserves the
  earlier evidence for provenance.
- `PrivacyForgetService` freezes an owner-bound impact plan, confirms it,
  coordinates every governed cleanup store, optionally rebuilds mixed-source
  Derived Views from retained inputs, and commits a content-free audit.

Targeting one revision expands to the complete View identity before downstream
closure. After successful Forget, the storage adapter must permanently retire
every purged `view_id`; ordinary commits and replay paths may never reuse it.
Recapture uses a new View identity so historical exact references remain
unresolvable rather than drifting to replacement content.

Forget does not claim success until every configured store has a durable
success receipt. Failures retain only structured stage, code, store id, refs,
and digests. Payloads and raw provider errors never enter the audit.

## Verification

```bash
pnpm test:privacy-forget
pnpm test:view-search
pnpm test:view-commit-events
pnpm typecheck:v1
pnpm check:boundaries
```

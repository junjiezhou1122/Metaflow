# Deterministic Raw View search projection

`packages/view` now owns `Schema.search_projection@1`: a bounded list of
RFC 6901-compatible JSON Pointers with an array-item `*`, categorized as title,
text, identifier, URL, timestamp, or provenance. Only declared scalar values
are copied. Missing optional fields and
empty strings contribute nothing; category mismatches reject the complete View
transaction.

`ViewPolicy.allow_local_search` is a separate hard local-index constraint.
Connector policy cannot weaken it and Derived/Failure policy inheritance keeps
the strictest value. It is unrelated to external-model and embedding approval.

`packages/adapters/storage-sqlite` replaced whole-envelope `LIKE` scanning with
FTS5 `unicode61` search, safe AND-token compilation, category-weighted BM25,
and stable time/id tie-breaking. Exact View revision, projection metadata, and
FTS document share one commit transaction. Privacy Forget removes index state
inside its Core purge transaction.

`reindexSearch` has a durable run id and request fingerprint. It repairs missing
documents, reports scanned/indexed/excluded/unchanged/removed counts, returns a
frozen report for exact replay, and rebuilds atomically so crash or failure
leaves the prior index intact. Adapter migration 5 rebuilds stored declarations
under the current projection implementation.

Browser page/selection facts, all audited Screenpipe modalities, and the
Connector Kit Clipboard example declare source-native fields and are queried
through the same storage-neutral `ViewRepository.query({ text })`. External
media remains referenced. OCR, transcription, summarization, semantic
enrichment, and embeddings remain Transformations that create Derived Views.

## Verification

- `corepack pnpm test:view-search`: 8/8 passed.
- `corepack pnpm test:view-store`: 12/12 passed.
- `corepack pnpm test:privacy-forget`: 20/20 passed.
- Browser Capture: 23/23 passed.
- Screenpipe Capture: 6/6 passed with one opt-in live smoke skipped.
- Connector Kit and Capture Runtime: 15/15 passed.
- `corepack pnpm test`: 245 total, 244 passed, one opt-in live Screenpipe
  smoke skipped, zero failed.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: 94 modules and 233 dependencies checked,
  zero violations.

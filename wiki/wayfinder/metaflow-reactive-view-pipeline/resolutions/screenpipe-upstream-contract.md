# Screenpipe upstream capture contract

The Screenpipe Connector is a replaceable REST adapter for a separately
installed service. It is pinned to upstream commit
`4cf388b746454302f8cac673fc37530b9e2dc47f`, engine family `0.4.x`, and the
audited `1.0.0` API contract. Metaflow does not vendor, modify, auto-install,
redistribute, or read Screenpipe's internal SQLite database.

`/health` is auth-exempt and is judged from its JSON `status` and `status_code`,
not HTTP 200 alone. Required capabilities are probed against their real bounded
endpoints. Protected requests resolve exactly one declared `SecretReference`
through `ScreenpipeSecretResolver` just in time and send a Bearer Authorization
header; the resolved value never enters a URL, View, checkpoint, trace, error,
or dead letter. Missing, mismatched, empty, or invalid resolution fails before
protected provider access.

OCR, Audio, Input, and Accessibility are pulled explicitly because
`content_type=all` is incomplete. Each modality has an independent durable time
watermark. Requests use the upstream literal `order=ascending` and start at a
60-second inclusive overlap before the prior watermark. The checkpoint retains
exact item identities within that window, internally scans past replays, and
therefore does not depend on offsets that move when live rows are inserted.
Each watermark freezes its normalized selector; selector drift fails explicitly.
Same-timestamp rows progress using upstream's deterministic timestamp plus
provider-id ordering. Scan pages and retained identities are bounded; capacity
exhaustion fails explicitly. A failure in any requested modality prevents the
entire Capture Batch and every modality checkpoint from advancing.

Raw Views retain the complete validated provider object. OCR preserves
`text_source`; Audio accepts only upstream `Input`/`Output` device types and the
concrete `{ id, name, metadata } | null` speaker shape while leaving
`speaker_source` open. Audio identity combines chunk, offset, timestamp, and
segment bounds. Frame and audio bytes stay behind non-secret `screenpipe://`
references. Candidate idempotency is source/content-derived, connection-scoped,
and independent of page digests or capture clocks. Input uses one stable
provider-row identity because Screenpipe asynchronously enriches `frame_id`;
that enrichment creates a revision. Reverse-order dead-letter replay resolves
to the already admitted semantic batch.

Network and local timeout failures plus HTTP 408/503/504 are retryable. HTTP
400/403/404/500, health/version drift, unknown tagged variants, strict Schema
drift, pagination mismatch, and bounded-overlap exhaustion are terminal and
observable. Checkpoint CAS, retry, atomic admission, trace, health, and DLQ
remain owned by `ConnectorRuntime`.

At the pinned revision Screenpipe uses the Screenpipe Commercial License, not
MIT. Customer-facing or commercial integration requires license and legal
confirmation; official binaries also remain subject to Screenpipe's separate
terms.

## Verification

- `corepack pnpm test:screenpipe-capture`: 16 total, 15 passed, one opt-in live
  smoke skipped, zero failed.
- Deterministic cases cover all four modalities, exact secret resolution and
  non-leakage, health/version, HTTP retry classes, strict Audio shape, unknown
  variants, background and live Output Audio, late insertion before an old
  offset, inclusive boundary replay, same-timestamp pagination, selector-scope
  rejection, independent watermarks, cross-connection isolation, Input row
  enrichment, atomic modality failure, bounded scan failure, failed admission,
  reverse-order dead-letter replay, and stable candidate replay.
- `corepack pnpm test:v1-vertical`: 1/1 passed.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: 95 modules and 236 dependencies checked,
  zero violations.
- `corepack pnpm test:boundaries`: 23/23 passed.
- `corepack pnpm test`: 268 total, 267 passed, one opt-in live Screenpipe smoke
  skipped, zero failed.
- `git diff --check`: passed.
- Current live smoke was not run: `127.0.0.1:3030` refused the `/health`
  connection on 2026-07-26. This is not represented as end-to-end provider
  evidence.

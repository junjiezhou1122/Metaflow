---
title: Define Capture and Raw View admission
type: wayfinder-ticket
label: wayfinder:grilling
parent: ../map.md
status: closed
assignee: codex
blocked_by:
  - choose-capability-owners.md
---

# Define Capture and Raw View admission

## Question

Where is the boundary between source-native capture, Artifacts, Raw View
admission, and semantic View Operators, especially when a source such as
Screenpipe already emits OCR, transcripts, or timelines?

## Answer

The implemented boundary is:

```text
external source
  -> Connector normalization
  -> ObservationCandidate
  -> CaptureIngress
  -> immutable Raw View revision
```

Connectors do not write a database and do not produce Metaflow semantic
interpretations. `ObservationCandidate` carries source identity, source kind,
direct versus source-derived assertion, time, policy, schema, and an open View
Representation. CaptureIngress validates, applies retention, assigns stable Raw
View identity, enforces idempotency, emits events, and commits through the
`ViewRepository` port.

Screenpipe OCR or transcription is admitted as a source assertion. Screenpipe
Activity Summary or Memory must use `assertion: source_derived`; it may be
useful evidence but cannot claim to be a Metaflow Operator result. Metaflow-run
OCR, transcription, summarization, and clustering remain View Operators.

Large screenshots, audio, and videos remain external references unless a View
schema and policy explicitly require retention. There is no implicit download,
transcription, or SQLite fallback.

## Implementation

- `packages/capture/contracts.ts`
- `packages/capture/ingress.ts`
- `packages/capture/connectors/browser.ts`
- `packages/capture/connectors/screenpipe.ts`
- `packages/server/http-server.ts` (`POST /context/v1/observations`)
- `packages/adapters/storage-sqlite/index.ts`
- `tests/view-v1.test.ts`

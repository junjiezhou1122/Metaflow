# AI-authorable Connector and Adapt Kit

`packages/capture` now exports one small authoring boundary:

```text
defineConnectorKit
  manifest
  configuration_schema
  payload_schema
  pure adapt(payload, context) -> candidate drafts
  -> validated RawViewCandidate[] / CaptureBatch
```

The Kit fills connector and connection attribution, exact inherited policy,
captured time, and batch envelopes. Authors explicitly choose stable source or
occurrence identity, direct or source-derived assertion, inline payload or
external reference, idempotency key, semantic Schema, and candidate purpose.

Candidate policy may tighten but never weaken the Source Connection. Inline
credentials are rejected and `secretReference` preserves only provider/key
identity. Every emitted Schema must exactly match a manifest declaration.

`runConnectorConformance` verifies malformed payload rejection, deterministic
Adapt, declared Schema evolution, candidate count, a source-specific lossless
assertion, and exact replay identity through an author-provided real Runtime
submission.

`packages/adapters/clipboard-capture` proves the boundary. A native Clipboard
payload becomes one lossless occurrence Raw View; each file becomes an
external-reference occurrence. The controller uses the ordinary
`ConnectorRuntime.submitBatch`, so replay, checkpoint, admission, trace, and
failure behavior remain shared.

Browser retains Manifest V3, DOM, tab/document, focus, and transport-outbox
logic. Screenpipe retains REST auth, health/version negotiation, pagination,
modality cursors, and HTTP error classification. Connector Kit contains no
provider access or large-media fetching.

## Verification

- `corepack pnpm test:connector-kit`: 15/15 passed, including 12 existing
  Capture Runtime cases and 3 Kit/Clipboard conformance cases.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: passed, 93 modules and 228 dependencies.
- Static audit found no provider fetch, SQLite, ViewRepository, archived owner,
  or sibling adapter dependency in the Kit or Clipboard adapter.

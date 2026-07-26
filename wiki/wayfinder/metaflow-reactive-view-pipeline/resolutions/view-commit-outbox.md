# Transactional View commit outbox

Every SQLite transaction that creates at least one View revision now persists
one policy-safe `view.committed@1` event plus its exact-ref index in the same
transaction as revisions, relations, initial Materializations, search state,
and replay fingerprints. A mixed replay/new batch lists only new revisions;
complete replay, conflict, or rollback writes no event.

`packages/view` owns the transport-neutral `ViewCommittedOutbox` port and
`ViewCommittedOutboxDispatcher`. The public lifecycle is ordered lease,
publish, acknowledgement, retry or poison, inspection, and explicit replay.
Leases expire durably, so a crash before acknowledgement redelivers the same
immutable event id after restart. Publisher failure is recorded before the
dispatcher throws; no fallback or silent acknowledgement exists.

`packages/adapters/storage-sqlite` migration 6 owns the physical outbox and
exact-ref index. Capture freezes its Capture Batch and connection origin;
Execution freezes its Run origin; direct Operation commits may pass their
request identity. The adapter never invokes Automation or III in a View
transaction. Privacy Forget atomically removes any unacknowledged event touching
a governed exact ref, while replay of delivered audit fails once the exact View
is unavailable.

## Verification

- `corepack pnpm test:view-commit-events`: 10/10 passed.
- `corepack pnpm test:view-store`: 12/12 passed.
- `corepack pnpm test:connector-kit`: 15/15 passed.
- `corepack pnpm test:execution-runtime`: 12/12 passed.
- `corepack pnpm test:privacy-forget`: 20/20 passed.
- `corepack pnpm test:boundaries`: 23/23 passed.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: 95 modules and 235 dependencies checked,
  zero violations.
- `corepack pnpm test`: 249 total, 248 passed, one opt-in live Screenpipe
  smoke skipped, zero failed.

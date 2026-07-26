# Browser capture identity and MV3 lifecycle

Browser Capture now has one browser-safe `BrowserCaptureEvent` wire contract
shared by the Chrome Extension, Ambient HTTP controller, and
`packages/adapters/browser-capture`. Provider events fail before Capture
admission when kind/action, page/domain, document/frame, caption-segment,
focused-heartbeat, or explicit-save identity is malformed.

The MV3 service worker stores tab/visit state in `chrome.storage.session`, uses
`chrome.alarms` instead of process timers, and records both committed and
history-state navigation. Attention distinguishes the active tab of the focused
non-minimized window from background and merely open tabs. Navigation admission
and the first DOM-ready snapshot have independent persisted state, so an early
navigation event cannot permanently lock in metadata-only page evidence. Each
frame derives policy from its own URL.

Pages, caption segments, and caption state are stable source objects that gain
immutable revisions. Navigation, selection, copy, play/pause, heartbeat,
search, and save intent are occurrences. Manual save submits page evidence,
one independent save-intent occurrence, and optional selection in one atomic
Capture Batch.

Extension transport retains the exact canonical event for network failures and
HTTP 408/425/429/5xx. Outbox mutations are serialized and pending events are
never silently truncated. Server acceptance transfers retry, checkpoint,
trace, and DLQ ownership to the shared Connector Runtime.

The old Browser record normalizer and archived
`/context/v1/observations` double-write route are deleted. Canonical capture
posts only to `/capture/v1/browser-events`; retained v0 side-panel records post
only to `/context/ingest`, preserving that UI without manufacturing a second
Raw View from the same fact.

## Verification

- `corepack pnpm test:browser-capture`: 28/28 passed.
- `corepack pnpm browser:build`: production Extension build passed.
- `corepack pnpm test:v1-vertical`: 1/1 passed.
- `corepack pnpm test:view-commit-events`: 10/10 passed with a deterministic
  repository clock.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: 95 modules and 235 dependencies checked,
  zero violations.
- `corepack pnpm test:boundaries`: 23/23 passed.
- `corepack pnpm test`: 255 total, 254 passed, one opt-in live Screenpipe smoke
  skipped, zero failed.

# Browser Capture Adapter

This package is the Chrome extension implementation behind `@info/capture`.
It validates source events, maps them to Raw View Candidates, and submits one
atomic push batch through `ConnectorRuntime`.

It contains no Ambient matching, writing assistance, learning inference,
debugger attachment, arbitrary script execution, CSP mutation, or browser
control. Those are Automation, Application, or high-privilege tool concerns.

Pages, caption segments, and caption state use stable source identities and
gain immutable Raw View revisions. Navigation, selection, copy, heartbeat,
search, play/pause, and explicit save intent are occurrences. A manual save
places page evidence, its independent save-intent occurrence, and any selected
text in one batch, so they commit or roll back together.

`@info/browser-capture-adapter/wire` is browser-safe and owns the single strict
Zod event schema used before Extension delivery, at the HTTP controller, and by
the adapter. It freezes tab/window/visit attention and available document/frame
identity; there is no legacy `observation.*` record normalization step.

The extension sends canonical events to `/capture/v1/browser-events`. An exact
event replay returns the original receipts. Reusing an event id with changed
evidence fails with an idempotency conflict. Once the server accepts delivery,
retry, checkpoint, health, trace, and dead-letter behavior belongs exclusively
to the shared Connector Runtime.

The Manifest V3 service worker can stop between events, so network failures
that have not reached Metaflow are retained in `chrome.storage.local` with the
exact canonical event and retried explicitly. This follows Chrome's documented
[service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
and [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).
No retry dependency is needed: native `fetch` and Chrome storage cover the
extension transport boundary, while `ConnectorRuntime` already owns durable
server retries and DLQ semantics.

The outbox serializes read-modify-write mutations and never evicts unresolved
events to enforce a count limit. Network errors and HTTP 408/425/429/5xx remain
local because the server did not accept them. Contract/policy conflicts fail
visibly, and a successful HTTP acceptance transfers retry/DLQ ownership to the
server Capture Runtime.

Visit state lives in `chrome.storage.session` so service-worker suspension does
not invent a new visit. `chrome.alarms` drives periodic capture, and
`webNavigation.onCommitted` plus `onHistoryStateUpdated` preserve full and SPA
navigation occurrences with document/frame identity. A heartbeat is emitted
only for the active tab in the focused non-minimized window; background and
open states remain source facts on other event types.
Committed navigation and the initial DOM snapshot use separate persisted flags,
so an early `onCommitted` event cannot lock in a metadata-only page forever.
Frame navigation derives policy from the frame URL rather than inheriting the
top-level page policy.

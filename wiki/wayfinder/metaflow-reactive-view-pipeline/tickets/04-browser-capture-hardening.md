## Question

What changes make Browser capture preserve real user attention and occurrence identity across Manifest V3 worker suspension, multiple windows, SPA navigation, media changes, and explicit saves?

## Acceptance criteria

- Replace unreliable service-worker intervals with an MV3-supported scheduling/event strategy and persist visit/tab state across worker restart.
- Distinguish focused-window attention from merely open/background tabs and retain that distinction as source facts.
- Capture SPA committed/history navigation with document/frame identity.
- Model caption segments, caption state, play/pause occurrences, page revisions, selections, copies, and manual saves with correct stable-versus-occurrence identities.
- A manual save atomically commits page evidence plus an independent user-intent occurrence.
- Share a browser-safe validated capture contract across Extension, HTTP, and adapter; remove the old double-normalization path when its migration checks pass.

## Verification method

- Add deterministic tests for worker restart, visit continuity, focused window, SPA navigation, media identity, manual save, outbox replay, and malformed events.
- Run Browser Capture tests and build the Extension surface covered by this contract.

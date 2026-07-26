## Question

How should the Chrome extension emit source-attributable Browser Raw Views without retaining Ambient, writing, learning, or high-privilege browser-tool behavior inside Capture?

## Depends on

- Implement View Store and SQLite revision persistence
- Implement View access approval profiles and deny overrides

## Acceptance criteria

- Browser Connector emits normalized page, navigation, selection, media, and interaction candidates.
- CaptureIngress alone assigns Raw View identity and commits evidence.
- Ambient decisions, writing suggestions, learning inference, debugger attachment, arbitrary script execution, and CSP changes are outside the Connector.
- Delivery success, rejection, retry, and dead-letter evidence is observable; errors are not swallowed.
- Duplicate browser events are idempotent and conflicting source evidence fails explicitly.

## Verification method

- Contract-test normalized candidates and ingress outcomes.
- Run an extension-to-ingress smoke scenario covering success, duplicate, policy denial, transport failure, and dead-letter inspection.

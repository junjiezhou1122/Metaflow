## Question

How should Ambient route progress, decisions, and results to lightweight
surfaces while preventing the notch or browser UI from becoming the decision
engine?

## Depends on

- Lock the Ambient Runtime boundary
- Connect Ambient invocation to the Agent Adapter

## Acceptance criteria

- Delivery requests name a surface, urgency, expiry, and interaction actions.
- The notch displays at most one immediate decision; longer work is routed to
  an inbox or panel with progress references.
- Delivery adapters render shared result/progress contracts and contain no
  context or Agent-selection logic.
- Accept, dismiss, later, cancel, retry, and correction become Feedback Views
  linked to the exact result and invocation.
- Delivery failure is observable and does not masquerade as execution failure.

## Verification method

- Use fake notch, browser, and inbox adapters to test result, progress,
  replacement, expiry, action feedback, and unavailable surface behavior.

## Resolution

Automation owns one shared Delivery contract; notch, browser, panel, and inbox
are renderers only. A request freezes its exact Automation revision,
occurrence, optional Run, progress or result View refs, target surface,
urgency, expiry, actions, and `replace` or `keep_existing` policy. Renderers do
not resolve context or choose an Agent.

The notch has single-item capacity. A new request either withdraws and replaces
the active item or is observably suppressed. Other surfaces may accept multiple
items. Expired, suppressed, unavailable, failed, and delivered outcomes remain
distinct from execution status.

Delivery history is stored through `AutomationDeliveryLedger`. Request ids are
idempotent, delivered ids are unique, and conflicting payloads fail. Active
renderer state may remain in memory, but persisted request/result history lets
a new coordinator validate interactions from cards rendered before a daemon
restart. A rendered item is withdrawn when its ledger commit fails.

`accept`, `dismiss`, `later`, `cancel`, `retry`, and `correct` create strict
Feedback Views with exact invocation and result provenance. `later` requires
`snooze_until`; `correct` requires correction text. Feedback commits before an
interaction command runs, and replay does not dispatch that command twice.

## Implementation

- `packages/automation/delivery.ts`
- `packages/automation/runtime.ts`
- `packages/adapters/automation-sqlite/index.ts`
- `tests/automation-delivery.test.ts`
- `tests/automation-sqlite.test.ts`
- `tests/automation-v1.test.ts`

## Acceptance results

- Notch replacement and suppression: pass.
- Browser/inbox independence, expiry, unavailable, and failed delivery: pass.
- Exact Agent progress View refs retain Run correlation: pass.
- Six strict actions produce exact Feedback Views: pass.
- Feedback and command replay idempotency: pass.
- Interaction after SQLite ledger restart: pass.
- Focused Ambient and Agent suite: 32/32 pass.
- Root TypeScript check: pass.
- Dependency cruise: zero violations.
- Package boundary tests: 19/19 pass.

# Committed View trigger boundary

`packages/adapters/committed-view-trigger` is the provider-neutral consumer of
durable `view.committed@1` events. It resolves every exact event member,
discovers the latest enabled `metaflow.automation` Views, evaluates deterministic
bounded predicates, and hands each match to the Automation-owned invocation
port. Browser, macOS, Capture, storage, III, and Worker implementations do not
construct special trigger flows.

The domain path remains deliberately small:

```text
Input Views -> Operator -> Output Views
                    ^
                    |
        code | Agent | Workflow | human | service | III Worker
```

An Operator is the stable callable transformation contract. A Worker is one
replaceable implementation or runtime host. Automation only answers when a
particular Operator should be invoked and with which exact View evidence; it
does not introduce a second View or Worker model. Worker definitions and
configuration may themselves be persisted as Views.

Committed-View triggers support Schema, capture source, Raw/Derived role,
policy, relation type and exact relation, and Representation predicates. One
View may fan out to many Automations, and one Automation may accept many Schema
names. Matching is bounded by event, Automation, relation, predicate-node,
predicate-depth, predicate-byte, and Representation-byte limits. Regular
expressions are rejected on this synchronous path.

Representation content used by a predicate is ephemeral matching evidence. It
is read only when `policy.allow_local_search` permits it and never enters the
invocation signal, occurrence repository, queue request, or Automation trace.
Invocation persists a descriptor-only signal, the exact View ref, and a
predicate result bound to the exact Automation revision, canonical predicate
digest, frozen trigger id, and signal id. Automation context resolution then
re-resolves and authorizes the exact View before an Operator can read its
content. Missing, unrelated, mismatched, oversized,
forbidden, malformed, and infrastructure-failed evidence fails explicitly.

Event id plus exact View revision determines signal and idempotency identity.
The existing Automation occurrence reservation stops duplicate delivery, while
each matching Automation keeps its own occurrence. Outcomes are recorded as
matched, ignored, denied, failed, or enqueued with exact evidence and
correlation identity. Structured target failure and policy denial remain
terminal observable results; infrastructure and contract failures throw after
trace persistence so the View outbox can retry.

## Verification

- `corepack pnpm test:committed-view-trigger`: 6/6 passed, covering zero, one,
  and many matches, disabled and failed predicates, exact recursion through the
  transactional outbox, duplicate delivery, policy denial, context denial,
  forged event membership, predicate byte bounds, prevalidated-match replay
  across Automation/revision/predicate/trigger/signal boundaries, and trace
  failure.
- The privacy regression uses SQLite occurrence and trace stores and proves a
  content predicate can match while the private value is absent from both
  durable records before authorization.
- Automation context/runtime/SQLite/trace regression: 26/26 passed.
- `corepack pnpm test:v1-vertical`: 1/1 passed.
- `corepack pnpm typecheck:v1`: passed.
- `corepack pnpm check:boundaries`: 96 modules and 241 dependencies checked,
  zero violations.
- `corepack pnpm test:boundaries`: 23/23 passed.
- `corepack pnpm test`: 275 total, 274 passed, one opt-in live Screenpipe
  smoke skipped, zero failed.
- `git diff --check`: passed.

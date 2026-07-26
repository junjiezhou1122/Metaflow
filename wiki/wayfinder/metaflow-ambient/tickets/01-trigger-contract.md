## Question

What declarative Trigger contract can represent user shortcuts, browser DOM or
URL matches, View events, schedules, and bounded accumulation without running
an Agent continuously?

## Depends on

- Lock the Ambient Runtime boundary

## Acceptance criteria

- Trigger definitions are versioned, user-editable, enableable, and
  independently testable.
- Trigger occurrences carry source, observed time, correlation identity, and
  dedupe identity.
- Conditions are deterministic and cannot silently invoke a model.
- Cooldown, debounce, concurrency, expiry, and replay behavior are explicit.
- A failed condition or malformed occurrence is observable and does not count
  as a successful invocation.

## Verification method

- Contract-test shortcut, GitHub DOM match, View-created, daily schedule, and
  dwell-threshold fixtures.
- Test duplicate delivery, restart replay, disabled trigger, malformed payload,
  and concurrent occurrences.

## Resolution

Ambient Triggers are deterministic tagged contracts with four kinds: `user`,
`event`, `schedule`, and `accumulation`. Every definition has a stable id,
source, and event. Event/user/accumulation definitions may use a closed
predicate tree over normalized signal fields. Schedule definitions declare a
cron expression and validated IANA timezone; the scheduler adapter remains
responsible for parsing and firing that expression.

Trigger adapters emit strict signals carrying source time, source idempotency
identity, exact evidence View revisions, and a small JSON payload. A matched
signal becomes an exact Trigger occurrence tied to one Automation View
revision. Invalid regex, timezone, numeric comparison, View ref, or target
revision fails validation before matching.

Occurrence reservation is a required atomic port. The SQLite adapter uses
`BEGIN IMMEDIATE` and records exact replay duplicates, cooldown rejection,
concurrency rejection, succeeded finalization, and failed finalization as
distinct states. A conflicting second finalization fails rather than
overwriting history.

## Implementation

- `packages/automation/contracts.ts`
- `packages/automation/matching.ts`
- `packages/automation/runtime.ts`
- `packages/adapters/automation-sqlite/index.ts`
- `tests/automation-v1.test.ts`
- `tests/automation-sqlite.test.ts`
- `tests/ambient-agent-integration.test.ts`

## Acceptance results

- Strict Trigger families and predicates: pass.
- Exact Automation, target, evidence, and occurrence revisions: pass.
- Invalid definitions fail fast: pass.
- Duplicate and restart replay: pass.
- Cooldown and concurrent occurrence rejection: pass.
- Structured trace distinction for ignore, duplicate, rejection, execution,
  and Delivery: pass.

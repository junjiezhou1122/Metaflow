## Question

What durable trace explains why Ambient ran, which exact context it disclosed,
which Agent executed, what was delivered, and where a failure occurred?

## Depends on

- Define declarative Ambient Triggers
- Resolve and freeze current-context Views
- Connect Ambient invocation to the Agent Adapter
- Define delivery, interruption, and feedback

## Acceptance criteria

- One correlation id links Trigger occurrence, context resolution,
  Transformation Run, Agent events, delivery attempts, and Feedback Views.
- Trace records trigger revision, matching evidence, dedupe decision, selected
  View revisions, policy decisions, Agent Adapter, timings, and delivery status.
- Context, execution, validation, and delivery failures have distinct codes.
- Failed execution produces a Failure View through Execution Runtime.
- Retry or alternative context/Agent/delivery is a linked explicit attempt.

## Verification method

- Force one failure at every lifecycle stage and inspect the resulting trace.
- Verify no failed or partial attempt is reported as delivered success.

## Resolution

Ambient trace is a strict append-only domain port, not optional logging. One
correlation id joins the exact Automation revision, Trigger occurrence and
match evidence, reservation decision, Context candidates and allowed/denied
policy decisions, Transformation Run, Agent runtime events, exact result or
Failure Views, Delivery requests/results, and Feedback Views.

`AutomationTraceStore` appends validated events and queries an ordered timeline
by correlation id. `SqliteAutomationTraceStore` persists sequence, event time,
recording time, and the strict event envelope across daemon restart. A trace
write failure stops the lifecycle with `trace_persistence_failed` rather than
continuing with an invisible attempt.

`createAutomationAgentTraceBridge` checks Agent event correlation and JSON
payloads before forwarding runtime selection, progress, permissions,
completion, cancellation, or failure through the Automation target callback.
The bridge does not move ACP ownership into Automation.

Failures carry a distinct stage and code. Context failures preserve the role
and all source attempts. Execution, validation, and commit failures require an
exact Failure View from Execution Runtime. Delivery failure is separate and
cannot rewrite a successful Run. Reservation and finalization storage failures
remain distinguishable. A raw target exception is an infrastructure boundary
failure, not a fabricated structured Run result.

Retry and alternative context, Agent, or Delivery attempts must declare a new
attempt id, parent attempt id, and reason. No alternative is a silent fallback.

## Implementation

- `packages/automation/trace.ts`
- `packages/automation/runtime.ts`
- `packages/automation/context.ts`
- `packages/automation/delivery.ts`
- `packages/adapters/automation-sqlite/index.ts`
- `packages/adapters/agent-runtime/execution-adapter.ts`
- `tests/automation-trace.test.ts`
- `tests/ambient-agent-integration.test.ts`

## Acceptance results

- Complete Trigger-to-Feedback correlation timeline: pass.
- Exact selected Views and allowed/denied policy decisions: pass.
- Agent runtime selection and completion in the same timeline: pass.
- SQLite restart query with ordered sequence: pass.
- Occurrence, context, execution, validation, commit, delivery,
  finalization, and trace failure behavior: pass.
- Structured Run failures retain exact Failure Views: pass.
- Explicit retry parent-attempt link: pass.
- Unstructured failure and orphan parent validation: pass.
- Root TypeScript check: pass.
- Focused Automation, Agent, Delivery, Context, and trace suite: 37/37 pass.
- Dependency cruise: zero violations across 42 modules and 71 dependencies.
- Package boundary tests: 19/19 pass.

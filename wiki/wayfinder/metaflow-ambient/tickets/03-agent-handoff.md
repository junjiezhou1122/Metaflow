## Question

How does Ambient turn a trigger occurrence plus frozen context into an ordinary
Transformation and hand it to an Agent Adapter without owning Agent routing or
session lifecycle?

## Depends on

- Resolve and freeze current-context Views
- Define RuntimeAdapter contracts in the Agent Runtime map

## Acceptance criteria

- Invocation contains the user's instruction, exact context references,
  requested output contract, delivery request, and policy snapshot.
- Explicit Agent selection is preserved; absent selection uses one observable
  configured default.
- `invoke`, interactive session, and background job modes map to public Agent
  Adapter capabilities rather than Ambient-specific code paths.
- Agent progress and permission requests are correlated to the Ambient
  invocation and Transformation Run.
- Unsupported capability fails with structured evidence.

## Verification method

- Contract-test mock, CLI, and ACP adapters with the same frozen invocation.
- Verify explicit Codex selection, configured default selection, permission
  request, cancellation, and unsupported background mode.

## Resolution

Ambient hands one target request to Execution containing the exact Automation
revision, Trigger occurrence, exact resolved context bindings, exact target
revision, Automation policy snapshot, requested Delivery, and timeout. It does
not import or start ACP.

Execution owns the `AgentOperatorPort`. Its invocation freezes the
Transformation and Run ids, correlation id, user prompt, current
voice/screen/app context, exact input View refs and policies, available View
tools, requested output contract, execution mode, policy snapshot, and an
optional accepted runtime override.

`AgentExecutionAdapter` implements this port over registered Agent runtime
adapters. It preserves an explicit runtime override or emits that it selected
the configured default, checks the runtime's declared `invoke`, `interactive`,
or `background` modes before submission, maps the frozen invocation into the
shared Agent handoff, and correlates progress, permission, cancellation,
completion, and failure events to the Automation occurrence and
Transformation Run.

Unsupported modes and unknown runtimes return structured failures before an
Agent is started. Runtime alternatives are never attempted silently. Agent
output remains a candidate: the complete Execution Runtime must still validate
and atomically commit a Derived View or Failure View and persist the Run.

## Implementation

- `packages/execution/agent-operator.ts`
- `packages/adapters/agent-runtime/execution-adapter.ts`
- `packages/adapters/agent-runtime/types.ts`
- `packages/automation/runtime.ts`
- `tests/agent-execution-adapter.test.ts`
- `tests/ambient-agent-integration.test.ts`

## Acceptance results

- Same frozen invocation through mock, explicit Codex CLI, and ACP: pass.
- Configured default selection is observable: pass.
- Exact context refs, policies, output contract, and Delivery intent: pass.
- Permission and progress events retain occurrence and Run correlation: pass.
- Cancellation reaches the active selected runtime: pass.
- Unsupported background mode fails before submission: pass.
- Root and v1 TypeScript checks: pass.
- Dependency and manifest boundaries: 19/19 pass with zero violations.
- Focused Agent and Ambient suite: 31/31 pass.

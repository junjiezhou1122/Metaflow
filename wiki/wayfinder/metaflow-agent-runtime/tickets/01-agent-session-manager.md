## Question

When is ACP session reuse useful, and when is a direct CLI handoff enough?

## Depends On

- Lock the Agent Runtime boundary

## Acceptance Criteria

- Direct CLI handoff remains valid when the agent can receive the prompt and
  current context and can access View CLI or MCP tools.
- ACP session reuse is used only when it improves latency or interactive
  continuity.
- A warm ACP session never becomes durable product memory.
- Losing a session does not lose the task contract or committed Views.
- Cold and warm paths use the same context handoff and output contract.

## Verification Method

- Record direct CLI handoff latency, ACP cold spawn latency, and ACP warm
  prompt latency.
- Verify all three paths can produce the same output View shape or Failure
  View shape.

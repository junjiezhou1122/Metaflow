## Question

What minimal handoff contract lets ACP, CLI, Pi, Codex, workflow engines,
model APIs, and function Operators execute the same Metaflow task?

## Depends On

- Lock the Agent Runtime boundary
- Define AgentPool and session lifecycle

## Acceptance Criteria

- Adapter input contains the user's prompt, current voice/screen/app context,
  available View tools, and output contract.
- Skills are not inlined into the prompt; the agent environment owns installed
  skills.
- ACP adapters may stream events and permissions. CLI adapters may only return
  artifacts and exit status.
- Adapters surface structured failure evidence instead of returning partial
  success.
- Runtime-specific logs and raw protocol events can be retained as artifacts
  linked from trace.

## Verification Method

- Contract-test mock, ACP stdio, and one CLI adapter against the same fake
  Transformation Run.
- Verify each adapter receives the same prompt/context contract and returns
  either a valid artifact or inspectable failure.

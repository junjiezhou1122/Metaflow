# Agent Runtime Adapter

This package owns the thin handoff boundary between Metaflow and external
agents. It does not install skills, inline skill bodies, or decide how an agent
should reason. The agent environment owns its skills and tools. Metaflow owns
Views, provenance, policy checks, output validation, and artifact retention.

The core handoff is:

```text
user prompt
  + current voice/screen/app context
  + available View CLI/MCP tools
  + output contract
  -> external agent through ACP, CLI, mock, or future adapters
  -> artifact or event stream
  -> validated View or Failure evidence
```

Current adapters:

- `MockAgentRuntimeAdapter` for deterministic tests.
- `CliJsonAgentRuntimeAdapter` for direct CLI handoff.
- `AcpStdioAgentRuntimeAdapter` for ACP stdio agents with optional MCP server
  injection.

`AgentExecutionAdapter` implements the Agent Operator port declared by
`@info/execution`. It receives a frozen Transformation Run invocation, selects
an explicitly requested runtime or one configured default, checks the
runtime's declared execution modes, and correlates progress, permission,
cancellation, completion, and failure events back to the Run.

The adapter returns candidate output only. Execution remains responsible for
validating the output contract, committing a Derived View or Failure View, and
atomically recording the completed Transformation Run.

Agent tasks have two explicit output modes. The default `agent_task_output`
mode preserves the legacy summary/analysis/key-points envelope.
`schema_value` instead returns one JSON-compatible value for the frozen View
Schema. CLI and ACP runtimes parse strictly according to that mode and never
fall back to the other shape. They do not validate the View Schema or commit a
View; the Execution Runtime remains the sole validation and commit boundary.

Session reuse is only a latency optimization for ACP-style agents. The durable
state remains the task handoff, traces, artifacts, and committed Views.

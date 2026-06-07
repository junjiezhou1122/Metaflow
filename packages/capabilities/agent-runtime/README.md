# Adapters

Adapters isolate external or runtime-specific execution boundaries from the
core Info runtime. Capabilities and Programs can depend on adapter interfaces
without knowing the concrete CLI, protocol, process, or provider implementation.

Current packages:

- `agent-runtime/` — generic AgentTask runtime adapter boundary. It supports
  deterministic mock execution, Claude Code JSON CLI execution, and ACP stdio
  session orchestration with MCP server injection.

Adapters are kept separate from View compilers. A compiler decides how to build
one kind of View; an adapter decides how Info talks to an external runtime or
system to obtain structured results.

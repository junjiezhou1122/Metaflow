# Issue: Add Package-Level Agent Runtime Adapter

## Problem

Info is moving toward package-level boundaries, but `capability.agent_task.submit` still owns runtime invocation details. We need a generic agent-level adapter package for real agent runtimes, especially ACP-compatible runtimes, so Programs can submit agent tasks without depending on Claude Code, Codex, browser tooling, or a particular CLI shape.

## Goal

Create `packages/capabilities/agent-runtime` as the reusable boundary between Info capabilities and external/local agent runtimes.

The package should support:

- runtime-neutral `AgentRuntimeAdapter` types;
- one-shot agent task submission;
- ACP stdio runtime orchestration using `@agentclientprotocol/sdk`;
- injected MCP providers for browser/context/project/screen evidence;
- permission and policy hooks;
- structured output suitable for conversion into `ContextView`;
- provenance-friendly runtime events.

## Research Summary

ACP is a JSON-RPC protocol between clients and coding agents. The local stable transport is newline-delimited JSON-RPC over stdio. Clients initialize a connection, negotiate capabilities, create/load/resume sessions, send prompts, receive streamed `session/update` notifications, answer permission requests, and cancel prompt turns.

`chrome-acp` demonstrates the right layering: a proxy acts as ACP client to the agent, while browser powers are exposed as an MCP server and injected into ACP sessions through `mcpServers`. Info should reuse that pattern but not copy the proxy/UI coupling.

## Proposed Scope

Files to add in the implementation issue:

```text
packages/capabilities/agent-runtime/
  index.ts
  types.ts
  mock-runtime.ts
  cli-json-runtime.ts
  acp/stdio-runtime.ts
  acp/content.ts
  providers/mcp-provider.ts
  outputs/view-output.ts
```

Follow-up wiring:

```text
packages/capabilities/index.ts
packages/index.ts
src/programs/capabilities/agent-task-submit.ts
tests/agent-runtime-adapter.test.ts
```

## Acceptance Criteria

- [x] `capability.agent_task.submit` delegates runtime execution through an `AgentRuntimeAdapter` instead of directly shelling out.
- [x] Existing local mock behavior still works.
- [x] Existing Claude Code JSON CLI behavior is preserved behind an adapter or explicitly left as a compatibility path.
- [x] ACP stdio adapter can initialize an ACP-compatible command, create a session, send a prompt, collect updates, and return structured output.
- [x] Adapter accepts externally supplied MCP server configs and passes them into ACP session creation.
- [x] Policy denial for private provenance still happens before external runtime execution.
- [x] Tests cover mock success, invalid output contract, privacy denial, adapter selection, and ACP prompt/content mapping.
- [x] Documentation in `docs/agent-runtime-adapter-package.md` remains accurate after implementation.

## Non-Goals

- Building browser UI or copying `chrome-acp`'s WebSocket proxy.
- Making browser tools part of ACP itself.
- Granting filesystem write or terminal execution by default.
- Turning AgentTask output into action plans or file diffs in v0.
- Replacing Programs, connectors, or View compilers.

## Implementation Plan

1. Add runtime-neutral types and a mock adapter.
2. Extract current Claude Code invocation behind the adapter interface.
3. Add ACP stdio adapter with `ClientSideConnection` and `ndJsonStream`.
4. Map Info tasks to ACP content blocks and parse the final JSON result.
5. Add runtime event hooks for lifecycle and permission events.
6. Wire `capability.agent_task.submit` to select runtime by `task.runtime` / env default.
7. Add tests and update docs.

## Implementation Status

- Implemented: `packages/capabilities/agent-runtime` with `local_mock`, `claude_code` CLI JSON, and `acp_stdio` adapters.
- Implemented: `capability.agent_task.submit` selects adapters through `createDefaultAgentRuntimeAdapter`.
- Implemented: slow work can now be exposed through `agent.task_list`, `/agent/tasks`, and `mf task list|queue|process`.
- Remaining enhancement: richer permission event streaming and long-running cancel/resume UX for real external agents.

## References

- Design doc: `docs/agent-runtime-adapter-package.md`
- ACP docs: `https://agentclientprotocol.com/llms.txt`
- ACP TypeScript SDK: `https://agentclientprotocol.com/libraries/typescript.md`
- chrome-acp reference: `/Users/junjie/agent/acp/chrome-acp`

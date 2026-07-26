# Agent Runtime Adapter Package

> Research and design note for opening a package-level adapter that lets Info submit generic agent tasks to real agent runtimes, starting with ACP-compatible runtimes.

## Why This Package Exists

Info already has `capability.agent_task.submit`, but that capability currently mixes three concerns:

- translating a Program request into an agent task;
- choosing and invoking an external runtime;
- turning runtime output back into provenance-backed Views and events.

The package split should make the second concern explicit:

```text
Program
  -> capability.agent_task.submit
  -> packages/capabilities/agent-runtime
  -> external agent runtime
  -> ContextView + runtime events
```

The adapter package is not a new Program and not a source connector. It is the reusable execution boundary for real agent runtimes.

## Research Sources

ACP official docs:

- Firecrawl map cache: `.firecrawl/acp-urls.json`
- ACP LLM index: `https://agentclientprotocol.com/llms.txt`
- `https://agentclientprotocol.com/get-started/introduction.md`
- `https://agentclientprotocol.com/get-started/architecture.md`
- `https://agentclientprotocol.com/get-started/agents.md`
- `https://agentclientprotocol.com/get-started/clients.md`
- `https://agentclientprotocol.com/get-started/registry.md`
- `https://agentclientprotocol.com/protocol/overview.md`
- `https://agentclientprotocol.com/libraries/typescript.md`
- `https://agentclientprotocol.com/protocol/authentication.md`
- `https://agentclientprotocol.com/protocol/initialization.md`
- `https://agentclientprotocol.com/protocol/session-setup.md`
- `https://agentclientprotocol.com/protocol/session-list.md`
- `https://agentclientprotocol.com/protocol/session-modes.md`
- `https://agentclientprotocol.com/protocol/session-config-options.md`
- `https://agentclientprotocol.com/protocol/prompt-turn.md`
- `https://agentclientprotocol.com/protocol/agent-plan.md`
- `https://agentclientprotocol.com/protocol/slash-commands.md`
- `https://agentclientprotocol.com/protocol/tool-calls.md`
- `https://agentclientprotocol.com/protocol/content.md`
- `https://agentclientprotocol.com/protocol/file-system.md`
- `https://agentclientprotocol.com/protocol/terminals.md`
- `https://agentclientprotocol.com/protocol/extensibility.md`
- `https://agentclientprotocol.com/protocol/schema.md`
- `https://agentclientprotocol.com/protocol/transports.md`

Reference implementation:

- `/Users/junjie/agent/acp/chrome-acp/README.md`
- `/Users/junjie/agent/acp/chrome-acp/packages/proxy-server/src/server.ts`
- `/Users/junjie/agent/acp/chrome-acp/packages/proxy-server/src/mcp/handler.ts`
- `/Users/junjie/agent/acp/chrome-acp/packages/proxy-server/src/cli/command.ts`
- `/Users/junjie/agent/acp/chrome-acp/packages/shared/src/acp/client.ts`
- `/Users/junjie/agent/acp/chrome-acp/packages/shared/src/acp/types.ts`

## ACP Findings That Matter For Info

ACP standardizes the client-agent boundary for coding agents. The stable local transport is JSON-RPC over stdio: the client launches the agent subprocess, writes newline-delimited JSON-RPC to stdin, reads valid ACP messages from stdout, and treats stderr as logs.

Every connection starts with `initialize`, where client and agent negotiate protocol version and capabilities. Client capabilities include filesystem and terminal support. Agent capabilities include prompt content support, MCP transport support, auth, and optional session operations.

Sessions are explicit. The client creates or reconnects with `session/new`, `session/load`, or `session/resume`, passing `cwd` and MCP server configurations. Prompts are sent through `session/prompt`; agent progress streams back through `session/update`; cancellation is `session/cancel`; optional close is `session/close`.

Tool execution is agent-owned, but user-facing tool state is reported to the client as `tool_call` and `tool_call_update` session updates. Agents may ask the client for permission with `session/request_permission`.

Content uses MCP-style content blocks: text and resource links are baseline, while image, audio, and embedded resources require negotiated prompt capabilities.

MCP servers are injected by the client at session setup. This is the important extension point for Info: browser, Screenpipe, local context, repository, and future application tools should be exposed as MCP servers or provider-backed MCP proxies instead of becoming special ACP protocol branches.

Firecrawl map found newer stable protocol surfaces beyond the first minimal flow. These matter for later versions, but they should not be required for the v0 one-shot adapter:

- `authentication` and `logout`: relevant when the selected agent needs an auth handshake before session creation.
- `session/list`, `session/load`, `session/resume`, `session/close`: relevant for long-lived WorkThread-linked agent sessions.
- `session-modes` and `session-config-options`: relevant if Info exposes model/mode/config selectors in UI.
- `agent-plan` and `slash-commands`: useful runtime events for visibility, but v0 still rejects plan/action output as View payload.
- `extensibility` and `_meta`: the right place for Info correlation ids, provenance ids, and WorkThread ids without adding custom ACP methods.
- `schema`: the compatibility source of truth for generated types and tests when ACP SDK versions move.

## chrome-acp Findings

`chrome-acp` is useful because it separates three layers:

- a proxy server that speaks WebSocket to browser clients and ACP over stdio to the agent;
- a browser-tool MCP endpoint exposed by the proxy;
- web and Chrome clients that render chat state and answer browser tool calls.

The proxy uses `@agentclientprotocol/sdk` and `ClientSideConnection`. On connect it spawns the configured agent, wraps stdin/stdout with `acp.ndJsonStream`, calls `initialize`, stores agent capabilities, then creates ACP sessions with an injected browser MCP server.

The browser tools are not ACP methods. They are MCP tools (`browser_tabs`, `browser_read`, `browser_execute`) surfaced through the `mcpServers` field during session setup. The proxy forwards MCP tool calls to the browser over WebSocket and formats the response as MCP content.

For Info, this means the package should not copy chrome-acp's UI/WebSocket shape. The reusable idea is:

```text
ACP ClientSideConnection
  + runtime process lifecycle
  + session lifecycle
  + capability negotiation
  + injected MCP providers
  + permission bridge
  + event bridge
```

## Proposed Package Boundary

Implemented:

```text
packages/capabilities/agent-runtime/
  index.ts
  types.ts
  mock-runtime.ts
  cli-json-runtime.ts
  acp/
    stdio-runtime.ts
    content.ts
  providers/
    mcp-provider.ts
    info-context-provider.ts
  outputs/
    view-output.ts
```

The package owns runtime invocation and session orchestration. It does not own Program routing, View compiler policy, browser extension UI, or raw observation ingestion.

Top-level exports are available from `@info/capabilities`.

## Core Interfaces

```ts
export type AgentRuntimeKind = "acp_stdio" | "cli_json" | "mock";

export interface AgentTaskRequest {
  id: string;
  goal: string;
  cwd?: string;
  contextPack?: {
    markdown?: string;
    sources?: unknown[];
    diagnostics?: Record<string, unknown>;
  };
  outputContract: {
    viewType: string;
    title?: string;
    purpose?: string;
    schema?: unknown;
  };
  constraints?: Record<string, unknown>;
  policy?: {
    autonomy?: "suggest" | "act" | "autonomous";
    allowExternalLlm?: boolean;
    allowNetwork?: boolean;
    allowWrite?: boolean;
  };
}

export interface AgentRuntimeAdapter {
  id: string;
  kind: AgentRuntimeKind;
  capabilities(): Promise<AgentRuntimeCapabilities>;
  submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult>;
  cancel?(taskId: string): Promise<void>;
}

export interface AgentRuntimeContext {
  signal: unknown;
  mcpServers?: AgentMcpServerConfig[];
  permissions?: AgentPermissionBroker;
  events?: AgentRuntimeEventSink;
}

export interface AgentTaskResult {
  ok: boolean;
  reason: string;
  output?: {
    summary: string;
    analysis?: string;
    keyPoints?: string[];
    confidence?: number;
    raw?: unknown;
  };
  diagnostics?: Record<string, unknown>;
}
```

The first implementation should be ACP stdio. The current Claude Code `-p --output-format=json` path can remain as `cli_json` or stay inside the existing capability until ACP is stable.

## ACP Mapping

`AgentRuntimeAdapter.submit()` maps to ACP like this:

```text
spawn process
initialize(clientInfo, clientCapabilities)
session/new({ cwd, mcpServers })
session/prompt({ prompt: ContentBlock[] })
collect session/update notifications
wait for prompt response stopReason
parse final structured output
session/close when supported, otherwise disconnect/kill when needed
```

The adapter intentionally starts with `session/new` for each AgentTask. It records capabilities from `initialize`, but does not yet drive authentication, session listing, mode switching, config-option selection, slash commands, or plan UI. Those are additive runtime/session features, not prerequisites for turning one AgentTask into one structured View.

Prompt construction should use ACP content blocks:

- always include task instructions as `text`;
- include context pack markdown as `text` for the first slice;
- later, use embedded resources only when `promptCapabilities.embeddedContext` is negotiated;
- later, include images/audio only if the agent advertises support.

## MCP Provider Strategy

MCP providers are the generic way for Info to give agents powers without hard-coding those powers into the runtime adapter.

Initial providers:

- `info_context`: query context pack sources by `context://records/<id>` and `context://views/<id>`;
- `browser`: optional provider similar to chrome-acp, backed by the existing browser extension when connected;
- `local_project`: read-only project metadata and git snapshot;
- `screenpipe`: optional, query-time evidence provider, policy-gated.

The runtime package only accepts `mcpServers` or provider descriptors. It should not import Screenpipe or browser extension code directly.

## Permission And Policy

The adapter must keep Info's existing architecture rule:

```text
Actions require provenance and permission.
```

The package should expose permission requests as runtime events and let `capability.agent_task.submit` or a higher Program decide whether to auto-allow, ask the user, or deny.

Default v0 policy:

- allow read-only ACP sessions for local trusted runtimes;
- deny external LLM use when any provenance source says `allow_external_llm === false`;
- do not grant write or terminal capability by default;
- surface tool calls and permission requests as events even when no UI exists yet.

## Output Contract

The adapter returns structured `AgentTaskResult`. The capability remains responsible for turning the result into `ContextView`.

Info should not duplicate every agent skill as an Info capability by default. A real agent runtime may use its own Jina, Firecrawl, GitHub, PDF, video, browser, CLI, or MCP tools. Info's responsibility is to validate the structured result, attach policy/provenance, and write Views.

V0 output JSON:

```json
{
  "summary": "string",
  "analysis": "string",
  "key_points": ["string"],
  "confidence": 0.5,
  "views": [
    {
      "view_type": "extraction.reader_snapshot",
      "title": "Optional evidence title",
      "summary": "Optional evidence summary",
      "content": {
        "url": "https://example.com",
        "text": "Evidence the agent acquired with its own tools",
        "provider": "agent_skill"
      },
      "confidence": 0.5
    }
  ]
}
```

The top-level object still produces the final AgentTask analysis View. The optional `views` array lets an agent return evidence Views acquired by agent-owned skills. Info assigns ids, scope, provenance, privacy, compiler metadata, and lifecycle fields; it does not trust runtime-supplied ids or scope.

The runtime adapter should reject action plans, file diffs, and task lists unless the caller explicitly asks for an action-capable output contract in a later version.

## Implementation Slices

1. Done: extract runtime-neutral types and mock adapter.
2. Done: move current Claude Code JSON CLI invocation behind `AgentRuntimeAdapter`.
3. Done: add ACP stdio adapter using `@agentclientprotocol/sdk`.
4. Done: add basic MCP provider injection shape, starting with externally supplied MCP configs.
5. Done: add runtime event hooks for initialize, session create, prompt update, permission requested, prompt complete, failed, and cancelled.
6. Done: wire `capability.agent_task.submit` to choose an adapter by runtime id.
7. Done: add tests for mock success, ACP prompt mapping, output parsing, and ACP stdio session/MCP injection. Existing Program/HTTP tests cover policy denial and capability wiring.
8. Done: support optional agent-returned evidence Views while keeping tool execution owned by the agent runtime.

## Open Design Questions

- Should Info expose filesystem/terminal ACP client capabilities at all in v0, or only MCP providers?
- Do we want long-lived sessions per WorkThread, or one-shot sessions per AgentTask until session history is mature?
- Should runtime state be persisted as Views, runtime events, or both?
- What is the first real ACP target: Codex ACP, Claude Agent ACP, Gemini CLI ACP, or OpenCode ACP?
- Which ACP optional capabilities should be surfaced in the extension or UI first: auth, session history, modes/config, slash commands, or agent plans?

## Recommended Decision

Keep the implementation under `packages/capabilities/agent-runtime`. The old
`packages/adapters/agent-runtime` name described the boundary, but the actual
workspace package is `@info/capabilities`, and `agent-runtime` is the reusable
capability submodule inside it. Keep the public interface runtime-neutral, but
implement ACP stdio first because ACP gives us session lifecycle, capability
negotiation, tool call streaming, cancellation, and future registry
compatibility.

Do not copy `chrome-acp`'s WebSocket proxy into Info. Copy its architecture lesson: ACP is the runtime protocol; browser and context powers are MCP providers injected at session setup.

## Implementation Status

The first implementation is now in place:

- `MockAgentRuntimeAdapter` preserves deterministic local test behavior.
- `CliJsonAgentRuntimeAdapter` wraps Claude Code's JSON CLI path while keeping its dry-run prompt preview and tool-policy diagnostics.
- `AcpStdioAgentRuntimeAdapter` follows the `chrome-acp` pattern: spawn a process, wrap stdin/stdout with `ndJsonStream`, create `ClientSideConnection`, call `initialize`, create a session with injected MCP servers, send `session/prompt`, collect `session/update`, parse structured JSON output, and close/kill resources.
- `capability.agent_task.submit` now delegates runtime execution through `createDefaultAgentRuntimeAdapter`.
- `mcp_servers` can be supplied on an AgentTask payload and are passed into ACP `session/new`.

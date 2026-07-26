---
title: Metaflow Agent Runtime and Operator Adapters
type: wayfinder-map
label: wayfinder:map
status: open
created: 2026-07-26
updated: 2026-07-26
---

# Metaflow Agent Runtime and Operator Adapters

## Destination

Design and verify the Metaflow Agent Adapter layer: versioned
Transformations can hand the user's prompt plus the current context to an
external Agent through ACP, CLI, MCP, or native adapters. The Agent already has
its own skills and can use Metaflow View CLI or MCP tools to find related
Views. Durable truth remains in Views, Transformation Runs, traces, and
Failure Views.

The first accepted slice is:

```text
Ambient intent or CLI request
  -> Transformation with OperatorProfile
  -> user's prompt + current voice/screen/app context
  -> Agent through ACP, CLI, MCP, Pi, Codex, or workflow adapter
  -> Agent uses its installed skills and View CLI/MCP tools
  -> collected artifact or AgentRun events
  -> validated Candidate View or explicit Failure View
  -> atomic commit and trace inspection
```

## Notes

- This map is about runtime execution, not Ambient UI, marketplace packaging,
  or a complete general-purpose agent product.
- Existing adapter code is evidence, not target architecture authority.
- Do not put durable product memory inside external agent sessions. Skills and
  tools belong to the agent; Views belong to Info.
- The adapter does not need to inline skill bodies. It hands off the user's
  prompt and current context; the agent uses its installed skills.
- For a Mac ambient request, the minimal current context is enough: current
  voice utterance, current screen/app/window context, and a path to search
  related Views through CLI or MCP.
- ACP is the main interactive route, but direct CLI can do the same job when
  the agent can access the same View tools.
- Agent Adapter must preserve Metaflow invariants: trace the handoff, fail
  observably, and commit only validated Views.
- No separate Worker domain layer is introduced. Agent, workflow, model,
  function, human, and service remain Operator kinds inside Transformations.
- Build on a non-main branch. Preserve unrelated user changes and generated
  local artifacts.
- Refer to child issues by title, not bare issue number.

## External patterns to compare

- ACP and Zed: editor host starts or connects to an external agent, then uses
  session/new, session/load, session/resume, and session/prompt. ACP is the
  interoperability protocol, not the full Metaflow runtime.
- Claude Code, Codex, Gemini CLI, and OpenCode: coding agents expose
  persistent sessions or history/resume behavior; cold CLI invocation is a
  slow fallback.
- LangGraph: durable execution, persistence, streaming, and human-in-the-loop
  are workflow-runtime evidence.
- AWS AgentCore Runtime: isolated sessions and long-running/background agents
  are cloud-runtime evidence; long-term memory still belongs outside the
  transient session.
- Pi-style agent harnesses: useful evidence for embeddable tool/state/runtime
  adapters controlled by Metaflow.

## Decisions so far

- Agent Adapter is a handoff layer below Transformation Run, not a second
  memory system.
- The core handoff is simple: prompt, current context, available View tools,
  and output contract.
- The agent chooses how to use its own skills and how to search related Views.
- Session reuse is only a latency optimization for ACP-style agents.

## Frontier

- [[wayfinder/metaflow-agent-runtime/tickets/00-lock-agent-runtime-boundary|Lock
  the Agent Runtime boundary]]
- [[wayfinder/metaflow-agent-runtime/tickets/01-agent-session-manager|Decide
  when ACP session reuse is useful]]
- [[wayfinder/metaflow-agent-runtime/tickets/02-runtime-adapter-contract|Define
  RuntimeAdapter contracts]]
- [[wayfinder/metaflow-agent-runtime/tickets/03-view-tool-bridge|Design the
  ViewGraph tool bridge]]
- [[wayfinder/metaflow-agent-runtime/tickets/04-policy-and-permissions|Define
  policy, permission, and side-effect gates]]
- [[wayfinder/metaflow-agent-runtime/tickets/05-trace-failure-repair|Specify
  traces, failures, and repair]]
- [[wayfinder/metaflow-agent-runtime/tickets/06-first-demo-slice|Verify the
  first Ambient-to-AgentRuntime slice]]

## Not Yet Specified

- Exact ACP idle timeout, prewarm, and resume policy if the first slice needs
  warm sessions.
- Whether a later daemon is needed beyond direct ACP/CLI handoff.
- How far to support remote hosted runtimes in the first slice.
- Operator marketplace packaging, signing, installation, and rollback.
- Full Ambient proactive trigger policy.
- Human-facing session browser and run visualization.

## Out of Scope

- Notch, browser, and native UI styling.
- A universal external side-effect authorization system beyond this slice.
- Full multi-agent social orchestration.
- Replacing View Core, Capture, or Execution Runtime decisions.

---
name: research/builderio-agent-native
title: BuilderIO Agent-Native
desc: Evidence-backed evaluation of Agent-Native's Action surface, Agent Runtime, Automation model, and fit as a Metaflow dependency or reference.
category: framework-evaluation
tags: [agent-native, actions, mcp, automation, framework]
sources: [github-builderio-agent-native, agent-native-docs]
created: 2026-07-24T12:42:18Z
updated: 2026-07-24T12:42:18Z
---
# BuilderIO Agent-Native

> Status: reference evaluation, not an adoption decision.

## Snapshot

- Repository:
  [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native)
- Inspected commit: `8f8e0764f651bffb25294e45a851eac2221e49c8`
- Commit time: 2026-07-24
- Inspected `@agent-native/core` version: `0.120.2`
- Repository shape at this snapshot: 18 packages, 13,199 tracked files.
- `@agent-native/core`: 2,234 source files and 72 direct dependencies.

## What it actually implements

Agent-Native directly implements the define-once/use-everywhere pattern
Metaflow has been discussing:

```text
defineAction(schema + run)
├── in-app Agent tool
├── React query/mutation hooks
├── imperative client call
├── HTTP endpoint
├── MCP tool
├── A2A tool
└── CLI command
```

The implementation is more than a README claim:

- actions are discovered from `actions/` and package registries;
- Standard Schema input is converted to agent JSON Schema and validated before
  execution;
- optional output schemas validate results;
- every dispatch carries caller identity such as tool, frontend, HTTP, CLI,
  MCP, A2A, or Automation;
- exposure flags control Agent, HTTP, MCP/A2A, iframe, and public visibility;
- `needsApproval` pauses a specific consequential tool call before execution;
- action routes, MCP, A2A, CLI, React hooks, and Agent tools invoke the same
  action body;
- the default external catalog is compact and retains `tool-search` for
  on-demand discovery;
- long Agent work has durable task handles, background execution, run events,
  cancellation, and resume protection against repeating completed side effects;
- scheduled and event-triggered Automations reuse the Agent and Action runtime.

Primary evidence:

- [Actions](https://agent-native.com/docs/actions)
- [Agent Surfaces](https://agent-native.com/docs/agent-surfaces)
- [Automations](https://agent-native.com/docs/automations)
- [External Agents](https://agent-native.com/docs/external-agents)
- [Human Approval](https://agent-native.com/docs/human-approval)
- [Durable Resume](https://agent-native.com/docs/durable-resume)

## The closest match to Metaflow

Agent-Native validates the architecture pattern proposed in
[[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]:

```text
One domain operation
→ multiple human and agent surfaces
→ shared validation and execution
```

Its compact catalog plus `tool-search` also independently implements the
recommended pattern from the architecture discussion:

```text
small task-relevant default tool set
+ searchable wider catalog
```

This makes Agent-Native the strongest current reference for Metaflow's
Operation Surface.

## Important mismatches

### Different meaning of Processor

Agent-Native's Processor is an in-loop observer or guard around an Agent run.
It can inspect input/output, mutate its own run state, or abort. Its
documentation explicitly says it is not an Action and does not define app
behavior.

Metaflow currently uses Processor for a runtime-neutral derivation:

```text
Observation/View → Observation/View
```

The two terms are not compatible. Metaflow should not import Agent-Native's
Processor vocabulary into its domain model.

### No ViewGraph domain

Agent-Native has SQL resources, application state, UI selection context,
conversation memory, and Agent observational memory. It does not supply
Metaflow's required graph lifecycle:

```text
Observation provenance
View → View derivation
merge · split · fork · promote · retire
federated external View references
```

These remain Metaflow-owned capabilities.

### Different data ownership model

Agent-Native is built around app-owned Drizzle SQL state. It supports local
SQLite for development but recommends a persistent hosted database for
deployed applications.

Metaflow's personal Observation, artifact, privacy, and local-daemon model
cannot be delegated to that storage convention.

### Core coupling

`@agent-native/core` combines Action contracts, Agent loops, React clients,
database adapters, MCP, A2A, CLI, authentication, collaboration, memory,
automation, telemetry, and many product capabilities.

Metaflow is specifically trying to establish smaller deep capability owners.
Depending on this entire Core would replace one mixed architecture with
another, larger one.

### Approval is narrower

Agent-Native provides strong per-call human approval through
`needsApproval`. Metaflow additionally needs:

- Task Authorization created by an explicit user request;
- Standing Approval Policy, including explicit full approval;
- Smart Approval translating Codex, Hermes, and other runtime requests;
- consistent policy for non-Agent callers and long-running workflows.

Agent-Native's gate is useful evidence and possibly adapter behavior, but not
the complete Metaflow authority model.

### Runtime and language assumptions

Actions are TypeScript handlers inside a Node/Nitro-style application.
Metaflow needs local Swift integration and potentially TypeScript, Python,
Rust, III workers, remote Agent platforms, and external federated Views.

The stable Metaflow contract therefore needs to sit above Agent-Native's
Action runtime.

## Recommended adoption boundary

Use Agent-Native as:

1. the primary design reference for `defineOperation`;
2. evidence for generating Agent, UI, HTTP, MCP, A2A, and CLI adapters from one
   schema-defined operation;
3. a reference for caller context, exposure flags, human approval, compact
   catalogs, tool search, durable task handles, and resume idempotency;
4. a possible Web Studio or generated personal-application shell, connected
   through a Metaflow Operation adapter.

Do not currently:

1. replace Metaflow Core with `@agent-native/core`;
2. let Agent-Native own Observation, ViewGraph, personal memory, or policy;
3. model Metaflow Processors using Agent-Native in-loop Processors;
4. put ViewGraph invariants directly inside app-local Action handlers;
5. bind the domain to Drizzle or a hosted SQL deployment model.

The desired composition is:

```text
Metaflow Core Operation
├── native CLI / HTTP / MCP / III adapters
└── optional Agent-Native Action adapter
    ├── React application
    ├── Agent tool
    ├── MCP / A2A
    └── generated personal application
```

## Licensing and maturity note

The repository README and `packages/core/package.json` say MIT, while the root
`package.json` says ISC, and no root license file was present in the inspected
snapshot. This inconsistency should be clarified before copying source code.
Depending on the published package is governed by its package metadata, but
code reuse still deserves an explicit license check.

The inspected Core version is pre-1.0 and the repository is changing rapidly.
Architecture reuse should target stable concepts and narrow adapters rather
than internal file paths.

## Evaluation

| Question | Result |
|---|---|
| One definition reused across UI, Agent, HTTP, MCP, A2A, CLI | Strong match |
| Compact catalog with Agent-driven tool discovery | Strong match |
| Long Agent runs and durable resume | Strong match |
| Human approval | Partial match; per-call only |
| Triggered Automation | Strong infrastructure reference |
| Observation and ViewGraph | Missing |
| Local-first personal data authority | Different model |
| Multi-runtime and cross-language execution | Partial |
| Clean capability package boundaries | Weak match |
| Safe wholesale adoption for Metaflow Core | Not recommended |

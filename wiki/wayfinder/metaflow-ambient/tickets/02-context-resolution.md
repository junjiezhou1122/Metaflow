## Question

How should one Ambient occurrence resolve and freeze the minimum exact Views
needed for the request while preserving source coverage, privacy, and latency?

## Depends on

- Lock the Ambient Runtime boundary
- Define declarative Ambient Triggers

## Acceptance criteria

- A context selector declares required and optional context roles rather than
  hard-coding a provider.
- Resolution freezes exact View ids and revisions before execution.
- Explicit selection, Browser DOM, Accessibility, screenshot/Vision, and
  project/history context are distinguishable sources with coverage metadata.
- Required-context failure stops the invocation; optional alternatives appear
  as explicit trace attempts.
- Sensitive or denied context never reaches the Agent Adapter.

## Verification method

- Resolve fixtures for browser selection, full GitHub page, AX selection,
  screenshot-only application, and current project context.
- Test missing required context, stale revision, policy denial, and explicit
  screenshot alternative.

## Resolution

An Automation declares context as named roles. Each role is required or
optional and contains an ordered list of explicit sources: Trigger evidence,
an exact View reference, or a View query. Source order expresses allowed
alternatives; it is not a hidden provider fallback.

`AutomationContextResolver` evaluates one source at a time, records every
selected, empty, denied, or failed attempt, authorizes each candidate before
disclosure, and returns only exact View ids and revisions. Trigger evidence is
resolved by the View Store rather than trusted from the occurrence payload, so
a missing or stale revision fails instead of drifting to the latest View.

A required role with no authorized result raises a structured
`AutomationContextResolutionError` before target execution. Optional roles may
remain empty, but their attempts stay in the invocation trace. Policy denial
records the policy decision and never adds the denied View to disclosed
context. Browser DOM, macOS Accessibility, explicit selection,
screenshot/Vision, project, and history therefore remain distinguishable by
their View schema and source metadata.

The Automation Runtime emits `automation.context_resolved` with frozen
bindings or `automation.context_failed` with structured attempts. Context
failure finalizes the occurrence as failed and does not call the target port.

## Implementation

- `packages/automation/context.ts`
- `packages/automation/contracts.ts`
- `packages/automation/runtime.ts`
- `tests/automation-context.test.ts`
- `tests/automation-v1.test.ts`
- `tests/ambient-agent-integration.test.ts`

## Acceptance results

- Required and optional role selectors: pass.
- Exact Trigger evidence and queried View revisions: pass.
- Ordered, observable alternatives: pass.
- Missing or stale exact revision fails before execution: pass.
- Policy-denied context is traced but not disclosed: pass.
- Ambient focused suite: 20/20 pass.
- v1 TypeScript and package dependency checks: pass.

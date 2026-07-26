---
title: Metaflow Ambient Runtime
type: wayfinder-map
label: wayfinder:map
status: open
created: 2026-07-26
updated: 2026-07-26
---

# Metaflow Ambient Runtime

## Destination

Design and verify a thin Ambient Runtime that reacts to explicit user,
application, View, and time triggers; freezes the exact current-context Views;
invokes an ordinary Transformation or external Agent through the shared Agent
Adapter; and routes observable results to browser, macOS, notch, or inbox
surfaces without introducing a second data model or intelligence runtime.

The first accepted slice is:

```text
user holds the global shortcut and speaks over selected text
  -> user trigger with utterance and source surface
  -> exact Browser or Accessibility context Views are resolved and frozen
  -> Agent Adapter receives prompt plus current context
  -> result and progress are delivered to a lightweight surface
  -> feedback and the complete invocation trace are committed as Views
```

## Notes

- This map includes design and implementation. A ticket closes only after its
  decision and first contract are verified.
- Ambient is orchestration behavior, not a new View type hierarchy, model,
  memory system, or UI toolkit.
- Ambient does not continuously ask an Agent to inspect context. Work begins
  from an explicit trigger: user input, matching DOM/URL/View event, schedule,
  or bounded accumulation condition.
- The notch is a delivery surface. It does not select context, choose an
  Agent, or decide when to interrupt.
- Browser DOM is preferred when full page structure is required; macOS
  Accessibility supplies current app/window/selection; screenshot or Vision is
  an explicit alternative, never a hidden fallback.
- An explicit user instruction such as "send this to Codex" selects that Agent
  Adapter subject to normal policy checks.
- Historical behavior discovery, learned interruption timing, and automatic
  workflow invention are out of scope for v1. User-authored triggers and
  scheduled summaries are sufficient.
- Depend on the public Agent Adapter handoff contract being developed by
  [[wayfinder/metaflow-agent-runtime/map|Metaflow Agent Runtime and Operator
  Adapters]]. Do not duplicate ACP session or permission logic.
- Depend on canonical View and Transformation semantics from
  `wiki/architecture/view-core-transformation-runtime.md`. New v1 code must not
  depend on legacy `@info/core`.
- Fail fast on missing required context, denied View access, unsupported Agent
  capability, invalid result, and delivery failure. Every attempt is traceable;
  alternatives are explicit attempts.
- Build on a non-main branch and preserve unrelated worktree changes.
- Canonical GitHub map:
  https://github.com/junjiezhou1122/Metaflow/issues/45

## Decisions so far

- [Lock the Ambient Runtime boundary](https://github.com/junjiezhou1122/Metaflow/issues/52) — Ambient is a product behavior built from editable Automation Views, deterministic Triggers, exact context Views, shared Execution/Agent adapters, Delivery ports, and Feedback Views; the reusable v1 owner is `packages/automation`.
- [Define declarative Ambient Triggers](https://github.com/junjiezhou1122/Metaflow/issues/53) — strict user, event, schedule, and accumulation contracts now create exact occurrences; SQLite reservation makes replay, cooldown, concurrency, and finalization explicit and durable.
- [Resolve and freeze current-context Views](https://github.com/junjiezhou1122/Metaflow/issues/46) — named required or optional roles resolve ordered explicit sources, authorize candidates, freeze exact View revisions, and fail before execution when required context is unavailable or denied.
- [Connect Ambient invocation to the Agent Adapter](https://github.com/junjiezhou1122/Metaflow/issues/50) — Execution now owns a frozen Agent Operator port; the shared adapter preserves explicit or default runtime selection, gates execution modes, and correlates ACP/CLI progress, permissions, cancellation, and failures without Automation importing Agent code.
- [Implement the observable Execution Runtime and atomic commit path](https://github.com/junjiezhou1122/Metaflow/issues/39) — the shared dependency now accepts trigger-time exact role bindings without re-resolution and provides the Agent bridge, bounded View content context, candidate validation, atomic View commit, Failure View, and replay APIs required by Ambient slices.
- [Define delivery, interruption, and feedback](https://github.com/junjiezhou1122/Metaflow/issues/54) — shared Delivery requests freeze exact progress or result Views; single-capacity notch replacement is deterministic; a durable ledger preserves restart-safe interactions; and strict Feedback Views commit before idempotent commands without changing execution status.
- [Specify Ambient traces and failure behavior](https://github.com/junjiezhou1122/Metaflow/issues/47) — a strict append-only timeline now correlates Trigger evidence, exact Context and policy decisions, Agent events, Run outputs or Failure Views, Delivery, and Feedback across restart; failure stages and explicit retry links cannot be hidden.
- [Verify a Browser trigger slice](https://github.com/junjiezhou1122/Metaflow/issues/49) — a declarative GitHub Browser event now freezes exact page and optional selection roles, executes the exact Transformation through ACP and shared Execution, commits and delivers a summary View, records Feedback, and deduplicates the same navigation under one durable trace.
- [Verify a scheduled summary slice](https://github.com/junjiezhou1122/Metaflow/issues/48) — timezone-aware cron periods now freeze exact category-filtered Views through epoch queries, execute an ordinary summary Transformation, persist restart-safe bounded cursors, deliver to Inbox, and retain replay/Feedback correlation.

## Frontier

- [Verify the macOS shortcut and voice slice](https://github.com/junjiezhou1122/Metaflow/issues/51) — deterministic vertical, strict native smoke tests, and signed app bundle pass; live selected-text and Apple Speech evidence await an unlocked console and Speech authorization.

## Not yet specified

- Cross-device trigger delivery and remote Agent execution.
- User-facing trigger editor and personal Application generator.
- Long-running job progress aggregation across multiple delivery surfaces.
- Trigger marketplace packaging, signing, installation, and rollback.

## Out of scope

- Automatic discovery of repeated workflows from historical behavior.
- Learned interruption timing or reinforcement-learning attention policy.
- A separate Ambient memory database or always-running Ambient LLM.
- Full notch, browser panel, or inbox visual design.
- Replacing View Core, Transformation Runtime, Capture, or Agent Adapter.
- Universal side-effect authorization beyond the selected Agent Adapter's
  existing policy and permission boundary.

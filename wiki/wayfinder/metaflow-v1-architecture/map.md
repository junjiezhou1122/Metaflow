---
title: Metaflow v1 Architecture Map
type: wayfinder-map
label: wayfinder:map
status: open
created: 2026-07-25
updated: 2026-07-26
---

# Metaflow v1 Architecture Map

## Destination

Build the Metaflow v1 framework incrementally from verified vertical slices:
canonical domain language, capability owners, package and dependency map, and
stable contracts between capture, Views, operators, runtimes, applications,
Ambient behavior, and operation surfaces. Each resolved decision is
implemented and tested on the v1 branch before the map advances to the next
framework boundary.

## Notes

- The View Core and Transformation Runtime implementation frontier moved to
  [[wayfinder/metaflow-view-core/map|the focused map]] and its canonical GitHub
  issue: https://github.com/junjiezhou1122/Metaflow/issues/26. Do not implement
  the older View/Operator terminology from this broad map where it conflicts
  with the focused canonical design.
- The Agent Runtime and Operator Adapter frontier moved to
  [[wayfinder/metaflow-agent-runtime/map|the focused map]]. It owns warm
  sessions, runtime adapters, ViewGraph tool bridges, permission gates, traces,
  and the first Ambient-to-AgentRuntime slice.

- This map now coordinates architecture and implementation together. A ticket
  closes only after its decision is recorded and its first contract is tested.
- Use `grilling` and `domain-modeling`; resolve one decision at a time.
- Explain alternatives and a concrete example before asking the founder to
  decide.
- Derive View schemas, names, and Operators from complete real user scenarios.
  Papers and existing implementations are comparison evidence, not the source
  of Metaflow's ontology.
- Existing v0 packages are evidence, not constraints on the new design.
- Current domain baseline: [[architecture/view-model|View Model and View
  Algebra]].
- New architecture documentation lives in `wiki/`; `docs/` is legacy.
- Implementation requires a new branch and must preserve fail-fast errors,
  provenance, execution traces, and observable attempts.

## Decisions so far

- [[wayfinder/metaflow-v1-architecture/tickets/choose-capability-owners|Choose
  the top-level capability owners]] — organize packages by stable capability
  ownership; adapters remain packages, and apps compose adapters with domain
  ports without reversing the dependency.
- [[wayfinder/metaflow-v1-architecture/tickets/define-capture-boundary|Define
  Capture and Raw View admission]] — Connectors emit ObservationCandidates;
  CaptureIngress alone admits immutable, idempotent Raw Views through a
  repository port. Browser and Screenpipe are the first adapters.

Decisions made before this map are recorded in
[[architecture/view-model|View Model and View Algebra]].

## Not yet specified

- Operator marketplace packaging, signing, installation, and rollback.
- The durable Application Space model and how applications reuse Views across
  spaces.
- Ambient attention, automation, trust, approval, and notification ownership.
- The universal Operation Surface projected through CLI, HTTP, MCP, Web, and
  native UI.
- Human View Graph exploration and editing behavior.
- Migration order from v0 after the target architecture is complete.

## Out of scope

- Detailed visual styling for the website, View Graph Explorer, or notch UI.
- Choosing final model providers before their required contracts are known.

---
name: architecture/reactive-view-evolution
title: Reactive View Evolution
desc: The canonical working model for turning committed upstream View revisions into traceable downstream View revisions through explicit triggers, Transformations, Operators, and Workers.
category: canonical-working-decision
tags: [view, reactive, transformation, operator, worker, automation, graph, search, renderer]
sources: [architecture-discussion, architecture/view-core-transformation-runtime]
created: 2026-07-27T11:56:03+08:00
updated: 2026-07-27T11:56:03+08:00
---

# Reactive View Evolution

> Status: canonical working model. The generic commit-to-Transformation path is
> implemented. Declarative per-package evolution, coalescing, and parent
> propagation rules remain open product contracts and are not claimed as
> complete below.

## Start after capture

This page deliberately starts after source information has already been
admitted. An Observation is simply a Raw View role, so downstream processing
does not need a parallel Observation or Processor universe:

```text
Raw or Derived View revision committed
        -> explicit Trigger or manual request
        -> exact Transformation revision
        -> frozen Operator contract
        -> Worker executes it
        -> Execution validates and commits Derived View revision(s)
        -> another view.committed event may continue the graph
```

`Processor` is useful conversational language, but the stable contract is the
Operator inside a Transformation. A Worker is only the concrete host that
executes that Operator: fixed code, Agent, model, Workflow, human, remote
service, or III Function. Changing the Worker does not create another View
model or bypass the ordinary Run and commit path.

## One View-centered abstraction

Everything after capture can be reasoned about using three durable concepts:

```text
View             information at one exact immutable revision
Transformation   a versioned declaration of View inputs -> View outputs
Automation       when and with which exact evidence to start a Transformation
```

Operator, Worker, Execution Runtime, and Run explain how one Transformation is
performed and observed. They do not introduce another information universe.

Automatic and manual work use the same execution boundary:

- a `view.committed` Automation reacts to new upstream evidence;
- a schedule or accumulation Trigger starts work at a declared boundary;
- a person or Agent invokes an exact Transformation through `run.execute`;
- direct human authoring may commit a View, whose commit can then trigger the
  same downstream path.

No View updates merely because the system guesses it should. Automatic
evolution requires an explicit, inspectable Automation. This keeps fan-out,
authorization, failures, retries, and causality observable.

## Real example: a page watched for more than ten seconds

```text
Browser page/navigation/heartbeat Raw Views
        -> attention evidence reaches the declared 10-second condition
        -> Automation freezes the exact page and attention evidence
        -> Transformation: create or revise a watched-page View
        -> Operator: deterministic function or Agent
        -> Execution commits watched-page@revision
        -> downstream Automations may summarize, classify, or add it to a space
```

The threshold calculation is not hidden inside Search or the View Store. It may
be produced by a deterministic attention Transformation or by a bounded
accumulation Trigger. Either way, the selected evidence and resulting View are
exact and traceable.

For example, the watched-page commit may fan out into several independent
branches:

```text
watched-page
  |-> topic classification
  |-> project relevance
  |-> English-learning material
  `-> daily browsing summary
```

Each branch has its own Automation, Transformation, authorization decision,
Run, budget, and output View. A failure in one branch does not silently erase
the others, and cascade limits prevent uncontrolled recursive execution.

## Recursive composition creates the graph

A View may freeze exact child or member View revisions in its Representation
and relations. That child can itself compose other Views:

```text
Application Space
  -> daily learning plan
      -> learning material
          -> watched page
              -> captured page Raw View
```

This indentation is only a projection. The durable structure is a graph:

- one View may belong to several parents;
- membership, composition, provenance, reference, and supersession are
  different relation meanings;
- historical relations point to exact revisions and never drift to `latest`;
- a child revision does not currently mutate or automatically revise every
  parent. Parent evolution requires an explicit Automation until a different
  rule is accepted.

## Search, Agent access, and human display are projections

The same exact View revisions support three major ways of use:

```text
                         -> Search projection
exact View + relations  -> Agent Method through CLI/MCP Operations
                         -> human Renderer or Graph Explorer
```

Search can target one exact View, selected internal Representation locations,
an Application Space, a bounded related subgraph, or all authorized Views. It
returns exact refs and evidence; it does not create or transform Views.

Agent-facing Methods belong to a View Package and reference existing Operations
or exact Transformations. Agents use the same `view.get`, `view.search`,
`view.graph.project`, and `run.execute` contracts rather than reading SQLite.

Human Renderers display one Representation through a declared Renderer ABI.
The Graph Explorer displays a bounded authorized graph projection. Rendering,
layout, filtering, and camera state do not become View semantics unless an
explicit Transformation commits a new View.

## What exists now

The integration branch currently contains these executable foundations:

- immutable Raw and Derived View revisions, exact relations, provenance,
  policy, Schema, Representation, and Materialization;
- atomic View commits with a durable `view.committed@1` outbox;
- committed-View Automation matching and exact occurrence admission;
- Transformation and Operator contracts plus observable Execution Runs;
- Function and Agent Operator routing, atomic success or Failure View commit;
- durable III queue/cascade safety, replay, limits, and DLQ terminalization;
- View Package schemas, Representation/Materialization profiles, Renderer
  descriptors, Agent Methods, and Schema evolution edges;
- keyword, semantic, and relation-aware Search over bounded authorized scopes;
- shared in-process, CLI, HTTP, and MCP Operations;
- Application Space graph roots, Web Renderer host, and Sigma/Graphology View
  Explorer.

## What is not complete

The following are design and product gaps rather than missing low-level View
storage primitives:

- a declarative View Package contract that installs the Automations responsible
  for continuously evolving its View families;
- incremental input state: which upstream revisions have already contributed
  to one evolving output and what watermark or evidence set is frozen;
- burst behavior: process every commit, debounce, coalesce a bounded window, or
  recompute from the latest frozen set;
- output identity policy: revise one existing View identity versus create a new
  occurrence or fork for each result;
- explicit parent refresh behavior when a child View receives a new revision;
- user-facing controls for automatic, approval-required, and manual evolution;
- a complete Agent-access distribution and security vertical. The Operations
  boundary exists, but its browser/daemon access integration is still under
  root-cause review.

The existing `ViewPackageEvolution` contract only maps one declared Schema
version to another through an exact Transformation. It is not yet a general
reactive rule and must not be described as one.

## Decisions to make next

1. For one evolving logical result, does each new input revise a stable View
   identity, or does every processing occurrence create a new View that a
   separate collection/root View later groups?
2. When many upstream revisions arrive quickly, should the default be exact
   per-event processing, bounded coalescing, or latest-state recomputation?
3. Should a child revision merely emit evidence that parents may subscribe to,
   or should composition relations install an automatic parent-refresh rule?
4. Should reactive declarations live directly in a View Package as references
   to Automation Views, or should installation create ordinary Automation Views
   while the package remains a declarative template?

Until these choices are confirmed, the safe current rule is explicit
Automation plus exact revisions: no hidden recomputation and no implicit parent
mutation.

## Related decisions

- [[architecture/view-core-transformation-runtime|View Core and Transformation Runtime]]
- [[architecture/ambient-automation-runtime|Ambient Automation Runtime]]
- [[architecture/application-view-spaces|Application View Spaces]]
- [[architecture/view-search|View Search]]

---
name: vision/topic-map
title: Vision Topic Map
desc: An open multi-label index from architecture topics to the founder statements that introduced or changed them.
category: evidence-index
tags: [founder-evidence, topic-map, architecture-input]
sources: [vision/dream-log]
created: 2026-07-24T05:41:00Z
updated: 2026-07-24T17:01:16Z
---
# Vision Topic Map

This page answers: **what was each founder statement about, and where did that
idea come from?**

It indexes statements in [[vision/dream-log]]. A statement can belong to many
topics because architecture concerns overlap. Topics are added when the
conversation produces evidence for them; this is not a closed taxonomy.

## Classification rules

1. Give every new founder contribution a stable `V-###` statement ID.
2. Preserve its meaning in the Dream Log before synthesizing it elsewhere.
3. Apply all useful topics, not one mutually exclusive category.
4. Add a topic only when it improves later retrieval or comparison.
5. Treat labels as navigation, not as committed modules or package names.
6. When a statement changes an earlier idea, link both statements rather than
   silently rewriting the history.

## Topics

### Architecture method

- `architecture.method` — how the architecture discussion should proceed:
  [[vision/dream-log#v-003--classify-the-architecture-conversation|V-003]]
- `architecture.topic-classification` — organizing statements for later design:
  [[vision/dream-log#v-003--classify-the-architecture-conversation|V-003]]
- `architecture.system-shape` — identifying the major architectural
  capabilities and their boundaries:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]]
- `architecture.data-flow` — following information, decisions, actions, and
  feedback through the system:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]]
- `architecture.package-structure` — mapping capability ownership to source
  packages:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]],
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]],
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `architecture.clean-slate-v1` — allowing next-version packages and schemas to
  be rewritten from domain principles rather than preserving v0 structure:
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `architecture.layer-interface` — keeping layers independently improvable
  through small explicit contracts:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `architecture.adaptive-method` — defining Metaflow's own abstractions first
  and composing external capabilities through adapters:
  [[vision/dream-log#v-009--adaptive-abstraction-and-adapter-composition|V-009]]
- `architecture.dreaming-stage` — preserving broad desired capabilities before
  prematurely fixing implementation details:
  [[vision/dream-log#v-009--adaptive-abstraction-and-adapter-composition|V-009]]

### Core and interfaces

- `core.operation-surface` — one catalog of schema-defined domain queries and
  actions:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `interface.multi-surface` — projecting the same Operations through CLI, MCP,
  HTTP, Web, and Agent tools:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `policy.operation-gateway` — applying validation, authorization, provenance,
  and observability at the Operation boundary:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `core.action-surface` — evaluating a define-once Action abstraction as the
  concrete shape of a shared Operation Surface:
  [[vision/dream-log#v-008--evaluate-builderio-agent-native|V-008]]
- `core.schema-owned` — keeping domain Schemas under Metaflow ownership even
  when adapters expose them through external frameworks:
  [[vision/dream-log#v-009--adaptive-abstraction-and-adapter-composition|V-009]]

### Documentation

- `documentation.conversation-evidence` — preserving the founder's evolving
  ideas:
  [[vision/dream-log#v-003--classify-the-architecture-conversation|V-003]]
- `documentation.governance` — where canonical architecture knowledge lives:
  [[vision/dream-log#v-003--classify-the-architecture-conversation|V-003]]

### Capture, sources, and representation

- `capture.continuous` — ongoing screen and speech capture:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]
- `capture.raw-artifact` — original images, audio, timelines, files, and other
  materials preserved before interpretation:
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `observation.multimodal` — screen, audio, browser, editor, photo, and future
  device evidence:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]
- `representation.decode` — OCR, transcription, captions, Accessibility, and
  multimodal interpretation:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]],
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `representation.media-kind` — image, video/timeline, audio, and text as
  primary decoded representation families:
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `observation.envelope` — preserving source, time, raw artifacts, and decoded
  representations as one attributable evidence unit:
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `source.extensions-and-devices` — browser, VS Code, AI glasses, photo library,
  and future inputs:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]
- `connector.external-source` — adapting external systems into Metaflow without
  teaching Core each source protocol:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]
- `connector.unified-contract` — making all source adapters use one logical
  Observation entry boundary:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]
- `connector.delivery-mode` — push, pull/sync, local stream, federated reference,
  and manual import behind one contract:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]
- `observation.ingress` — policy-checked validation, normalization,
  deduplication, provenance, and persistence of candidate Observations:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]
- `architecture.observation` — designing the Observation capability before
  downstream Views and Agents:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]
- `observation.graph-root` — treating Observation as the immutable evidence root
  of the graph used by downstream Views:
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]]
- `observation.atomic` — defining Observation as the smallest independently
  attributable unit directly admitted from a source:
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `observation.view-boundary` — sharing graph infrastructure without sharing
  mutable lifecycle semantics:
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]],
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]],
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `representation.unified-space` — allowing source-root Observations and derived
  Views to share traversal, selection, and derivation interfaces:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `observation.raw-view` — exploring Raw View or Source View as a product-level
  interpretation of an immutable source-root Observation:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `graph.shared-substrate` — common node identity, edges, provenance, and
  traversal for Observation and View nodes:
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]]
- `source.federated` — retaining external identity and resolving full content
  lazily when copying all source data is unnecessary:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]
- `policy.connector-boundary` — enforcing source permissions, privacy, schema,
  and observable failures at the ingestion boundary:
  [[vision/dream-log#v-011--external-information-and-connector-design|V-011]]

### Context, Views, and memory

- `context.current-surface` — resolving the page, window, app, or file the user
  currently means:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `view.current-state` — fusing several source-root representations into a
  comprehensive View of the user's current state:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `context.resident` — context already present when an interaction begins:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `context.agent-selected` — additional Views chosen by an agent through
  ViewGraph search:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `context.naming` — replacing inherited Context Pack and canonical View names
  with a model that matches the new architecture:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `viewgraph.task-specific` — deriving different Views for different tasks:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]],
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `view.task-representation` — exposing a stable task-appropriate
  representation over selected source material:
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `view.selection` — including relevant Observations and Views while leaving
  unrelated evidence outside a task representation:
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `viewspec.contract` — declaring the purpose, eligible inputs, selection
  rules, schema, lifecycle, producers, storage, and policy of a View family:
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `view.reuse` — allowing agents, Workflows, and applications to share a
  representation without reconstructing it independently:
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `task.context-relevance` — treating relevance as task-dependent rather than
  sending all available context to every consumer:
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `learning.personalized` — deriving learning material from content the user
  actually watched or read:
  [[vision/dream-log#v-014--views-as-task-specific-representations|V-014]]
- `viewgraph.multimodal-input` — composing Views from images, timelines, audio,
  text, and source metadata:
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `viewgraph.cluster` — grouping related evidence into useful task-specific
  Views:
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `viewgraph.agent-search` — allowing authorized agents to search, traverse, and
  select graph content:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `viewgraph.operations` — exposing search, split, merge, fork, and related graph
  changes as shared Operations:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `data.domain-query` — querying Observations and Views without exposing raw
  storage internals:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `memory.personal` — durable understanding of the person:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]
- `memory.personal-preferences` — style, habits, and preferences useful across
  interactions:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `memory.project` — durable context around projects such as Metaflow and
  AutoResearch:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]
- `workflow.inbox` — holding uncategorized captures or candidate Views for later
  resolution:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]

### Ambient, Automation, and applications

- `ambient.proactivity` — noticing useful opportunities without an explicit
  request:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]]
- `ambient.proactive-action` — proactively preparing or completing useful work:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `automation.workflow` — user-requested or observed reusable Automations:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]],
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `automation.trigger-operation` — binding declared Triggers to Core Operations
  or Workflows:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `application.personalized` — applications built over the user's own evidence
  and Views:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]],
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]]
- `application.domain-owner` — making the Personal Application, rather than an
  Agent Runtime, the stable owner of one domain's contracts and behavior:
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]]
- `application.view-space` — storing an application's materials, strategies,
  history, tasks, feedback, and learned state as a ViewGraph subgraph:
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]],
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `application.subgraph` — organizing an Application as a traversable subgraph
  of independently addressable Views:
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `view.subview` — composing a broader View from independently identified child
  Views with their own contracts and lifecycle:
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `view.composition` — expressing part-whole structure through typed edges
  instead of nested payloads:
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `viewgraph.typed-edge` — distinguishing composition, provenance, semantic,
  lifecycle, and space-membership relationships:
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `viewgraph.multi-parent` — allowing one View to participate in several parent
  Views and Application View Spaces:
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `learning.feedback-loop` — connecting material, session, feedback, profile,
  strategy, and future plan Views as a learning cycle:
  [[vision/dream-log#v-019--application-view-spaces-are-composable-subgraphs|V-019]]
- `context.data-not-agent` — keeping durable domain context independent of the
  actor that currently processes it:
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]]
- `strategy.versioned` — separating versioned general Application logic from
  personalized strategy represented as durable Views:
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]]

### Agents and execution

- `agent.tool-discovery` — keeping a compact default tool set with searchable
  access to the wider catalog:
  [[vision/dream-log#v-008--evaluate-builderio-agent-native|V-008]]
- `agent.operation-access` — allowing authorized agents to invoke the same Core
  Operations as human-facing adapters:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]]
- `agent.data-use` — agents using clustered Views and decoded representations
  to perform meaningful work:
  [[vision/dream-log#v-010--decoded-media-primitives-and-view-clustering|V-010]]
- `iii.function-trigger` — using III Functions, Triggers, and invocation modes as
  execution infrastructure:
  [[vision/dream-log#v-006--automation-and-one-shared-operation-core|V-006]],
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `processor.runtime-neutral` — defining derivation independently of its
  execution technology:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]],
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]
- `terminology.processor` — evaluating whether Processor should remain a
  canonical term or be replaced by narrower concepts:
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]
- `view.producer` — considering a narrow role for Functions, Agents, Workflows,
  or projections that create and update Views:
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]
- `processor.implementation` — allowing multiple versioned executables to
  fulfill one stable Processor contract:
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `processor.selection` — explicitly choosing an eligible implementation from
  privacy, locality, latency, cost, quality, hardware, and availability:
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `runtime.worker` — treating a Worker as an execution host for one or more
  implementations rather than a domain capability:
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `processor.long-running-agent` — fulfilling a Processor with a durable Agent
  Session:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `agent-runtime.delegation` — selecting a capable worker for the work:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `agent-runtime.background-run` — durable, inspectable work beyond one
  interaction:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `integration.local-files` — locating and operating on files implied by the
  current app:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `policy.task-authority` — what one user command authorizes:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `agent-runtime.permission-bridge` — translating Codex, Hermes, or another
  worker's permission request into shared policy:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]]
- `agent-runtime.active-work` — active tasks and runs that remain relevant to
  the current interaction:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `agent.stable-identity` — defining the durable identity, role, state, tools,
  history, permissions, and initiative of a fixed Agent:
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]
- `agent.view-production` — allowing a persistent Agent to create and maintain
  Views without reducing that Agent to a transformation implementation:
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]
- `automation.trigger-binding` — treating Automation as the durable binding
  that starts work rather than the worker or intelligence itself:
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]
- `execution.orthogonal-model` — separating required result, responsible actor,
  and invocation condition:
  [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]],
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `derivation.open-actor` — allowing a human, Function, model, Agent, Workflow,
  external service, or future actor to derive a View:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `actor.reference` — recording a stable producer identity and execution
  evidence without owning every actor's internals:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `agent.external-runtime` — delegating Agent lifecycle and orchestration to an
  external runtime while retaining Metaflow task and provenance ownership:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `agent.multica` — treating Multica-managed Agents and teams as externally
  referenced actors rather than duplicated local Agent definitions:
  [[vision/dream-log#v-017--raw-views-open-actors-and-thin-agent-references|V-017]]
- `agent.replaceable-executor` — treating an Agent as one replaceable actor over
  Application data rather than the owner of durable domain context:
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]]
- `agent.runtime-memory` — limiting runtime-owned memory to reconstructable
  cache or session scratch state unless it is promoted into Views:
  [[vision/dream-log#v-018--application-owns-domain-context-not-agent|V-018]]

### Capture and Decode packages

- `capture.package` — owning Connector and Source Connection lifecycle,
  checkpoints, health, and source-native normalization:
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]]
- `decode.package` — the earlier separate Decode package proposal, superseded by
  the Processor-family model:
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]],
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `decode.processor-family` — modeling OCR, transcription, extraction, and
  temporal decoding as Processors that write Views:
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `processor.package` — owning all Observation/View-to-View derivation
  contracts, routing, runs, and failure evidence:
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]],
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `view.extraction` — single-source interpreted Views such as OCR and
  transcripts:
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `view.temporal` — derived key-frame, change, comparison, and timeline Views:
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]
- `viewgraph.lifecycle` — keeping merge, split, fork, promote, and retire on View
  nodes rather than source Observations:
  [[vision/dream-log#v-012--observation-roots-and-capture-package-design|V-012]],
  [[vision/dream-log#v-013--observation-atoms-and-all-derivations-as-views|V-013]]

### Authority and approval

- `policy.task-authorization` — authority created by an explicit user request:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]]
- `policy.standing-approval` — durable user rules, including explicit full
  approval:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]]
- `policy.smart-approval` — evaluating runtime permission requests against task
  authority, standing rules, and action properties:
  [[vision/dream-log#v-004--explicit-authority-and-approval-modes|V-004]]

### Interaction and attention

- `surface.current-environment` — the current screen and application context
  available when an interaction begins:
  [[vision/dream-log#v-005--runtime-neutral-processors-and-agent-chosen-context|V-005]]
- `surface.launch` — immediate command surface using current context:
  [[vision/dream-log#v-001--continuous-context-and-useful-views|V-001]],
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `surface.notch` — glanceable progress, permission, and result surface:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]
- `notification.completion` — telling the user when background work finishes:
  [[vision/dream-log#v-002--proactive-action-and-delegation|V-002]]

### Research and adoption

- `research.framework-search` — searching for an existing framework with a
  reusable unified operation contract:
  [[vision/dream-log#v-007--find-the-existing-unified-agent-framework|V-007]]
- `research.compose-not-invent` — preferring proven infrastructure when its
  boundary matches Metaflow:
  [[vision/dream-log#v-007--find-the-existing-unified-agent-framework|V-007]],
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `integration.upstream-capability` — reusing source-native or open-source
  capabilities behind Metaflow-owned contracts:
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `integration.screenpipe` — using Screenpipe capture, OCR, and transcription
  as attributable source capabilities without making it the domain owner:
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `architecture.dream-first` — defining the desired experience and stable
  contracts before choosing implementations:
  [[vision/dream-log#v-015--replaceable-decoding-implementations-and-upstream-reuse|V-015]]
- `research.reference-framework` — evaluating concrete implementations as
  architectural references:
  [[vision/dream-log#v-008--evaluate-builderio-agent-native|V-008]]
- `reference.builderio-agent-native` — BuilderIO Agent-Native evidence:
  [[vision/dream-log#v-008--evaluate-builderio-agent-native|V-008]]
- `automation.framework` — comparing framework-provided Trigger and Automation
  semantics:
  [[vision/dream-log#v-008--evaluate-builderio-agent-native|V-008]]
- `adoption.framework-boundary` — deciding whether to adopt a framework,
  integrate it as an adapter, or extract its design principles:
  [[vision/dream-log#v-008--evaluate-builderio-agent-native|V-008]],
  [[vision/dream-log#v-009--adaptive-abstraction-and-adapter-composition|V-009]]
- `adapter.composition` — using adapters to connect useful framework-native
  capabilities without surrendering Metaflow Core ownership:
  [[vision/dream-log#v-009--adaptive-abstraction-and-adapter-composition|V-009]]

## Still unclassified

Nothing yet. Ambiguous future statements should remain visible here until a
useful topic emerges; they must not be dropped or forced into an unrelated
label.

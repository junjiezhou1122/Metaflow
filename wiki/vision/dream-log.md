---
name: vision/dream-log
title: Dream Log
desc: A chronological evidence log of founder ideas, scenarios, corrections, and unresolved questions used to design the Metaflow architecture.
category: evidence
tags: [founder-evidence, architecture-input, conversation]
sources: [founder-conversation-2026-07-24]
created: 2026-07-24T03:49:25Z
updated: 2026-07-24T17:01:16Z
---
# Dream Log

This page preserves the source ideas behind the synthesized
[[vision/founder-dream]]. It is evidence, not a list of committed requirements.

Each conversation contribution receives a stable statement ID and any number of
topic labels. The labels are navigation aids defined in
[[vision/topic-map]]; they do not force a statement into one category.

## V-001 — Continuous context and useful Views

**Recorded:** 2026-07-24

**Topics:** `capture.continuous`, `observation.multimodal`,
`representation.decode`, `source.extensions-and-devices`,
`viewgraph.task-specific`, `memory.personal`, `memory.project`,
`ambient.proactivity`, `surface.launch`, `workflow.inbox`,
`application.personalized`

**Founder statement:** The founder described the desired system from capture
through useful personal applications.

The founder described a system that can record what appears on the screen and
what the user says. Future sources may include the photo library, AI glasses,
browser extensions, VS Code extensions, and other devices.

Raw inputs must become retrievable representations. Examples include OCR,
speech transcription, browser information, captions, Accessibility state, and
ordinary multimodal model interpretation.

Recording has value only when the information can later help with real work.
The same evidence may support different Views and applications:

- a watched YouTube video becomes personalized English-learning material;
- daily activity becomes a useful summary and learning recommendation;
- Twitter bookmarks become a daily digest;
- repeated PPT, document, coding, or AutoResearch work triggers background
  research or a proposed tool;
- Codex, Claude, browser, file, and project context become project memory;
- unknown captures enter an Inbox until a useful View family exists.

The founder wants a global Launch shortcut. It should answer questions about the
current screen, explain or summarize what is visible, and save an important
screen into the ViewGraph.

**Architecture signals extracted:**

- source capture and derived representations must be separate;
- the same evidence must support multiple task-specific Views;
- personal memory, project memory, and transient context are distinct concerns;
- active help can be initiated by either Ambient or Launch;
- unknown material needs an Inbox rather than forced classification.

## V-002 — Proactive action and delegation

**Recorded:** 2026-07-24

**Topics:** `ambient.proactive-action`, `automation.workflow`,
`surface.launch`, `surface.notch`, `context.current-surface`,
`agent-runtime.delegation`, `agent-runtime.background-run`,
`integration.local-files`, `notification.completion`,
`policy.task-authority`

**Founder statement:** The founder clarified that Metaflow must complete
real-world work, expose long-running progress, and learn opportunities for
Automation.

The founder clarified that Metaflow must actively help complete work, not only
record and summarize.

The user should be able to explicitly request a Workflow or Automation. The
system should also observe repeated work and proactively design useful
Automations, reminders, schedules, searches, and personalized tools.

Concrete examples:

- A mentor sends a PPT or document through WeChat. Launch should let the user
  ask Metaflow to locate the file, convert or process it, run the work, and
  report completion.
- While viewing a GitHub repository, the user should be able to ask Metaflow to
  clone it, analyze its value for another project, save the result, and notify
  the user.
- Background task state should be visible in the Notch. Results should also
  have a durable place where the user can inspect them later.

The founder emphasized that these architecture conversations are themselves
important evidence. The ideas may initially be incomplete or disorganized.
They should be recorded continuously, then synthesized into a clearer product
and architecture over time.

**Architecture signals extracted:**

- one explicit command may initiate a multi-step background run;
- execution should be delegated without making the worker the product identity;
- current screen, browser, app, and local-file context must be resolvable;
- progress, permission, failure, completion, and durable output need distinct
  representations;
- observed behavior may produce Automation proposals.

## V-003 — Classify the architecture conversation

**Recorded:** 2026-07-24

**Topics:** `documentation.governance`, `documentation.conversation-evidence`,
`architecture.topic-classification`, `architecture.method`

**Founder statement:** Install Plasma CLI and classify what every founder
statement is about so later architecture design can retrieve and compare the
relevant ideas.

**Architecture signals extracted:**

- `wiki/` is the living source of truth for the new architecture;
- conversation evidence and its synthesis must remain distinguishable;
- statements need stable identities and multi-label classification;
- the topic system must be able to grow as the architecture becomes clearer.

## V-004 — Explicit authority and approval modes

**Recorded:** 2026-07-24

**Topics:** `policy.task-authorization`, `policy.standing-approval`,
`policy.smart-approval`, `agent-runtime.permission-bridge`,
`architecture.system-shape`, `architecture.data-flow`,
`architecture.package-structure`

**Founder statement:** When the user explicitly says “help me complete this
task,” that utterance grants authority to do the task. The user should also be
able to configure a full-approval condition. A Smart Approval mechanism should
handle permission requests from worker runtimes such as Codex or Hermes. The
next architecture discussion should connect the overall system shape, data
flow, major capabilities, and package structure.

**Architecture signals extracted:**

- authority originates in explicit user intent, not in the selected Agent
  Runtime;
- a task-scoped grant and durable user approval policy are different objects;
- Smart Approval must translate runtime-specific permission requests into the
  shared policy language;
- Codex, Hermes, and future workers should not each define Metaflow's approval
  semantics;
- system boundaries, data movement, and source package ownership must be
  designed together.

## V-005 — Runtime-neutral Processors and agent-chosen context

**Recorded:** 2026-07-24

**Topics:** `processor.runtime-neutral`, `processor.long-running-agent`,
`architecture.layer-interface`, `viewgraph.agent-search`,
`context.resident`, `context.agent-selected`, `context.naming`,
`surface.current-environment`, `memory.personal-preferences`,
`agent-runtime.active-work`

**Founder statement:** The proposed diagram still crossed too many concerns and
did not show the layered interfaces clearly. A Processor may itself be carried
out by a long-running Agent rather than a one-shot function before the
ViewGraph. Agents should be able to search the ViewGraph and choose the Views
they need through an interface instead of receiving a centrally selected
Context Pack. The old Context Pack and canonical View names should be
reconsidered. When the user asks through the Notch, some context should already
be resident, including the current screen, personal style and preferences, and
currently active tasks.

**Architecture signals extracted:**

- Processor describes a derivation contract, not one runtime duration or
  implementation technology;
- each architectural layer needs a small explicit interface;
- the ViewGraph must support agent-driven search, traversal, and selective
  reading;
- system-provided context and agent-retrieved context are different;
- resident context is dynamic session state, not a universal summary;
- context usage must remain traceable even when the agent chooses what to
  retrieve;
- names inherited from the old architecture should not be treated as fixed.

## V-006 — Automation and one shared operation core

**Recorded:** 2026-07-24

**Topics:** `automation.trigger-operation`, `iii.function-trigger`,
`core.operation-surface`, `interface.multi-surface`,
`agent.operation-access`, `viewgraph.operations`,
`data.domain-query`, `policy.operation-gateway`

**Founder statement:** A continuously triggered Processor can be expressed as
an Automation using III's Trigger mechanisms, making the implementation
straightforward. Every useful backend capability should be operable through a
shared Core, including data and View queries and View operations such as split,
merge, and fork. Agents should receive the same operational access. CLI, MCP,
Web, and other external interfaces should all reuse the same Core rather than
implementing separate behavior.

**Architecture signals extracted:**

- Automation is the durable product object that binds Triggers to operations;
- III already supplies useful Function, Trigger, synchronous, fire-and-forget,
  and durable enqueue primitives;
- domain Operations must remain independent of III so the runtime can be
  replaced or executed in process;
- every human or agent-facing adapter must project the same schema-defined
  Operations;
- ViewGraph mutations and searches are first-class Operations;
- data access should be expressed through policy-aware domain queries rather
  than exposing storage internals;
- validation, authorization, provenance, errors, and observability belong at
  the Operation boundary.

## V-007 — Find the existing unified agent framework

**Recorded:** 2026-07-24

**Topics:** `research.framework-search`, `research.compose-not-invent`,
`core.operation-surface`, `interface.multi-surface`

**Founder statement:** Search for the existing Agent framework that defines a
unified interface once and makes it reusable from other parts of an
application, then use that evidence to continue the architecture discussion.

**Architecture signals extracted:**

- an existing framework may already implement the Operation projection pattern;
- Metaflow should inspect and compose proven infrastructure before building its
  own;
- candidate selection must be based on implementation boundaries rather than
  similar terminology.

## V-008 — Evaluate BuilderIO Agent-Native

**Recorded:** 2026-07-24

**Topics:** `research.reference-framework`,
`reference.builderio-agent-native`, `core.action-surface`,
`agent.tool-discovery`, `automation.framework`,
`adoption.framework-boundary`

**Founder statement:** Evaluate
[`BuilderIO/agent-native`](https://github.com/BuilderIO/agent-native) as the
possible framework remembered in V-007.

**Architecture signals extracted:**

- Agent-Native's Action abstraction directly targets the desired
  define-once/use-everywhere behavior;
- the framework must be evaluated separately as a design reference, reusable
  dependency, and possible application shell;
- its Action, Agent Runtime, Automation, approval, catalog, and Surface
  semantics should be compared against Metaflow's Observation and ViewGraph
  requirements;
- framework adoption must account for package coupling, data ownership,
  runtime replacement, maturity, and licensing.

## V-009 — Adaptive abstraction and adapter composition

**Recorded:** 2026-07-24

**Topics:** `architecture.adaptive-method`, `architecture.dreaming-stage`,
`core.schema-owned`, `adapter.composition`, `adoption.framework-boundary`,
`research.compose-not-invent`

**Founder statement:** The founder accepted an adaptive architecture method:
Metaflow should first clarify what it wants to become, then define its own
abstractions and Schemas, while using Adapters to connect useful native
capabilities from frameworks such as Agent-Native. During the dreaming stage,
the team should continue describing the broad set of desired capabilities
before prematurely fixing implementation details.

**Architecture signals extracted:**

- Metaflow should own the domain abstraction and Schema before choosing any
  framework dependency;
- external frameworks should contribute capabilities through explicit Adapters
  rather than owning the Core;
- adoption choices should be judged by fit to the desired Life OS domain, not
  only by implementation convenience;
- the current phase should preserve broad product dreams and examples as
  architecture evidence;
- references and experiments can validate abstractions without forcing the
  final package structure.

## V-010 — Decoded media primitives and View clustering

**Recorded:** 2026-07-24

**Topics:** `capture.raw-artifact`, `representation.media-kind`,
`representation.decode`, `observation.envelope`, `viewgraph.multimodal-input`,
`viewgraph.cluster`, `agent.data-use`, `automation.workflow`

**Founder statement:** The founder clarified the early data pipeline. Capture
may collect many kinds of material, then Decode turns them into a smaller set
of useful representation kinds. Screen captures may form image timelines or
short video-like sequences; individual images may be OCRed or interpreted
directly by a vision model; audio can be transcribed with relatively low loss;
and some sources already arrive as text. Different Views are then built from
these representation kinds and their capture sources. Over time, related
information should cluster into task-specific Views that agents and workflows
can use for meaningful work.

**Architecture signals extracted:**

- raw capture artifacts and decoded representations should remain distinct;
- the first stable representation families are likely image, video/timeline,
  audio, and text;
- OCR is one decode path for images, but direct multimodal interpretation must
  also be supported;
- audio transcription can become a high-value text representation while still
  linking back to the original audio;
- Views should be composed from multiple representation kinds and source types,
  not from one universal text store;
- clustering related evidence into Views is the bridge from recorded data to
  useful Agent and Workflow behavior.

## V-011 — External information and Connector design

**Recorded:** 2026-07-24

**Topics:** `connector.external-source`, `connector.unified-contract`,
`connector.delivery-mode`, `observation.ingress`, `architecture.observation`,
`source.federated`, `policy.connector-boundary`

**Founder statement:** The founder asked how many kinds of external information
can connect directly to Metaflow, what the Connector should do, and how all of
those sources should enter the Observation system through one coherent design.
The Observation layer should now be designed before moving further downstream.

**Architecture signals extracted:**

- browser extensions, local capture systems, cloud services, files, devices,
  MCP sources, and future sensors need one logical Observation entry contract;
- push, pull/sync, local stream, federated reference, and manual import are
  different delivery modes behind that contract;
- Connector code and a user's configured Source Connection are distinct;
- Connectors should normalize external identity and evidence but should not
  write Views or decide task meaning;
- privacy, schema validation, deduplication, provenance, and failure evidence
  belong at Observation Ingress;
- external information may be copied, cached, or lazily referenced according to
  source and policy rather than one universal ingestion strategy.

## V-012 — Observation roots and Capture package design

**Recorded:** 2026-07-24

**Topics:** `observation.graph-root`, `observation.view-boundary`,
`architecture.package-structure`, `capture.package`, `decode.package`,
`graph.shared-substrate`, `viewgraph.lifecycle`

**Founder statement:** The founder asked to design the package structure for
Capture and Decode before moving on to how the system deals with Observations.
The founder proposed that an Observation may be understood as a foundational
kind of View because it determines all later derivation, and asked whether the
two concepts can be combined cleanly.

**Architecture signals extracted:**

- Observation and View should participate in one traversable provenance graph;
- Observation is the immutable evidence root while View is a task-shaped,
  lifecycle-managed derived node;
- a small shared graph substrate can unify identity, edges, provenance, and
  traversal without making Observation a mutable View;
- Capture, Observation, Decode, and ViewGraph need separate package owners and
  one-way dependencies;
- Decode transforms Observation/Artifact into new provenance-linked
  Observations; semantic clustering belongs downstream in ViewGraph;
- source adapters should remain replaceable and must not bypass Observation
  Ingress or write Views directly.

## V-013 — Observation atoms and all derivations as Views

**Recorded:** 2026-07-24

**Topics:** `observation.atomic`, `view.extraction`, `view.temporal`,
`decode.processor-family`, `processor.package`, `architecture.clean-slate-v1`,
`architecture.package-structure`, `viewgraph.lifecycle`

**Founder statement:** The founder corrected the prior model: a screen timeline,
key-frame selection, and interaction/change result are Views because they are
not minimal components. Observation should be the smallest source-grounded
component. The next-version package design may be rewritten from first
principles and must not be constrained by the current code or earlier package
proposal.

**Architecture signals extracted:**

- Observation is an immutable source atom, not a generic derived graph node;
- any Metaflow-created extraction, selection, comparison, interpretation, or
  composition is a View, even when it has only one source Observation;
- OCR, transcription, key-frame selection, frame diff, and timelines are
  extraction/temporal View families;
- Decode is a family of Processors that writes Views, not a separate core data
  layer or Observation-producing package;
- the minimal next-version package owners are Observation, Capture, Processor,
  and ViewGraph;
- v0 code is migration evidence only and may be replaced when it conflicts with
  the new domain boundary.

## V-014 — Views as task-specific representations

**Recorded:** 2026-07-24

**Topics:** `view.task-representation`, `view.selection`, `viewspec.contract`,
`view.reuse`, `task.context-relevance`, `learning.personalized`

**Founder statement:** The founder clarified that Observations are raw
materials, while Views are the representations that particular tasks need.
A task should not receive every available Observation. For English learning,
English webpages, watched YouTube videos, captions, and reading behavior may be
useful material, while unrelated code and terminal activity are not. The
resulting View is important because other agents, Workflows, and applications
can reuse that task-appropriate representation.

**Architecture signals extracted:**

- Observation is source material; View is a task-shaped representation over a
  relevant subset of material;
- a View family needs a stable declared representation contract even though
  its contents evolve as new evidence arrives;
- source selection and exclusion are part of the View contract, not accidental
  behavior hidden inside one Processor implementation;
- a View should retain references to its source Observations and Artifacts
  rather than copying every source payload;
- the same Observation may contribute to several Views for different tasks;
- irrelevant Observations remain available as evidence but are not included in
  a task's active representation;
- agents, Workflows, and personal applications should consume Views instead of
  repeatedly reconstructing task relevance from the entire Observation store.

## V-015 — Replaceable decoding implementations and upstream reuse

**Recorded:** 2026-07-24

**Topics:** `processor.implementation`, `processor.selection`,
`runtime.worker`, `iii.function-trigger`, `integration.upstream-capability`,
`integration.screenpipe`, `architecture.dream-first`,
`research.compose-not-invent`

**Founder statement:** The founder emphasized that small capabilities such as
image OCR and audio transcription may have many implementations and that the
best models will change over time. Metaflow therefore needs a strong
abstraction above those implementations. A Worker-based framework can execute
the work, while existing upstream capabilities such as Screenpipe OCR or
transcription should be reused rather than unnecessarily reimplemented. The
system should begin from the desired end-to-end experience and freely compose
open-source implementations that help realize it.

**Architecture signals extracted:**

- OCR and transcription are stable Processor contracts, not model or provider
  identities;
- one Processor may have multiple versioned implementations across
  source-native output, local libraries or models, remote APIs, Workflows, and
  Agent Sessions;
- a Worker is an execution host and may register several implementations; it
  does not own the Observation or View meaning;
- III Functions, Triggers, queues, and cross-language Workers are suitable
  execution infrastructure behind Metaflow-owned contracts;
- implementation selection should consider privacy, locality, latency, cost,
  quality, hardware, and availability, and must be recorded in Processor Run
  evidence;
- failures and alternative attempts must remain explicit rather than becoming
  silent fallback;
- when Screenpipe already supplies OCR or transcription, its source assertion
  should enter through Observation Ingress and should not trigger duplicate
  decoding by default;
- Metaflow may reprocess the source Artifact when a task needs another language,
  higher quality, a local-only path, or a newer decoder;
- open-source projects should be composed behind adapters, while Metaflow owns
  the domain contracts, policy, provenance, selection, and View outputs.

## V-016 — Challenge the Processor abstraction

**Recorded:** 2026-07-25

**Topics:** `terminology.processor`, `view.producer`,
`agent.stable-identity`, `agent.view-production`,
`automation.trigger-binding`, `execution.orthogonal-model`

**Founder statement:** The founder challenged whether Processor is the right
core term. Some work needs to be handled by a specific persistent Agent rather
than an interchangeable transformation implementation, while an Automation is
comparatively simple to model. The architecture needs to explain these cases
without forcing them all into the Processor abstraction.

**Architecture signals extracted:**

- Processor currently overloads at least three concerns: what result is
  required, who or what performs the work, and when execution begins;
- a persistent Agent has identity, role, durable state, permissions, tools,
  history, and initiative, so it should not disappear as merely one Processor
  runtime kind;
- a View Producer is a possible narrower role for anything authorized to create
  or update a View, including a Function, fixed Agent, Workflow, or projection;
- Automation is a durable Trigger binding that starts an Operation, Workflow,
  Agent assignment, or View production; it is not the intelligence or
  transformation itself;
- Core Operation remains the shared callable action/query boundary and should
  not be conflated with a persistent actor;
- execution should be modeled along three orthogonal questions: what capability
  or result is required, which actor or implementation owns it, and which
  Trigger or request starts it;
- the canonical replacement for Processor must remain unresolved until it is
  tested against concrete fixed-Agent scenarios.

## V-017 — Raw Views, open actors, and thin Agent references

**Recorded:** 2026-07-25

**Topics:** `representation.unified-space`, `observation.raw-view`,
`view.current-state`, `derivation.open-actor`, `actor.reference`,
`agent.external-runtime`, `agent.multica`, `automation.trigger-binding`

**Founder statement:** The founder proposed that any Observation or View may be
processed by many different means: a person, an Agent, fixed code, a Workflow,
or another mechanism. Observation may be understood as a raw View containing a
comprehensive current state. The founder also noted that Multica may create and
manage many Agents itself, so Metaflow may need only a weaker Agent definition
rather than duplicating the external runtime's internal Agent model.

**Architecture signals extracted:**

- Observation and View should share one processable and traversable
  representation space;
- source-root and derived representations still need different provenance and
  lifecycle invariants even if the product describes both as Views;
- one source snapshot can be a raw representation of that source, while a
  comprehensive current state fused across screen, browser, audio, editor, and
  tasks is itself a derived View;
- any Observation or View may be an input to a Derivation, but a Derivation does
  not mutate its inputs and produces a new or versioned View;
- the actor performing a Derivation must remain open: human, fixed Function,
  model call, Agent, Workflow, external service, or future implementation;
- Metaflow should record an Actor Reference and execution evidence without
  requiring ownership of every actor's internal definition;
- for Multica-managed Agents, Multica may own Agent creation, roles, teams,
  prompts, memory, tools, and internal orchestration;
- Metaflow should retain its own task intent, authorization, input View
  references, run events, validated output Views, and provenance;
- Automation remains the Trigger binding that invokes an actor or capability;
  it does not define the actor.

## V-018 — Application owns domain context, not Agent

**Recorded:** 2026-07-25

**Topics:** `application.domain-owner`, `application.view-space`,
`context.data-not-agent`, `strategy.versioned`,
`agent.replaceable-executor`, `agent.runtime-memory`

**Founder statement:** The founder clarified that an English coach may be an
Agent or may be an Application, but its teaching strategy, historical tasks,
memory, and other core context must be retained independently. That context is
the domain's data and is not owned by the Agent.

**Architecture signals extracted:**

- English learning is most naturally modeled as a stable Personal Application
  whose work may be performed by an Agent, Function, Workflow, person, or a
  combination of them;
- teaching strategy, learning profile, materials, mistakes, plans, historical
  tasks, feedback, and progress belong to an Application View Space;
- a general teaching algorithm may be versioned Application logic, while its
  personalized strategy and learned adaptations are durable Views;
- an Agent is a replaceable actor over Application data, not the owner of that
  data;
- Agent or runtime memory may be used as a session scratchpad or cache, but any
  domain state that must survive actor or runtime replacement must be written
  back as a provenance-linked View;
- changing from Multica to Codex, Hermes, a Workflow, or deterministic code
  must not erase or redefine the English-learning state;
- an Application is more than a UI: it composes ViewSpecs, Operations,
  Automations, policies, and Surfaces around a stable purpose.

## V-019 — Application View Spaces are composable subgraphs

**Recorded:** 2026-07-25

**Topics:** `application.subgraph`, `view.subview`, `view.composition`,
`viewgraph.typed-edge`, `viewgraph.multi-parent`,
`learning.feedback-loop`

**Founder statement:** The founder clarified that learning feedback and the
many other independent data objects of an Application belong in its Application
View Space. Each View may itself have many child Views, creating an interesting
subgraph rather than a flat collection.

**Architecture signals extracted:**

- an Application View Space is a traversable subgraph, not a table, document,
  nested JSON payload, or isolated database;
- a SubView has independent identity, ViewSpec, provenance, privacy, lifecycle,
  and version history;
- parent and child are typed graph relationships rather than physical nesting;
- a View may participate in several parent Views and Application View Spaces,
  so the graph must support multiple parents and cross-domain reuse;
- composition, provenance, semantic reference, lifecycle, and space membership
  require distinct edge semantics;
- removing one composition or membership edge must not delete a View still
  referenced elsewhere;
- learning should form a closed graph loop in which materials and sessions
  produce feedback, feedback updates learner profile and personalized strategy,
  and those Views shape future plans and sessions.

## Unresolved

- Capture and retention policy remains undecided.
- Automatic action risk levels remain undecided.
- The exact scope and revocation semantics of full approval remain undecided.
- The canonical name and lifecycle for resident and agent-selected context
  remain undecided.
- Whether any privileged maintenance surface should expose raw storage queries
  remains undecided; the shared Operation Surface should not.
- The exact relationship between task inbox, View inbox, Kanban, background
  runs, and durable results remains undecided.
- The exact Agent-Native adapter boundary remains undecided.
- The initial eligibility and ranking policy for competing Processor
  Implementations remains undecided.
- Whether Processor should remain a narrow derivation term or be replaced by
  View Producer, Capability, or another concept remains undecided.
- The identity, state, ownership, and lifecycle that make an Agent "fixed"
  remain undecided.
- Whether Observation remains the canonical source-root term or becomes a
  subtype such as Raw View or Source View remains undecided.
- The minimum fields and discovery behavior of an external Agent Reference
  remain undecided.
- The exact boundary between versioned Application logic and personalized
  strategy Views remains undecided.
- The minimal canonical View Edge vocabulary and which edges are mutable remain
  undecided.

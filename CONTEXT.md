# Info

Info is a local-first ambient context runtime. It preserves raw evidence, derives reusable Views, and exposes those Views to agents and applications through a shared language.

## Language

**Observation**:
The product term for a Raw View: source-attributable evidence admitted from a
capture source with source, time, and policy identity. It is immutable after
admission at the revision level and may reference one or more Artifacts. A
stable source object may accumulate immutable Raw View revisions; occurrence
evidence such as a watch session or copy event receives its own View identity.
Observation and Derived View share the View interface, but source evidence
cannot be revised into an interpretation.
_Avoid_: derived interpretation, mutable source record, separate information universe

**Raw View**:
The framework role of an Observation. It is the evidence-root member of the
View model and may contain text, structured data, or references to source
media. It can be queried, revised by new source observations, and traversed
like any View while every admitted revision retains strict immutability and
attribution invariants.
_Avoid_: untrusted derived result, editable source evidence, universal current state

**Derived View**:
A task-shaped, versioned representation produced from one or more Raw or
Derived Views through View Algebra. It must retain provenance to its inputs and
may be revised without rewriting source evidence.
_Avoid_: source assertion, provenance-free summary, arbitrary cache

**Artifact**:
An immutable binary or document payload referenced by an Observation, such as
an image, audio segment, video segment, PDF, HTML snapshot, or file.
Artifacts preserve source media; they are not Views and do not need to be
copied into the Observation body.
_Avoid_: observation payload, view attachment, decoded text

**Connector**:
A replaceable adapter that knows how to authenticate with, subscribe to, poll,
or receive data from one external system and emit candidate Observations and
Artifacts. A Connector does not write Views or define Metaflow domain meaning.
_Avoid_: source account, sensor backend, processor, plugin with arbitrary access

**Source Connection**:
A configured installation of a Connector for one account, device, workspace,
vault, folder, or service endpoint. It owns credentials, cursor/checkpoint,
health, permissions, and capture policy for that installation.
_Avoid_: connector implementation, observation source type, user identity

**Connector Runtime**:
The capture coordinator that triggers configured Source Connections, invokes
Connectors, submits their candidates to Capture Ingress, and commits a source
checkpoint only after the admitted Raw View batch succeeds. Scheduling,
webhooks, retries, backpressure, health, and trace belong here; source API
translation belongs in the Connector.
_Avoid_: connector implementation, View transformation runtime, hidden retry loop

**Capture Ingress**:
The single policy-checked Core Operation that validates, normalizes, deduplicates,
and persists candidate Observations and Artifact references from Connectors,
users, agents, and imports. View Operators cannot use it to disguise derived
output as source evidence.
_Avoid_: direct store insert, connector-specific HTTP route, view operator

**Decode**:
A family of View Operators that turns Raw Views or their Artifacts into
extraction Views such as OCR text, a transcript, page structure, detected
entities, key-frame selections, diffs, or multimodal descriptions. Decode
never mutates its Raw View inputs.
_Avoid_: Observation ingestion, destructive conversion, separate data layer

**Sensor Observation**:
A normalized Observation produced from an external capture source such as Screenpipe, Chrome, editor state, Git, or AI session metadata. Agents consume sensor information through Info's normalized Observations and derived Views, not through raw sensor backends.
_Avoid_: raw Screenpipe data, sensor API result

**View Algebra**:
The closed family of Transformations from Views to Views. Split and merge may
provide stable operation shapes, while grouping, compression, diagnosis, and
future transformations remain extensible and may be created by users or AI.
It is not a fixed catalog, graph UI, or storage query language.
_Avoid_: mandatory operator vocabulary, graph renderer, separate runtime

**View Operator**:
The executable embedded in a Transformation. It may reference an Agent,
Workflow, function, model call, human, or remote service. The final Operator
reference and configuration are frozen before a Run starts.
_Avoid_: separate Worker domain, hidden runtime choice, semantic type hierarchy

**Transformation**:
A versioned declaration that turns selected input Views into output Views. It
contains an instruction and an Operator, and may contain an input selector,
trigger, policy, and budget. Its output Schema may be declared or inferred, but
the complete Schema is frozen before the revision can execute. Formation from
a Raw View and later View composition use this same concept.
_Avoid_: mutable prompt, implicit background rule, storage conversion

**Transformation Run**:
A durable execution record containing exact input revisions, Transformation
revision, frozen Operator, policy snapshot, events, attempts, outputs, timing,
costs, and errors. A changed Operator or hidden fallback is not the same Run.
_Avoid_: untracked task, overwritten attempt, provider log as source of truth

**Failure View**:
A valid View representing an unsuccessful Transformation Run and its error
evidence. It may reference an invalid candidate artifact and can be split,
grouped, diagnosed, or repaired by later Transformations without hiding the
original failure.
_Avoid_: invalid output admitted as success, swallowed exception, transient log

**View**:
A schema-bearing information representation in Metaflow. A View is either a
Raw View carrying source evidence or a Derived View shaped for a task. Every
View exposes a common identity and discovery envelope, schema, policy,
provenance, Representation, and revision semantics appropriate to its role.
Any View may be selected into, composed with, or transformed into another
View. Terms such as leaf,
collection, composite, and live are contextual descriptions rather than View
classes, and they imply no absolute abstraction hierarchy.
_Avoid_: UI page, storage row, unstructured result, universal summary

**View Representation**:
The semantic information body of one View revision. It declares a kind and may
be strict structured data, a graph, freeform Markdown, media, or an external
reference. A declared strict Schema must validate; a schema-light or freeform
Representation must say so explicitly rather than masquerade as structured
data.
_Avoid_: storage location, reconstructed index, hidden untyped payload

**View Materialization**:
A physical storage, exchange, display, or index form of one exact View
Representation, such as a Markdown file, JSON document, SQLite rows,
Graphology data, or a vector index. A discardable Materialization may be
rebuilt without creating new semantic information. OCR, summarization,
inference, or fetching content behind an external reference creates a new View
instead.
_Avoid_: semantic interpretation, View identity, mandatory storage format

**View Schema**:
The machine-readable shape and constraints a View carries inline or references
by stable name and version. It may be minimal for Markdown or an external
reference, or richer for tables and semantic graphs. A schema is part of the
View contract rather than another top-level domain object.
_Avoid_: View instance, storage schema, mandatory global registry

**View Package**:
An authored, versioned capability bundle around one or more explicitly
declared View Schema versions. It binds accepted Representations,
Materialization profiles, human Renderer descriptors, Agent Methods that point
to existing Core Operations or exact Transformations, explicit evolution
edges, fixtures, and conformance in one discoverable contract. The package
owns coherence and validation, not SQLite, UI execution, CLI/MCP transport, or
another Execution Runtime.
_Avoid_: View instance, custom database, Renderer implementation, duplicate operation runtime

**Plugin**:
An installable bundle that may contribute reusable View schemas, Operators,
Automations, renderers, migrations, and evaluations. Marketplace Plugins do
not include another user's personal View data by default. A Plugin may contain
one or more View Packages; the two terms are not competing domain models.
_Avoid_: personal data export, mandatory View wrapper, unbounded trusted code

**Personal Application**:
A stable task or domain capability that composes Views, View schemas, Core Operations,
Automations, policies, and Surfaces for one user-facing purpose. It may delegate
work to replaceable humans, Functions, Agents, Workflows, or external services.
_Avoid_: Agent, UI shell, model wrapper, isolated database

**Application View Space**:
The durable, typed ViewGraph subgraph containing a Personal Application's
materials, strategies, history, tasks, feedback, and learned state. Views may
also participate in other spaces; the space remains independent of whichever
Agent or runtime currently processes it.
_Avoid_: Agent memory, chat history, runtime state, application database

**View Edge**:
A typed relationship between Views expressing selection, composition,
provenance, reference, lifecycle, or space membership without copying either
View. Edge type determines traversal and mutation semantics.
_Avoid_: untyped link, foreign key ownership, folder path

**Provenance Summary**:
A compact description of where a View came from: producer, source record count, source view count, freshness, status, and relevant scope. It does not use confidence as an agent-facing quality signal.
_Avoid_: confidence score, trust score

**Core Operation**:
A named, schema-defined query or action over Info's domain that applies policy, provenance, validation, and stable error semantics independently of transport or actor.
_Avoid_: route handler, III Function, arbitrary backend function, raw database query

**Operation Surface**:
The stable catalog through which humans, applications, Automations, and authorized agents invoke Core Operations. CLI, HTTP, MCP, Web, and Agent tools are adapters over this same surface.
_Avoid_: Agent Surface, UI API, duplicated route logic

**Agent Tool**:
A Core Operation projected into an Agent Runtime's tool protocol. Tools do not prescribe a fixed workflow; the agent chooses which tool to call from the current task and available context.
_Avoid_: hardcoded step, wizard, UI workflow

**Agent CLI**:
A JSON-first command-line adapter for the Operation Surface with a fixed command whitelist, stable output schemas, and stable exit semantics.
_Avoid_: shell access, human-only script, arbitrary command runner

**Automation**:
A durable, policy-governed binding from a Trigger to an exact Core Operation or
Transformation revision, input mapping, Delivery request, and lifecycle
limits. A user-authored Automation is stored as an editable, versioned View;
its occurrence and target Run remain observable.
_Avoid_: View Operator, cron job, hidden background task, Agent session

**Trigger**:
A declared manual, event, schedule, or state condition that requests a Core Operation or starts an Automation.
Trigger matching is deterministic; it may observe cheap source events but does
not invoke an Agent or model to decide whether it matched.
_Avoid_: View Operator, direct function call, implicit Agent polling

**View Commit Event**:
A durable fact that one atomic commit created one or more exact Raw or Derived
View revisions. Its stable event identity may be redelivered, but its exact
View references, commit origin, and batch identity never change. It carries
discovery metadata rather than View content or access policy and may be used as
Trigger evidence only after the View commit succeeds.
_Avoid_: mutable View notification, pre-commit hook, full View payload, hidden processor call

**Ambient**:
The product behavior formed by Automations that bind current-context Views to
ordinary Core Operations or Transformations and route results to lightweight
Delivery surfaces. Ambient is not an Agent, a memory store, or a second
execution runtime.
_Avoid_: always-running LLM, notch logic, proactive Agent domain

**Delivery**:
An observable request to project progress, a result View, or a decision onto a
named Surface with declared urgency, expiry, and interaction actions. Delivery
does not choose context, an Operator, or whether an Automation should run.
_Avoid_: notification intelligence, notch policy, hidden fallback surface

**Agent-Native Authority**:
The principle that an authorized agent may use the same Info capabilities available to a human operator. The system distinguishes actors through provenance, scope, cost, reversibility, and audit records rather than by treating agents as a lower permission class.
_Avoid_: agent-only sandbox, human-only operation

**Task Authorization**:
Authority created when the user explicitly asks Info to complete a task. It covers actions reasonably required within the stated task and scope, while standing policy decides which runtime permission requests may proceed automatically.
_Avoid_: one tool approval, unrestricted consent, inferred intent

**Standing Approval Policy**:
User-controlled durable rules that pre-authorize action classes, tools, scopes, or runtimes across tasks, including an explicit full-approval mode.
_Avoid_: hidden default, agent preference, permanent consent

**Smart Approval**:
A policy decision that evaluates a runtime permission request against Task Authorization, Standing Approval Policy, action scope, risk, cost, reversibility, and provenance, then approves it or asks the user.
_Avoid_: model whim, silent consent, blanket fallback

**Permission Prompt**:
A risk, cost, and reversibility interaction strategy for actions that should be confirmed or made explicit before execution. It is not a permission boundary between human and agent actors.
_Avoid_: agent permission tier, human approval gate

**State Surface**:
An ephemeral View of what is currently in front of the user, fused from browser, editor, media, and screen observations.
_Avoid_: current page, browser context

**Work Focus Set**:
A short-lived View of active work lanes inferred from normalized evidence such as Screenpipe search results, browser activity, local project signals, Git state, and AI session metadata. It groups recent evidence into lanes such as project, topic, domain, app, or communication without replacing the underlying sensor search layer.
_Avoid_: active thread, current task

**Activity Episode**:
A short-lived View that groups continuous Observations from the same stable user context, such as an application, page, window, project, or conversation, into one user-understandable activity segment.
_Avoid_: raw log, task, daily summary, legacy episode record

**Project Current**:
A project-scoped View of current project state derived from strong, fresh, provenance-backed project lanes in a Work Focus Set. It describes the current project identity, path, repo, active files, active webpages, active agent sessions, and supporting sources without recommending next actions.
_Avoid_: project.current_context, project summary

**Dynamic View**:
A View family is not permanent just because it exists. Info can add, reshape, promote, demote, or remove Views as agents and applications discover which derived context is useful. Canonical Views are only the currently stable agent-facing contract; lower-level projections and experiments can still exist behind them.
_Avoid_: fixed memory model, hardcoded view set

**Daily Memory**:
A markdown-backed `memory.daily` View that summarizes one calendar day's work, decisions, active projects, useful context, and notable evidence. It is editable and useful as a retrieval and compression layer, not as an irreversible fact store.
_Avoid_: memory.candidate, raw daily log

**Profile Memory**:
A markdown-backed `memory.profile` View derived from daily memories and explicit feedback. It is editable and records durable user preferences, thinking style, workflow patterns, project principles, and stable context that future agents should reuse.
_Avoid_: hidden preference store, confidence-ranked profile fact

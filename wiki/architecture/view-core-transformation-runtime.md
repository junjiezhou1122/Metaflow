---
name: architecture/view-core-transformation-runtime
title: View Core and Transformation Runtime
desc: Canonical Metaflow v1 design for capture, immutable View revisions, extensible Transformations, execution traces, feedback, failures, and shared operation surfaces.
category: architecture-decision
tags: [view, transformation, operator, runtime, schema, materialization, provenance]
created: 2026-07-25T20:45:00+08:00
updated: 2026-07-26T23:30:00+08:00
---

# View Core and Transformation Runtime

> Status: canonical design baseline for the first Metaflow v1 implementation
> slice. Existing v0 code and the experimental v1 branch are evidence, not
> constraints on this target architecture.

## Goal

Build one traceable information runtime in which external evidence becomes Raw
Views, any View can be transformed into new task-shaped Views, and feedback or
failure can drive explicit evolution without rewriting history.

```text
Browser / Screenpipe / future Connectors
  -> Raw Views
  -> Transformations
  -> evolving Views
  -> Feedback or Failure Views
  -> improved Transformations and Views
```

CLI, HTTP, and MCP project the same Core operations. They do not reimplement
capture, transformation, policy, or persistence rules.

## Scope

Included in the first framework slice:

- provider-neutral Connector Runtime and Capture Ingress, verified with Browser
  and Screenpipe;
- the View envelope, schema declaration, Representation, materialization, provenance,
  relations, policy, and immutable revision model;
- Transformation, Operator, Execution Runtime, and Transformation Run;
- split, merge, trace-driven grouping, and AI-created Operators through one
  extensible contract;
- feedback-driven Transformation evolution;
- Failure Views and repair Transformations;
- View access approval profiles;
- shared CLI, HTTP, and MCP operations;
- migration boundaries from v0.

Out of scope:

- Ambient attention and proactive product decisions;
- Application Spaces;
- notch, web, and graph-explorer UI design;
- external side-effect approval beyond View access;
- marketplace distribution;
- a complete general-purpose Agent Runtime product.

## Canonical language

```text
View
  information itself: a task-shaped semantic representation

Schema
  the declared structure and interpretation rules for a View

Representation
  the semantic information body of one exact View revision

Materialization
  a physical storage, exchange, display, or index form of a View revision

Transformation
  a versioned declaration of how input Views should become output Views

Operator
  the executable inside a Transformation: Agent, Workflow, code, model,
  human, or remote service

Execution Runtime
  resolves inputs, runs the frozen Operator, validates output, records trace,
  and atomically commits success or an explicit Failure View

Transformation Run
  the durable record of one execution and all its attempts

Connector Runtime
  invokes Source Connections and advances checkpoints only after admission

Capture Ingress
  validates and atomically admits source candidates as Raw View revisions

Operation Service
  authorizes and dispatches one transport-neutral catalog over the public
  Capture, View, Transformation, Execution, Feedback, policy, and trace ports
```

There is no separate Worker domain object. An Agent, Workflow, function, or
service is represented by the Transformation's Operator reference and frozen
in the Run trace.

## View contract

Every committed View revision has a thin common envelope:

```text
identity       view id and immutable revision id
description    name and purpose
schema         freeform or strict interpretation contract
representation semantic body: data, graph, Markdown, media, or reference
materialization physical storage, exchange, display, or index form
provenance     exact input revisions, Transformation Run, source and time
policy         ownership, visibility, and View access rules
```

### View Package authoring

A View Package groups the capabilities needed to use a Schema family without
creating another View or execution universe:

```text
View Package
├── Schema versions
├── accepted Representation profiles
├── Materialization profiles
├── Renderer descriptors for humans
├── Agent Methods -> existing Operation or exact Transformation
├── explicit Schema evolution edges
└── conformance fixtures
```

`packages/view-package` owns manifest validation, exact reference checks,
catalog discovery, duplicate detection, and conformance. Declarative bundles
live under `view-packages/*`. A Renderer host, SQLite adapter, CLI/MCP surface,
or Execution Runtime remains an independent implementation behind its existing
interface. Renderer and Agent Methods therefore project the same exact View;
they do not copy or reinterpret its information in separate stores.

`Plugin` is the marketplace/distribution container and may carry one or more
View Packages. It is not a second name for the View Package contract.

Representations remain open: Markdown, JSON, table, graph, external reference,
media reference, or future forms. Schema may be explicitly freeform or strict
and machine-validatable. A strict Representation that fails its Schema is
rejected rather than silently accepted.

Representation and Materialization are distinct. Representation is what the
View means and contains. Materialization is how that exact Representation is
stored, exchanged, displayed, or indexed. A Markdown file, SQLite rows,
Graphology JSON, or vector index may be a Materialization depending on the
View contract.

OCR, transcription, summarization, inference, and semantic restructuring are
not Materializations. They create new Views through Transformations.

### Minimum implementation profile

The first executable contract uses a small envelope rather than a registry or
graph framework:

- `ViewDraft` is the validated pre-commit envelope; a committed `View` adds a
  positive numeric `revision` whose identity is the exact pair
  `{ view_id, revision }`.
- Schema explicitly selects `freeform` or `strict`. Strict Schema embeds JSON
  Schema 2020-12 and validates the semantic Representation before admission.
  A View identity keeps one Schema family. Within that revision chain, a
  `Schema name@version` is immutable; changed rules require a higher version
  rather than silently redefining that contract. A different Schema family
  forks a new View identity.
- Schema may also declare `search_projection@1`: RFC 6901-compatible JSON
  Pointers with an array-item `*`, grouped into title, text, identifier, URL,
  timestamp, and provenance categories. It
  is part of the immutable interpretation contract and changing it at the same
  Schema version is forbidden within a View revision chain.
- Representation is either inline semantic content or a complete external
  reference. A reference does not imply that Metaflow fetched or decoded it.
- Materialization is a closed primary physical manifest plus optional
  alternatives. The minimum manifest contains only format, media type,
  location, and digest; summary, OCR, transcription, and arbitrary semantic
  metadata are rejected.
- Provenance inputs, graph membership, Automation targets, trigger evidence,
  and persisted relations use exact revision references. Resolving `latest` is
  a repository query and never mutates historical references.
- Same-id evolution preserves role, purpose, and Schema family, points to the
  exact previous revision with `supersedes`, and cannot regress or redefine
  its Schema version. A changed purpose or Schema family uses a new id with
  exact `forked_from` lineage.
  Stable Raw source state may revise; a Raw occurrence cannot.

Zod validates the static TypeScript envelope. Ajv 8 executes embedded JSON
Schema 2020-12 supplied by users or AI. Graphology is reserved for future graph
materialization and UI work; View Core does not depend on it. Automation is a
real downstream consumer of this contract and reuses View Core's exact
revision reference rather than declaring a parallel identity format.

## Identity, revision, and relations

```text
same purpose or stable source object, newly observed state
  -> same view_id, new immutable revision

new purpose or direction
  -> new view_id linked by forked_from

new source occurrence such as a watch session, selection, or copy event
  -> new Raw View identity
```

Every admitted Raw View revision is immutable. A source deletion appends a
tombstone revision; it does not erase history. Privacy Forget is a separate
governed operation that reports impact and purges the source content and its
affected downstream derivations according to policy.

Privacy Forget treats a View identity as the stable semantic address behind
all of its revisions. Targeting one exact revision therefore expands the
frozen plan to every revision of that `view_id` before provenance and relation
closure is computed. This prevents a historical exact reference from being
rebound after a partial history deletion.

```text
target exact View / View identity / source identity / policy scope
  -> freeze complete identity and downstream impact
  -> require digest confirmation or declared sensitive preauthorization
  -> obtain durable receipts from every governed cleanup store
  -> atomically retire View identities and purge Core rows
  -> retain only content-free plan, receipt, replacement, and failure audit
```

A successfully purged `view_id` is permanently retired in SQLite. New commits,
View idempotency replay, and persisted Capture batch replay fail closed when
they reference it. Recapturing the same external source is allowed only under
a new View identity. Cleanup failure is durable and retryable; a Core purge
failure rolls back identity retirement, payload deletion, heads, relations,
Materializations, capture identity, and View idempotency state together.

Every persisted provenance or membership relation freezes exact View
revisions. A convenience query may resolve the latest revision, but historical
relations never drift.

A Transformation must declare the target base revision when evolving an
existing View. Atomic commit rejects stale bases. The caller must explicitly
rerun, rebase, split, or merge; last-write-wins is forbidden.

## View Store and SQLite

`packages/view` owns a storage-neutral View Store port. Its public operations
are deliberately semantic rather than SQLite-shaped:

```text
commit / commitBatch          immutable revisions with compare-and-swap
get(exact ref)                historical lookup that never drifts
getLatest / resolveLatest     explicit moving-head lookup
query                         latest or historical search
reindexSearch                 durable idempotent deterministic projection rebuild
traverseRelations             incoming/outgoing exact graph edges
getRepresentation             exact semantic body lookup
getMaterializations           physical forms for one exact revision
putDerivedMaterialization     generation-CAS rebuild without a View revision
```

Every commit requires `expected_revision`, including `0` for a new View. A
batch plans all revisions first, validates exact provenance and relation
targets against committed or same-batch revisions, then atomically writes the
revisions, heads, relations, initial Materializations, and idempotency records.
Forward references inside one batch are valid; dangling references are not.

An idempotency key is bound to a canonical request fingerprint. A retry may
carry a different attempt trace id or capture-attempt timestamp, but changing
the observed evidence, View content, identity, source, policy, or expected base
under the same key is a structured conflict. A connector-scoped capture
identity also binds each stable source object or occurrence to one View id, so
changing the idempotency key cannot create a parallel revision chain.
Cross-Connector evidence remains separate unless an explicit Transformation
relates it.

The SQLite adapter normalizes five concerns behind the port:

```text
view_revisions_v1        immutable validated envelopes
view_heads_v1            one compare-and-swap head per View identity
view_idempotency_v1      exact replay fingerprint and committed revision
view_capture_identities_v1 connector-scoped source identity to View identity
view_relations_v1        exact source and target revisions
view_materializations_v1 physical forms and generation
view_search_projection_v1 exact revision to deterministic projection state
view_search_fts_v1       SQLite FTS5 title/text/id/url/time/provenance columns
view_search_reindex_runs_v1 durable rebuild reservation, result, and failure
view_commit_outbox_v1 durable sequence, lease, ack, retry, poison, and event
view_commit_outbox_refs_v1 exact-ref index for validation and governed purge
view_store_schema_versions_v1 private, versioned adapter migration state
execution_runs_v1       frozen Run snapshot and terminal result
execution_attempts_v1   explicit linked Operator attempts
execution_trace_v1      durable append-only runtime events
```

The embedded manifest is the initial physical state of a View revision.
Rebuilding a derived index, cache, export, or display form advances only that
Materialization generation; the semantic View revision remains unchanged.
Primary and declared alternative manifest entries are immutable.

Search projection is not a semantic Materialization and never mutates a View.
On commit, deterministic code resolves only fields declared by the exact
Schema, validates their scalar category, and writes the projection metadata and
FTS row in the same transaction as the View revision. The View policy has an
independent `allow_local_search` hard constraint. Omitted legacy policy means
allowed; explicit false excludes the exact revision and strict policy
inheritance cannot turn it back on.

SQLite uses FTS5 `unicode61` tokenization and category-weighted BM25 with stable
time/id tie-breaking. It does not scan the full canonical JSON. A durable
reindex run reserves its identity first and rebuilds in a separate atomic
transaction: crash rollback preserves the prior index, same-run replay returns
the frozen report, and an explicit new run repairs missing rows. Privacy Forget
deletes projection and FTS state in the governed Core purge transaction.

This deterministic projection does not call AI and does not fetch external
media. OCR, transcription, summarization, semantic restructuring, and future
embeddings remain ordinary Transformations that produce Derived Views; those
Views may declare their own deterministic projection if they should be locally
searchable.

Durable SQLite rejects `do_not_store` and `session` retention. A future
session-scoped adapter may implement the latter; it must not be silently
persisted by the durable adapter.

The implementation uses Node 24 `node:sqlite` with WAL, foreign keys,
`BEGIN IMMEDIATE`, busy timeout, defensive runtime defaults, and prepared
statements. `better-sqlite3` and `sqlite3` were not added because both introduce
another native addon while the built-in driver already supplies the required
transaction and constraint primitives. Storage failures retain operation,
phase, transaction id, affected View ids, and native SQLite code.

Adapter migration is itself atomic and fail-fast. A legacy database has its
stored View envelopes normalized first, then heads and idempotency tables are
rebuilt with the current checks and exact-revision foreign keys. Migration runs
`foreign_key_check` before recording its private schema version. The prior
empty `Materialization.metadata` default is removed because that conversion is
lossless; non-empty legacy metadata is rejected with exact row context rather
than silently discarded. Manifest rows and replay fingerprints are regenerated
from the migrated canonical envelope, while derived Materialization generations
remain untouched. This version state belongs to the View Store adapter and does
not reuse database-global `user_version`, because the context database may
contain other package-owned schemas.

At read and migration time, primary and alternative normalized rows must match
the immutable manifest exactly. Missing, extra, role-shifted, or divergent rows
fail as corrupt data. Only rows explicitly marked `derived` may exist beyond the
manifest, and their generations remain independently compare-and-swapped.

## Reactive View commit boundary

A committed View is the only valid starting point for generic reactive work.
Capture, Execution, direct Core Operations, and migrations may all create
Views, but none may invoke Automation or an III Function inside the View Store
transaction.

`packages/view` owns one transport-neutral batch event:

```text
view.committed@1
  event_id        stable replay and downstream deduplication identity
  batch_id        one semantic commit batch
  transaction_id  physical atomic commit identity
  committed_at    timestamp after successful persistence
  origin          capture | execution | operation | migration | system + id
  views[]         exact ref + raw/derived role + Schema summary + durable retention
```

The event deliberately excludes Representation, Materialization contents,
complete policy, owner, privacy labels, credentials, and arbitrary source
metadata. Consumers resolve and authorize exact Views through normal ports;
the event is discovery evidence, not access authority.

For a durable adapter, newly created View revisions, relations, initial
Materializations, replay fingerprints, and one outbox event are persisted in
the same transaction. A rollback creates neither Views nor an event. Exact
idempotent replay returns the original commit result and does not enqueue a
second event. A mixed batch event lists only revisions newly created by that
transaction.

Publication begins only after commit. A crash before or during publication
leaves the outbox entry pending; redelivery retains the same `event_id`.
Acknowledgement changes delivery state, not the immutable event. Poison events,
retry exhaustion, and explicit replay remain observable. The storage adapter
does not call Automation or III directly: a later adapter drains committed
events into the Automation trigger boundary.

The executable port is `ViewCommittedOutbox` in `packages/view`. SQLite
implements ordered `leaseEvents`, `acknowledgeEvent`, `failEvent`,
`replayEvent`, `getEvent`, and `listEvents`; expired leases are reclaimable after
restart. `ViewCommittedOutboxDispatcher` is transport-neutral, records retry or
poison state before propagating publisher failure, and keeps one stable event id
through duplicate delivery and explicit replay. Capture and Execution supply
their semantic batch/origin context; direct commits use an explicit operation
context or the observable `system/view-repository` default.

Durable publication accepts only `normal` and `archive` retention. A
`do_not_store` candidate cannot become a committed View, and a future
session-only store must not feed the durable outbox. Privacy Forget must remove
or invalidate governed pending delivery before dispatch; a purged exact ref
must never be published as newly committed evidence.

Package ownership is therefore:

```text
view                    event Schema and publisher/consumer ports
storage adapter         atomic outbox persistence and post-commit delivery
capture / execution     commit origin; no trigger dispatch
automation adapter      event-to-TriggerSignal matching and occurrence admission
III adapter             Worker, Function, queue, retry, receipt, and DLQ transport
automation / execution  canonical policy, Run, validation, and output commit
```

III Worker and Function are runtime concepts. They never become a second
Metaflow Worker domain object and never own canonical View, Automation,
Transformation, Run, policy, or provenance state.

The v1 III binding is `packages/adapters/iii-runtime`. It exposes the same
`AutomationInvocationPort` and `OperatorExecutionPort` used by an in-process
composition, while deploying their implementations as versioned III Functions:

```text
descriptor-only Automation invocation
  -> named III queue
  -> exact Automation View resolution
  -> Automation Runtime
  -> Execution Runtime
  -> frozen Operator Function
  -> untrusted candidate
  -> Execution validation and atomic View commit
```

The queue contains exact refs and match descriptors, not View content. Function
and Agent implementations return only untrusted candidates. A Function cannot
construct a canonical output View or bypass Execution authorization,
validation, provenance, and commit. Registration fails if the pinned SDK, live
engine, named queue concurrency, or Function metadata is incompatible; there is
no in-process fallback hidden behind the III port.

### Reactive cascade safety

Every `view.committed` Automation invocation enters one durable cascade before
an Operator runs. The attempt freezes root correlation and event, parent event
and optional Run/attempt, exact View lineage, Automation and Transformation
revisions, bound Operator revision, depth, fan-out index and total, semantic
transition fingerprints, policy revision, root/attempt time, aggregate attempts
and cost, and explicit replay linkage. Sibling fan-out is reserved atomically;
mixed root facts or partial reservation fail before any Worker is invoked.

The ledger enforces depth, fan-out, total attempt, aggregate cost, elapsed time,
and exact-Operator concurrency limits. Repeated semantic transitions and exact
lineage cycles become terminal admission evidence. Committed-View Automations
may target only Transformations, so an Operation cannot turn a child result into
an untracked new cascade root. Explicit replay or repair creates a linked new
attempt and must name a real terminal parent; transport retry retains the same
attempt identity.

Admission stop and Automation context denial still cross Execution without
calling a Worker. A terminal cascade snapshot or `pre_execution_failure`
creates one frozen Run, strict Failure View, terminal trace, and transactional
`view.committed@1` event. Exact-Operator concurrency exhaustion is reported as
a typed cascade limit at Operator binding and uses that pre-execution boundary;
storage or protocol errors are not reclassified as a limit. Reserved and
running attempts retain leases. When a
running lease expires, `AutomationExecutionTarget` reconciles the original
ready/running Run and never invokes its Worker twice. If Execution has already
committed a terminal result but cascade finalization crashes, the ledger remains
recoverable; retry reads the same terminal Run and cannot rewrite success as
failure.

III owns queue retry and DLQ transport evidence, not terminal Run formation.
Reactive III startup therefore requires both a durable cascade ledger and a
`ReactiveCascadeTerminalizer`. The implementation in
`packages/adapters/automation-execution` asks Execution to reconcile an existing
Run or create a terminal one under the strictest lineage policy. III updates the
ledger only after that succeeds. A DLQ after an already committed successful Run
preserves success; a true terminal transport failure produces canonical Failure
evidence and a correlated `iii.queue.dlq_terminalized` event.

## One closed View transformation model

Observation is the Raw View role. Formation from raw evidence and later View
composition use the same closed form:

```text
View[] -> Transformation -> View[]
```

Split and merge describe operation shapes, not hard-coded semantic rules.
Cluster, summarize, repair, and future operations are ordinary
Transformations whose Operators may be added or revised by users and AI.

```text
split    one View -> many ordinary Views
merge    many Views -> one ordinary View
cluster  many Views -> many grouped ordinary Views
compress one or more Views -> a smaller ordinary View
```

Outputs retain exact input revisions, Transformation revision, Operator
snapshot, Run id, and policy. The input View is never destroyed.

A grouped View revision freezes its members. New evidence creates a new
revision rather than silently changing an old group.

In the executable v1 path, these shapes need no separate algebra AST or Core
class. Input bindings and output cardinality provide the stable structural
shape; natural-language instruction, frozen Operator, output Schema, and free
metadata provide its open semantics. The Function Operator adapter registers
exact `function_id@version` implementations. Agent and Function ports compose
under one `OperatorExecutionRouter` and return the same untrusted candidate
envelope to Execution.

## Transformation contract

```text
required
  id + immutable revision
  instruction
  frozen Operator snapshot before execution

optional before planning, frozen before execution
  explicit inputs or input selector
  output Schema
  policy
  budget
```

An Operator is a tagged executable reference:

```text
agent | workflow | function | model | human | remote_service
```

The same Operator reference may serve many Transformations with different
instructions. One logical View may be evolved by multiple Transformations.
Durable domain memory remains in Views; an external Agent session is not the
source of truth.

"Worker" does not add another contract here. It names the concrete thing that
runs an Operator: a process, person, Agent session, Workflow engine, remote
service, or III Function host. Changing the Worker may change deployment and
runtime evidence, but it does not change the frozen Operator meaning or the
`View[] -> View[]` boundary.

AI may infer inputs, output Schema, and Operator from a natural-language
request. Before a Run starts, the Runtime freezes the resolved input revisions,
Operator reference and configuration, output contract, policy snapshot, and
budget. Changing any of these produces a new Transformation revision or an
explicit new Run, never a hidden fallback.

The v1 persisted Transformation snapshot makes that boundary concrete:

```text
Transformation revision
  stable id + sequential revision + exact supersedes
  required natural-language instruction
  frozen Operator id/revision/reference/configuration/capabilities
  exact View inputs and/or versioned selector snapshots
  complete output Schema + declared/inferred origin + cardinality
  optional versioned trigger, policy, and budget snapshots
```

`inferred` describes how the output Schema was chosen; it does not permit an
unresolved output contract. Run ids, status, resolved selector results,
attempts, candidates, and results are rejected from this snapshot and belong to
Execution Runtime. Exact references have one shared wire shape,
`{ transformation_id, revision }`, used by Execution, Automation targets, and
Agent trace events.

## Execution and observability

```text
resolve and freeze inputs
  -> authorize View access
  -> create Run
  -> execute Operator and emit trace events
  -> validate candidate envelope, Schema, policy, and provenance
  -> atomically commit output revisions and relations
```

Invalid or incomplete output is not admitted as a successful View. The failed
attempt remains addressable as an artifact from a valid Failure View.

Run trace includes the selection query, candidate and selected input
revisions, Transformation revision, Operator snapshot, policy decision,
events, attempts, timing, costs, outputs, and errors.

Automation may supply trigger-time exact input bindings by role. A supplied
role is never re-resolved: each exact revision must exist and either match a
declared exact source or satisfy a frozen selector. The supplied candidates and
selected revisions are frozen and authorized as one complete set, so a browser
page observed at trigger time cannot drift to a newer matching page before
execution. Roles not supplied by the invocation retain normal selector
resolution.

All Operator kinds cross one `OperatorExecutionPort`. The canonical
`AgentOperatorExecutionBridge` adapts existing Agent runtime semantic output
into an untrusted candidate envelope; it does not validate or commit. It
projects bounded frozen input evidence (role, exact ref, Schema, inline
Representation or external reference) into Agent current context so ACP/CLI
runtimes do not require MCP merely to read the selected page. Static Operator
context can supplement but cannot replace this evidence.

`OperatorExecutionRouter` dispatches only on the frozen Operator kind and keeps
the active attempt-to-port link needed for cancellation. It has no semantic
fallback. `@info/function-operator-adapter` then resolves exact registered
Function revisions and emits start, completion, failure, and cancellation
events into the same durable trace. Adding an implementation does not change
View Core, and duplicate registrations fail immediately.

SQLite writes output Views and relations, terminal attempt and Run state, and
the terminal trace event in one transaction. Any rollback leaves no partial
output and no false success. A separate atomic failure transaction commits a
valid Failure View and terminal failure evidence.

## Feedback, failures, and repair

Feedback is a normal View that references the exact target View revision and,
when relevant, its Run. It triggers an explicit new Transformation revision or
Run and never mutates the target.

The strict Feedback Representation carries its exact target, optional Run,
actor, judgment, requested change categories, and occurrence time. Execution
validates that an optional Run actually produced the target. Applying Feedback
requires an exact base Transformation and an explicit resolution of every
requested instruction, Operator configuration, output Schema, or selection
change. The evolved Transformation adds exact `evolution_target` and
`evolution_feedback` input bindings, so its next Run and output retain lineage
to both the prior result and the judgment that changed it.

`@info/transformation` owns the `TransformationRepository` port.
`@info/transformation-sqlite` stores immutable revisions, explicit heads, and
idempotency fingerprints with atomic compare-and-swap. `@info/execution` owns
Feedback validation and construction of the next revision. Concurrent feedback
against one base therefore uses the same ordinary revision conflict as every
other Transformation evolution; both Feedback Views remain queryable even when
only one evolution wins.

Execution failure produces a valid Failure View containing the Run reference,
error evidence, candidate artifact reference, policy snapshot, and causal
links. Failure Views can be split, grouped, compared, and transformed like any
other View.

The executable contract is strict `metaflow.execution.failure@2`. Schema v2 is
used because the earlier freeform v1 contract is immutable history, not a name
that can be silently rebound. A failure freezes terminal status, exact
Transformation and attempt, full View-access policy and decision, structured
error, exact inputs, and repair ancestry. If a candidate reached validation,
Execution creates a separate Candidate Artifact View. Small JSON candidates are
inline; large candidates retain a bounded preview, byte count, and digest;
non-JSON candidates retain an explicit unavailability reason. Candidate and
Failure Views commit atomically with terminal Run evidence.

Repair is not hard-coded into Core. Repair Transformations may be created and
bound to Failure Views. A repair result creates new diagnosis, Transformation,
Run, and output Views while retaining the original failure. Runtime supplies
trace, cancellation, budgets, and cycle detection; individual Transformations
declare retry and trigger policy.

`RepairExecutionService` is a policy-enforcement and composition boundary, not
an Agent planner. It accepts a complete Transformation whose exact inputs
include the target Failure View. A versioned caller-supplied policy names
retryable and non-retryable classes, maximum causal depth, and maximum repeated
semantic fingerprint. The service commits an allowed or blocked Repair Decision
View before any Operator call. Allowed Runs freeze the exact decision, parent,
ancestor chain, depth, policy, and fingerprint; failed repair Runs extend that
chain. Repeated fingerprints, depth exhaustion, non-retryable failures, and
causal cycles stop as inspectable blocked Views.

Run idempotency is checked before selector resolution. Once a key has frozen a
Run, replay returns that terminal Run and its original exact inputs even if a
newer View now matches the selector. Reusing the key for a different declared
request fails instead of drifting or starting another attempt.

Temporal's explicit retry policy and non-retryable error boundary, and
LangGraph's observable recursion limit, inform these mechanics. Neither system
is imported as Metaflow's domain runtime: immutable Views, Transformations, and
Runs already provide the required evidence model.

## View access policy

Metaflow supports Manual, Smart Approve, and Approve All profiles. Approve All
may still carry explicit deny rules for a View, source, Schema, or Operator.
Explicit deny wins. Every Run records the policy snapshot and exact View
revisions disclosed to its Operator.

The executable contract is a typed specialization of the Transformation policy
snapshot. Its deterministic order is:

```text
exact View constraint
  -> matching explicit deny
  -> matching explicit allow
  -> profile default
```

An exact View's `allow_external_model: false` or `allow_embedding: false` is a
hard constraint and cannot be overridden by Approve All or an allow rule.
Manual requires approval for unmatched Views. Smart Approve automatically
permits non-sensitive unmatched Views and requires approval for sensitive ones.
Approve All permits unmatched Views after hard constraints and denies pass.

The decision freezes the policy and Operator revisions, usage class, exact
allowed, denied, and approval-required View revisions, matched rule provenance,
and a deterministic decision id. If any required input is denied, the overall
decision is denied; Execution may not silently submit only the allowed subset.

Failure and repair Views inherit the strictest input visibility, privacy,
retention, external-model and embedding flags. Labels are unioned. Mixed owners
fail closed until an explicit cross-owner policy decision exists.

This slice governs View access only. Filesystem, shell, browser control, and
other side effects remain outside this map.

## Package ownership

```text
packages/
  view/             View model, revisions, Schema, Materialization,
                    provenance, relations, policy, View Store port
  transformation/   Transformation and Operator contracts
  execution/        input resolution, authorization, execution, validation,
                    atomic commit, trace, Failure View formation
  automation/       editable Automation View contract, Trigger occurrence
                    runtime, target invocation, Delivery, correlation trace
  capture/          Connector port, admission, Raw View normalization
                    Source Connections, Connector Runtime, checkpoints, trace
  adapters/         workspace packages for SQLite, Browser, Screenpipe, III,
                    Agent Operators, Markdown, and future infrastructure

apps/
  cli/ server-http/ server-mcp/ web/ chrome-extension/ mac/
```

Dependencies point inward:

```text
capture -> view
transformation -> view
execution -> transformation + view
automation -> execution + transformation + view
adapters -> the ports they implement
apps -> capabilities they compose
```

Automation is intentionally separate from Transformation. Transformation
describes how exact input Views become output Views; Automation describes when
that reusable target starts, how trigger evidence maps to inputs, and where its
result is delivered. The canonical Ambient boundary is defined in
`wiki/architecture/ambient-automation-runtime.md`.

No separate Worker, View Algebra runtime, Schema registry, policy, repair, or
marketplace package is created until a real ownership boundary demands it.

## Connector evidence

### Connector Kit authoring profile

Adding a source should require one strict source payload Schema, one typed
non-secret configuration Schema, and one deterministic Adapt function. The
provider-neutral `defineConnectorKit` API validates the Connector manifest and
Source Connection, then fills the repeated connector, connection, policy, and
Capture Batch envelopes around source-authored candidate drafts.

The author still chooses every semantic boundary explicitly:

```text
stable source object  later observations revise one View identity
source occurrence     each event receives an independent View identity
direct assertion      the source observed this fact directly
source-derived        the source already inferred or summarized this value
inline payload        accepted source fields remain in Representation
external reference   large/source-owned material remains unfetched
```

Candidate policy inherits the complete Source Connection policy. An adapter
may supply a full stricter policy, but cannot change owner, weaken visibility,
privacy or retention, enable a forbidden external model or embedding, or drop
required labels. Credentials remain secret references and are rejected from
configuration, endpoints, Representation, metadata, errors, traces, and dead
letters.

The Kit verifies every candidate Schema is declared exactly by the versioned
manifest and produces an ordinary `CaptureBatch`. It does not call provider
APIs, fetch media, schedule polling, classify HTTP failures, advance a cursor,
write Views, or invoke downstream Transformations.

Every source adapter runs the shared conformance harness over malformed
payloads, deterministic repeated Adapt, expected Schema versions, lossless
source fields, multi-candidate events, and two submissions through the real
Capture Runtime that resolve to the same exact View refs.

`packages/adapters/clipboard-capture` is the minimum reference: one native
clipboard event becomes one lossless occurrence Raw View, while each file
value remains an external-reference occurrence. Browser retains Manifest V3,
DOM, tab/document identity, focus, and transport-outbox concerns. Screenpipe
retains REST authentication, health/version negotiation, pagination,
per-modality cursors, and HTTP error classification. Those source-specific
responsibilities do not move into Capture Core.

Browser Capture emits page, navigation, selection, media, and interaction facts.
Ambient decisions, writing assistance, learning inference, and browser-control
tools do not belong in the Connector.

The Chrome extension emits one strict canonical event to
`/capture/v1/browser-events`. `packages/adapters/browser-capture` maps that
event into a single push `CaptureBatch`. Its browser-safe `./wire` schema is
shared by Extension, HTTP, and adapter; the old `observation.*` intermediary is
not part of Browser Capture. Pages, caption segments, and caption state are
stable source objects with immutable revisions. Navigation, selection, copy,
heartbeat, search, play/pause, and save intent are occurrences. A manual save
atomically admits page evidence plus an independent intent occurrence and any
selection. The adapter never writes the repository directly.

The MV3 worker persists visit state in `chrome.storage.session`, uses
`chrome.alarms` for periodic work, and observes committed/history-state SPA
navigation with document/frame identity. Attention is a source fact:
`focused` means the active tab in the focused non-minimized window;
`background` and `open` are never silently promoted to watched time.
Navigation admission and DOM-ready snapshot admission have separate persisted
state. Each frame derives policy from its own URL. The serialized Extension
outbox retains exact network and HTTP 408/425/429/5xx failures without silently
evicting pending events; a successful HTTP acceptance transfers retry ownership
to `ConnectorRuntime`.

The extension retains only transport failures that did not reach the server in
`chrome.storage.local`, because Manifest V3 service workers are ephemeral. An
explicit retry resends the exact event id and evidence. After HTTP acceptance,
all retry, checkpoint, trace, health, and DLQ semantics belong to
`ConnectorRuntime`; there is no second extension-side capture runtime.

Screenpipe is an external, replaceable Connector. It must negotiate version and
capability through its supported API rather than reading internal SQLite.
Screenpipe OCR or summaries remain source-attributed assertions; they do not
masquerade as Metaflow Transformation output. Media is referenced by default.
Schema or API incompatibility fails observably.

The executable adapter is `packages/adapters/screenpipe-capture`, pinned to the
audited upstream REST contract at Screenpipe commit `4cf388b` (engine `0.4.x`,
OpenAPI `1.0.0`). `/health` has no capability list and always responds at the
HTTP layer even when its body reports `status_code: 503`; the adapter therefore
validates body health/version and probes every required endpoint with a bounded
request before capture. `/health` is auth-exempt and never receives credentials.
Protected endpoints resolve exactly one declared `SecretReference` through the
adapter's `ScreenpipeSecretResolver` just in time and send only a Bearer header.
Missing, mismatched, empty, or invalid resolution fails before protected
provider access; the value never enters URL, View, checkpoint, trace, error, or
DLQ.

Screenpipe `content_type=all` excludes Input and Memory, so it is never used as
a completeness primitive. OCR, Audio, Input, and Accessibility are pulled as
four explicit modalities with independent durable time watermarks. Every sync
uses ascending order and a bounded 60-second inclusive overlap containing exact
item identities, so boundary replay is deduplicated and live insertion cannot
shift a global offset past unseen evidence. The adapter internally scans past
overlap duplicates; scan or checkpoint capacity exhaustion fails explicitly.
All modalities are admitted in one atomic batch only after every requested page
validates. `/elements` has its own cursor. OCR uses `text_source` to preserve
accessibility-versus-OCR origin; Audio preserves `Input`/`Output` device types
and the concrete speaker object, and uses a composite segment identity rather
than `chunk_id` alone. Input uses a stable provider-row identity because
Screenpipe may asynchronously enrich its `frame_id`; frames, audio segments,
accessibility rows, and elements are stable sources that may gain immutable
revisions.

`/activity-summary` is opt-in `source_derived` Raw evidence, never a Metaflow
Operator result or capture-completeness source. Base64 frames are forbidden;
logical `screenpipe://` frame/audio references keep media external. Connector
transport and HTTP 408/503/504 remain retryable, while 400/403/404/500,
version mismatch, unknown variants, strict field drift, and pagination mismatch
fail explicitly. Connector-open failures update durable health trace even when
no batch was emitted; checkpoints advance only with an admitted batch.

The audited Screenpipe repository now uses the Screenpipe Commercial License,
not MIT. Metaflow connects to a separately user-installed official service and
does not vendor, distribute, modify, or auto-install Screenpipe. Commercial or
customer-facing integration requires license/legal confirmation. Official
binaries remain governed by Screenpipe's separate terms and subscription.

Connector access may be implemented with a native SDK, REST, filesystem, MCP,
Nango, Ampersand, or another provider adapter. These are transport and access
choices behind Metaflow's contract. Capture Connectors continuously or
incrementally admit evidence; Action Adapters perform external side effects
and remain outside this map.

Capture Ingress performs same-source idempotency but never erases evidence
because another Connector appears to describe the same entity. Cross-source
identity resolution is an explicit Transformation that creates relations.
Credentials never enter a View. Connector Runtime advances a durable
checkpoint only after the corresponding Raw View batch commits successfully.

The executable Capture path is:

```text
ConnectorPort
  -> CaptureBatch with RawViewCandidates
  -> ConnectorRuntime attempt
  -> CaptureIngress normalization and strict Schema validation
  -> one repository transaction
     [Raw View revisions + checkpoint + receipts + health + trace]
```

Push, pull, stream, reference, and manual import converge on this operation.
The Connector cursor is opaque to Core. The batch freezes both the expected
checkpoint revision and previous cursor, so stale or conflicting progress
fails instead of skipping evidence. Exact batch replay is recognized before
the stale-checkpoint check and returns its original receipts.

Pause and disabled state are checked before provider health or open. A
backpressured request that never acquired an in-flight slot records a failed
pre-attempt trace but does not enter a dead letter. Once an attempt starts,
retry is controlled by one versioned code-based policy. Terminal attempted
batches enter a sanitized, queryable dead letter and can only be replayed
explicitly. Restart recovery clears abandoned in-flight state, marks health
degraded, and appends a durable recovery event.

The design deliberately reuses established ingestion semantics without taking
their runtimes as dependencies:

- [Kafka manual offset control](https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html#manual-offset-control-heading)
  separates record processing from committing the consumed position.
- [Airbyte State and Checkpointing](https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol#state--checkpointing)
  keeps source state opaque and treats emitted destination state as evidence
  that preceding records were written.
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
  isolate exhausted work for inspection and explicit redrive.

Metaflow combines these patterns at the View boundary: admitted evidence,
checkpoint advancement, health, and terminal trace share one SQLite
transaction. There is no Kafka, Airbyte, or SQS runtime dependency.

An external reference may remain the complete and useful Representation of a
Raw View. Later fetch, OCR, transcription, or enrichment creates a new View
through a Transformation and never backfills the original Raw View revision.

## Shared operation surfaces

`packages/operations` is the only owner of the v1 operation catalog and its
structured error semantics. It sits above the domain packages and depends only
on their public ports:

```text
authenticated principal
  -> OperationService.execute(operation, input)
  -> operation authorization
  -> exact View read authorization where content is involved
  -> Capture / View / Search / Transformation / Execution ports
  -> one structured success or error envelope
  -> required operation observer event
```

The catalog covers Capture Batch admission, exact View get/search/reindex/traversal,
Transformation submit/get, Run execute/inspect/cancel, Feedback submission,
Failure inspection, frozen policy-decision lookup, and Run or Capture trace
reads. `run.execute` accepts an exact Transformation reference and loads that
committed revision; a transport cannot provide a competing definition.

`packages/adapters/operation-surfaces` contains three projections. CLI parses
argv and prints the canonical JSON envelope. HTTP maps
`POST /metaflow/v1/operations/<operation>` to the same call and derives status
only from the shared error category. MCP uses the official TypeScript SDK and
registers one tool per catalog operation. The composition root supplies the
authenticated principal out of band, so payloads cannot self-assign grants.
No surface imports SQLite or reimplements domain behavior.

Operation authorization and View content authorization are separate. A grant
permits a principal to call `view.get`, `view.search`, `view.traverse`, or
`failure.inspect`; the shared exact View authorizer still decides whether each
requested revision is readable. Owner and public reads are deterministic.
Shared non-owner reads fail closed until a versioned sharing ACL is introduced.
Search freezes this authorized scope before SQLite FTS or relation retrieval,
and the retained exact-View compatibility HTTP route delegates to `view.get`
instead of reading the repository directly.

Active cancellation is coordinated by an AbortController in the operation
service. The controller only signals Execution Runtime; Execution remains the
owner of Operator cancellation and the terminal cancelled Run, attempt,
Failure View, and durable trace. Missing and already-terminal Runs fail with
structured `run_not_found` or `run_not_active` errors.

The shared conformance suite executes the same realistic scenario through
in-process, CLI, HTTP, and a real MCP client/server in-memory transport. It
checks every catalog capability plus byte-equivalent structured success and
failure envelopes for equivalent requests.

The canonical runtime composition is now `apps/ambient-daemon`. It owns the
pure v1 Node HTTP handler, durable View and Transformation repositories,
Execution and Agent routing, Capture Runtime, Feedback and Privacy services,
and the authenticated OperationService. `pnpm dev` and `pnpm http` both start
this composition. `pnpm mf` and `pnpm mcp` project the same OperationService;
none of these commands import the archived ContextStore or legacy server.

## First acceptance slice

```text
Browser and Screenpipe evidence
  -> immutable, idempotent Raw Views
  -> natural-language Transformation
  -> function or Agent Operator
  -> validated Derived View revision
  -> Feedback View
  -> improved Transformation and View revision
  -> failure produces Failure View and traceable repair path
  -> the same operations work through CLI, HTTP, and MCP
```

The slice is complete only when its acceptance scenario passes end to end and
the compatibility path cannot become a permanent second architecture. The
post-migration workspace, commands, and temporary adapter removal conditions
are fixed in `wiki/architecture/v0-migration-inventory.md` and enforced by
`tests/v0-migration-boundaries.test.ts`.

The deterministic executable acceptance boundary is
`tests/metaflow-v1-vertical.test.ts`, run with `pnpm test:v1-vertical`. It uses
one SQLite graph to exercise Browser and Screenpipe capture, Function and Agent
Operators, exact invocation context, Feedback-driven Transformation evolution,
same-identity View revision, invalid-candidate Failure evidence, explicit
repair, approve-all with an exact deny override, and equivalent in-process,
CLI, HTTP, and official MCP SDK reads. Live source probes remain separate smoke
evidence because local Screenpipe and a loaded Chrome extension are environment
dependencies, not deterministic test fixtures.

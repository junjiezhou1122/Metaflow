---
name: architecture/reactive-view-evolution
title: III-native View Workers
desc: The canonical working model for semantic View processing, heterogeneous Representation parsers, unified Search, and reactive composition on the III Worker substrate.
category: canonical-working-decision
tags: [view, processor, worker, iii, parser, search, trigger, semantic-algebra]
sources: [architecture-discussion, mfpiccolo-agentic-backend, iii-docs, iii-workers]
created: 2026-07-27T11:56:03+08:00
updated: 2026-07-27T12:49:27+08:00
---

# III-native View Workers

> Status: accepted working direction for the next View implementation slice.
> This page defines the target model. Where the current v1 implementation still
> uses immutable View revisions and a central Execution/Automation composition,
> that difference is called out rather than silently reinterpreted.

## Decision in one sentence

    View is information.
    Processor Worker performs View[] -> View.
    Parser Worker projects one heterogeneous View for unified Search.
    Trigger decides when a Worker runs.
    III is the production execution substrate for all of them.

The backend is the composition of replaceable Workers running on III. Metaflow
does not need another large orchestration service around them.

## Scope

This design begins after source information has already become a Raw View. The
first implementation slice is deliberately limited to:

    View[] -> View semantic processing
    heterogeneous View -> Parser -> searchable fragments
    unified scoped Search over those fragments and View relations

Graph UI, marketplace distribution, broad Ambient behavior, parent refresh
policy, and general external actions are not part of this slice.

## Stable language

View
: a durable logical information space

View State
: the information and relations currently available through that View

View Change
: an append, update, removal, or recomputation affecting View State

Snapshot
: an immutable state boundary frozen only when replay or provenance requires it

Schema
: the structure and interpretation rules for a View

Representation
: how semantic information is expressed: Markdown, JSON, table, graph, image,
  database-backed records, external reference, or another form

Processor
: one semantic View[] -> View capability

Worker
: the III-native installable and replaceable unit hosting that Processor

Function
: a typed callable surface exposed by a Worker

Trigger
: an III event, schedule, queue, or explicit invocation that starts a Function

In the Metaflow product model, one independently deployable Processor is one
Processor Worker. A Worker may expose auxiliary health, capability, and
inspection Functions, but its primary semantic capability remains one clear
Processor.

A Processor Worker may be implemented by deterministic code, an Agent, a
Workflow, a model, a human task, or a remote service. This implementation
choice does not change the View[] -> View boundary.

## III-native topology

    III Engine
    |
    |-- view-store Worker
    |   |-- view::get
    |   |-- view::query
    |   |-- view::commit
    |   +-- view::changes
    |
    |-- Processor Workers
    |   |-- processor::english-learning
    |   |-- processor::summarize
    |   |-- processor::cluster
    |   |-- processor::combine
    |   +-- processor::human-review
    |
    |-- Parser Workers
    |   |-- parser::markdown
    |   |-- parser::json
    |   |-- parser::table
    |   |-- parser::graph
    |   +-- parser::external-reference
    |
    |-- search Worker
    |   |-- search::index
    |   +-- search::query
    |
    |-- llm-router Worker
    |   +-- llm::complete / llm::stream
    |
    +-- shared III Workers
        queue / state / pubsub / cron / HTTP / sandbox / observability

These are sibling Workers. A small harness may sequence calls, but it owns no
growing business logic. Approval gates, spend budgets, multi-Agent handoff, or
other capabilities become additional sibling Workers when they acquire real
logic.

III removes transport, queue, service-mesh, discovery, and observability glue.
It does not remove typed Function contracts. Production Workers still require
versioned input/output Schemas, idempotency, authorization, budget, provenance,
and observable failure.

## Processor Worker contract

The minimum semantic request is role-bound Views plus an instruction:

    type ProcessViewsInput = {
      invocation_id: string;
      inputs: Array<{
        role: "include" | "exclude" | "context" | "target";
        view: ViewRef;
      }>;
      instruction: string;
      output?: {
        view?: ViewRef;
        schema?: SchemaRef;
        representation_kind?: string;
      };
    };

    type ProcessViewsOutput = {
      candidate: ViewCandidate;
      evidence: ProcessorEvidence;
    };

The Processor returns an untrusted candidate. Only view::commit validates and
persists View State, provenance, policy, and idempotency. Processor Workers do
not write the View database directly.

Manual, event-driven, and scheduled work call the same Function:

    person or Agent -> iii.trigger(processor Function)
    View Change     -> III Trigger -> processor Function
    cron            -> III Trigger -> processor Function

There is no separate manual processing runtime and automatic processing
runtime.

## Semantic View algebra

The algebra is semantic, not an in-memory set implementation:

    English Learning View
      = YouTube View
      + English Web Page View
      - Mastered Vocabulary View

The executable request is:

    iii.trigger("processor::english-learning", {
      invocation_id: "learning:2026-07-27",
      inputs: [
        { role: "include", view: { view_id: "youtube:123" } },
        { role: "include", view: { view_id: "webpage:456" } },
        { role: "exclude", view: { view_id: "vocabulary:mastered" } },
      ],
      instruction: "Create today's English learning material",
      output: {
        view: { view_id: "learning:today" },
        representation_kind: "markdown",
      },
    });

An Agent interprets what inclusion and exclusion mean for this task. It may
select useful expressions from the video and page, remove mastered vocabulary,
and form examples, exercises, or explanations. Metaflow does not implement plus
and minus as a closed mathematical engine.

Combine, split, filter, compress, summarize, cluster, compare, and revise are
reusable Processor names or instructions, not mandatory Core opcodes.

## Recursive View composition

A View may contain or reference many Views, and any child may itself compose
other Views. The same View may participate in several parents:

    YouTube View
      |-- included by English Learning View
      |-- included by Research View
      +-- included by This Week's Browsing View

This is a graph, not exclusive object nesting. Composition, evidence lineage,
semantic reference, and membership remain distinguishable relations.

Adding information changes View State. It does not automatically mean a new
business version. The target identity model is:

    ViewRef         { view_id }
    ViewChangeRef   { view_id, change_id }
    ViewSnapshotRef { view_id, as_of_commit }
    SchemaRef       { schema_id, version }

The current v1 code instead uses { view_id, revision } as the universal exact
reference. Migrating that contract requires a separate explicit design and
must not be smuggled into the Processor/Parser slice.

## Parser Workers

Representations remain heterogeneous. Unified Search is achieved by compatible
Parser Workers, not by forcing every View into one document format:

    Markdown View ---------> parser::markdown ---------+
    JSON View -------------> parser::json -------------|
    Table View ------------> parser::table ------------|
    Graph View ------------> parser::graph ------------+-> ViewFragment[]
    Database-backed View --> parser::database ----------|
    Image View ------------> parser::image ------------|
    External Reference ----> parser::external-reference+

The minimum normalized unit is:

    type ViewFragment = {
      view: ViewRef;
      location: string;
      kind: "text" | "field" | "entity" | "relation" | "reference";
      value: unknown;
      searchable_text?: string;
      metadata?: Record<string, unknown>;
    };

The fragment retains its owning View and internal location. Search results can
therefore return a View, a location inside that View, or a relation path without
pretending every paragraph or database row is a separate View.

A Parser performs bounded structural projection for retrieval. Fetching an
external resource, OCR, transcription, semantic summarization, or inference may
require a Processor Worker and produce another View rather than becoming a
hidden Search side effect.

## Unified Search Worker

    search(query, scope, target, modes)
      -> resolve authorized Views
      -> select compatible Parser Workers
      -> obtain or reuse ViewFragment projections
      -> keyword / vector / relation retrieval
      -> deterministic fusion or explicit reranking
      -> View refs + locations + paths + evidence

Scope may be one View, several Views, an Application Space, a bounded
relation-derived subgraph, or all authorized Views. Target may include the
View envelope, internal fragments, direct children, or descendants. Modes may
request keyword, semantic, structured, relation, or hybrid retrieval.

Search is read-only. Missing Parser, embedding, or reranker capability is an
explicit outcome; it never silently substitutes a weaker mode.

The implemented structured suite resolves this without query-time parsing:

    content.json.document@1 -------> parser.json@1@1
    content.table@1 ---------------> parser.table@1@1
    content.property_graph@1 ------> parser.graph@1@1
    content.external_reference@1 --> parser.external-reference@1@1
                                      |
                                      v
                         metaflow.view.fragment-set@2

Each Parser is an ordinary exact Function Operator Transformation. Execution
freezes the source, limits, output Schema, policy, and budget, then validates
and commits the untrusted fragment candidate. Search sees only that committed
projection. An internal-only query over a scope with no committed internal
projection returns `parser_capability_missing`.

The transferable open-source pattern is:

    Unstructured       Parser implementations for heterogeneous content
    LlamaIndex         Reader / Node Parser -> normalized retrieval units
    RAGFlow and Khoj   parser-specific ingestion -> hybrid retrieval
    III                Worker / Function / Trigger production substrate
    Metaflow           semantic View[] -> View and View provenance model

Metaflow should reuse focused parsers and proven indexing libraries where they
fit, not import another project's complete memory or Agent ontology.

## View Package

A View Package declares how one View family participates in this Worker system:

    View Package
    |-- Schemas
    |-- accepted Representations
    |-- Parser Worker references
    |-- Processor Worker references
    |-- Trigger templates
    |-- Search projection rules
    |-- human Renderer references
    +-- Agent Methods

Installing a package answers:

    What kind of View is this?
    Which Workers can parse it?
    Which Processor Workers can form or update it?
    Which Changes may trigger those Processors?
    How can people and Agents retrieve it?

The package remains declarative. III Workers own execution; the View Store owns
admission; Search owns retrieval; Renderer hosts own presentation.

## Production invariants

- Worker Functions use strict versioned input and output Schemas.
- Processor outputs are candidates; only view::commit admits information.
- Workers never read or write another Worker's database directly.
- Every invocation carries a stable idempotency identity.
- Inputs, Processor version, policy, budget, output, and failure are observable.
- Queue retry retains the same invocation; an alternative is an explicit linked
  attempt.
- Unknown Worker, Function, Parser, Schema, or capability fails immediately.
- Trigger and scheduled execution call the same Processor Function as manual
  invocation.
- Search never performs hidden semantic processing or hidden fallbacks.

## Current implementation versus target

Already reusable:

- View Schema, Representation, Materialization, policy, provenance, and storage;
- Function and Agent processing adapters;
- III Function, queue, retry, DLQ, and observability integration;
- keyword, vector, and relation-aware Search;
- View Package declarations and conformance;
- CLI, HTTP, MCP, Renderer, Application Space, and Graph Explorer surfaces.

Implemented in the accepted Parser/Search slice:

- exact View Package descriptors for Markdown, JSON, table, graph, and
  external-reference Representations;
- deterministic bounded Parser Workers behind Function Operator and Execution;
- strict location-aware fragment-set Derived Views committed before Search;
- internal Search for one projection View, selected projection Views, and an
  incoming `derived_from` bounded subgraph;
- explicit unsupported Representation, missing Materialization, malformed
  result, implementation crash, timeout, cancellation, and missing capability
  behavior.

Still required beyond this slice:

- make Processor Worker the simple public View[] -> View authoring boundary;
- move from III-as-one-runtime-adapter toward discoverable sibling Workers;
- build one deterministic and one live Agent vertical for semantic
  include/exclude processing;
- add future PDF/image/audio parsers only behind explicit materialization,
  policy, provenance, and budget contracts.

## First acceptance scenario

    YouTube material View
    + English Web Page View
    - Mastered Vocabulary View
        -> processor::english-learning
        -> English Learning View
        -> parser selected by its Representation
        -> unified keyword / semantic / relation Search
        -> exact result usable by Agent CLI/MCP

The deterministic test uses a fixed semantic Processor fixture. A separate live
smoke may use llm-router, but model nondeterminism is not the acceptance oracle.

## Sources

- [Production-ready Agentic Backend Architecture](https://x.com/mfpiccolo/status/2064358779940995141)
- [III documentation](https://iii.dev/docs)
- [III Engine](https://github.com/iii-hq/iii)
- [III Workers](https://github.com/iii-hq/workers)
- [[architecture/view-search|View Search]]
- [[architecture/application-view-spaces|Application View Spaces]]

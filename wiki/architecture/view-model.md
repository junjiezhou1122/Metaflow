---
name: architecture/view-model
title: View Model and View Algebra
desc: The current canonical working model for Raw Views, Derived Views, schemas, representations, and View Algebra.
category: architecture-decision
tags: [view, observation, raw-view, view-algebra, schema, representation, provenance]
sources: [vision/dream-log, architecture-discussion]
created: 2026-07-25T00:00:00+08:00
updated: 2026-07-25T00:00:00+08:00
---

# View Model and View Algebra

> Status: superseded by
> [[architecture/view-core-transformation-runtime|View Core and Transformation
> Runtime]]. This page remains discussion history and must not be used as the
> implementation contract where its terminology differs.

## One information model

Metaflow treats every admitted or derived information representation as a
View:

```text
External world
    -> Capture
Raw View (Observation)
    -> View Algebra
Derived View
    -> View Algebra
Derived View
```

`Observation` remains the product term for source evidence. In the framework
model it is the `Raw View` role, not a separate information universe.

`Raw` and `Derived` describe provenance roles, not different View classes.
Source-attributable evidence remains immutable; a derived interpretation may
never be presented as a source assertion or rewrite its evidence.

## Views form one recursive universe

A resource does not require a parallel `Item` or `Resource` domain object. A
URL, clipboard copy, screenshot, file reference, Markdown note, or any existing
View may be selected as an element in another View. Algebra can form a new View
from any set of Views:

```text
View[] -> View
```

There are no `Leaf View`, `Composite View`, `Collection View`, or `Live View`
domain classes. These words may describe what a View is doing in one local
context, but every View can be composed, selected, transformed, and used as an
element of another View.

```text
View A is an element of View B
View B is transformed into View C
View C is later an element of View D
```

This does not establish an absolute hierarchy. Abstraction and composition
depth are task-relative: a weekly summary may compress many video Views and
later appear as one ordinary element inside a project-planning View.

Examples of the same recursive model:

```text
YouTube URL View
    may be used directly or selected into many other Views

Watched Videos View
    selects many video Views

Daily Summary View
    represents a compression of the Views it used

Current Surface View
    selects the screen, window, browser, Accessibility, and active-task Views
    relevant at a particular moment
```

A View may participate in any number of other Views. Relations form a graph,
not exclusive tree ownership or nested copying. `includes` and `derived_from`
remain different relations: one records selection or membership, while the
other records evidence lineage.

## One View envelope, many representations

Every View has a small common envelope for identity, naming, discovery,
policy, lineage, and lifecycle. Its information body is a Representation, and
Representations are intentionally heterogeneous:

```text
View envelope
|- stable id
|- type and schema version
|- human name and aliases
|- Raw or Derived role
|- time, policy, provenance and revision
`- Representation
   |- external reference
   |- Markdown
   |- JSON/document
   |- table
   |- graph/subgraph
   |- media or Artifact reference
   `- future representation
```

Every View participates as a node in the global ViewGraph. Opening that node
may reveal a simple reference, a document, or an internal semantic subgraph.
The global graph model therefore does not force every View body into a
node-and-edge payload.

When a View uses an internal semantic graph, its schema defines the vocabulary
needed for its task:

```text
Schema: learning.english.material@1

Nodes: Material, Expression, Topic, Practice
Edges: contains, about, practiced_in, derived_from
```

The schema may be a shared, versioned schema reference or an inline schema for
a personal View. A concrete View records at least:

```text
identity + schema reference or inline schema
representation kind and representation reference/body
source/provenance references
policy
revision/history
```

Graph-specific node and edge schemas are required only for graph
Representations.

## Representation is not storage format

The semantic representation answers how a View understands its subject.
SQLite, Markdown, JSON, a vector index, and Graphology answer how a revision is
stored, exchanged, searched, or displayed.

One logical View revision may therefore have one primary Representation and
several derived materializations:

```text
Logical View revision
|- database materialization
|- Markdown materialization
|- JSON projection
|- vector/search index
`- Graphology UI projection
```

Every materialization must identify the logical View revision and schema it
represents. Storage selection is behind a View Store port; View Algebra does
not depend on a specific database or file format.

## Representation is task-defined, not a maturity ladder

There is no universal rule that a reference-only View is temporary,
incomplete, or waiting to be promoted. An external reference may be the final
and permanently useful Representation for one purpose:

```text
View id + name + URL + page/platform metadata + observed time + policy
Representation kind: external reference
```

Another View may store copied clipboard text inline. Another may store
Markdown, a table, a graph, or retained media. None is intrinsically more
complete than another; each preserves the information its purpose requires.

Reference-only capture still has an explicit trade-off: an external page may
later change or disappear. That trade-off belongs to the View's schema and its
user's policy, not to a global promotion ladder.

## Adaptation uses the same small concepts

A View carries or references its schema; Operators describe transformations;
Automations decide when they run. A user may describe a need in one sentence
and ask an Agent to create or reuse those pieces.

```text
View       information + identity + schema + Representation
Operator   View[] -> View
Automation Trigger -> Operator or Algebra expression
Plugin     installable bundle of reusable schemas and behavior
```

Examples include a URL-only browser resource View, a clipboard-copy View, a
daily Markdown View, or a personal learning graph. Shared schemas remain
optional: a personal View may begin with a small inline schema and later adopt
a reusable schema without inventing another top-level domain object.

A marketplace distributes Plugins containing reusable schemas, Operators,
Automations, renderers, migrations, and evaluations. Personal View data is not
included by default.

## One View Algebra

The former distinction between Formation and Algebra is not a top-level domain
boundary. Since an Observation is a Raw View, both are instances of the same
closed operation:

```text
View Operator: View[] -> View
```

This covers structural and semantic operations, including:

```text
select, combine, compress, expand, group
relate, compare, subtract, infer, verify, revise
```

`compress` is a normal unary operator. Its result remains a View with schema,
provenance, and links to the information it preserved or summarized.

View Algebra is the formal, AI-readable language for declaring what
information transformation should happen. It is not the implementation:

```text
View Algebra expression
    -> Operator Runtime
       |- fixed code
       |- model call
       |- Agent
       |- Workflow
       |- remote service
       `- human
    -> new View + provenance + execution trace
```

An AI may compose existing operators or create a new Operator implementation
using an Agent, generated code, or a Workflow. The new implementation must
still satisfy the declared input/output schemas, policy, provenance, and
failure semantics.

## Boundaries retained

- Capture admits source material as Raw Views; it does not create semantic
  interpretations.
- OCR, transcription, summarization, clustering, and inference are View
  Operators, regardless of whether a source or Metaflow executes them.
- UI rendering projects an existing View; it is not View Algebra.
- Graphology and Sigma.js may support UI projection, but they are not the
  persistent semantic model.
- Operator errors and alternative attempts are explicit run evidence; the
  runtime does not hide fallbacks.

## Still open

- the first stable View Algebra vocabulary beyond the initial typed expression;
- View revision and materialization consistency rules;
- capability/package owners and dependency direction.

## Canonical v1 foundation

The active workspace and default entrypoints now select the v1 capability owners;
v0 sources remain only as migration evidence outside the workspace:

- `packages/view` owns the common envelope, open Representation, policy,
  provenance, links, revisioned repository port, Algebra expression, and
  Operator contract;
- `packages/capture` owns provider-neutral Connector, Capture Runtime, candidate,
  checkpoint, trace, and ingress contracts;
- `packages/adapters/storage-sqlite` implements the ViewRepository port with
  revision conflict checks and ingress idempotency;
- `POST /capture/v1/browser-events` is the canonical Browser HTTP Capture
  surface, while other transports share the `capture.ingest` operation;
- `packages/adapters/browser-capture` translates strict Browser events into
  provider-neutral capture candidates before the shared Capture Runtime admits
  immutable Raw View revisions.

Raw View capture granularity is source- and schema-specific. External media is
referenced by default, and a schema/policy may explicitly retain more.

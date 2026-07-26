---
name: architecture/view-search
title: Recursive View Search
desc: A design draft for searching View envelopes, heterogeneous Representations, and relation-derived subgraphs through one policy-governed interface.
category: architecture-design
tags: [view, search, retrieval, parser, vector, graph, provenance]
sources: [architecture-discussion, research/view-search-landscape]
created: 2026-07-26T14:57:38Z
updated: 2026-07-27T04:00:00Z
---

# Recursive View Search

> Status: the issue 66 keyword + relation vertical is implemented in
> `packages/search` and `packages/adapters/storage-sqlite`. The deterministic
> `search_projection@1` contract in [[architecture/view-core-transformation-runtime|View
> Core and Transformation Runtime]] remains the indexing authority. Semantic
> retrieval remains unavailable until the separately gated pinned sqlite-vec
> work is accepted; it has no fallback.

## Decision summary

Metaflow searches one recursive View universe. It does not require every
Representation to become the same document shape.

```text
View
|- envelope: identity, name, Schema, policy, provenance, exact revision
|- heterogeneous Representation
`- exact relations to sources, children, parents, and derived Views
```

One search request has four independent parts:

```text
Search(query, scope, target, modes)
```

- `query` expresses text, structured constraints, or both.
- `scope` says where the search is allowed to look.
- `target` says which parts of those Views are searchable.
- `modes` say how matches are produced and ranked.

The result is always evidence, not anonymous text: exact View references,
match locations, relation paths, scores, and a bounded explanation.

## Accepted v1 boundary

`packages/search` now owns strict Search request/result/cursor/error/observer
contracts and `SearchService`. The service batch-authorizes exact View refs
before a retriever sees them, freezes exact/bounded-subgraph/bounded-all-visible
scope, executes requested modes without substitution, fuses one-based ranks
with weighted `rrf@1`, and validates opaque cursor fingerprints against both
the frozen scope and strategy.

Every scope-source and retriever response is validated as untrusted data before
it can influence a result. Relation edges must match the requested frontier,
direction, and relation-type allowlist. Retriever paths must equal the
canonical path frozen during scope resolution; match locations must honor the
frozen target flags. Related-View evidence and semantic evidence must reference
an exact View already in the frozen authorized scope, and only semantic mode
may provide semantic evidence. A future semantic materialization preflight may
expand that scope only by explicitly authorizing and freezing its evidence
before retrieval.

`packages/adapters/storage-sqlite` remains the only index and relation owner.
Its aggregate FTS row preserves cross-field AND matching and category-weighted
BM25 candidate order. A private per-scalar FTS unit table retains declaration
ordinal, expanded JSON Pointer, category, normalized value digest, and a
bounded snippet. Both projections commit, reindex, migrate, and purge through
the same SQLite transaction as their exact View revision. Bounded breadth-first
scope traversal reads relation layers from that same connection; denied nodes
are discarded before they can count toward limits, become paths, or expand the
frontier.

The issue branch deliberately does not own public integration files. The
integration owner must register `packages/search` in the workspace and package
boundary catalogs, inject `SearchService` into Operations, replace the legacy
`ViewRepository.query()` implementation of `view.search`, add authorized
`view.search.reindex`, and register the four-surface vertical in the root test
catalog. Until that wiring lands, the older public `view.search` operation is
not evidence of this contract.

## Scope: where to search

The caller may scope a query to:

- one exact View revision;
- several exact View revisions;
- an Application Space;
- a relation-derived subgraph rooted at one or more exact Views;
- all Views visible to the authorized principal.

`all_visible` is finite by contract. `max_nodes` bounds authorized exact Views
that may enter the frozen scope, while the separate `max_scan` bounds every
exact ref enumerated from storage, including denied refs. Each ordered page is
also checked against the exact limit requested from the port. Reaching the scan
cap while another page exists, or returning an oversized page, fails the scope;
the service never keeps scanning denied pages indefinitely.

`latest` is resolved explicitly before the query is frozen. Historical exact
references never drift during retrieval.

Example:

```text
search "英语学习"
scope = descendants of exact English Learning Space revision
```

This must not return a private coding View outside that subgraph merely because
its text has a high vector similarity.

## Target: what within the scope to search

Search may target independently:

- View envelopes, such as name, Schema, source, time, or provenance;
- fields or fragments inside a View's Representation;
- direct child Views;
- recursively related descendant Views;
- every eligible target above.

Searching a View and searching inside it are different operations. "Inside"
also has two meanings that must remain visible:

```text
internal Representation location
or
related child / descendant View
```

A Markdown paragraph may remain an internal match location. It becomes its own
child View only when it needs independent identity, provenance, relations,
evolution, policy, or reuse. Search must not explode every paragraph into a
View just to return a result.

## Modes: how to match

The first unified contract should be able to request one or more modes:

- deterministic keyword or full-text search;
- semantic or vector similarity;
- metadata and time constraints;
- relation or path traversal;
- a hybrid that fuses several modes and optionally reranks them.

These modes are peers behind one Search port. Vector search does not replace
keyword search, exact identity lookup, or graph traversal.

```text
search("英语学习", scope, target, [keyword, semantic, relation])
    -> execute eligible retrievers
    -> merge and deduplicate exact matches
    -> rank with visible component scores
    -> return exact refs, locations, paths, and evidence
```

Callers may request flat results or results grouped by the View that owns the
matched Representation or child View.

## Heterogeneous Representations

Different View forms need different compatible Parser or Operator
implementations:

```text
Markdown View      -> Markdown parser
PDF reference View -> PDF extraction Operator
Image View         -> OCR or vision Operator
Audio View         -> transcription Operator
Graph View         -> graph projection / traversal
Structured View    -> Schema-declared field projection
```

The relationship is many-to-many:

- one parser may support several Representation kinds;
- one Representation may have several alternative parsers or Operators;
- compatibility is declared and versioned rather than inferred from a file
  extension alone.

Parsing that changes or interprets information is not a hidden search side
effect. Fetching an external reference, OCR, transcription, summarization,
semantic restructuring, and embedding are explicit Transformations. They
produce Derived Views with exact provenance. Those results may then expose
their own searchable projections.

## Indexes are materializations, not truth

The canonical truth remains the exact View revision. Search infrastructure may
maintain several replaceable projections:

```text
exact View revisions
|- deterministic Schema-declared search documents
|- local keyword / FTS index
|- optional embedding index
`- relation index over exact View refs
```

Every index row maps back to an exact View revision and enough location data to
explain the match. Indexes may be rebuilt without changing View identity.

The existing `search_projection@1` path remains deliberately narrow:

- the immutable Schema declares eligible scalar fields;
- deterministic code projects only those fields;
- the FTS row commits or rolls back with the View revision;
- no AI, OCR, transcription, external fetch, or embedding happens during the
  projection.

Future semantic retrieval should add an explicit, policy-governed
materialization path. It must not redefine `search_projection@1`.

## Policy and failure behavior

Search applies access policy before retrieval and before returning evidence.
At minimum:

- `allow_local_search=false` excludes the exact revision from local indexes;
- `allow_embedding=false` forbids embedding generation and vector indexing;
- a relation traversal cannot cross into an unauthorized View;
- scope-source relation edges cannot change the requested frontier direction or
  relation-type allowlist;
- mixed authorized and denied content must not leak through snippets, scores,
  paths, or aggregate counts;
- retriever locations, paths, related refs, and semantic evidence must match
  the frozen target and authorized scope before fusion;
- forgotten or tombstoned content is removed according to the canonical View
  Store transaction rules.

Search is read-only. It never silently downloads a page, invokes OCR, calls a
model, or creates a Derived View. If a requested mode lacks a compatible and
already available projection, the result must explicitly report the skipped
mode and reason or fail according to the operation contract. It must not
pretend that the View contained no matching information.

## Result shape

A future transport-neutral result should contain enough structure for humans,
Agents, and Graph UI without exposing a storage engine:

```text
SearchResult
|- exact View ref
|- owning View ref, when the match is nested
|- internal location or matched child View ref
|- matched Schema and Representation kind
|- component scores: keyword, semantic, relation, recency
|- relation path from the scoped root, when applicable
|- bounded snippet or structured evidence
`- explanation of why it matched
```

Graph UI consumes these results and ordinary View graph queries. It does not
read a vector database directly. Sigma.js or Graphology may render and
manipulate a client-side graph projection, but neither owns View semantics,
authorization, retrieval, or persistence.

## Package direction

The implemented deterministic projection remains in `packages/view` because
it is part of View commit and repository consistency.

`packages/search` is the accepted owner for:

- the unified Search request and result contracts;
- scope and target resolution over exact authorized refs;
- Retriever, fusion, and reranker ports;
- observable partial-mode and unsupported-Representation outcomes.

Concrete parser, embedding, and vector implementations belong in independent
`packages/adapters/*` packages or SQLite-owned internal projections when they
must share the canonical transaction. The accepted vertical validates keyword,
relation, authorization, location, Forget, reindex, reopen, and cursor behavior.
It does not claim that the sqlite-vec adoption gate has passed.

## First vertical slice

Use a concrete English-learning query to prove the abstraction:

```text
1. Capture exact Browser page and YouTube Views.
2. Run explicit Transformations for any summary, transcript, or embedding.
3. Search within an exact English Learning Application Space revision.
4. Match View names, internal Markdown fields, and related child Views.
5. Fuse keyword and semantic matches without leaving the authorized subgraph.
6. Return exact refs, internal locations, paths, and score components.
7. Open the result as a focused View subgraph in Graph UI.
```

The slice is incomplete if it returns only detached text chunks, silently
materializes missing content, loses exact revision provenance, or bypasses View
policy.

## Open questions

- Which relation types define recursive containment for each Schema rather
  than merely semantic adjacency?
- Should hybrid score fusion be fixed deterministic code or a versioned
  strategy selected by the request?
- Which semantic index can preserve local-first deletion, policy, and durable
  rebuild guarantees?
- When should an internal match be promoted to a reusable child View, and who
  requests that Transformation?

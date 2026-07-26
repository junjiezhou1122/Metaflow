---
name: research/v1-next-search-implementation
title: Metaflow v1-next Search Implementation
desc: Search-before-building evaluation and the smallest reusable implementation plan for scoped exact-reference keyword, semantic, and relation retrieval.
category: framework-evaluation
tags: [view, search, sqlite, fts5, vector, graph, parsing, reranking, provenance]
sources: [source-inspection, github, project-documentation]
created: 2026-07-27T00:00:00+08:00
updated: 2026-07-27T00:00:00+08:00
---

# Metaflow v1-next Search Implementation

> Status: implementation recommendation, not an accepted package boundary.
> This document preserves `search_projection@1` and the current View Store as
> authority. It does not authorize a second document, graph, or vector truth.

## Executive decision

Build a small transport-neutral `packages/search` coordinator and extend the
existing SQLite owner with three narrow retrieval ports. Reuse SQLite FTS5,
bounded relation queries, and a pinned `sqlite-vec` extension; implement deterministic
weighted reciprocal-rank fusion locally. Do not adopt RAGFlow, LlamaIndex,
Khoj, GraphRAG, LanceDB, Orama, or Graphology as the Metaflow search runtime.

The first slice should contain:

```text
authorized exact scope
    -> location-preserving FTS5 candidates
    -> optional pre-existing embedding candidates through sqlite-vec
    -> exact relation paths from recursive SQLite traversal
    -> deterministic weighted RRF
    -> exact View refs + locations + paths + component evidence
```

Heterogeneous parsing is not a search side effect. A parser is an Operator
implementation that turns an exact source View into an extracted Derived View.
Unstructured is the leading optional implementation for file formats, behind a
strict adapter and a versioned parsing profile. It is not a dependency of
`packages/search`, and it is not needed to prove the first search vertical.

Use no learned reranker in the first slice. RRF is small, deterministic, and
does not require normalizing incomparable BM25 and vector-distance scales. Add
a reranker port only after retrieval quality fixtures show a concrete deficit.

## Current implementation and the actual gap

The implemented front half is already stronger than most RAG libraries:

- `packages/view/search.ts` projects only Schema-declared scalar fields, rejects
  invalid category values, excludes tombstones and `allow_local_search=false`,
  and binds the projection digest to the immutable declaration and exact View.
- `packages/adapters/storage-sqlite` commits projection metadata and one FTS5
  row with the View revision, uses `unicode61`, category-weighted BM25, stable
  tie-breaking, durable idempotent reindex, and governed Privacy Forget purge.
- `ViewQuery` supports Schema, role, exact time basis, latest/all revisions,
  text, and a bounded limit. `ViewRepository.query()` remains storage-neutral.
- exact relations are durable, but `traverseRelations()` is one hop only.
- `packages/operations` exposes `view.search` and `view.traverse` through the
  same transport-neutral catalog, but `view.search` currently delegates
  directly to `ViewRepository.query()` and returns `View[]`.

That surface cannot yet implement the canonical search draft:

| Required behavior | Current behavior | Consequence |
| --- | --- | --- |
| authorized exact scope | repository query has no principal or per-View read decision | operation grant alone cannot prevent cross-space or cross-owner retrieval |
| internal match location | one aggregated FTS row per View | result cannot identify the declared field or expanded array element that matched |
| exact evidence result | returns whole `View[]` | no bounded snippet, owning ref, path, component score, or mode outcome |
| recursive subgraph scope | one-hop relation query | Application Space search cannot be frozen before retrieval |
| semantic retrieval | no vector projection | no hybrid retrieval, model identity, dimension check, or semantic deletion proof |
| explicit mode failure | only keyword exists | a future adapter could be tempted to hide an unavailable vector/model path |
| public reindex operation | repository method only | no common authorized CLI/HTTP/MCP maintenance surface |

Do not expand `ViewQuery` until it becomes a second search language. Keep it as
the low-level deterministic View Store query used by the keyword adapter. The
public `view.search` operation should accept the unified Search contract and
return evidence results.

## External implementation evidence

### Comparison

Repository state and release metadata were checked on 2026-07-27. Commit links
pin the inspected behavior; release dates indicate activity, not quality.

| Project | Inspected mechanism | License | Maintenance signal | Metaflow/platform fit | Decision |
| --- | --- | --- | --- | --- | --- |
| [RAGFlow](https://github.com/infiniflow/ragflow/tree/53e83dcadfef7b88c56648049c9966b5046cd06a) | format-aware ingestion, text+dense retrieval, weighted fusion, model reranking, graph retrieval | Apache-2.0 | v0.26.4 on 2026-07-07; inspected head 2026-07-26 | large Python/Go platform with Elasticsearch/Infinity-style stores; its graph search and reranker silently fall back to text-only/token-only paths | reference algorithms and tests only; reject runtime and fallback semantics |
| [Unstructured](https://github.com/Unstructured-IO/unstructured/tree/d309caf8ee20b735eb105d4e16ac3f04e5a48172) | MIME-routed partitioners emit common Elements for PDF, Office, HTML, images, and text | Apache-2.0 | 0.24.1 on 2026-07-11; inspected head 2026-07-15 | proven Python parser stack, but PDF/image strategies bring native tools, OCR/model dependencies, and some automatic strategy fallback | optional external Operator adapter with an exact profile; never a search dependency |
| [LlamaIndex](https://github.com/run-llama/llama_index/tree/199e9b5b130bbde72639358a08935b913e7132c0) | Reader -> Document -> Node -> Retriever pipeline, recursive retriever, RRF and relative-score fusion | MIT | v0.14.23 on 2026-06-24; inspected head 2026-07-24 | mature Python abstractions, but `Document`, `Node`, `IndexNode`, and query engines duplicate View identity and runtime ownership | copy the RRF idea, not code or object model |
| [Khoj](https://github.com/khoj-ai/khoj/tree/1e30154d1070c7b132f389638c008b490be1481b) | source-specific Markdown/PDF/DOCX/Notion/GitHub entry processors, bi-encoder retrieval, CrossEncoder reranking | AGPL-3.0 | beta 2.0.0-beta.28 on 2026-03-26; inspected head 2026-06-24 | strong local personal-search product evidence; Python stack and AGPL are poor direct-dependency fit | behavior reference only; no code reuse without a separate license decision |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag/tree/14a00ad88fc33cf2b52f4f113f25807556f8e25e) | entity entry points, entity-to-text/report/edge expansion, global community reports, DRIFT | MIT | v3.1.1 on 2026-07-18 | strong proof for graph-assisted retrieval and source breadcrumbs; indexing creates a separate AI-derived graph and reports, with graph extraction estimated by its docs at about 75% of indexing cost | later explicit Transformations only; reject as primary graph/search store |
| [sqlite-vec](https://github.com/asg017/sqlite-vec/tree/04d28bd21773981e2d266bbf6aa4efbd011eb4f6) | `vec0` KNN virtual table, cosine/L2, metadata filters, deletes, WAL tests, Node `node:sqlite` loader | MIT or Apache-2.0 | v0.1.9 on 2026-03-31; inspected pre-v1 head 2026-05-17 | same SQLite file and Node 24 runtime as Metaflow; no server or second cleanup store; extension and Node bindings remain pre-v1 | best narrow candidate, gated by a pinned-version spike and startup verification |
| [LanceDB](https://github.com/lancedb/lancedb/tree/f655f62e0938395ab54caaa722addcb5351eb8fe) | local vector, FTS, SQL filtering, TypeScript, RRF/custom rerankers, delete and optimize | Apache-2.0 | v0.32.0-beta.3 on 2026-07-24; inspected head 2026-07-25 | capable and maintained, but adds Lance/Arrow storage, native bindings, version cleanup, and a second transactional/deletion domain | reject for v1-next; reconsider only after SQLite scale evidence fails |
| [Orama](https://github.com/oramasearch/orama/tree/b030e1bd1d330327bad1483f2d9c88a9ea0d493c) | TypeScript BM25, vector/hybrid search, filters, save/load | Apache-2.0 in `LICENSE.md` | v3.1.18 on 2025-12-19; inspected head 2026-07-03 | excellent browser/ephemeral index, but serialized in-memory state would duplicate durable SQLite truth and governed transaction behavior | UI-side small-corpus candidate only; reject as canonical adapter |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3/tree/ab6232e7105810a865de20ce47340f78072fe0b6) | synchronous transactions, extensions, WAL, workers | MIT | v13.0.1 on 2026-07-21; inspected head 2026-07-23 | proven Node extension host, but Metaflow already uses Node 24 `node:sqlite`, including manual transactions | do not add a second SQLite binding just for vectors |
| [Graphology](https://github.com/graphology/graphology/tree/b6e4b31ac0d68aaff36600c19faa0c751db6d015) | typed in-memory graph, BFS/DFS/shortest paths, Sigma.js data backend | MIT | v0.26.0 on 2025-02-08; inspected head 2026-07-21 | excellent Graph UI projection; not durable, transactional, policy-aware, or exact-revision storage | keep for UI only; use bounded SQLite relation queries for canonical scope |

### What is worth reusing

RAGFlow proves the conventional two-stage shape: fetch a wider hybrid candidate
set, then rerank a bounded window. It also demonstrates why Metaflow must state
failure semantics in the contract. Its inspected graph retrieval returns
text-only expressions when embedding fails, and its model reranker logs an
error and falls back to token similarity. Both are explicitly forbidden here.

LlamaIndex's `QueryFusionRetriever` contains four strategies. Its RRF path uses
the standard `1 / (rank + 60)` contribution and deduplicates by node hash. This
is the only mechanism needed initially. Relative-score fusion is less suitable:
it normalizes each candidate list using its observed min/max, so adding a weak
outlier can change every fused score and pagination boundary.

Khoj validates a later two-stage local reranker: inexpensive embedding retrieval
followed by a CrossEncoder over a small result set. It does not justify taking
Khoj's entry identity or AGPL implementation into Metaflow.

GraphRAG's useful mechanism is entity-based entry followed by relation and
source-text expansion. Its local search preserves associations from entities
to text units, community reports, and edges. In Metaflow, those associations
must be ordinary exact View relations and paths. Entity extraction, graph
summaries, and community reports are Derived Views produced by Transformations,
not hidden index state.

`sqlite-vec` is a plausible narrow dependency because:

- it loads into Node >=23.5 `node:sqlite`; Metaflow currently runs Node 24;
- its pure-C extension supports macOS, Linux, Windows, and WASM;
- `vec0` can prefilter KNN by metadata or partition keys;
- upstream tests cover row deletion, reinsertion, WAL snapshot behavior, and
  page reclamation after `VACUUM`;
- the vector row can live in the same transaction and Privacy Forget boundary
  as the exact View and FTS rows.

The caveat is material: the project is pre-v1, the current head is an alpha,
and its documentation says language bindings are outside its semantic-version
guarantee. Pin an exact stable package and extension version. On startup,
verify `vec_version()`, the compiled SQLite ABI, dimensions, distance metric,
and required virtual-table features. A mismatch must fail before serving
semantic search.

## Smallest package design

```text
packages/search
|- strict Search request/result contracts
|- SearchService orchestration
|- scope, keyword, semantic, query-embedding, and reranker ports
|- deterministic rrf@1 fusion and cursor fingerprinting
`- observer events and typed errors

packages/adapters/storage-sqlite
|- remains sole owner of View, relation, FTS, and vector index rows
|- implements location keyword retrieval
|- implements recursive exact-relation scope resolution
|- optionally loads pinned sqlite-vec and implements semantic retrieval
`- extends governed purge and durable reindex in the same database

packages/adapters/unstructured-parser       (later, optional)
`- exact external-reference View -> extracted Derived View candidate

packages/operations
`- projects view.search and view.search.reindex to SearchService
```

`packages/search` may depend on `packages/view` for exact refs and envelopes.
It must not import SQLite, Unstructured, LlamaIndex, Graphology, embedding SDKs,
or a transport. `storage-sqlite` may implement search ports because the
dependency direction is `storage-sqlite -> search -> view`, and it already owns
the atomic tables and purge transaction.

Do not create `packages/adapters/search-sqlite` with a second connection and a
parallel lifecycle. That would obscure who must delete vectors during Forget
and who owns index migrations. If the SQLite adapter becomes too large, split
internal files under the same package before splitting ownership.

## Contracts

The following is a behavioral sketch, not final Zod syntax.

### Request

```ts
type SearchRequestV1 = {
  contract_version: 1;
  query: { text: string };
  scope:
    | { kind: "exact_views"; refs: ExactViewRef[] }
    | {
        kind: "subgraph";
        roots: ExactViewRef[];
        direction: "incoming" | "outgoing" | "both";
        relation_types: string[];
        max_depth: number;
        max_nodes: number;
      }
    | { kind: "all_visible"; max_nodes: number; max_scan: number };
  target: {
    envelope: boolean;
    internal: boolean;
    related_views: boolean;
  };
  modes: Array<"keyword" | "semantic" | "relation">;
  semantic?: {
    embedding_profile: { id: string; revision: number };
  };
  fusion: {
    strategy: "rrf@1";
    k: 60;
    weights: Partial<Record<"keyword" | "semantic" | "relation", number>>;
  };
  reranker?: {
    descriptor: { id: string; revision: number };
    candidate_limit: number;
  };
  failure_mode: "require_all" | "allow_explicit_partial";
  page: { limit: number; cursor?: string };
};
```

Rules:

- Arrays are non-empty, unique, and bounded. `max_depth`, `max_nodes`,
  `max_scan`, candidate counts, snippet bytes, and total execution time have
  hard maxima. For `all_visible`, `max_nodes` bounds authorized output while
  `max_scan` bounds every enumerated ref, including denied refs.
- `latest` is not a scope value. A caller resolves it before submitting the
  request so the request and cursor fingerprint contain only exact refs.
- `semantic` requires one exact embedding profile. Document vectors indexed
  under another model, revision, dimension, or distance metric are ineligible.
- Query embedding is an explicit local `QueryEmbeddingPort` call caused by the
  requested semantic mode. The descriptor, duration, and failure are observed;
  the ephemeral query vector is not persisted or logged.
- `failure_mode` defaults to `require_all`. Under explicit partial mode, every
  skipped mode appears in the response with a typed reason. A mode never turns
  into another mode after failure.
- A requested reranker failure fails the operation. It never returns RRF output
  while claiming reranking succeeded.

### Result

```ts
type SearchHitV1 = {
  ref: ExactViewRef;
  owner_ref: ExactViewRef;
  matched_schema: { name: string; version: number };
  representation_kind: string;
  matches: Array<{
    location:
      | { kind: "envelope"; path: string }
      | { kind: "representation"; path: string; element_id?: string; page?: number }
      | { kind: "related_view"; ref: ExactViewRef };
    snippet?: string;
    value_digest: string;
    modes: Array<"keyword" | "semantic" | "relation">;
    semantic_evidence_ref?: ExactViewRef;
  }>;
  path?: Array<{ relation_id: string; type: string; from: ExactViewRef; to: ExactViewRef }>;
  scores: {
    keyword_rank?: number;
    semantic_rank?: number;
    relation_rank?: number;
    fused: number;
    reranker?: number;
  };
  explanation: Array<"keyword" | "semantic" | "relation" | "reranked">;
};

type SearchResponseV1 = {
  contract_version: 1;
  scope_fingerprint: string;
  strategy_fingerprint: string;
  modes: Array<{
    mode: "keyword" | "semantic" | "relation";
    status: "executed" | "unavailable" | "forbidden";
    candidate_count?: number;
    code?: string;
  }>;
  hits: SearchHitV1[];
  next_cursor?: string;
};
```

The cursor freezes the scope, query digest, mode descriptors, fusion strategy,
and final stable sort tuple. It contains no query text, snippet, vector, policy,
or secret. A cursor reused with a changed request fails.

### Ports

```ts
interface SearchScopeResolver {
  resolve(request: ExactSearchScope, principal: SearchPrincipal): Promise<FrozenSearchScope>;
}

interface KeywordRetriever {
  retrieve(input: ScopedTextQuery): Promise<RankedSearchCandidate[]>;
}

interface SemanticRetriever {
  retrieve(input: ScopedVectorQuery): Promise<RankedSearchCandidate[]>;
}

interface QueryEmbeddingPort {
  embed(input: { text: string; profile: ExactEmbeddingProfileRef }): Promise<QueryVector>;
}

interface SearchReranker {
  rerank(input: AuthorizedRerankInput): Promise<RerankedCandidate[]>;
}

interface SearchObserver {
  record(event: SearchTraceEvent, cause?: unknown): Promise<void>;
}
```

Scope authorization must happen before a retriever computes candidates. Do not
retrieve globally and filter later: result counts, ranks, snippets, distances,
and paths would leak denied content. Intermediate nodes in a returned path must
also be authorized; otherwise the path is unavailable, not partially redacted.
Scope-source edges must match the exact requested frontier, direction, and
relation type. Retriever paths must equal the frozen canonical path, locations
must honor the frozen target, and related or semantic evidence refs must already
be part of the authorized scope. Semantic evidence is valid only from semantic
mode; there is no post-retrieval repair or filtering.

The existing Execution `ViewAccessAuthorizer` is Operator-use specific and
freezes an Operator and policy snapshot. Do not call it with fake Operator
values. Define a deterministic batch read-authorization port for Search, then
share lower-level policy evaluation only after both use cases prove the same
contract.

## SQLite projection and retrieval

### Location-preserving keyword index

Do not redefine `Schema.search_projection@1`. Change only the private index
implementation so the projector also emits one bounded unit for every resolved
scalar:

```text
SearchUnit
|- exact owner View ref
|- declaration ordinal and category
|- expanded JSON Pointer (no remaining `*`)
|- normalized text
`- value digest
```

Keep the current aggregate `ViewSearchDocument` and digest for compatibility.
Keep its one-FTS-row-per-View candidate query as well: an AND query may match
one token in the title and another in body text, so replacing it with only
per-unit rows would regress cross-field matching. Add a location table plus a
second FTS table with one row per unit, for example:

```text
view_search_units_v2
  search_unit_id, view_id, revision, ordinal, category,
  expanded_path, value_digest, indexed_at

view_search_unit_fts_v2
  title, text, identifiers, urls, timestamps, provenance
```

The existing aggregate FTS table decides whether the View matches and retains
its category-weighted BM25 rank. Only after candidate refs are scope-authorized,
the unit table locates the contributing declared values with an OR of the
already compiled tokens. This preserves cross-field AND semantics and can
return several `matches` for one exact View. Only the unit's category column is
populated. Bounded snippets are derived from the authorized normalized unit;
FTS auxiliary functions must not expose undeclared View JSON.

### Exact subgraph scope

Use a deterministic, layered breadth-first traversal over batched SQLite
queries to `view_relations_v1`:

1. Seed exact authorized roots.
2. Fetch one layer for the authorized frontier, following only requested
   directions and relation types.
3. Batch-authorize newly discovered exact refs before adding, counting, or
   expanding them. A denied node cannot affect limits, paths, or result counts.
4. Track exact refs and relation ids in the path; reject repeated refs to stop
   cycles rather than relying only on depth.
5. Stop at `max_depth` and fail if the authorized set would exceed `max_nodes`.
   Truncation is not a valid frozen scope.
6. Materialize the frozen authorized ref set for both FTS and vector queries.

A recursive CTE is a valid later optimization only if it joins a previously
materialized exact authorized-ref set. It must not traverse the whole graph,
hit a limit because of denied nodes, and filter policy afterward.

The relation contribution in the first slice is scope-root proximity, not an
AI knowledge-graph score. Rank eligible hits by minimum path depth with stable
exact-ref/path tie-breaking and feed that ranked list into RRF.

### Semantic evidence

Honor the current canonical rule: embedding generation is an ordinary
Transformation. A committed embedding is a strict Derived View whose content
freezes:

```text
target exact View ref + target location
+ normalized source digest
+ embedding profile id/revision
+ provider/model identity and dimension
+ distance metric
+ vector or governed external vector reference
+ exact derivation provenance and policy
```

The SQLite vector index projects only eligible committed embedding Views. A
semantic hit returns the target View/location and the exact embedding Derived
View as `semantic_evidence_ref`. Search never generates missing document
embeddings, OCR, transcript, summary, or graph structure.

Use an ordinary mapping table as authority and `vec0` only for KNN:

```text
view_search_vectors_v1
  vector_rowid, embedding_view_id, embedding_revision,
  target_view_id, target_revision, target_path,
  profile_id, profile_revision, dimension, source_digest

view_search_vec0_v1
  rowid, profile_partition_key, embedding float[N]
```

If multiple dimensions are supported, use separate versioned `vec0` tables per
profile/dimension rather than a loosely typed mixed table. Profile partitions
must have enough rows to avoid the over-sharding warned about by sqlite-vec;
for small local collections, separate tables are simpler.

### Fusion and reranking

For each mode, sort with that retriever's deterministic ordering, group match
locations under the exact target View ref, and assign one-based View rank. Fuse
the exact View refs with:

```text
fused(hit) = sum(weight(mode) / (k + rank(mode, hit)))
k = 60 for rrf@1
```

Final tie-breakers are `fused desc`, minimum relation depth, exact
`view_id asc`, `revision desc`, and path. Locations inside a hit sort by kind,
path, and value digest. Store the weights and
`k` in the strategy fingerprint. Do not fuse raw BM25, cosine, or future
reranker scores directly.

A later reranker receives only bounded, already authorized snippets and exact
candidate ids. Its output must be a complete permutation with a score for each
candidate, validated against the input ids. Model identity, duration, and
failure are observable. Start with an interface, not a dependency on Khoj,
sentence-transformers, or `@huggingface/transformers`.

## Parsing boundary

The optional Unstructured adapter should be an `Operator` implementation with
this shape:

```text
exact external-reference View
    -> fetch/decode under an explicit Transformation and policy
    -> fixed ParserDescriptor
    -> untrusted Elements
    -> strict extracted-document candidate
    -> Execution validation and Derived View commit
```

`ParserDescriptor` freezes library version, supported media type, exact parser,
strategy, OCR languages/model, table behavior, timeout, resource limits, and
output Schema. Do not call Unstructured's `partition(..., strategy="auto")` in
the durable path. Select a fixed format-specific partitioner and strategy. If
the library substitutes another strategy, requires an undeclared download, or
cannot meet the profile, the Operator attempt fails visibly.

The extracted View keeps element ids, types, text, page/coordinates when
available, source digest, and exact source provenance. Its Schema declares the
element text and title fields through `search_projection@1`. Unstructured
Elements never become Core identity objects. A paragraph becomes its own child
View only when independent reuse, policy, provenance, relations, or evolution
requires it.

For the first search vertical, use existing Browser/Markdown/transcript Views.
That proves the search contract without making a Python parser service a hidden
prerequisite. Add one pinned PDF fixture as a later adapter conformance test.

## Deletion, reindex, and observability

### Commit and deletion invariants

- Deterministic FTS units commit or roll back with their exact View revision.
- A vector row commits only with its exact embedding Derived View and mapping.
- `allow_local_search=false` excludes FTS and vector targets.
- `allow_embedding=false` prevents the embedding Transformation before vector
  state exists; policy inheritance cannot re-enable it.
- a tombstone excludes that revision; historical revisions remain searchable
  only when explicitly requested and authorized until Privacy Forget.
- Privacy Forget deletes affected FTS units, vector mappings, and `vec0` rows in
  the existing Core purge transaction before content can be returned again.
- a purged/retired exact ref cannot be resurrected by index replay or rebuild.

Do not introduce best-effort cleanup receipts for a second vector database.
The main reason to prefer sqlite-vec over LanceDB is that one SQLite transaction
can prove absence across View payload, relation, FTS, and vector state.

### Durable reindex

Extend the current run-id/fingerprint protocol rather than replacing it:

```text
reserve run -> validate configured index implementations
            -> rebuild keyword locations from exact Views
            -> rebuild vector mappings from exact embedding Views
            -> verify counts, dimensions, refs, policy, and orphan absence
            -> commit one report or roll back all rebuilt state
```

Reindex never recomputes embeddings. Missing semantic evidence is reported as
`missing_materialization`, not repaired by a hidden model call. Exact replay of
a succeeded run returns the frozen report; a changed request under the same id
fails; a failed run requires a new id. Include per-mode scanned/indexed/
excluded/unchanged/removed/orphan counts, versions, duration, and the first
bounded failures in the report.

Expose an authorized `view.search.reindex` operation through the same service
and CLI/HTTP/MCP envelopes. It calls the search maintenance port; transports do
not import SQLite.

### Search trace

Required observer stages are:

```text
search.started
scope.resolved | scope.failed
mode.started / mode.succeeded / mode.unavailable / mode.failed
fusion.succeeded | fusion.failed
rerank.started / rerank.succeeded / rerank.failed
search.succeeded | search.failed
```

Record request id, principal id, scope/strategy fingerprints, exact descriptor
refs, bounded counts, durations, and typed error codes. Do not log query text,
vectors, snippets, full paths through denied nodes, View content, or secrets.

## Focused tests

### Contract and service

1. Strictly reject unknown fields, empty/duplicate modes, raw `latest`, invalid
   bounds, semantic without a profile, cursor/request mismatch, and unbounded
   all-visible requests.
2. Prove `require_all` fails on an unavailable semantic adapter and explicit
   partial mode returns an `unavailable` mode record without changing rankings
   to claim semantic success.
3. Prove `rrf@1` against fixed keyword/vector/relation lists, duplicate exact
   locations, missing modes, weights, ties, and cursor continuation.
4. Make a requested reranker error fail the operation; never return the RRF
   order under a reranked response.
5. Assert observer start/terminal pairing and distinct scope, retrieval, fusion,
   rerank, authorization, and storage error codes.

### SQLite keyword and scope

1. One View with two declared array elements returns two exact expanded JSON
   Pointer locations; an undeclared sibling cannot appear in snippets.
2. Preserve current title/text/id/url/time/provenance weighting, tokenizer,
   exact revision, latest/all, policy exclusion, and stable ordering tests.
3. Resolve incoming/outgoing/both subgraphs with an edge allowlist, cycles,
   multiple roots, multiple shortest paths, exact historical refs, max depth,
   and max-node overflow.
4. Put a denied View on the shortest path and prove no hit, path, count, or rank
   leaks it. Prove a high-scoring View outside the Application Space is absent.
5. Inject projection, relation-query, and transaction failures and prove prior searchable
   state plus terminal error evidence remain intact.

### SQLite vector

1. At startup, reject a missing extension, wrong `vec_version()`, unsupported
   SQLite ABI, wrong dimension, distance mismatch, and unrecognized profile.
2. Query a fixed tiny vector fixture and prove prefiltered exact scope, profile,
   target location, distance order, and exact embedding evidence refs.
3. Delete, replace, rollback, reopen, WAL-read, and reindex rows. Confirm a
   rolled-back embedding commit leaves no mapping or `vec0` row.
4. Privacy Forget an owning View and prove its FTS units, embedding Derived
   Views, mappings, vectors, paths, and cursors fail closed in one transaction.
5. Corrupt a mapping and orphan a vector row; reindex must report and remove the
   orphan without invoking an embedder.

### Parser adapter, later

1. Use pinned PDF, DOCX, PPTX, HTML, and image fixtures to prove deterministic
   element order, source-field retention, page/location mapping, and output
   Schema conformance for each exact descriptor.
2. Missing native dependency, undeclared strategy substitution, protected PDF,
   timeout, oversized document, OCR model mismatch, and malformed Element must
   fail the Operator attempt without an alternate parser.
3. Exact replay returns the original derived output; changing parser version or
   profile under the same idempotency key fails.

## Required vertical test

Add one deterministic `tests/metaflow-v1-next-search-vertical.test.ts` and a
`pnpm test:v1-next-search` command only when implementation begins. The test
must use one SQLite graph and cross the real in-process, CLI, HTTP, and MCP
`view.search` operation.

```text
1. Commit an English Learning Application Space root.
2. Capture a Browser page View and a YouTube source View.
3. Commit an explicitly transformed transcript/Markdown Derived View with two
   searchable internal locations.
4. Commit one strict embedding Derived View for a transcript location using a
   deterministic fixture embedder, then index it through sqlite-vec.
5. Relate the exact revisions into the Application Space; add a private,
   unauthorized, higher-scoring View outside the scope.
6. Search the exact subgraph with keyword + semantic + relation modes.
7. Assert identical exact refs, locations, path relation ids, component ranks,
   RRF score/order, mode status, and cursor behavior on all four surfaces.
8. Prove the outside and denied Views affect neither results nor counts.
9. Privacy Forget the transcript source and prove the governed closure removes
   its FTS/vector/path evidence and retires replay while unrelated hits remain.
10. Run durable reindex, reopen SQLite, repeat the query, and prove the same
    remaining exact results with no orphan index state.
```

The vertical is incomplete if it asserts only a passing build, uses an in-memory
mock vector store, filters unauthorized results after retrieval, compares only
detached text, silently creates embeddings, or skips post-Forget/reopen proof.

## Rejections and adoption gates

Reject now:

- **RAGFlow runtime:** too broad, owns alternate storage and domain objects,
  and inspected fallback behavior conflicts with fail-fast invariants.
- **LlamaIndex runtime:** duplicates View/Transformation/Execution concepts and
  is Python-first; only its published fusion shape is needed.
- **Khoj code/dependency:** AGPL plus a full product/runtime; use only as product
  and reranking evidence unless legal and architecture decisions change.
- **GraphRAG indexing in Search:** its AI graph and reports are Transformations,
  expensive and purpose-changing, not a local index of canonical evidence.
- **LanceDB:** technically strong, but a second storage lifecycle weakens atomic
  Forget and reindex proof before SQLite scale is measured.
- **Orama:** useful ephemeral/browser engine, not transactional durable truth.
- **Graphology on the backend:** appropriate for Graph UI projections, not
  policy-governed exact-revision traversal.
- **better-sqlite3:** no demonstrated need to replace Node 24 `node:sqlite`.
- **model reranker in slice one:** no quality fixture yet justifies its model,
  latency, packaging, or failure surface.

Adopt `sqlite-vec` only after a narrow spike proves all of these on the actual
macOS/Node 24 composition root:

1. exact pinned package and extension load with startup compatibility checks;
2. explicit `BEGIN IMMEDIATE` commit/rollback with the existing adapter;
3. FTS + vector + relation scope query on one connection;
4. deletion and Privacy Forget rollback/reopen behavior;
5. durable reindex and orphan repair without vector recomputation;
6. packaged macOS distribution and CI support on required platforms;
7. acceptable latency and database size on a representative local corpus.

If the extension gate fails, ship keyword + relation search with semantic mode
explicitly unavailable. Do not substitute LanceDB, an in-memory cosine loop, or
a remote vector service inside the same release.

## Implementation order

1. Introduce strict Search contracts, observer/errors, `view.search` service
   routing, exact scope authorization, and location-preserving FTS. Prove the
   keyword + relation vertical first.
2. Spike and pin sqlite-vec behind the semantic ports. Extend commit, Forget,
   migration, and reindex transactions, then add semantic to the same vertical.
3. Add the optional Unstructured Operator adapter with fixed descriptors and
   fixture conformance. It should consume Search, not block Search release.
4. Collect retrieval fixtures and user judgments. Add a strict reranker adapter
   only if RRF quality is measurably insufficient.
5. Add AI-derived entity/community Views only as ordinary Transformations after
   a product scenario proves GraphRAG-like retrieval is worth its cost.

## Confidence and method

High confidence: local package ownership, current query/result limitations,
FTS/reindex/Forget behavior, upstream licenses, and the inspected algorithms.
These were checked directly in current Metaflow source and pinned upstream
source/license files.

Medium confidence: sqlite-vec packaging and transactional fit. Upstream source
and tests support the design, but the extension was not installed or exercised
inside Metaflow during this research-only task. The adoption gate is therefore
mandatory rather than implied by documentation.

No unresolved source contradiction remains. GitHub's metadata did not classify
Orama's license, while the repository's `LICENSE.md` states Apache-2.0; the
license file is the controlling evidence used above. GitHub code-search rate
limits were bypassed by inspecting shallow pinned repository checkouts, not by
reducing evidence coverage.

Research covered six planned claims: heterogeneous parsing, authorized scoped
retrieval, hybrid fusion/reranking, graph traversal, local deletion/reindex,
and TypeScript/macOS/SQLite fit. Ten upstream repositories and the current
Metaflow packages/wiki were inspected. No paid search or scrape service was
used.

## Primary sources

- Metaflow: `packages/view/search.ts`, `packages/view/repository.ts`,
  `packages/adapters/storage-sqlite/index.ts`, `packages/operations/contracts.ts`,
  `packages/operations/service.ts`, `tests/view-search-projection.test.ts`, and
  [[architecture/view-search|Recursive View Search]].
- RAGFlow: [hybrid retrieval](https://github.com/infiniflow/ragflow/blob/53e83dcadfef7b88c56648049c9966b5046cd06a/internal/service/nlp/retrieval.go),
  [reranker failure fallback](https://github.com/infiniflow/ragflow/blob/53e83dcadfef7b88c56648049c9966b5046cd06a/internal/service/nlp/reranker.go),
  and [graph hybrid expressions](https://github.com/infiniflow/ragflow/blob/53e83dcadfef7b88c56648049c9966b5046cd06a/internal/service/graph/retrieval.go).
- Unstructured: [automatic partition contract](https://github.com/Unstructured-IO/unstructured/blob/d309caf8ee20b735eb105d4e16ac3f04e5a48172/unstructured/partition/auto.py)
  and [PDF strategies](https://github.com/Unstructured-IO/unstructured/blob/d309caf8ee20b735eb105d4e16ac3f04e5a48172/unstructured/partition/pdf.py).
- LlamaIndex: [fusion retriever](https://github.com/run-llama/llama_index/blob/199e9b5b130bbde72639358a08935b913e7132c0/llama-index-core/llama_index/core/retrievers/fusion_retriever.py)
  and [recursive retriever](https://github.com/run-llama/llama_index/blob/199e9b5b130bbde72639358a08935b913e7132c0/llama-index-core/llama_index/core/retrievers/recursive_retriever.py).
- Khoj: [embedding and CrossEncoder implementation](https://github.com/khoj-ai/khoj/blob/1e30154d1070c7b132f389638c008b490be1481b/src/khoj/processor/embeddings.py).
- GraphRAG: [local search](https://github.com/microsoft/graphrag/blob/14a00ad88fc33cf2b52f4f113f25807556f8e25e/docs/query/local_search.md),
  [indexing methods and cost note](https://github.com/microsoft/graphrag/blob/14a00ad88fc33cf2b52f4f113f25807556f8e25e/docs/index/methods.md),
  and [source-linked dataflow](https://github.com/microsoft/graphrag/blob/14a00ad88fc33cf2b52f4f113f25807556f8e25e/docs/index/default_dataflow.md).
- sqlite-vec: [Node `node:sqlite` loading](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/site/using/js.md),
  [`vec0` metadata and partition filters](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/site/features/vec0.md),
  [KNN queries](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/site/features/knn.md),
  [delete/WAL tests](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/tests/test-insert-delete.py),
  and [pre-v1 guarantee](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/site/versioning.md).
- Alternatives: [LanceDB](https://github.com/lancedb/lancedb/tree/f655f62e0938395ab54caaa722addcb5351eb8fe),
  [Orama](https://github.com/oramasearch/orama/tree/b030e1bd1d330327bad1483f2d9c88a9ea0d493c),
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3/tree/ab6232e7105810a865de20ce47340f78072fe0b6),
  and [Graphology traversal](https://github.com/graphology/graphology/tree/b6e4b31ac0d68aaff36600c19faa0c751db6d015/src/traversal).

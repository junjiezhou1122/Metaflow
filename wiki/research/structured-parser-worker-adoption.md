---
name: research/structured-parser-worker-adoption
title: Structured Parser Worker Adoption
desc: Pinned upstream review for JSON, table, property-graph, and external-reference Parser Workers.
category: framework-evaluation
tags: [parser, json-pointer, table, graph, worker-thread, search]
sources: [standards, official-documentation, npm]
created: 2026-07-27T10:00:00Z
updated: 2026-07-27T10:00:00Z
---

# Structured Parser Worker Adoption

## Decision

The first structured Parser suite adds no third-party runtime dependency. Its
inputs are already decoded JSON Representations, so the required work is a
bounded deterministic projection, not file decoding or graph analytics. The
implementation reuses the existing Function Operator, Execution Runtime,
terminable Node Worker Thread, strict View validation, and SQLite FTS path.

## Evaluated upstreams

| Upstream | Pinned evidence on 2026-07-27 | Decision |
|---|---|---|
| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | IETF Standards Track JSON Pointer syntax and `~0`/`~1` escaping | Adopt the standard; implement only the two-token escaping rule locally |
| [@jsonjoy.com/json-pointer 18.28.0](https://www.npmjs.com/package/@jsonjoy.com/json-pointer) | Apache-2.0, Node >=10, 161,425-byte unpacked package | Do not add: no pointer evaluation or mutation is required |
| [Graphology 0.26.0](https://graphology.github.io/serialization.html) | MIT, 2,729,833-byte unpacked package; serialized node/edge model | Do not add to Parser: the committed Representation already contains nodes and edges, and rebuilding a graph would lose exact array paths and risk a second graph store |
| [csv-parse 7.0.1](https://csv.js.org/parse/) | MIT, 1,605,074-byte unpacked package | Do not add: table Views already contain typed columns, rows, and cells rather than CSV bytes |
| [Apache Arrow 21.2.0](https://arrow.apache.org/docs/js/) | Apache-2.0, 5,818,996-byte unpacked package | Do not add: Arrow is useful for columnar interchange, not for projecting an already-decoded bounded JSON table |
| [Node Worker Threads](https://nodejs.org/api/worker_threads.html) | Official runtime API; `worker.terminate()` provides an explicit cancellation boundary | Reuse the existing Markdown Parser isolation pattern |
| [SQLite FTS5 bm25](https://www.sqlite.org/fts5.html#the_bm25_function) | Official auxiliary ranking function used in the FTS query context | Keep ranking in the FTS row query and reduce best-per-token scores in TypeScript; do not wrap `bm25()` in SQL aggregate functions |

## Resulting boundary

```text
exact committed source View
  -> exact Parser Function Operator
  -> bounded terminable Worker Thread
  -> untrusted metaflow.view.fragment-set@2 candidate
  -> Execution validation and atomic commit
  -> Schema-declared SQLite FTS projection
  -> read-only Search
```

The JSON Parser emits RFC 6901-compatible paths. The table Parser emits exact
row and column coordinates. The graph Parser emits bounded node, edge, label,
and property fragments while retaining source array paths. The
external-reference Parser emits only the already committed URI and metadata and
requires a matching URI Materialization; fetching remains a separate explicit
Transformation.

Re-evaluate Graphology only for algorithms or browser visualization,
`csv-parse` only when a Connector admits CSV bytes, and Arrow only when a
columnar Materialization profile is introduced.

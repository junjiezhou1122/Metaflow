# `@info/search`

`@info/search` coordinates authorized retrieval over exact committed View
revisions. It owns strict request/result/cursor/error/observer contracts,
authorization-first scope freezing, explicit mode outcomes, deterministic
`rrf@1` fusion, and pagination.

The package has no database, transport, parser, model, vector, or graph runtime.
Concrete stores receive only the frozen authorized exact-ref set. SQLite FTS and
relation rows remain owned by `@info/storage-sqlite`. Its optional configured
semantic port uses the exact pinned sqlite-vec adapter and prefilters the frozen
exact scope inside the vector query; unavailable semantic/query-embedding or
reranker implementations are reported or fail according to the request rather
than falling back.

Scope and retriever ports are untrusted inputs. `all_visible` requests freeze
both `max_nodes` for authorized output and `max_scan` for every enumerated ref,
including denied refs; a page that exceeds its requested limit fails before
authorization. Subgraph relation rows must match the exact frontier, requested
direction, and requested relation types before discovery. Candidate paths must
equal the frozen canonical path, locations must honor the frozen target flags,
and related or semantic evidence refs must already belong to the authorized
scope. Semantic evidence from any non-semantic mode fails closed.

## Runtime integration

`OperationService` exposes `view.search` with the complete `SearchRequestV1`
and an explicit `view.search.reindex` operation. Ambient composes one
repository-backed exact View read authorizer into both Search and the other
public View read operations. SQLite supplies only scope, descriptor, relation,
keyword, and explicitly configured semantic ports after Search freezes
authorization. Semantic evidence is an exact strict embedding Derived View
that must already belong to the authorized scope. In-process, CLI, HTTP, and
the official MCP server therefore observe the same result and failure
envelopes.

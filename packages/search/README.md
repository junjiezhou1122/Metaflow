# `@info/search`

`@info/search` coordinates authorized retrieval over exact committed View
revisions. It owns strict request/result/cursor/error/observer contracts,
authorization-first scope freezing, explicit mode outcomes, deterministic
`rrf@1` fusion, and pagination.

The package has no database, transport, parser, model, vector, or graph runtime.
Concrete stores receive only the frozen authorized exact-ref set. SQLite FTS and
relation rows remain owned by `@info/storage-sqlite`; unavailable semantic or
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

## Issue 66 integration boundary

This package and the SQLite Search ports are the bounded issue 66 worker
artifact. Root workspace registration, dependency-boundary catalog updates,
`OperationService` injection, `view.search`/`view.search.reindex` catalog
projection, and CLI/HTTP/MCP vertical registration are intentionally left to
the integration owner so this branch does not edit shared composition files.

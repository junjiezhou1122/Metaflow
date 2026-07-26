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

## Issue 66 integration boundary

This package and the SQLite Search ports are the bounded issue 66 worker
artifact. Root workspace registration, dependency-boundary catalog updates,
`OperationService` injection, `view.search`/`view.search.reindex` catalog
projection, and CLI/HTTP/MCP vertical registration are intentionally left to
the integration owner so this branch does not edit shared composition files.

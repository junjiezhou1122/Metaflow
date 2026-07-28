# Metaflow Operations

This package owns the transport-neutral Metaflow v1 operation catalog. It
coordinates only public View, Transformation, Execution, Authoring, Feedback,
and Capture ports. It has no SQLite, HTTP, CLI, or MCP dependency.

Connector onboarding is exposed through the same catalog as
`connector.list/inspect`, `capture.connection.create/check/discover/activate/
update/pause/run`, and `capture.dlq.list/replay`. CLI, HTTP, official MCP, and
in-process callers therefore receive the same validation, authorization,
structured errors, lifecycle receipts, and observer evidence.

Every invocation carries an authenticated principal supplied by the composition
root, passes one operation authorization port, and emits started plus terminal
observer evidence. Domain errors become one structured envelope with a stable
code and category. Unexpected errors are not returned as raw implementation
details; the complete cause is sent to the required observer.

View access has three separate contracts. `view.get` returns one exact View.
`view.query` invokes a registered versioned Method profile over one exact
subject with typed parameters and a request-bound cursor, then reauthorizes
every returned evidence ref. The Registry compiles and enforces the Method's
declared JSON Schema before dispatch; collection adapters may additionally bind
their cursor to a durable repository commit sequence. `view.search` performs relevance discovery across
an explicit authorized scope. `view.resolve.latest` is the only moving-head
resolution operation. Connector refresh remains the generation-bound
`capture.connection.run` lifecycle operation.

`run.execute` accepts an exact committed Transformation reference. The service
loads that immutable revision before calling Execution Runtime, so no transport
can smuggle a second Transformation definition. Active Run cancellation is
coordinated with an AbortController owned by this service; Execution Runtime
still records the terminal cancelled Run, attempt, Failure View, and trace.

Transport adapters live in `packages/adapters/operation-surfaces` and may only
parse or serialize requests around `OperationService.execute`.

Natural-language authoring is projected as six ordinary operations:
`view.authoring.request`, `propose`, `inspect`, `approve`, `reject`, and
`apply`. Lifecycle references are exact. Operations authorizes every supplied
Request, Proposal, Decision, Receipt, or source View independently; operation
grants never grant View content access. The same operation schemas and
structured errors are registered by the CLI, HTTP, and official MCP surfaces.

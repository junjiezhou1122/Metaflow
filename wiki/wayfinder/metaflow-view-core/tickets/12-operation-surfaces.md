## Question

How should CLI, HTTP, and MCP expose one shared catalog of Capture, View, Transformation, Run, Feedback, Failure, policy, and trace operations?

## Depends on

- Implement the observable Execution Runtime and atomic commit path
- Implement Browser Raw View Capture
- Implement Screenpipe Raw View Capture

## Acceptance criteria

- One transport-neutral operation service owns commands and error semantics.
- CLI, HTTP, and MCP are thin adapters over that service.
- Each surface can ingest Raw Views, get/search/traverse Views, submit Transformations, inspect/cancel Runs, submit Feedback, inspect Failures, and read policy decisions as authorized.
- Equivalent requests return equivalent structured results and errors.
- No adapter reads SQLite directly or reconstructs domain behavior.

## Verification method

- Run a shared conformance suite against in-process, CLI, HTTP, and MCP adapters.
- Compare structured outputs and failure codes for representative success and failure cases.

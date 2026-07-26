# Operation Surfaces

These are thin projections of `@info/operations`:

- the installable `mf` client connects to the resident daemon from any cwd,
  accepts only strict `--input` JSON or `@file`, and prints one canonical
  envelope;
- HTTP accepts `POST /metaflow/v1/operations/<operation>`;
- MCP registers one tool per canonical operation through the official
  `@modelcontextprotocol/sdk` v1, advertises an output schema, validates
  `structuredContent`, and derives read-only/destructive hints from the shared
  effect catalog.

`mf --json doctor` checks the exact HTTP protocol, server version,
authentication source, reachability, and catalog access without printing
credentials. `mf --json <operation> --help` reads the live catalog; bounded
View access Operations include their strict input schema and literal example.
Malformed input never becomes a string fallback.

The composition root supplies an authenticated `OperationContext`; principals
are never accepted from the request body. All three surfaces call the same
`OperationService.execute` method and return its structured result or error.
This package has no View Store, SQLite, Transformation, Capture, or Execution
dependency and cannot reconstruct domain behavior.

The daemon also serves the same MCP server at `/mcp`. The retained stdio entry
point is a daemon client, not another `OperationService` composition.

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
every Operation includes its current generated input schema. The four bounded
Agent discovery/read Operations also include literal examples.
Malformed input never becomes a string fallback.

The composition root supplies an authenticated `OperationContext`; principals
are never accepted from the request body. All three surfaces call the same
`OperationService.execute` method and return its structured result or error.
This package has no View Store, SQLite, Transformation, Capture, or Execution
dependency and cannot reconstruct domain behavior.

The loopback-only daemon also serves the same MCP server at `/mcp`. The retained
stdio entry point negotiates the exact doctor contract before exposing tools;
it is a daemon client, not another `OperationService` composition.

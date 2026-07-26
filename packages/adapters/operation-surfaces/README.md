# Operation Surfaces

These are thin projections of `@info/operations`:

- CLI accepts `<operation> '<json-input>'` and prints the canonical envelope;
- HTTP accepts `POST /metaflow/v1/operations/<operation>`;
- MCP registers one tool per canonical operation through the official
  `@modelcontextprotocol/sdk`.

The composition root supplies an authenticated `OperationContext`; principals
are never accepted from the request body. All three surfaces call the same
`OperationService.execute` method and return its structured result or error.
This package has no View Store, SQLite, Transformation, Capture, or Execution
dependency and cannot reconstruct domain behavior.

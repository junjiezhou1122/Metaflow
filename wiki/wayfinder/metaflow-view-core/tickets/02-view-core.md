## Question

How should the minimum View contract implement open information forms while enforcing immutable revision identity, Schema, Representation, Materialization, provenance, policy, and exact relations?

## Depends on

- Establish v1 package boundaries and dependency checks

## Acceptance criteria

- View ids and immutable revision ids distinguish same-purpose evolution from fork.
- A stable source object may accumulate immutable Raw View revisions; occurrence evidence receives an independent View identity.
- Every committed revision declares name/purpose, Schema, semantic Representation, primary Materialization or manifest, provenance, and policy.
- Representation supports explicitly freeform and strict machine-validatable forms. Declared strict Schema mismatch fails closed.
- External references are valid complete Representations; fetching or decoding them creates another View.
- Relations freeze exact View revisions; current/latest resolution is a query operation.
- Raw evidence cannot be rewritten into a derived interpretation.
- Materialization is distinguished from OCR, transcription, summary, inference, and other semantic outputs.

## Verification method

- Unit-test Raw source revision, source occurrence, Derived, freeform, strict, external-reference, graph, revision, fork, and invalid-envelope cases.
- Typecheck the package without execution, adapter, or app imports.

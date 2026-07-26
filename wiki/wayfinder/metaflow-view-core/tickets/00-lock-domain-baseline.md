## Question

What domain language, scope, invariants, and package ownership form the binding implementation baseline for the Metaflow v1 front half?

## Acceptance criteria

- One canonical design defines View, Schema, Materialization, Transformation, Operator, Execution Runtime, Run, Feedback View, and Failure View.
- The design records immutable revision, fork, conflict, provenance, policy, package, and first-slice boundaries.
- `CONTEXT.md` and `AGENTS.md` use the same language and do not retain a separate Worker domain layer.
- Superseded drafts point to the canonical design.

## Verification method

- Review `wiki/architecture/view-core-transformation-runtime.md`, `CONTEXT.md`, and `AGENTS.md` together.
- Search active canonical guidance for contradictory `Operator Implementation`, `Worker`, or View-body `Representation` ownership.

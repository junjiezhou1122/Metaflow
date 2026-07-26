## Resolution

The implementation baseline is `wiki/architecture/view-core-transformation-runtime.md`.

Confirmed domain model:

- View is the universal recursive information object; Observation is its immutable Raw View role.
- View is the semantic representation. Schema describes structure and interpretation. Materialization is a physical storage, exchange, display, or index projection.
- Same-purpose evolution creates an immutable revision under the same View id. A changed purpose forks a new View id. New source evidence always appends a Raw View.
- Transformation is the versioned View-to-View declaration. Operator is its executable Agent, Workflow, function, model, human, or service. There is no separate Worker domain layer.
- Runtime freezes exact inputs, Operator, output contract, policy, and budget before execution and records an observable Run.
- Split, merge, grouping, compression, feedback, failure diagnosis, and repair all produce ordinary Views through the same extensible Transformation model.
- Feedback and Failure are Views. Repair is performed by ordinary Transformations; failures and repair attempts are never hidden.
- Manual, Smart Approve, and Approve All govern View access. Explicit deny rules override broad approval, and every disclosure is traced.
- Capability owners are `view`, `transformation`, `execution`, and `capture`; adapters implement ports; apps compose shared operations.

The first accepted slice is Browser and Screenpipe Capture through Raw Views, natural-language Transformation, function and Agent Operators, Derived View evolution, Feedback, Failure/repair, policy enforcement, and equivalent CLI/HTTP/MCP operations.

## Acceptance results

- Canonical design created: pass.
- `CONTEXT.md` canonical language synchronized: pass.
- `AGENTS.md` package direction and invariants synchronized: pass.
- Superseded architecture drafts point to the canonical design: pass.
- Scoped `git diff --check`: pass.

## Verification method

Reviewed the canonical design, glossary, and engineering guide together and searched them for the superseded separate Operator Implementation, Worker domain, and View-body Representation ownership.

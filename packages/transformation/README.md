# Transformation Contract

`@info/transformation` defines immutable intent snapshots. It does not execute
Operators or own Run state.

## Boundary

```text
Transformation revision
  instruction
  frozen Operator snapshot
  exact input refs and/or versioned selectors
  frozen output Schema and cardinality
  optional versioned trigger, policy, and budget

Run
  resolved exact inputs
  authorization decisions
  attempts, events, costs, outputs, and failures
```

An inferred output still contains the complete frozen Schema before execution.
`status`, `run_id`, resolved inputs, candidates, and results are rejected from a
Transformation and belong to Execution Runtime.

Operator references are tagged as `agent`, `workflow`, `function`, `model`,
`human`, or `remote_service`. Provider sessions and Workers are runtime details,
not durable domain entities.

Exact references use `{ transformation_id, revision }` everywhere. Execution
invocations, Automation targets, and Agent trace events import this schema
instead of maintaining wire-compatible copies.

A later revision must supersede the same Transformation identity at exactly
`revision - 1`. Revision validation fails on an identity change, a skipped
revision, or mismatched supersession.

`TransformationRepository` is the durable port for exact revision reads,
explicit moving-head reads, and compare-and-swap commits. Implementations must
preserve every revision and enforce idempotency independently of process
lifetime. `@info/transformation-sqlite` is the canonical local adapter: it uses
`BEGIN IMMEDIATE`, an expected head revision, and immutable revision rows. A
stale writer fails with a structured conflict; it never overwrites the winner.

Feedback does not mutate this contract. Execution may interpret a Feedback
View and construct a complete next Transformation revision, but only the
repository admits that revision.

There is no second executable `ViewExpression` contract. View Algebra names the
closed family of View-to-View Transformations; every executable request must be
represented by a complete Transformation revision before a Run starts.

`split`, `merge`, `group`, and `compress` are useful operation-shape names, not
a closed enum or semantic catalog. The Transformation input bindings and output
cardinality define the stable shape; its instruction, Operator reference, and
output Schema define what that particular transformation means. Arbitrary
user- or AI-created names may be carried in metadata without changing Core.

## External Pattern Check

- BuilderIO `agent-native` actions demonstrate schema-backed inputs and outputs
  across tool, HTTP, CLI, MCP, and automation callers. Metaflow reuses the
  schema-first boundary but rejects warn/fallback output admission: invalid
  candidates must fail before becoming Views.
- Temporal separates a durable workflow definition from each execution's
  options, conflict policy, retries, and run identity. Metaflow similarly keeps
  Transformation revisions separate from observable Runs, but does not adopt
  Temporal as the domain model or runtime dependency.

Zod remains the runtime contract library because it is already shared by the
View Core and can freeze JSON-Schema-backed output contracts without adding a
second validation system.

# Execution Contracts

`@info/execution` owns runtime ports and deterministic policy mechanics used by
the observable Transformation Run path. It does not own Connector, Automation,
or UI behavior.

## View Access Authorization

`ViewAccessPolicySnapshot` is a typed specialization of the generic
Transformation policy snapshot:

```text
id + revision
configuration
  kind: view_access
  profile: manual | smart_approve | approve_all
  rules: exact View | source | Schema | Operator -> allow | deny
```

Evaluation order is fixed:

1. An exact View's hard `allow_external_model` or `allow_embedding` constraint.
2. Any matching explicit deny rule.
3. Any matching explicit allow rule.
4. The selected profile default.

Explicit deny always wins. An allow rule cannot override a hard View
constraint. Manual requires approval for unmatched Views; Smart Approve allows
non-sensitive unmatched Views and requires approval for sensitive ones;
Approve All allows unmatched Views.

Every decision contains a deterministic id, exact allowed/denied/approval
subsets, the overall outcome, and rule provenance. Execution must check the
overall outcome: a mixed input set containing one denied View cannot execute as
a partially disclosed Run.

`ViewAccessAuthorizer` is the port consumed by the next Execution Runtime slice.
It governs View disclosure for local execution, external-model context, and
embedding. It grants no filesystem, shell, browser-control, communication, or
other external side-effect authority.

Failure and repair Views use `inheritStrictestViewPolicy`. It takes the
strictest visibility, privacy, retention, and allow flags, unions labels, and
fails on mixed owners instead of inventing a cross-owner policy.

## Observable Execution Runtime

`ExecutionRuntime` is the single orchestration boundary for all Operator kinds.
Its public dependencies are `ViewRepository`, `ExecutionRepository`,
`ViewAccessAuthorizer`, `OperatorExecutionPort`, and an optional
`ViewSelectorResolver`.

```ts
const result = await runtime.execute({
  run_id: "run:browser:42",
  correlation_id: "occurrence:browser:42",
  transformation,
  access_policy: viewAccessPolicy,
  access_use: "external_model",
  invocation_inputs: [{
    role: "current_page",
    views: [{ view_id: "view:browser:page", revision: 7 }],
  }],
});
```

`invocation_inputs` is the Automation/Ambient handoff for trigger-time context.
When a role is supplied, Execution never resolves that role again. Every exact
revision must exist and must match an exact source or satisfy a frozen selector
in the Transformation binding. Unsupplied roles retain normal selector
resolution. The candidates and selected exact revisions are both frozen in the
Run before authorization.

The repository persists the Run before Operator execution, then records an
explicit attempt and append-only events. Success validates cardinality, View
envelope, strict Schema, inherited policy, exact provenance, and base revision.
SQLite commits all output Views, relations, the terminal attempt, terminal Run,
and terminal trace event in one transaction. Cancellation, timeout, rejection,
validation error, adapter crash, and commit failure produce an ordinary Failure
View through a separate atomic failure commit. Alternatives link an explicit
`previous_attempt_id`; there is no hidden fallback.

`runtime.replay(run_id)` returns the frozen Run, attempts, events, and exact
provenance for every committed output.

An optional invocation `idempotency_key` is durable. Execution checks it before
selector resolution, so a retry returns the original frozen terminal Run even
if newer Views now match the selector. The same key with a different Run,
Transformation, policy, runtime override, or repair context fails with
`idempotency_conflict`. A replay of a still-ready or running Run reports
`run_already_active`; it never starts a second Operator attempt silently.

## Operator routing and Function implementations

`OperatorExecutionRouter` maps the frozen Operator `kind` to one registered
`OperatorExecutionPort` while retaining the active attempt for cancellation.
Missing and duplicate routes fail explicitly. The router contains no View
semantics and does not select a hidden fallback.

`@info/function-operator-adapter` resolves exact `function_id@version`
registrations. A Function implementation receives the frozen invocation,
abort signal, and durable event sink, then returns an untrusted candidate just
like an Agent bridge. Split, merge, group, and compress are conventional
Transformation shapes expressed by input and output cardinality plus optional
metadata; their semantic rules are implementation-owned and extensible.

Grouped Views store exact member revisions in their Representation. Adding
members produces an ordinary immutable View revision with a `supersedes`
relation; prior membership remains queryable.

## Agent bridge

`AgentOperatorExecutionBridge` is the canonical adapter from the existing
`AgentOperatorPort` to `OperatorExecutionPort`. It wraps semantic Agent output
in an untrusted candidate with a deterministic View id, frozen output Schema,
strictest input policy, exact Run provenance, and `derived_from` relations.
Execution still performs validation and commit.

The bridge also projects bounded invocation evidence into `current_context`:
role, exact ref, Schema, inline Representation value, or an external reference.
`current_page` contributes URL, title, and text; `current_selection`, voice, and
app roles contribute their matching immediate fields. Static Operator
configuration may add context but cannot replace fields owned by frozen input
evidence. `max_input_tokens` becomes a deterministic character bound for this
JSON projection: large inline values become observable previews, external
materializations retain exact View refs and reference metadata, and a budget
too small for the minimum evidence fails as `input_context_budget_exceeded`.
Browser and Ambient adapters must pass exact refs; they must not construct
candidate envelopes or duplicate Execution behavior.

## Feedback-driven evolution

`FeedbackEvolutionService` records user judgment as an ordinary strict
`metaflow.feedback@1` Derived View. It references one exact target View revision
through its Representation, relation, and provenance, and may also name the Run
that produced that target. A mismatched target or Run fails before feedback is
committed.

Applying Feedback is explicit. The caller supplies the exact base
Transformation, the requested changes, and a resolution. Execution validates
the target and optional Run, requires every requested category to produce a
real change, adds exact `evolution_target` and `evolution_feedback` inputs, and
commits the next Transformation revision through the repository CAS. A changed
configuration under the same Operator identity advances exactly one Operator
revision. Instruction, Operator configuration, output Schema, and selection
may evolve; old Transformation, View, Feedback, and Run evidence remains
queryable.

Two Feedback Views may coexist for one output. If both try to evolve the same
base, normal Transformation head conflict handling admits one and rejects the
stale writer. An idempotent replay returns the original admitted revision.

## Failure evidence and repair

Execution failure commits a strict `metaflow.execution.failure@2` View. Version
2 is intentional: the earlier freeform Schema v1 may already exist as history
and cannot be silently redefined. The Representation freezes the terminal
status, exact Transformation and attempt, error, full access policy and
authorization decision, exact causal chain, and optional repair context.

If an invalid candidate exists, Runtime forms a separate strict Candidate
Artifact View and links it from the Failure View. JSON candidates up to 64 KiB
are retained inline. Larger candidates retain a bounded preview, byte count,
and SHA-256 digest; non-JSON candidates record why payload capture was
unavailable. SQLite commits the artifact, Failure View, terminal attempt and
Run, and terminal trace event in one transaction.

Failure Views are ordinary Views. Split, group, diagnosis, and repair behavior
therefore use normal Transformations and Operators instead of a closed failure
taxonomy in Core.

`RepairExecutionService` requires a complete Transformation that declares the
exact target Failure View as an input. It computes a semantic repair
fingerprint, reconstructs the exact ancestor Failure chain, and commits a
strict Repair Decision View before execution. Its caller supplies a versioned
policy containing maximum depth, repeated-fingerprint limit, and optional
retryable/non-retryable error classes. An allowed decision freezes the policy,
fingerprint, parent, ancestors, depth, and decision ref in the new Run. Depth,
repeat, non-retryable, and causal-cycle rejection remain queryable blocked
Views and never invoke the Operator.

Diagnosis Views, changed Transformation revisions, and corrected outputs are
ordinary immutable artifacts. A failed repair creates another Failure View
whose causal chain reaches the original failure; prior evidence is never
rewritten.

### External pattern check

- Temporal makes retry a declarative policy with explicit maximum attempts and
  non-retryable errors. Its documentation also warns that rerunning unchanged
  Workflow logic repeats the same failure and wastes resources. Metaflow keeps
  this explicit-policy boundary but records each repair as Views and Runs.
- LangGraph turns an overlong or cyclic graph into `GRAPH_RECURSION_LIMIT`
  rather than continuing invisibly. Metaflow similarly stops at a frozen depth
  or repeated fingerprint, but does not adopt LangGraph as its runtime.
- `zod-to-json-schema` generates persisted strict View Schemas from the same
  Zod contracts used by Execution. The generation boundary normalizes its
  draft-07-compatible output into the View Core's 2020-12 subset; AJV remains
  the admission validator.

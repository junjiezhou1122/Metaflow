# Approval-gated natural-language View authoring

Status: canonical v1 design and implementation for GitHub issue #76.

## Decision

Natural language does not bypass Metaflow's ordinary contracts. It creates a
durable proposal which a human can inspect before any target is committed.

```text
natural-language request
  -> strict Request View
  -> Agent schema_value (untrusted)
  -> strict Proposal View + canonical artifact digest
  -> exact Approval or Reject View
  -> canonical target owner
  -> terminal Receipt View
```

The three supported artifact shapes are:

1. A concrete Derived View candidate. Authoring supplies the frozen Request
   policy and provenance; `ViewRepository` performs final validation and CAS.
2. A `View[] -> View` Transformation snapshot. `TransformationRepository`
   performs CAS; an approved proposal may carry a frozen ordinary Execution
   request.
3. An exact registered View Package reference. Proposal formation resolves
   `id@version` in `ViewPackageCatalog` and freezes the canonical manifest
   digest. Apply resolves it again and rejects drift. The Agent cannot submit a
   manifest or executable implementation.

Candidates are bounded to 1 MB. Request policy cannot weaken any exact source
policy, and that external-model decision reaches the Agent runtime. Concrete
View relations and revision bases must be among the exact Request sources; the
committed target keeps both the Request and those sources in provenance.
The Agent Runtime bridge fails closed: runtime ids are external-model capable
unless explicitly registered as local, so a prohibited Request never reaches
ACP/CLI `submit`.

Request, Proposal, Decision, and Receipt are ordinary strict Derived Views.
Their exact relations form the durable authoring trace. `AuthoringObserver`
also emits transition events for live observability. Operations is the only
shared projection owner; CLI, HTTP, and official MCP expose the same schemas,
authorization, envelopes, and errors.

## Exactness and recovery

- Every transition takes exact refs, `expected_revision`, a caller idempotency
  key, and `created_at`.
- The Proposal digest is SHA-256 over canonical JSON of the frozen artifact.
- Approval binds exact Proposal revision plus digest. A changed digest fails
  before a Decision View is committed.
- Concurrent/repeated calls use a persisted operation digest. An exact replay
  does not call the Agent or target again. Failed Proposal and Apply replays
  raise the persisted failure with its exact Receipt; changed input fails as an
  idempotency conflict.
- Reject commits Decision and Receipt in one View transaction.
- Cross-repository apply uses deterministic target and Receipt idempotency. A
  retry after a target/receipt crash window reuses the target commit and
  completes the Receipt. That interruption is not recorded as a false terminal
  failure after the target has already committed.
- Proposal or apply failures commit a failed Receipt before the typed error is
  returned. The error includes the exact Receipt ref.

`apps/ambient-daemon` is the production composition root for this capability.
It registers the canonical built-in View Packages, projects the existing
resident Agent runtime through `AgentRuntimeAuthoringProposalAdapter`, and
injects the Authoring service into shared Operations. Direct Assist remains an
independent prompt plus immediate-context path and does not create lifecycle
Views.

## Reference review

Reviewed on 2026-07-27:

- LangGraph `30c4d58db86455128e42ddec96b1ba53c553ba22`: interrupts persist exact
  checkpoint state and resume through the same thread identity. We reuse the
  durable checkpoint idea, represented by Proposal Views, not LangGraph.
- OpenAI Agents Python `a2d82707d94bfcf2ffbcc62ea9746c5fb183804f`: tool approval decisions
  attach to exact call ids and serialized `RunState`. We reuse exact decision
  binding, not its agent runner.
- Terraform `38e20815846fecc9013232c360a18182291b69e8`: applying a saved plan treats
  that exact plan file as the approval. We reuse plan/review/apply separation,
  strengthened with the Proposal digest.

These projects informed lifecycle semantics only. Metaflow keeps View,
Transformation, Execution, View Package, Operations, and repository ownership
unchanged.

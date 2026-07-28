# Natural-language View authoring

`@info/authoring` coordinates one approval-gated lifecycle:

```text
Request View -> Proposal View -> Approval or Reject View -> Apply -> Receipt View
```

The package owns strict lifecycle contracts, exact proposal digests,
idempotent transition validation, and authoring trace events. It does not own a
database, model SDK, executable implementation registry, or transport.

The Agent is a proposal worker. It receives a strict `schema_value` output
contract and returns untrusted declarative JSON. Only `AuthoringService` may
validate that candidate and delegate to the existing commit owners:

- concrete View -> `ViewRepository`;
- Transformation -> `TransformationRepository` CAS and optional ordinary
  `ExecutionRuntime` execution;
- View Package -> an exact `ViewPackageCatalog` registration whose canonical
  manifest digest still matches the approved Proposal.

Generated code, commands, entrypoints, URLs, source blobs, and package manifests
have no place in the View Package proposal contract. Supporting executable
authoring requires a separate sandbox, review, signing, and implementation
registration design.

Untrusted candidates are capped at 1 MB. Request policy must equal or strengthen
the strictest exact source policy, and the Agent runtime receives that frozen
`allow_external_model` decision. A concrete View retains the Request and exact
sources in provenance; its relation targets and any revision base must already
be frozen Request sources.

The canonical Agent Runtime bridge treats every runtime as external-model
capable unless its id is explicitly registered as local. A Request with
`allow_external_model=false` therefore fails before `submit` on ACP/CLI or any
unclassified runtime.

All lifecycle calls require explicit `created_at`, exact revisions, and
idempotency keys. The Proposal freezes the candidate and SHA-256 digest. A
Decision binds both its exact Proposal ref and digest. Replays return the
existing exact lifecycle outcome without invoking the Agent or target again; a
failed replay raises the persisted error with its exact Receipt ref. A changed
request under the same identity fails.

Target application and Receipt persistence can cross repository boundaries. If
the target commits but Receipt storage is interrupted, the service reports
`authoring_receipt_commit_failed` with the exact target and leaves no false
failed Receipt. Retrying the identical Apply request reuses the target's
idempotent commit and completes the applied Receipt.

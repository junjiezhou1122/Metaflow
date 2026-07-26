## Destination

Implement and verify the Metaflow v1 front half: a provider-neutral Connector
Runtime admits Browser and Screenpipe evidence as immutable Raw View revisions;
versioned Transformations execute Agent, Workflow, code, model, human, or
service Operators to produce evolving Views; feedback, failure, deletion, and
privacy Forget remain traceable; CLI, HTTP, and MCP share one Core.

## Notes

- This map includes implementation. A task closes only when its acceptance criteria are demonstrated with the stated verification method.
- Canonical design: `wiki/architecture/view-core-transformation-runtime.md`.
- Existing v0 and experimental v1 code are evidence, not target architecture constraints.
- Fail fast on schema, API, policy, revision, checkpoint, and storage incompatibility. Never hide fallback or partial success.
- Critical paths retain structured traces. Errors become inspectable Failure Views.
- Build on a non-main branch. Preserve unrelated user changes and generated artifacts.
- Refer to child issues by title, not bare issue number.

## Decisions so far

- [Lock the View Core and Transformation Runtime domain baseline](https://github.com/junjiezhou1122/Metaflow/issues/38) — fixed the recursive View model, Transformation/Operator/Run language, revision and trace invariants, View-access policy, package ownership, and first acceptance slice.
- [Lock Connector, Raw View, and Representation boundaries](https://github.com/junjiezhou1122/Metaflow/issues/42) — separated Connector access from Runtime and Ingress, fixed stable source identity plus immutable Raw View revisions, restored semantic Representation versus physical Materialization, and defined deduplication, lazy enrichment, tombstone, and Forget boundaries.
- [Establish v1 package boundaries and dependency checks](https://github.com/junjiezhou1122/Metaflow/issues/31) — made every v1 capability and adapter a buildable workspace package and enforced source plus manifest dependency direction with tested failures.
- [Implement the minimum immutable View contract](https://github.com/junjiezhou1122/Metaflow/issues/36) — enforced immutable View revisions, strict or freeform Schema, open Representation, closed Materialization, exact provenance and relations, role-aware lineage, and shared exact refs for Automation.
- [Implement View Store and SQLite revision persistence](https://github.com/junjiezhou1122/Metaflow/issues/37) — implemented atomic revision CAS, exact graph and Materialization access, semantic capture idempotency and source identity, versioned legacy migration, and structured storage diagnostics.
- [Define the versioned Transformation and Operator contract](https://github.com/junjiezhou1122/Metaflow/issues/29) — froze natural-language intent, exact inputs or versioned selectors, six Operator kinds, complete output Schema, policy/budget/trigger snapshots, sequential revisions, and one exact reference shared by Execution and Automation.
- [Implement View access approval profiles and deny overrides](https://github.com/junjiezhou1122/Metaflow/issues/32) — implemented deterministic Manual, Smart Approve, and Approve All decisions; hard View constraints and explicit deny precedence; exact auditable subsets; and strict Failure/repair policy inheritance behind one Execution authorization port.
- [Implement the observable Execution Runtime and atomic commit path](https://github.com/junjiezhou1122/Metaflow/issues/39) — persisted frozen Runs before execution, validated invocation or selector inputs through one Operator port, atomically committed success or Failure Views with durable attempts/events, and bridged existing Agent adapters without moving validation into Browser/Ambient.

## Not yet specified

- Operator marketplace packaging, signing, installation, and rollback.
- Application Spaces and long-lived application composition.
- Ambient attention and proactive decision policy.
- Human View Graph editing and visualization.
- General external side-effect authorization.

## Out of scope

- Notch, Web, and graph-explorer UI design.
- A complete general-purpose Agent Runtime product.
- Marketplace implementation.
- Ambient proactive product behavior.
- External filesystem, shell, browser-control, and communication side effects.
- Long-tail SaaS provider implementation beyond the provider-neutral Connector
  port; a later Notion proof will compare native REST, MCP, and Nango after the
  capture contract is verified.

## Destination

Implement and verify a provider-neutral Reactive View Pipeline: external facts
enter through small AI-authorable Connectors as lossless immutable Raw Views;
every committed Raw or Derived View can durably trigger matching Automations;
III-hosted Operators execute through the existing Execution Runtime and commit
new Views that may continue the graph under explicit cascade safety.

The first accepted slice is:

```text
Browser saved page + Screenpipe evidence
  -> lossless Raw Views committed atomically
  -> ViewCommitted events published after commit
  -> matching Automations durably enqueued through III
  -> Function and Agent Operators run through Execution
  -> summary and learning Views committed
  -> those Derived Views trigger one bounded next transformation
  -> replay, denial, crash, and cycle-stop evidence remain inspectable
```

## Notes

- This map includes design and implementation. A ticket closes only after its
  contract and acceptance scenario are verified.
- Canonical View, Transformation, Capture, Automation, and Execution semantics
  remain owned by the completed work in
  [[wayfinder/metaflow-view-core/map|Metaflow View Core and Transformation Runtime]].
- Ambient user, browser, schedule, and delivery behavior remains owned by
  [[wayfinder/metaflow-ambient/map|Metaflow Ambient Runtime]].
- Connector means source access plus source-native adaptation. Operator means
  any code, model, Agent, Workflow, human, or remote-service transformation.
  III Worker and Function are deployment/runtime concepts, not new Metaflow
  domain concepts.
- Capture commits facts before downstream work. A failed Worker never rolls
  back or invalidates its source View.
- All trigger evidence uses exact View revisions. Replay, retry, fan-out,
  recursion, and terminal stops are durable and observable.
- III may host Functions, triggers, queues, retries, and DLQ processing. It
  does not own canonical View, Automation, Transformation, Run, policy, or
  provenance state.
- The archived `packages/iii-runtime` is evidence only. No active v1 package
  may import archived `@info/core`, `@info/views`, `@info/processor-runtime`, or
  `@info/runtime` owners.
- Fail fast on schema, source protocol, policy, revision, event publication,
  queue, and runtime incompatibility. There is no hidden fallback.
- Build on a non-main branch, preserve concurrent worktree changes, and update
  `AGENTS.md` plus canonical architecture docs when ownership changes.
- Canonical GitHub map:
  https://github.com/junjiezhou1122/Metaflow/issues/55

## Decisions so far

- [Define and enforce the Reactive View Pipeline boundary](https://github.com/junjiezhou1122/Metaflow/issues/56) — fixed one policy-safe exact-revision `view.committed@1` contract, post-commit outbox ownership, and strict separation among View, storage, Automation, III, and Execution.
- [Build an AI-authorable Connector and Adapt Kit](https://github.com/junjiezhou1122/Metaflow/issues/57) — reduced new-source work to strict manifest/config/payload Schemas plus a pure Adapt function, enforced identity/Schema/policy/secret invariants, and proved it through shared conformance and a Clipboard Runtime slice.
- [Implement deterministic Raw View search projection](https://github.com/junjiezhou1122/Metaflow/issues/58) — added Schema-declared deterministic search projection, policy-aware atomic SQLite FTS5 indexing, durable crash-safe reindexing, and storage-neutral search across Browser, Screenpipe, and Clipboard Raw Views.
- [Publish committed View events through a transactional outbox](https://github.com/junjiezhou1122/Metaflow/issues/59) — atomically persists policy-safe exact-revision events with every new View batch and provides ordered durable leases, acknowledgement, crash redelivery, retry/poison evidence, explicit replay, and governed pending-event purge.
- [Harden Browser capture identity and MV3 lifecycle semantics](https://github.com/junjiezhou1122/Metaflow/issues/60) — shares one strict Browser wire contract across Extension, HTTP, and adapter; persists visit identity across MV3 suspension; freezes attention/navigation/frame facts; separates stable sources from occurrences; atomically saves page plus intent; and removes legacy double normalization.
- [Align Screenpipe capture with the verified upstream contract](https://github.com/junjiezhou1122/Metaflow/issues/61) — pins the external REST/license boundary, validates real health/auth/audio shapes, and replaces unstable offsets with selector-bound per-modality watermarks, bounded overlap, connection-scoped idempotency, atomic replay, and fail-fast drift evidence.
- [Bridge committed View events into Automation](https://github.com/junjiezhou1122/Metaflow/issues/62) — converts exact post-commit View evidence into bounded deterministic Automation matches while keeping Representation content ephemeral and Worker/Execution ownership outside the trigger adapter.
- [Implement the v1 III Worker and queue adapter](https://github.com/junjiezhou1122/Metaflow/issues/63) — binds exact Automation and Operator ports to versioned III Functions plus one durable descriptor-only queue while canonical policy, Run, validation, and View commit remain in Metaflow.
- [Enforce recursive View cascade safety](https://github.com/junjiezhou1122/Metaflow/issues/64) — freezes durable recursive lineage and budgets, atomically limits cycles and fan-out, and routes every stop, recovery, concurrency exhaustion, and III DLQ terminal through canonical Execution evidence without duplicate Worker invocation.

## Not yet specified

- Connector marketplace packaging, signing, installation, permissions, and
  rollback after the authoring kit is proven locally.
- Semantic/vector retrieval and learned ranking after deterministic text
  projection and FTS are correct.
- User-facing visual editors for Connectors, Automations, Transformations, and
  recursive View graphs.
- Distributed III workers and cross-device execution after one local durable
  worker path is verified.
- Adaptive creation of new Operators and Automations from repeated behavior.

## Out of scope

- Replacing the immutable View model or introducing Observation as a second
  persistence model.
- Reviving archived v0 Processor, Program, Runtime, or III packages.
- Making III state the source of truth for Views, Runs, or Automations.
- Full Application Space, graph-explorer, notch, browser-panel, or inbox UI.
- General shell, filesystem, browser-control, communication, or other external
  side-effect authorization.
- Bundling or redistributing Screenpipe.

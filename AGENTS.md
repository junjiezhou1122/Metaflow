# Metaflow Engineering Guide

## Product model

Metaflow has one recursive information model:

```text
external source -> Connector -> RawViewCandidate -> CaptureIngress
  -> Raw View -> Transformation -> Derived View
```

An Observation is a Raw View role, not a second storage universe. Raw evidence
is immutable and source-attributable. A Derived View may be revised but must
retain input provenance.

Metaflow's stable front-half language is `View`, `Schema`, `Materialization`,
`Transformation`, `Operator`, `Execution Runtime`, and `Transformation Run`.
An Operator is the stable callable contract embedded in a Transformation:
input Views become output Views through an Agent, Workflow, function, model,
human, or service. A Worker is a runtime implementation or host of that
Operator contract. Its definition and configuration may be stored as Views,
but there is no separate canonical Worker domain layer.

Current product scope keeps Connector Marketplace/onboarding UX and a
natural-language authoring UI deferred. New sources use the code-first
Connector Kit, and users or Agents may edit View Package, Transformation,
Operator, and Automation definitions directly. Existing authoring contracts
remain backend capability; neither product surface is a release blocker.

## v1 package boundaries

- `packages/view`: View, Schema, Representation, Materialization, policy,
  provenance, relations, immutable revisions, versioned deterministic search
  projection, the View Store port, and the transport-neutral exact
  `ViewCommitted` event/outbox ports and post-commit dispatcher.
- `packages/view-package`: the fail-fast authoring and discovery module for a
  coherent Schema family. It validates Representation and Materialization
  profiles, exact Processor and Parser descriptors, human Renderer descriptors,
  Agent Methods that reference existing Operations or exact Transformations,
  versioned JSON Schema parameters and cursor bounds for data-specific Methods,
  evolution edges, catalog registration, and conformance fixtures. Processor
  descriptors expose `View[] -> View` formation; Parser descriptors expose the
  narrower one-source committed search-projection profile. They contain no
  executable code or runtime connection. The package never executes a Renderer
  or Operator, reads a database, or creates another transport/runtime.
- `packages/authoring`: the transport-neutral approval-gated natural-language
  authoring coordinator. It owns strict Request, Proposal, Decision, and
  Receipt View contracts, exact proposal digests, idempotent lifecycle
  transitions, an untrusted schema-value Agent port, and observable authoring
  events. It delegates concrete View, Transformation CAS/Execution, and exact
  registered View Package application to their existing owners and never owns
  storage, model SDKs, transports, executable code, or implementation
  registration.
- `view-packages/*`: declarative installable View Package bundles. A bundle may
  depend only on `view`, `transformation`, and `view-package`; concrete hosts
  resolve its Renderer descriptors and existing Operation/Transformation
  references.
- `view-packages/personal-activity`: the first product-View bundle. It owns the
  strict semantic Audio, Activity Timeline, and Daily Summary Schema families,
  exact Timeline/Summary Transformations, Processor descriptors, Renderer
  descriptors, and conformance fixtures. Its executable acceptance begins
  from already admitted Audio Views; it does not claim that semantic Audio
  formation from Screenpipe Raw Views is implemented.
- `view-packages/application-space`: the strict ordinary View definition for an
  immutable Application Space graph root. It freezes exact entry refs and
  explicit membership/composition semantics. Its Schema relation projection
  makes the Representation entries and managed envelope relations one admission
  invariant; attach and detach create ordinary root revisions rather than
  mutating members or creating a second application database.
- `packages/transformation`: reusable Transformation and Operator contracts,
  immutable revision rules, and the durable Transformation Repository port.
- `packages/execution`: input resolution, authorization, Transformation Run,
  Operator execution, validation, atomic commit, traces, and Failure View
  formation.
- `packages/automation`: strict Automation View contracts, Trigger adapter
  ports, occurrence admission and idempotency, target invocation, Delivery
  ports, and correlation trace. Ambient behavior is built from Automations; it
  is not a separate Agent or memory runtime. Its invocation port admits either
  a direct Runtime result or a durable queued receipt without changing Trigger
  semantics.
- `packages/capture`: Connector and Source Connection contracts, Connector
  Package descriptors/catalog/trusted exact-artifact loading, CAS-generation
  onboarding, Connector Runtime, candidate admission, Raw View normalization,
  checkpointing, and capture traces. Connector Packages freeze Runtime ABI,
  publisher signature, permissions, named credential slots, configuration
  schema, and conformance v2 evidence. Its Connector Kit is the small deterministic authoring layer
  for manifest, configuration, source payload, Adapt, candidate, batch, and
  conformance contracts; it never owns provider API or SDK access.
- `packages/operations`: the transport-neutral v1 operation catalog,
  call-level authorization, active Run cancellation, shared structured error
  envelopes, and operation observer events. Exact View reads use the same
  deterministic read-authorizer port as Search; an operation grant never grants
  content access. `view.get` reads one exact View, `view.resolve.latest`
  explicitly resolves a moving identity, `view.query` pages one exact composite
  View through a registered versioned Method profile, `view.search` discovers
  relevant Views, and `capture.connection.run` explicitly invokes one active
  generation-bound Source Connection. Query cursors bind the exact subject,
  profile, and parameters;
  the Registry validates parameters against the exact View Package Method JSON
  Schema before adapter invocation, and collection Methods freeze a durable
  monotonic repository commit sequence so backfills and later revisions cannot
  reorder an active cursor. Every returned evidence ref is reauthorized. Its bounded
  `view.graph.project` coordinator authorizes every
  discovered exact revision before it can affect returned nodes, edges, paths,
  summaries, bounds, scan limits, or frontier, and consumes every relation page
  and summary through one source read snapshot. It coordinates public domain
  ports and never imports SQLite or transport code.
- `packages/search`: strict transport-neutral View Search request, evidence,
  cursor, error, and observer contracts; deterministic batch read
  authorization; exact, bounded subgraph, and bounded all-visible scope
  freezing; explicit mode outcomes; relation proximity; and deterministic
  `rrf@1` fusion. It receives only exact authorized View refs at retriever
  ports and never imports SQLite, a parser, model SDK, vector store, or
  transport.
- `packages/adapters/*`: independent workspace packages implementing storage,
  Browser, Screenpipe, III, Agent Operator, Trigger, Delivery, and
  Materialization ports.
- `packages/adapters/personal-activity-operator`: the independent Function
  Worker implementation for `Audio View[] -> Activity Timeline View -> Daily
  Summary View`. It returns untrusted candidates only, emits formation events,
  rejects cross-day or unchanged inputs explicitly, and uses optional exact
  base Views to form immutable successor revisions. Execution retains
  authorization, validation, provenance, atomic commit, Run, trace, and
  Failure View ownership.
- `packages/adapters/storage-sqlite`: durable View and Run state plus the
  transactional View-commit outbox, local FTS projection, and the accepted
  pinned `sqlite-vec@0.1.9` semantic projection. It persists a
  `ViewCommitted` event and any Schema-declared search document in the same
  transaction as newly created View revisions, retains bounded expanded JSON
  Pointer evidence in per-scalar FTS units, resolves exact relation layers, and
  indexes only strict committed embedding Derived Views whose exact target,
  location, source digest, profile, model, dimension, metric, provenance, and
  policy pass startup and commit checks. Those committed eligible embedding
  Views are the authoritative expected set: losing both a mapping and its
  physical row still requires explicit repair, and physical vector bytes must
  exactly match the committed float32 payload rather than a mutable mapping
  field. Vector mappings and `vec0` rows share
  commit, rollback, Privacy Forget, reopen, and durable reindex/orphan-repair
  transactions with View and FTS state. Physical vector identity includes the
  exact profile revision; profile/target metadata mismatch fails before Search
  can return evidence. Missing or orphaned rows open an observable
  `reindex_required` maintenance state that blocks semantic retrieval and
  mutation until a new durable reindex commits. Integrity discovered after
  startup latches the same state before returning, and an older successful
  reindex cannot clear it. Missing/incompatible extension,
  profile, ABI, or unsafe persisted vector state fails without a cosine or
  remote fallback. It publishes events only after commit and never invokes
  Automation or III directly. The existing Search read adapter also implements
  the View-owned deterministic paged graph relation and authorized-summary port
  on the same SQLite connection; it does not own authorization or projection
  semantics.
- `packages/adapters/automation-execution`: maps resolved Automation roles into
  exact Execution invocation bindings and projects Execution Agent events back
  into the Automation trace. It also implements the canonical reactive-cascade
  terminalizer by asking Execution to reconcile or create a terminal Run; it
  never constructs or commits output Views itself.
- `packages/adapters/committed-view-trigger`: resolves exact post-commit View
  evidence, discovers latest Automation Views, performs deterministic bounded
  matching, and hands matches to the ordinary Automation invocation port. It
  never executes Workers or owns occurrence, context, authorization, Run,
  Delivery, or output commit state.
- `packages/adapters/iii-runtime`: binds the existing Automation invocation and
  Operator execution ports to versioned III Functions and the durable
  `metaflow-automation-v1` queue. `Operator` is the stable input/output
  contract; III Worker is only one runtime host. The adapter carries exact
  descriptor evidence, receipts, retry/DLQ state, cancellation, and correlated
  runtime events, but never owns or commits View, Automation, Transformation,
  Run, policy, provenance, validation, or output state. Startup must verify the
  installed SDK, live engine, named queue, and registered Function metadata;
  incompatibility fails without an in-process fallback. Reactive queue support
  requires both the durable cascade ledger and the canonical terminalizer.
- `packages/adapters/browser-capture`: validates Chrome source events, maps
  page, save-intent, navigation, selection, media, and interaction facts into
  one atomic Capture Batch. Its browser-safe `./wire` export is the single
  validated contract used by the Extension, HTTP surface, and adapter. It
  delegates admission, retry, checkpoint, trace, and DLQ to the shared
  Connector Runtime.
- `packages/adapters/screenpipe-capture`: integrates a separately installed
  Screenpipe service only through its strict REST contract. It negotiates the
  health body, engine version, and declared endpoint capabilities before
  capture; pulls OCR, Audio, Input, and Accessibility separately because
  Screenpipe `content_type=all` is incomplete; uses per-modality ascending time
  watermarks with bounded inclusive overlap instead of unstable global offsets;
  resolves Bearer credentials from one exact `SecretReference` only for
  protected endpoints; bounds capability probes to a recent explicit period so
  negotiation never scans all Screenpipe history; identifies the requested
  modality in provider failures; and leaves checkpoint, retry, atomic admission,
  trace, and DLQ to the shared Connector Runtime. Do not vendor, bundle,
  auto-install, or read Screenpipe's internal SQLite.
- `packages/adapters/screenpipe-derived-views`: owns the deterministic Function
  Operator implementations and strict Schemas for evidence-level Screenpipe
  Timeline and Audio Views. It consumes exact admitted Screenpipe Raw Views and
  emits untrusted candidates through Execution; it never reads Screenpipe's
  database, invents semantic summaries, commits Views, or substitutes the later
  `personal.*` product View families.
- `view-packages/screenpipe-timeline`: declares the strict Timeline Index View,
  its Web Renderer, the typed `entries` Method backed by
  `screenpipe.timeline.entries@1`. The index is a queryable collection
  definition over independently authorized Screenpipe Raw Views; it never
  embeds an unbounded day of records into one Representation. Its explicit
  `refresh` Method invokes the ordinary generation-bound
  `capture.connection.run` Operation; Renderer code never contacts Screenpipe
  directly.
- `packages/adapters/clipboard-capture`: the minimum Connector Kit reference.
  It preserves accepted native clipboard fields in one occurrence Raw View,
  emits file values as external-reference Raw Views, and delegates admission,
  exact replay, checkpoint, trace, and failure behavior to Capture Runtime.
- `packages/adapters/codex-history-capture`: reads only complete local Codex
  rollout records under an explicitly configured Codex home. It admits safe
  session metadata plus user/assistant text, structurally excludes instructions,
  reasoning, tools, world state, and token data, and fails before batch formation
  when Secretlint matches. It never reads Codex preview/index databases.
- `packages/adapters/obsidian-capture`: reads Markdown below one explicitly
  configured vault root with no-follow containment, stable file identity,
  deterministic Markdown/frontmatter/link parsing, and a pre-batch secret gate.
  It never resolves links, fetches attachments, mutates the vault, or copies an
  absolute vault path into Views, checkpoints, traces, or failures.
- `packages/adapters/notion-capture`: integrates Notion only through the pinned
  official `@notionhq/client`. Discovery returns bounded previews without
  admitting Views or advancing checkpoints; pull/reference runs preserve full
  source objects as Raw Views and retain large media only as provider external
  references. The named `notion_token` SecretReference is resolved only at the
  SDK boundary and never enters configuration, Views, traces, or DLQ evidence.
- `packages/adapters/operation-surfaces`: thin CLI, HTTP, and official MCP SDK
  projections of `OperationService.execute`. Authenticated principals come
  from the composition root and are never accepted from request bodies. This
  adapter does not import View Store, Execution, Capture, or SQLite directly.
  The installable `mf` executable and retained stdio MCP proxy are strict
  loopback resident-daemon clients: both negotiate exact doctor, protocol,
  server, version, endpoint, required Bearer scheme and nonce-bound credential
  proof, frozen Operation allowlist/fingerprint, timeout, response status, and
  Operation-envelope evidence before use. The generated installable CLI wire
  module and `DaemonOperationClient` come from one canonical contract and share
  the full discriminated-envelope validator plus status/exit mappings. The `mf`
  executable works from any cwd, rejects unknown Operations before network
  access, inline/file JSON never falls back to a string, and stdout contains one
  envelope. MCP v1 tools advertise and validate the canonical discriminated
  envelope schema and derive effect hints from the Operation catalog.
- `packages/adapters/web-view-renderers`: the fail-fast Web Renderer ABI and
  trusted lazy implementation registry. It resolves exact
  `id@version@abi_version` descriptors, projects only authorized assets and
  declared Methods through host capabilities, and owns lifecycle evidence for
  load, mount, abort, and disposal. Its JSON, safe Markdown, image, and bounded
  Schema-driven table implementations are explicit registrations, never a
  generic fallback; it does not read View Store/SQLite or fetch arbitrary URLs.
- `packages/adapters/markdown-parser`: the deterministic first Parser Worker
  implementation. It accepts one exact inline Markdown View through the ordinary
  Function Operator/Execution path, enforces frozen byte and fragment bounds,
  and returns one untrusted strict `metaflow.view.fragment-set@1` candidate with
  exact source evidence and locations. CPU parsing runs in a terminable Worker
  Thread so Execution timeout and cancellation remain enforceable. It never
  commits Views, writes an index, computes embeddings, fetches references, or
  runs on the Search query path.
- `packages/adapters/structured-parser`: the exact-versioned JSON, table,
  property-graph, and external-reference Parser Worker suite. It projects one
  exact committed View through terminable Function Operators into an untrusted
  strict `metaflow.view.fragment-set@2` candidate with JSON Pointer,
  row/column, graph element/property, or reference coordinates. The graph
  Parser creates no second graph store, and the external-reference Parser
  requires a matching committed URI Materialization and never fetches it.
- `packages/adapters/browser-automation`: validates Browser events, performs
  cheap declarative matching, requests exact page/selection evidence through
  the Browser Capture port, and projects Delivery and interaction transport.
  It never constructs Raw View candidates or executes Operators.
- `packages/adapters/macos-automation`: validates explicit push-to-talk events,
  admits voice and Accessibility evidence, requests Browser DOM through an
  explicit bridge, and projects macOS Delivery. It never runs ACP or constructs
  Operator candidates.
- `packages/adapters/scheduler-automation`: evaluates timezone-aware cron
  schedules, emits exact half-open periods, and advances durable cursors only
  after a terminal or duplicate Automation occurrence. It never selects Views
  or executes Operators.
- `packages/adapters/inbox-automation`: projects multiple-capacity Inbox
  Delivery and interaction transport. It does not own summary behavior.
- `apps/ambient-daemon`: v1 Ambient composition root. Its direct-assist default
  is the resident Claude Code ACP conversation; Pi RPC remains a lazily started,
  user-selected alternative. It composes Automation, Execution, Operator routing, SQLite
  persistence, Browser/macOS/Scheduler triggers, Browser/macOS/Inbox delivery,
  durable Transformation revisions, shared Operations, a pure v1 HTTP handler,
  Feedback, and trace ports without a mock fallback. It keeps one ACP stdio
  process resident, binds HTTP and MCP explicitly to IPv4 loopback, and waits
  for ACP shutdown before closing persistence. Its
  temporary `/ambient/v1/assist` surface passes only prompt plus immediate
  voice/screen/app context and a bounded current-screen image into one ACP
  conversation session per `conversation_id`; it injects no MCP servers, does
  not use AgentTask/AgentTaskOutput, and does not create Views. It must never
  import `@info/core` or `@info/server`. Shared Operations separately compose
  approval-gated authoring with the resident Agent runtime and the exact
  registered built-in View Package catalog; this does not route Direct Assist
  through Views or Automation. Deployments may inject an explicit
  signed Connector Package catalog, artifact port, publisher trust store, and
  host permission allowlist; omitting it is a valid no-package deployment and
  never enables an implicit marketplace. Semantic Search is enabled only when
  the composition receives both an exact SQLite semantic profile set and a
  query embedding port; providing only one side fails before persistence opens.
  The ACP parent process remains resident,
  while at most four conversation sessions remain open; an inactive session is
  closed after ten minutes and revisiting it must use ACP `session/load` with
  the exact prior session id.
- `apps/view-explorer`: canonical v1 graph work surface. It calls only bounded
  shared Operations, validates graph/search/exact-View responses, and keeps a
  disposable Graphology projection plus Sigma camera/layout state in the
  browser. Its View surface resolves trusted Web Renderer implementations from
  View Package descriptors; the Screenpipe Renderer handles live Timeline
  Index, frozen Timeline, and Audio Views while preserving the same exact URL,
  selection, and camera state. Timeline pages `view.query` by date and typed
  filters, uses its explicit refresh command for a generation-bound Source
  Connection run, and requests DPR-aware
  authorized frame thumbnails with fixed pixel and byte ceilings. Explorer and
  Renderer code never import a View Store or SQLite, own traversal or access
  policy, persist layout as View semantics, contact Screenpipe directly, load
  an unbounded day at once, or silently fall back when WebGL is unavailable.
  Its accessible DOM companion and mutually exclusive mobile drawers remain
  synchronized with the visual graph.
- `apps/timeline-view`: temporary development harness for the Screenpipe Web
  Renderer interaction fixtures only. It remains outside the canonical pnpm
  workspace and has no root launch command; it is not a product surface or
  runtime composition root. The canonical user entry is `apps/view-explorer`.
- `apps/*`: CLI, HTTP, MCP, Web, browser extension, and native composition
  roots. Apps do not own domain behavior.
- `plugins/metaflow-view-access`: one skill-only Codex plugin containing the
  canonical repo-installable `metaflow-view-access` skill. It teaches bounded
  discovery, exact read, graph context, and exact citations; it contains no
  View data, daemon credential, MCP runtime, or duplicate Operation logic and
  is never injected into Agent prompts.

Legacy `core`, `views`, `view-system`, `processor-runtime`, `runtime`,
`sensors`, `ambient-layer`, `iii-runtime`, and `scheduled-batch` now live under
`archive/v0/packages/`; their old scripts and non-default tests live beside
them under `archive/v0/`. Legacy `packages/server`, `packages/programs`, and
`packages/capabilities` remain temporarily at their original paths only while
their uncommitted or compatibility behavior is mined into named v1 owners.
All of these paths are archived migration evidence: they are not workspace
packages, root dependencies, default commands, or active tests, and no active
source may import them. The machine-readable classification and the only
allowed temporary compatibility adapters live in
`wiki/architecture/v0-migration-inventory.md`.

Mixed Chrome side-panel v0 functions, passive macOS v0 calls, and Chrome proxy
Info tools are temporary transport/shape adapters, not domain owners. Their
named owners, callers, telemetry, and removal conditions are binding. Canonical
Browser Capture never normalizes `ContextRecord` or `observation.*` input: it
uses `/capture/v1/browser-events`, while retained side-panel records remain
isolated on `/context/ingest`. New callers must use canonical v1 events and
Operations.

## Invariants

- Connectors emit candidates; only CaptureIngress admits Raw Views.
- New Connectors define a strict source payload Schema and one deterministic
  Adapt function through `defineConnectorKit`. The Kit fills connector,
  connection, inherited non-weakening policy, and batch envelopes, but never
  infers stable-source versus occurrence identity or performs source I/O.
- Every Connector uses `runConnectorConformance` to reject malformed payloads,
  prove deterministic Adapt, declared Schema versions, lossless source-field
  retention, multiple candidates, and exact replay through Capture Runtime.
- Credentials exist only as `SourceConnection.secret_refs`. Configuration,
  endpoint userinfo, candidate Representation/metadata, errors, traces, and
  dead letters cannot contain inline secret material.
- Connector Package loading is exact on `id@version+sha256`. Unsigned,
  unknown, ambiguous, ABI-incompatible, digest-mismatched, untrusted-publisher,
  or host-permission-exceeding artifacts fail before executable Connector code
  is returned. Source Connections bind that exact package and use named secret
  slots plus compare-and-swap generations; create/check/discover/activate/
  update/pause/run are explicit idempotent lifecycle actions.
- A stable source object may accumulate immutable Raw View revisions. Source
  occurrences such as watch sessions or copy events have independent View ids.
- Cross-Connector semantic duplicates remain separate evidence and are linked
  by Transformations; only exact same-source deliveries are idempotent.
- Connector Runtime commits a checkpoint only after its complete admitted
  batch succeeds. Credentials remain secret references and never enter Views.
- Chrome transport failures that never reach the server remain explicit in the
  serialized extension outbox. Network failures and HTTP 408/425/429/5xx mean
  the server has not accepted the event and retain its exact payload locally;
  pending events are never silently truncated. Once accepted by HTTP, retry and
  dead-letter ownership is exclusively the shared Connector Runtime; the
  extension never simulates a second server-side capture state machine.
- Chrome visit identity is persisted in `chrome.storage.session`; alarms and
  `webNavigation` events, not service-worker intervals, drive periodic and SPA
  capture. Every event freezes tab/window/visit attention plus available
  document/frame identity. Only the active tab of the focused non-minimized
  window is focused attention; other active or open tabs remain explicit
  background/open facts.
- Navigation admission and the first DOM snapshot have separate persisted
  state. `webNavigation.onCommitted` may record navigation before
  `document_idle`, but only a DOM-ready event may complete the initial page
  snapshot; an early metadata-only navigation cannot permanently suppress it.
- Browser pages, caption segments, and caption state have stable source
  identities and immutable revisions. Navigation, selections, copies,
  play/pause, heartbeat/search, and explicit save intent are occurrences. A
  manual save admits its page evidence and independent intent occurrence in
  one Capture Batch.
- Capture batch replay is resolved before checkpoint conflict detection. Exact
  replay returns frozen receipts; a changed request under the same key fails.
- Paused or disabled connections fail before Connector health/open calls.
  Backpressure before attempt start is traced but never dead-lettered. Only an
  attempted terminal batch enters the DLQ, and replay is always explicit.
- Candidate normalization, stable-source head lookup, strict Schema validation,
  and atomic admission share one observable failure boundary. A
  `capture.started` event cannot be left without committed, skipped, or failed
  evidence because draft formation threw.
- Connector/API/schema incompatibility throws a structured error. There is no
  hidden SQLite or model fallback.
- CLI, HTTP, MCP, and in-process callers use the same operation names, input
  schemas, authorization decision, result/error envelope, and observer path.
  A transport never reconstructs View, Transformation, Run, policy, Failure,
  or trace behavior.
- Installed Agent access reaches only the explicitly loopback-bound resident
  daemon. Doctor is credential-free, declares required Bearer authentication,
  and proves credential possession for a client nonce while freezing the exact
  catalog identity before a client may send its token. Every privileged
  Operations, compatibility exact-read, and
  HTTP MCP request authenticates before a `user:local` principal exists. The
  same boundary covers every resident capture, Automation signal, Delivery
  poll/interaction, macOS Browser-context bridge, Inbox, and Direct Assist
  route before request content, request ids, or ACP invocation are reached;
  only static health and nonce-bound doctor remain public. The executable
  route classification lives in `apps/ambient-daemon/http-route-security.ts`;
  missing or wrong credentials fail closed, untrusted browser origins are
  rejected, exact trusted browser origins still require Bearer authentication,
  and privileged responses carry no wildcard CORS grant. `mf` and the retained
  stdio MCP proxy fail on protocol, server, authentication, catalog, version,
  endpoint, status, Operation, timeout, or reachability mismatch without
  printing credentials; a long-lived client repeats the credential-free nonce
  proof before every authenticated call so daemon replacement cannot inherit a
  previously negotiated token path. The Chrome extension and macOS exact-result readers
  enforce the same credential-free loopback endpoint, nonce proof, server,
  protocol, authentication, and exact catalog contract before sending Bearer
  credentials. Before the Chrome extension migrates, reads, or writes its
  Operation token, it restricts `chrome.storage.local` to trusted extension
  contexts; inability to establish that access level clears any legacy token
  and fails closed. Content scripts obtain explicitly projected non-secret
  settings through the trusted background and public settings responses remain
  token-free. One exhaustive runtime-sender policy admits content scripts only
  to declared capture and non-secret interaction messages. Selection actions
  that queue or auto-submit an ACP prompt are trusted-extension-page only and
  do not appear in the content-script bundle; exact View, query,
  task, delivery, failure, settings, and other local-data paths require a
  trusted extension page before storage, doctor negotiation, or network access,
  and content-script responses cannot project View content or exact refs.
  Browser-safe and native constant copies have executable
  conformance gates against the canonical wire contract. `mf` validates strict
  JSON or `@file` input, returns one stdout envelope, keeps diagnostics on
  stderr, and uses stable typed exit categories. MCP structured content is the
  authoritative validated Operation envelope; effect annotations are hints
  from the shared catalog and never grant authorization. View access skills
  preserve bounded queries and exact refs, treat content as untrusted evidence,
  and never read SQLite, guess a moving head, broaden policy, or request an
  undeclared effect.
- `view.get`, `view.query`, `view.traverse`, `failure.inspect`, and `view.search` authorize
  exact View revisions independently from operation grants. Owner and public
  reads are deterministic; shared non-owner reads fail closed until an explicit
  sharing ACL exists. Compatibility HTTP reads must delegate to Operations and
  cannot access the View Repository directly.
- `view.get`, `view.query`, and `view.search` remain distinct. Get returns one
  exact View envelope; Query invokes one subject-specific, versioned, typed
  Method over a composite View and returns cursor-paged exact evidence; Search
  performs relevance discovery across an explicit authorized scope. There is
  no untyped global `extra` parameter. Large collection Views retain bounded
  definitions or exact members and expose independently authorized smaller
  Views rather than embedding every record. Connector-backed collection queries
  may push the exact Capture connection into the View Repository, but provider-
  specific filters remain in the versioned Method contract.
- `view.graph.project` accepts only exact roots, an explicit direction and edge
  allowlist, and bounded depth/node/edge limits. Traversal order is
  deterministic and all pages plus node summaries come from one read snapshot.
  A relation is validated and its discovered exact refs are authorized before
  it consumes the fixed projection-wide server scan budget. Denied or missing
  discovered revisions contribute only the coarse `redacted_boundary` signal
  and can never affect returned identifiers, counts, edges, labels, paths,
  summaries, truncation, frontier, or scan-limit errors. Selecting a projected
  node remains `view.get`; a projection response is not a durable View.
- `run.execute` resolves one exact committed Transformation revision before
  Execution. `run.cancel` aborts only an active invocation owned by the same
  operation service; Execution still persists the terminal cancelled Run,
  attempt, Failure View, and trace.
- Large source media remains externally referenced unless a View schema and
  policy explicitly require retention.
- Every committed View revision has Schema, Representation, Materialization,
  policy, and provenance. Strict Representations validate; freeform
  Representations are explicitly declared.
- A strict Schema relation projection is a cross-envelope admission contract:
  every projected Representation entry must have exactly one matching managed
  relation with its exact target, relation type, and metadata. Missing, extra,
  mismatched, or non-normalized exact refs and managed relations reject the
  complete View commit.
- A View identity keeps one Schema family. Within its revision chain, a Schema
  `name@version` is immutable. Changing interpretation rules requires a higher
  version; changing the family requires a fork.
- Source deletion appends a tombstone revision. Explicit privacy Forget is a
  separate operation that reports impact and purges governed downstream data.
- Targeting any revision with Privacy Forget expands the frozen impact to every
  revision of that View identity before downstream closure. Every purged
  `view_id` is permanently retired in content-free audit state; ordinary
  commits, idempotent retries, and persisted Capture batch replay must fail
  closed rather than make an old exact reference resolve to new content.
- Fetching, decoding, or enriching a reference creates a new View through a
  Transformation; it never backfills the Raw View.
- Deterministic keyword Search indexes only fields explicitly named by the immutable
  `Schema.search_projection@1` contract. The projection is deterministic code,
  never OCR, transcription, summarization, model inference, or embedding.
  `policy.allow_local_search=false` is a hard exclusion that policy inheritance
  and Connector adaptation may not weaken.
- Semantic Search projects only strict committed
  `metaflow.search.embedding@1` Derived Views through exact-pinned
  `sqlite-vec@0.1.9`. Search never computes document embeddings. Every mapping
  freezes the exact target/location, source digest, embedding evidence ref,
  provider/model profile, dimension, metric, and policy; configured exact scope
  and target-kind filters execute inside KNN before distance affects rank.
  Product composition must wire the SQLite semantic retriever and query
  embedding port as one explicit pair. A configured vector store without query
  embedding, or query embedding without the exact store profile, is invalid.
- Same-purpose evolution creates a new immutable revision; a new purpose forks
  a new View identity. Stale base revisions fail rather than overwrite.
- View Store `get` requires an exact revision. Moving-head access is explicit
  through `getLatest` or `resolveLatest`; historical references never drift.
- Every View commit supplies `expected_revision`; `commitBatch` atomically
  persists revisions, exact relations, initial Materializations, and replay
  fingerprints. Last-write-wins is forbidden.
- Every durable batch that creates at least one View revision atomically
  persists one `view.committed@1` outbox event. The event contains only a
  stable event id, commit batch and transaction identity, non-secret origin,
  and exact View refs with role, Schema summary, and durable retention. It
  never contains Representation, full policy, credentials, or source payload.
- A rolled-back batch emits no commit event. Exact idempotent replay does not
  create another event. Publication happens after commit and may redeliver the
  same stable event id until acknowledged; a publisher crash leaves the outbox
  pending instead of losing the commit or rolling back the source View.
- Outbox polling uses durable sequence order and exclusive expiring leases.
  Publisher failures become explicit retry or poison state before dispatch
  throws; manual replay is explicit and retains the immutable event id.
- `do_not_store` candidates never become committed Views. Session-retained
  Views may exist only in a future non-durable store and cannot enter the
  durable View-commit outbox. Privacy Forget removes pending governed content
  before it can be dispatched and cannot publish purged View content.
- Idempotency is enforced at ingress/repository boundaries. Exact replay may
  return its original revision; a reused key with different evidence fails.
- One connector-scoped stable source object or occurrence maps to one View
  identity. Changing an idempotency key cannot create a parallel revision chain.
- Derived Materialization rebuilds advance a physical generation without
  changing semantic View identity. Durable SQLite never persists
  `do_not_store` or `session` retention.
- View Store schema upgrades are versioned, atomic, and constraint-checked.
  Legacy envelopes may be normalized only by an explicit lossless rule;
  otherwise migration fails with table, exact View revision, phase, and
  transaction context.
- A non-empty legacy Source Connection secret array migrates only when its
  connector manifest and configuration prove one exact named slot. The sole
  supported historical rule is a Screenpipe bearer reference whose configured
  `authentication.secret_ref` exactly matches the sole array member; it becomes
  `screenpipe_api_key`. Unknown, multiple, or inconsistent arrays fail closed.
- Search projection rows and SQLite FTS rows commit or roll back with their
  exact View revision. Full reindex runs are durable and idempotent: a crash
  leaves the prior index intact and the same reserved run can resume; failed
  runs require a new explicit run id. Privacy Forget removes governed FTS rows
  in the same Core purge transaction.
- Parser Workers are deterministic bounded Processors hosted behind the same
  exact Operator execution contract. They return untrusted fragment-set
  candidates; only Execution may validate and commit them. Search consumes
  previously committed projections and must never invoke parsing, fetching,
  OCR, transcription, enrichment, or embedding as a query-time side effect.
- Internal-only keyword Search fails with `parser_capability_missing` when its
  frozen authorized scope has no committed internal search projection.
  Fragment-set v2 hits retain their indexed evidence path plus exact source
  coordinates; combined envelope+internal Search may still return valid
  envelope evidence when no internal projection exists.
- A Transformation freezes exact inputs, Operator, policy, output contract, and
  budget before its Run starts. Alternatives are observable attempts, never
  silent fallbacks.
- Invocation-time exact input bindings from Automation override selector
  resolution for their declared roles. Execution validates every supplied
  revision against the frozen exact source or selector, freezes it, and never
  silently substitutes a newer matching View.
- View access authorization uses the typed Execution policy snapshot and one
  deterministic `ViewAccessAuthorizer` port. View constraints and explicit
  denies override broad approval; a mixed denied input set cannot execute as a
  partial disclosure.
- Manual requires approval for unmatched Views. Smart Approve automatically
  permits only non-sensitive unmatched Views. Approve All permits unmatched
  Views but cannot override exact View external-model or embedding prohibitions.
- Failure and repair Views inherit the strictest relevant input policy. Mixed
  owners fail and require an explicit cross-owner policy decision.
- Transformation, Execution, and Automation share one exact Transformation
  reference shape: `{ transformation_id, revision }`. Automation targets and
  Agent trace events must not redefine or weaken it.
- Transformation revisions contain declaration state only. Resolved selector
  results, Run ids, status, attempts, candidates, and results belong to
  Execution and are rejected by the Transformation contract.
- Feedback is an ordinary Derived View with an exact target View revision and
  optional Run. Applying it creates a new Transformation revision through the
  Transformation Repository CAS; prior Transformation and View revisions are
  never mutated. Every requested instruction, Operator configuration, output
  Schema, or selection change must be explicitly resolved.
- Natural-language authoring is Request View -> Proposal View -> exact
  Approval/Reject View -> Apply -> terminal Receipt View. The Agent returns
  untrusted strict `schema_value` JSON and never commits a target. Approval
  binds the exact Proposal revision and canonical artifact digest. Concrete
  Views use View Repository validation, Transformations use repository CAS and
  ordinary Execution, and View Packages may reference only an exact registered
  catalog implementation whose manifest digest still matches. Generated
  executable code, manifests, commands, entrypoints, and source blobs are
  rejected until a separate sandbox and signing design exists.
- Authoring candidates are bounded to 1 MB. A Request policy must equal or
  strengthen the strictest exact source policy and its external-model decision
  is passed to the Agent runtime. The canonical Agent bridge treats a runtime
  as external-model capable unless its id is explicitly registered as local;
  a prohibited Request fails before runtime submission. Concrete View relations
  and revision bases must already be frozen exact Request sources; the applied
  View retains the Request plus those sources in provenance.
- `packages/adapters/transformation-sqlite` owns durable Transformation
  revision heads, exact historical reads, replay idempotency, and atomic
  compare-and-swap. `packages/execution` owns Feedback target/Run validation and
  evolution provenance; neither responsibility belongs in UI or Automation.
- Failed execution creates a strict `metaflow.execution.failure@2` View. A
  same-transaction Candidate Artifact View retains bounded invalid output;
  the Failure View freezes the Run, error, access policy and decision, exact
  inputs, candidate ref, repair parent, and causal chain. Legacy freeform
  Failure Schema v1 is history and must not be silently redefined.
- Repair is implemented by ordinary Transformations through
  `RepairExecutionService`, not hidden runtime recovery. Every allowed or
  blocked request commits a Repair Decision View. Caller-supplied versioned
  policy controls retryable codes, maximum depth, and repeated fingerprints;
  cycles and exhausted repair plans stop before Operator execution.
- Execution idempotency is checked before selector resolution. Exact replay
  returns the original frozen terminal Run even when newer matching Views now
  exist; reusing a key with a different request fails.
- `AgentOperatorExecutionBridge` owns the conversion from semantic Agent output
  to an untrusted candidate envelope. It projects bounded exact input evidence
  into Agent current context; Browser and Ambient adapters never construct
  output View envelopes or commit Execution results themselves.
- Agent Operator output mode is explicit. `agent_task_output` preserves the
  legacy summary envelope; `schema_value` returns one untrusted JSON-compatible
  value for the frozen output Schema and never falls back to the legacy shape.
  Execution alone validates and commits it. A zero-input Transformation must
  freeze an explicit `output_policy`; legacy `failure_policy` is only an
  equivalent input alias and conflicting values fail before Run creation.
- Every Agent input projection retains role, exact View ref, Schema, and inline
  Representation or external reference under `raw.metaflow_inputs`. Static
  Operator context cannot overwrite frozen evidence. If `max_input_tokens`
  cannot fit the minimum exact projection, Execution records
  `input_context_budget_exceeded`; callers must not partially disclose inputs.
- `tests/metaflow-v1-vertical.test.ts` is the deterministic executable boundary
  for the first Browser/Screenpipe-to-evolving-View acceptance slice. Run it
  with `pnpm test:v1-vertical`; it must cross Function and Agent Operators,
  feedback evolution, failure and explicit repair, exact deny overrides, and
  equivalent in-process, CLI, HTTP, and real MCP observation on one SQLite
  graph.
- `OperatorExecutionRouter` dispatches the frozen Operator kind without hidden
  fallback. Exact-versioned Function implementations live in
  `packages/adapters/function-operator`; they emit durable events and return
  untrusted candidates for Execution to validate and commit.
- Split, merge, group, and compress are conventional Transformation shapes,
  not a fixed Core taxonomy. Grouped View Representations freeze exact member
  revisions and evolve through immutable revisions with `supersedes` lineage.
- SQLite terminal commits include output Views or the Candidate Artifact plus
  Failure View, relations, attempt state, Run state, and terminal trace event in
  one transaction. A rolled back batch cannot leave a succeeded Run, orphaned
  artifact, or partial View set.
- Automation decides when work starts; Transformation decides how Views are
  transformed. Trigger conditions never invoke a model silently.
- Every committed-View Automation requires a durable cascade ledger and one
  exact root policy snapshot. Each attempt freezes root/event identity, exact
  lineage, parent event/Run/attempt, Automation, Transformation, Operator once
  bound, depth, fan-out position and total, semantic fingerprints, aggregate
  cost/attempts, root time, and replay linkage. A whole fan-out plan is admitted
  atomically before any Operator invocation.
- Repeated semantic transitions and exact-lineage cycles stop before execution.
  Depth, fan-out, aggregate attempts/cost/time, and exact-Operator concurrency
  limits are enforced by the durable ledger. `view.committed` Automations may
  target only Transformations; an Operation target cannot escape the inherited
  cascade as a new root.
- Admission stops and Automation context denial still cross Execution with a
  terminal cascade or explicit pre-execution failure. Execution persists one
  Run, Failure View, terminal trace, and `view.committed@1` outbox event without
  invoking a Worker. Exact-Operator concurrency exhaustion is a typed cascade
  limit and follows the same pre-execution path; it is never finalized only in
  the ledger. Mixed denied context is never partially disclosed.
- Reserved and running cascade attempts retain expiring leases. Recovery keeps
  the exact Run and Operator; an abandoned ready/running Run is reconciled to
  one Failure View without reinvoking its Worker. If output commit succeeds but
  cascade finalization crashes, the attempt stays recoverable and replay reuses
  the stored terminal Run instead of rewriting it as failed.
- III DLQ inspection cannot terminalize a reactive attempt by ledger mutation
  alone. It must call `ReactiveCascadeTerminalizer`; Execution preserves an
  already successful Run or creates/reconciles canonical Failure evidence, and
  only then may III finalize cascade transport state and emit the correlated
  DLQ terminal event.
- An active Automation is an exact, editable Automation View revision. Trigger
  occurrences, context resolution, Runs, delivery attempts, and feedback share
  one correlation trace.
- Ambient invokes expensive work only after a declared user, event, schedule,
  or bounded accumulation Trigger. The notch and browser UI are Delivery
  adapters, not decision engines.
- Direct notch assist defaults to one resident Claude Code ACP process and one
  exact resumable session per conversation id. It
  receives only the prompt, frozen immediate context, and current screenshot;
  it streams Markdown text and has no MCP servers, Views, Automation, or
  AgentTask output contract. Current screen context is explicitly supplemental
  and may be unrelated to the request. Claude keeps its native ACP tools; local
  direct assist selects the Agent-provided allow-always or allow-once permission
  option and records bounded tool-call diagnostics. Pi starts only when selected
  and otherwise runs normally with its own tools,
  extensions, skills, prompt templates, project context, and session persistence;
  Metaflow must not replace or narrow harness capabilities. Provider/model, process reuse, first-token time,
  total duration, parse failure, and process exit are observable. A model that
  does not declare image input fails instead of silently dropping the screen.
  Ordinary direct-assist turns must settle in the foreground: background Agent,
  Task, worktree, or repository writes require an explicit request in that
  turn. The HTTP client disconnect signal cancels the active ACP prompt. The
  resident process permits at most four open conversation sessions, closes an
  inactive session after ten minutes, and resumes an evicted session only by
  exact ACP `session/load`; unsupported exact resume fails.
  Daemon shutdown stops admission and closes live HTTP connections so their
  disconnect signals cancel active prompts before ACP and persistence close.
  Startup recognizes only the exact legacy macOS Automation revision whose
  source was `metaflow-mac-companion`; it appends a `supersedes` revision using
  `metaflow-mac`. Any other seed drift remains a fatal conflict.
- The native Settings surface persists the global voice shortcut and direct
  Agent harness/provider/model selection. The default is Claude Code ACP; Pi
  RPC with a user-selected provider/model remains an explicit alternative.
- Schedule occurrences freeze one timezone-derived half-open period
  `[start,end)`. View time queries compare instants by epoch, never ISO text,
  and never substitute `created_at` when `observed_at` was requested. Restart
  catch-up is bounded and fails instead of silently dropping excess periods.
- Scheduler cursors use durable compare-and-swap and advance only after a
  succeeded, failed, or duplicate Automation result. Manual replay has a new
  explicit identity and never moves the ordinary schedule cursor.
- Delivery history is durable and separate from active renderer state. A user
  interaction resolves its exact persisted Delivery request, commits a
  Feedback View first, and only then dispatches an idempotent interaction
  command. Delivery failure never rewrites execution status.
- Ambient trace is a strict append-only correlation timeline, not best-effort
  logging. Trigger evidence, context authorization decisions, Agent runtime
  events, exact result or Failure Views, Delivery outcomes, Feedback Views,
  durations, and explicit attempt links must survive restart. Context,
  execution, validation, commit, delivery, finalization, and trace failures use
  distinct stages and codes.
- The current macOS direct-assist slice freezes Accessibility context at
  shortcut activation, uses Doubao realtime ASR, and sends prompt plus immediate
  context to `/ambient/v1/assist`. It does not poll Delivery, create Views, or
  register MCP tools. Missing Doubao configuration, denied Accessibility,
  failed ASR, and missing selection remain distinct observable outcomes; Apple
  Speech is not a fallback.
- Explicit notch or voice activation resolves selected text across native,
  browser, Electron, terminal, and PDF Accessibility shapes through direct
  selected text, character ranges, text-marker ranges, and a bounded descendant
  search of at most 120 elements over 12 levels. Periodic macOS observation
  remains focused-element-only and must not inherit that traversal cost. Agent
  context preserves selection whitespace;
  only the one-line UI preview may normalize it. Unsupported or inaccessible
  application text remains explicitly unavailable and never triggers a hidden
  clipboard mutation.
- Holding Right Option starts push-to-talk and releasing it submits. The notch
  remains docked for listening, transcription, and Agent work, then expands only
  when the turn reaches terminal success or failure. If the user starts a typed
  turn while the notch is already expanded, its answer and tool activity remain
  visible there. If the turn starts docked, or the user docks it while work is in
  progress, text deltas and tool updates must not expand it again. Direct
  text-only turns reveal Markdown after a short tool-detection buffer and then
  stream normally whenever the notch is already open.
  Once a turn emits a native ACP or Pi tool call, the notch suppresses provisional
  answer text, displays bounded per-tool running/completed/failed activity, and
  appends only the complete final answer. Tool ids, names, kinds, titles, and
  status are observable; raw tool input and result content are not sent to the UI.
  A completed launch event for a tool with `run_in_background=true` remains
  visually running until the containing conversation reaches terminal completion.
  The composer is the bottom-most surface and
  sent-message bubbles size to their content up to the conversation width.
  Assistant content uses a CommonMark block renderer so headings, paragraphs,
  lists, links, and code retain structure while streaming.
  The native request has a 900-second final hard deadline; this does not replace
  disconnect cancellation or Agent/session lifecycle completion.
  Each selected conversation and each new user turn declaratively anchors its
  latest user message at the top of the conversation viewport after that row is
  laid out. Streaming answer deltas never force-follow the bottom; after the
  turn anchor, scrolling remains under user control.
- The native notch supports multiple direct conversations over the resident
  Agent process. Each `conversation_id` independently owns messages, stream
  buffering, tool activity, phase, and in-flight state; callbacks update their
  frozen conversation even after the user navigates elsewhere. Conversation
  history is local UI state and defaults to the most recently updated entry on
  launch. A background completion updates its entry without switching or opening
  the visible conversation. Voice targets the current default conversation and
  creates a new one when that conversation is already working.
  Conversation navigation uses an in-panel switcher rather than an AppKit
  popover window, so selection never waits for a popover-close animation. It
  closes the switcher before replacing content and
  lazily materializes message rows. Assistant messages cache their parsed
  CommonMark content. Selecting or creating a conversation replaces content
  immediately, then recalculates the top-anchored panel on the next main-loop
  turn so SwiftUI content diff and AppKit window layout do not block the same
  click transaction. The panel still adapts in both directions between short
  and long histories. The click path must not reset the conversation subtree
  identity.
  Conversation replacement does not animate or apply a content transition to
  the Markdown subtree, and picker timestamps are static labels rather than
  timeline-driven relative `Text`. Visible text deltas are coalesced to one
  render per 50 ms while terminal completion synchronously flushes the exact
  final answer; tool mode, failure, reset, and completion cancel pending render
  tasks.
  Conversation selection and new-turn navigation use a one-shot scroll after
  the latest user row enters layout. A persistent scroll-position id must not
  cross conversation boundaries. The default viewport materializes only the
  current turn; earlier messages remain available behind an explicit history
  expansion control and must not be constructed on every conversation switch.
- Conversation history is durable UI data in the atomic
  `~/Library/Application Support/Metaflow/conversations-v1.json` file, not in a
  bundle-id preference domain. The store reads this stable file first, migrates
  current or legacy preferences only when it is absent, and fails on malformed
  data instead of substituting an empty history.
- Expanded/docked notch presentation synchronously commits presentation and
  top-anchored window geometry. There is no timer, snapshot, or delayed
  animation state that can diverge from the live SwiftUI tree. Streaming-only
  content height changes are throttled to one 33 ms update and equal frames are
  skipped. Structured presentation and conversation-navigation logs retain
  model commit duration, deferred content-resize duration, message count, and
  target height.
- macOS voice/TCC validation must run from the signed
  `~/Applications/Metaflow.app` produced by `pnpm mac:bundle` or `pnpm
  mac:run`. The raw SwiftPM executable does not bind `Info.plist` usage
  descriptions and is not valid evidence for Microphone behavior.
- CLI, HTTP, MCP, Web, and Agent tools must project the same future Core
  Operations instead of duplicating domain behavior.

## Debugging and changes

- Fail fast. Fix root causes and retain structured evidence on critical paths.
- Capture failures in the Chrome extension are written to
  `infoCaptureDeadLetters` in extension local storage and logged.
- Do not perform a large refactor on `main`; create a `codex/` branch first.
- Preserve user changes and generated local artifacts unless explicitly asked
  to remove them.
- Update this file and the canonical `wiki/architecture/` documents when the
  product model or package direction changes.
- Do not add an archived v0 package back to `pnpm-workspace.yaml`, root
  dependencies, default scripts, or `scripts/v1/run-tests.ts`. A deliberate
  migration must first name the v1 capability owner and add a boundary test.

The canonical target contract is
`wiki/architecture/view-core-transformation-runtime.md`. Existing v0 and
experimental v1 code are evidence, not authority over that design.

The canonical Ambient and Automation contract is
`wiki/architecture/ambient-automation-runtime.md`. Legacy
`packages/ambient-layer` and v0 Program attention code are migration evidence,
not the v1 runtime boundary.

## Verification

```bash
corepack pnpm typecheck
corepack pnpm check:boundaries
corepack pnpm test
corepack pnpm test:v1-vertical
```

`pnpm test` executes only the explicit active v1 manifest in
`scripts/v1/run-tests.ts`. Archived v0 tests are historical evidence, not a
release gate. The Chrome extension remains a separately built temporary
surface; do not claim its full typecheck passes until its documented migration
work and unrelated errors are resolved.

`pnpm test:personalized-view-workflow` is the deterministic Codex JSONL and
Obsidian Markdown acceptance boundary for Parser formation, natural-language
Transformation authoring, strict Agent output, Application Space composition,
keyword/internal/relation/semantic Search, Feedback evolution, restart/replay,
and Privacy Forget.

`pnpm smoke:personalized-sources --config <absolute-path>` is the opt-in real
personal-source acceptance boundary. With `workflow.enabled`, the same exact
pre-Forget Views must pass both an independent Claude Code ACP process plus a
staged project-level Metaflow skill gate and the real
Vite/React/Graphology/Sigma View Explorer gate.
The temporary Agent host rejects every undeclared Search request, exact View
read, or graph root/bound before `OperationService.execute`; the shared ACP
runtime closes and, when necessary, hard-kills a non-cooperative independent
Claude process within a bounded termination window. The browser
gate validates the exact Application Space root and working-state `view.get`
response before mounting and disposing the trusted Web Renderer Registry for
that same authorized View revision.
Neither gate may be replaced by synthetic evidence in the CLI smoke. A missing
or invalid Claude credential is an external failed gate, not permission to skip
Agent access or close its acceptance issue. Connector Marketplace/onboarding
UX and a natural-language authoring UI are explicitly deferred and are not
acceptance blockers; the code-first extension contracts remain canonical.
The Claude gate receives exact Search input templates but never the expected
View refs; those remain host-side validation evidence so the Agent must prove
discovery before exact reads. It must emit no assistant prose before its one
strict final JSON value; mixed prose/JSON remains an explicit failure.

ACP structured output is reconstructed by complete agent message identity:
chunks with the same `messageId` append across interleaved tool, plan, thought,
and usage updates; a fully unidentified v1 stream is one legacy message. Mixed
identified/unidentified chunks, non-text structured output, an invalid final
message, or any attempt to accept one parseable fragment fails explicitly.

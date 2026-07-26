---
name: architecture/observation-ingestion
title: Observation Ingestion
desc: A design draft for connecting external information to Metaflow through replaceable Connectors and one policy-governed Observation Ingress.
category: design-draft
tags: [observation, connector, ingestion, artifact, decode, provenance]
sources: [vision/dream-log, current-v0-inspection]
created: 2026-07-24T13:22:00Z
updated: 2026-07-24T16:44:48Z
---

# Observation Ingestion

> Status: partially superseded by [[architecture/view-model|View Model and View
> Algebra]]. Connector and ingress evidence remains useful, but the separate
> Observation/View type model and `Processor` terminology below are historical.

## Goal

External systems should be easy to connect without teaching Metaflow Core about
Chrome, Screenpipe, Notion, Obsidian, VS Code, WeChat, an iPhone, or future AI
glasses.

The stable boundary is:

```text
External system
→ Connector
→ candidate Observation + optional Artifact
→ Observation Ingress
→ immutable Observations
→ Processors, including Decode
→ extraction and task-specific Views
→ ViewGraph
```

## Four distinct objects

### Connector

Replaceable adapter code for one external protocol or product family.

Examples: Chrome extension, Screenpipe adapter, Notion API adapter, Obsidian
folder adapter, Apple Shortcuts inbox adapter.

### Source Connection

One configured installation of a Connector.

Examples:

- `chrome:personal-profile`;
- `notion:junjie-workspace`;
- `obsidian:research-vault`;
- `screenpipe:macbook-pro`;
- `icloud:iphone-screenshot-inbox`.

A Source Connection owns credentials, cursor/checkpoint, health, permissions,
privacy defaults, and capture policy. One Connector may have many Connections.

### Artifact

Immutable source material such as an image, audio segment, short video/timeline,
PDF, HTML snapshot, or file. Large binary content stays outside the Observation
body and is referenced by URI and digest.

### Observation

The smallest independently attributable unit directly emitted by a source and
admitted through Observation Ingress. It may reference raw Artifacts, but it is
never a Metaflow-derived interpretation, selection, aggregate, or timeline.

```text
observation.screen.frame
  └── Artifact: image/png
        ↓ Processor
View: extraction.image.ocr
View: extraction.image.description
        ↓ Processor
View: activity.episode / learning.material / project.context
```

If Screenpipe itself directly emits OCR text, that source assertion may arrive
as an Observation. If Metaflow runs OCR over a captured frame, the result is an
extraction View. The distinction is who asserted it at the system boundary, not
whether the payload contains text.

## Observation and View share a graph, not a lifecycle

The founder's intuition that an Observation is a foundational View is correct
as a graph metaphor: Observations are the evidence roots from which Views are
derived. It should not become a View subtype in the domain model.

They should still remain distinct domain types:

```text
Context Graph
├── ObservationNode
│   ├── smallest source-emitted evidence unit
│   ├── source and acquisition identity
│   └── immutable after ingress
└── ViewNode
    ├── extraction, selection, comparison, organization or interpretation
    ├── versioned lifecycle
    └── merge · split · fork · promote · retire
```

Making Observation a normal View would allow source evidence to be updated,
merged, or retired with derived interpretation. Keeping provenance traversal
separate would make cross-layer trace and search unnecessarily difficult. The
recommended composition is one ViewGraph that accepts immutable Observation
references as its roots and stores all derived nodes as Views.

This avoids adding a separate Context Graph product concept unless later usage
proves that name necessary.

## Proposed package boundary

The next-version design should begin from domain boundaries rather than preserve
v0 package names. The Observation area needs four capability owners:

```text
packages/
├── observation/    immutable Observations, Artifacts, ingress, query and trace
├── capture/        Connector and Source Connection lifecycle
├── processor/      Observation/View → View derivation contracts and runs
└── viewgraph/      all derived nodes, provenance and graph operations
```

Dependency direction:

```text
apps / source adapters
        ↓
capture → observation
              ↑
              │ reads roots
          viewgraph
              ↑ writes Views
              │
processor → observation + viewgraph
```

There is no direct `capture → viewgraph` write path. Capture may only create
Observations. Processors read Observation roots and existing Views, then write
new Views through ViewGraph.

### `observation`

This is the deep domain module and single owner of:

- Observation and Artifact schemas;
- `observation.ingest` and batch ingestion;
- schema/version validation;
- privacy and retention checks at ingress;
- deduplication and content integrity;
- immutable persistence ports;
- Observation get/query;
- `observation.ingested` and rejection/quarantine evidence.

Its small public interface should look conceptually like:

```text
ingest(candidate) → IngestionReceipt
ingestBatch(candidates) → IngestionBatchReceipt
get(observationId) → Observation
query(criteria) → ObservationPage
```

### `capture`

This package owns source connectivity, not evidence meaning:

- Connector manifests and registry;
- Source Connection configuration;
- authentication/capability declarations;
- push, pull, stream, reference and manual-import modes;
- cursors/checkpoints;
- health, pause/resume and backpressure;
- translation from source-native events to Observation candidates.

Source-specific adapters may begin as modules inside `capture/connectors/`.
Split one into its own package only when it has a different deployment runtime
or heavy dependencies. Chrome remains hosted by the browser extension; macOS
Accessibility remains hosted by the Swift companion; both speak the same
language-neutral ingress schema.

### `processor`

This package owns the runtime-neutral transformation contract, registry,
routing, Processor Runs, retry/failure evidence, and output validation. Decode
is one Processor family rather than a separate package or data layer:

```text
processor/
├── extraction/
│   ├── image-ocr
│   ├── image-description
│   ├── audio-transcript
│   ├── document-structure
│   └── browser-reader
├── temporal/
│   ├── key-frame-selection
│   ├── frame-change
│   └── screen-timeline
└── semantic/
    ├── activity-episode
    ├── project-cluster
    └── memory-candidate
```

Every one of these produces Views. The folders describe derivation depth, not
different top-level object types.

## Processor contract, implementation, and Worker

> Naming status: `Processor` is under review after
> [[vision/dream-log#v-016--challenge-the-processor-abstraction|V-016]]. The
> separation between result contract, responsible actor or implementation, and
> invocation remains useful, but a persistent Agent must remain a first-class
> actor rather than being hidden as only a Processor runtime kind.

The stable abstraction is the transformation contract, not the model, library,
service, or Worker that currently fulfills it:

```text
Processor contract
  consumes: observation.image + Artifact
  produces: extraction.image.ocr ViewSpec
  invariants: provenance, language, regions, source references
        │
        ▼
eligible Processor Implementations
  ├── source.screenpipe.ocr
  ├── local.apple-vision
  ├── local.open-source-ocr
  └── remote.multimodal-model
        │
        ▼
Processor Selection
  privacy + locality + latency + cost + quality + hardware + availability
        │
        ▼
Worker / Function invocation
        │
        ▼
Processor Run evidence + validated View
```

One Worker may host several related implementations. One implementation may be
an in-process function, an III Function in a TypeScript/Python/Rust Worker, an
HTTP adapter, a Workflow, or a long-lived Agent Session. Therefore neither a
model nor a Worker is the package or domain boundary.

III can provide cross-language function registration, Triggers, queues, and
delivery. Metaflow still owns Processor and ViewSpec schemas, eligibility and
selection policy, authorization, provenance, output validation, and run
records. This keeps the framework replaceable and prevents infrastructure state
from becoming the personal-data model.

Implementation choice must be observable. A Processor Run records the selected
implementation and version, reason, input references, policy decision, timing,
cost, output, and error. If policy permits another implementation after a
failure, that is a new explicit attempt linked to the failed attempt; it is not
a hidden fallback.

## Reusing source-native decoding

If a source already performed useful work, Metaflow should preserve and reuse
it:

```text
Screenpipe frame + source OCR
→ Connector
→ frame Observation referencing the screenshot Artifact
  + related source-OCR Observation
→ Observation Ingress
→ optional lightweight projection into extraction.image.ocr
→ task-specific Views
```

The default path does not run OCR a second time. A lightweight Processor may
project the source assertion into a canonical extraction View without invoking
another OCR model. Metaflow requests a different implementation only when the
task requires something the source output does not provide, such as another
language, higher quality, region geometry, a local-only privacy path, or
reprocessing with a newer decoder. The original source assertion and Artifact
remain immutable so outputs can be compared or regenerated later.

### `viewgraph`

This package consumes Observation roots and other Views. It owns all derived
nodes, source edges, provenance traversal, graph search, merge, split, fork,
promotion, retirement, and View lifecycle invariants. Typical View families
include:

```text
extraction.*   one-source interpretation such as OCR or transcript
selection.*    a chosen subset such as key frames
comparison.*   differences between two or more roots
timeline.*     an ordered temporal composition
activity.*     semantic episodes and work lanes
memory.*       durable task-useful compression
```

It never reaches directly into Connector implementations.

## App and adapter placement

```text
apps/
├── daemon/              composes Capture, Processors and triggers
├── chrome-extension/    browser-native capture host
├── mac/                Swift AX/screen/hotkey capture host
└── web/                  connection health and privacy controls

connectors/
├── screenpipe/
├── local-files/
├── git/
├── ai-sessions/
├── mcp-federated/
└── future service connectors
```

Notion, Calendar, photo-library and other connectors can be added without
changing `observation` or `viewgraph`; they only implement the Capture contract.

## Connector delivery modes

Many sources can connect directly, but not all sources should be copied or
handled in the same way.

| Mode | Examples | Connector behavior |
|---|---|---|
| Push | Browser/VS Code extension, webhook, macOS companion | Sends an Observation when an event occurs |
| Pull / sync | Notion, Calendar, GitHub, photo library | Polls changes using a durable cursor and emits deltas |
| Local stream | Screenpipe, Accessibility, microphone, filesystem watcher | Reads a local API/stream and emits bounded events |
| Federated reference | Notion/Obsidian/MCP/remote database | Stores identity and selected evidence; resolves full content only when needed |
| Manual import | Launch save, drag-and-drop, Apple Shortcut, inbox folder | Treats explicit user capture as a high-intent Observation |

Connectors may use HTTP, MCP, filesystem, stdio, webhook, or a native SDK.
Those transports are implementation details behind the same ingress contract.

## Observation Ingress

Every Connector calls one logical Core Operation:

```text
observation.ingest(candidate)
```

CLI, local HTTP, MCP, III Function, and in-process calls are adapters over that
same Operation. Connectors do not insert directly into the database.

Ingress performs, in order:

1. authenticate the Source Connection;
2. validate connector capability and Observation schema;
3. apply connection privacy and retention policy;
4. normalize source identity and timestamps;
5. store or reference Artifacts and verify digests;
6. deduplicate with a source event id or deterministic key;
7. append the immutable Observation;
8. emit `observation.ingested`;
9. schedule matching Processor work;
10. record success or failure with trace and connection health.

Unknown connector capabilities, schema versions, and privacy states fail
closed. Invalid evidence is quarantined with an observable error rather than
silently accepted or discarded.

## Minimal Observation envelope

```yaml
id: obs_...
schema:
  name: observation.browser.page
  version: 1
kind: event | text | image | audio | video | file | reference
source:
  connector_id: connector.chrome
  connection_id: chrome.personal
  external_id: optional-native-event-id
time:
  observed_at: when-it-happened
  captured_at: when-connector-saw-it
scope:
  user: ...
  device: ...
  app: ...
  project: ...
content:
  title: ...
  text: ...
  url: ...
artifacts:
  - artifact_id: artifact_...
privacy:
  level: private
  retention: normal
dedupe:
  key: ...
payload:
  schema-specific-fields: ...
```

The stable envelope stays small. Source-specific details live in versioned
`payload`; large media lives in Artifacts.

## Decode as an extraction Processor family

Decode reads Observation roots and writes extraction Views:

```text
Observation/Artifact
→ OCR | transcript | key frames | DOM extraction | entity extraction
→ extraction / selection / comparison / timeline Views
```

Examples:

- image Observation → `extraction.image.ocr` and
  `extraction.image.description` Views;
- audio Observation → `extraction.audio.transcript` and speaker Views;
- many screen-frame Observations → key-frame selection, frame-change, and
  `timeline.screen` Views;
- browser-page Observation → readable-text and structured-element Views;
- PDF Observation → document-text, image, and structure Views.

Decoding may happen locally or remotely according to privacy policy. It may run
eagerly for cheap/high-value paths or lazily when an Agent or downstream View
first needs it. A better decoder creates a new View version; it never rewrites
the Observation root.

## What Connectors must not do

- write Views directly;
- decide personal or project memory;
- cluster evidence into task meaning;
- bypass Observation Ingress or privacy policy;
- expose raw database access;
- silently swallow authentication, schema, cursor, or decoding failures;
- force all remote content to be copied locally.

## Current v0 evidence

The current code already contains useful pieces, but they do not yet share one
owned Connector contract:

- Chrome and macOS companion push records to `/context/ingest`;
- the mobile screenshot script constructs an Observation and Artifact itself;
- Screenpipe is queried and normalized through the CLI;
- `ContextRecord` already contains schema, source, time, scope, content,
  acquisition, privacy, relations, and payload;
- `ContextConnector` already contains produced schemas, defaults, permissions,
  and config.

These files are migration evidence, not architectural constraints. The next
version may rewrite packages and schemas from first principles, retaining only
behaviors and data that satisfy the new contracts.

## Open questions

- Which Decode paths run eagerly and which remain lazy?
- What is the smallest independently attributable capture unit for each source?
- How should source-provided OCR/transcripts be distinguished from Metaflow
  extraction Views?
- When should federated content be cached locally?
- How are connector credentials isolated from Agents and plugins?
- What retention defaults apply to continuous screen and audio capture?
- Does one Source Connection represent an account, a device, or either with an
  explicit source identity beneath it?

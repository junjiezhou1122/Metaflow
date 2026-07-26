# Context Pipeline Runtime

> Agent memory should be a pipeline, not a pile.

This document records the current design direction for `~/info`: a local-first
personal context runtime where raw observations enter once, then become useful
through replayable, provenance-preserving transformations.

## Core idea

The system should separate capture from understanding.

```text
Sensors capture raw observations.
Plugins transform context objects.
Views organize context.
Broker assembles task-scoped context packs for agents.
```

Capture should stay simple, fast, reliable, and local-first. Most interpretation
should happen later in an asynchronous pipeline.

## Core objects

### ContextRecord

A single captured fact or observation.

Examples:

- `observation.browser_page_snapshot`
- `observation.browser_text_selected`
- `observation.screenpipe_activity`
- `observation.local_project`
- large raw blobs or extracted files should be `ContextArtifact` or `extraction.*` Views, not legacy derived-prefix records

Interpretation should normally be written as a `ContextView`, not as a derived
record. For example, content classification is `analysis.content_classification`
because it is inferred meaning over an Observation.

### ContextArtifact

A pointer to a large blob or external/local asset.

Examples:

- screenshot
- PDF
- audio
- HTML
- image
- local file

Records should reference artifacts instead of embedding large blobs.

### ContextView

An organized, compressed, indexed, or interpreted view over records, artifacts,
or other views.

Examples:

- `timeline.observations`
- `work_thread`
- `daily_digest`
- `analysis.content_classification`
- `app.language.learning_pack`
- `project_status`
- `meeting_summary`

`WorkThread` should conceptually be a `ContextView`, not a separate top-level
data model. Existing `work_threads` storage can remain as a legacy/materialized
index until migration is worth doing.

### RuntimeEvent

Append-only provenance for system behavior.

Examples:

- `record_ingested`
- `record_deduped`
- `plugin_run_started`
- `plugin_run_completed`
- `plugin_run_failed`
- `view_compiled`
- `context_pack_built`

Runtime events answer: what did the system do, when, why, and from which inputs?

### RuntimeState

Small current-state pointers and caches.

Examples:

- `active_work_thread_view_id`
- `last_tick`
- `daemon_status`

Runtime state should point to durable context objects instead of duplicating
their full content.

## Processing concepts

### Sensor / Connector

A sensor turns the external world into raw `ContextRecord`s.

Examples:

- browser extension
- Screenpipe
- git/local project snapshot
- AI session importer
- file watcher
- terminal sensor
- calendar connector

Sensors should not become heavy classifiers. They may record generic metadata,
but their main job is observation.

### Plugin / Transformer

A plugin consumes context objects and produces new context objects.

```text
ContextObject -> ContextObject
```

Examples:

- content classifier
- PDF parser
- video transcript extractor
- repo analyzer
- summarizer
- timeline compiler
- language-learning compiler

Plugins are processors, not data. Their outputs are stored as
`ContextRecord`, `ContextArtifact`, or `ContextView`.

### View compiler

A view compiler is a plugin whose output is a `ContextView`.

Examples:

- `timeline-compiler` -> `timeline.observations`
- `work-thread-builder` -> `work_thread`
- `daily-digest-compiler` -> `daily_digest`

### Pipeline Runtime

The pipeline runtime is the scheduler/runner. It is not itself a plugin.

Responsibilities:

1. discover new or changed context objects;
2. match them to eligible plugins;
3. enforce privacy and permissions;
4. avoid duplicate runs;
5. run plugins;
6. write outputs;
7. write runtime events.

Unix analogy:

```text
ContextObject  = file / stream
Plugin         = grep / awk / jq / ffmpeg
PipelineRuntime = shell / pipe executor
ContextPack    = final task-scoped input for an agent
```


## Plugin, Skill, and View boundaries

A recurring design rule:

```text
Skill = how an agent does something.
Plugin = when/why the runtime does it, with permissions, provenance, storage, and reuse.
View = the persisted result that agents, UI, and other plugins can consume.
```

They are related but not the same thing.

### Skill

A skill is an execution recipe or capability available to an agent.

Examples:

- fetch YouTube captions;
- parse a PDF;
- crawl a website;
- summarize a paper;
- inspect a Git repository.

A skill is usually invoked for the current task or conversation. It may not have
its own triggers, storage policy, UI surface, or long-term provenance contract.

Example:

```text
User asks: summarize this PDF.
Agent uses a PDF skill.
Agent answers in the current conversation.
```

### Plugin

A plugin is a runtime module. It declares what it consumes, what it produces,
which triggers activate it, what permissions it needs, and where results are
written.

A plugin may package Programs, Applications, and permissions. Info should not
pick low-level agent skills by default. When deeper work is needed, it should
submit an AgentTask and let the external agent runtime decide which skills/tools
to use.

Example:

```text
pdf-research-plugin  // installed/enabled plugin, not default runtime path
  trigger: browser snapshot URL ends with .pdf
  submits: AgentTask(context_pack + output_contract)
  external agent runtime owns PDF/search/summary skills
  writes: extraction.pdf_text / paper.summary Views
```

### View

A view is not the plugin itself. A view is data produced by a plugin or compiler.

Example:

```text
coding-context plugin
  -> ContextView(view_type="coding_project_context")
```

The view can then be shown in UI, used by the broker, or consumed by another
plugin.

## Community plugin model

The core should stay small. It should define the substrate and protocol, not all
possible domain intelligence.

Core responsibilities:

```text
ContextObject schema
ContextStore
Trigger model
Runtime execution
Permissions
Provenance
Broker / ContextPack
```

Community/plugin responsibilities:

```text
coding context
PDF research
YouTube/video understanding
meeting summaries
language learning
finance digest
personal CRM
health/fitness summaries
project management
```

This keeps the product extensible:

```text
Every user has the same runtime core.
Different users install different context plugins.
```

Examples:

```text
youtube-context-plugin
  consumes: observation.browser_page_snapshot, ContextArtifact(video/url)
  submits AgentTask or runs its own compiler
  produces: extraction.video_transcript, video.summary Views

pdf-research-plugin  // installed/enabled plugin
  consumes: observation.browser_page_snapshot, ContextArtifact(pdf)
  submits AgentTask or runs its own compiler
  produces: extraction.pdf_text, paper.summary Views

coding-context-plugin
  consumes: observation.local_project, browser snapshots, ai sessions, runtime events, work_thread views
  submits AgentTask or runs its own compiler
  produces: project.current_context / coding.project_context Views
```

## Trigger-first routing instead of global classification

Do not start with one global classifier that tries to understand everything.
Prefer explicit trigger routing:

```json
{
  "id": "pdf-browser-trigger",
  "type": "event",
  "on": "record_ingested",
  "match": {
    "schema": "observation.browser_page_snapshot",
    "url_regex": "\\.pdf($|\\?)"
  },
  "action": {
    "kind": "run_plugin",
    "id": "pdf-research.extract"
  }
}
```

This is simpler and more extensible:

```text
Event happens.
Trigger matches.
Plugin runs.
Plugin writes records/views.
Those outputs can trigger more plugins.
```

Schedules are also triggers:

```json
{
  "id": "coding-context-every-5m",
  "type": "schedule",
  "on": "schedule_tick",
  "action": {
    "kind": "compile_view",
    "id": "coding-context.compile"
  }
}
```

The runtime can later map these to iii:

```text
plugin/view compiler -> iii registerFunction
trigger             -> iii registerTrigger
match/gate          -> iii condition_function_id
heavy work          -> TriggerAction.Enqueue(queue)
schedule            -> iii cron trigger
small state         -> iii state
```

## Coding context as an optional plugin

Coding support is important for this repository, but it should not be hard-coded
as a universal core concept.

Better model:

```text
Plugin: coding-context
  produces:
    - ContextView(view_type="work_thread")
    - ContextView(view_type="coding_project_context")
```

`work_thread` is task-oriented:

```text
What am I doing right now?
What evidence supports that?
What should happen next?
```

`coding_project_context` is project-oriented:

```text
Which project is active?
What files changed?
What tests/builds ran?
What browser references were recently used?
What AI sessions are relevant?
What decisions and next actions matter now?
```

A UI can group these views by project:

```text
Projects
  /Users/junjie/info
    active work thread
    current project state
    recent references
    test/build status
    next actions

  /Users/junjie/primoria
    active work thread
    recent localhost/browser evidence
    current TODOs
```

For coding agents, the broker should prefer compiled views first, then attach
supporting raw records:

```text
Active WorkThread View
  -> Coding Project Context View
  -> source_records / evidence
  -> ContextPack for Codex/Claude
```


## Data flow

```text
Sensor
  -> Raw ContextRecord
  -> Pipeline Runtime
  -> Plugin / Transformer
  -> ContextArtifact / ContextView
  -> Context Broker
  -> ContextPack
  -> Agent
```

Every processing output should be reusable as another plugin input.

```text
browser_page_snapshot
  -> analysis.content_classification
  -> extraction.video_transcript
  -> video.summary
  -> timeline.observations
  -> daily_digest
  -> agent ContextPack
```

## Provenance contract

Every derived artifact or view should identify its inputs and generator.

Recommended fields:

```json
{
  "source": {
    "type": "plugin",
    "connector": "plugin-id"
  },
  "relations": {
    "derived_from": ["input-context-object-id"]
  },
  "payload": {
    "plugin_id": "plugin-id",
    "plugin_version": "0.1.0",
    "run_id": "runtime-run-id",
    "input_hash": "sha256-of-normalized-input",
    "generated_at": "ISO timestamp"
  }
}
```

For views, use the existing `source_records`, `source_views`, and `compiler`
fields similarly.

## Capture strategy

The first capture layer should only collect raw information:

- URL, title, domain;
- visible DOM text when available;
- selected/copied text;
- dwell time and active time;
- scroll depth and scroll events;
- privacy flags;
- generic page metadata;
- source/provenance.

It should not hard-code lots of platform-specific understanding such as:

- `youtube.com` means video;
- `github.com` means repo;
- `x.com` means social post.

Those rules belong in later classifiers or plugin manifests. Capture may record
generic facts that help later processing, but should not become a large
classifier.

## Handling different content surfaces

Different surfaces require different later processors:

- normal web text -> browser snapshot / reader;
- video -> subtitle/transcript plugin;
- PDF -> PDF parser;
- image/canvas/WebGL -> Screenpipe OCR or visual processor;
- dashboard/console/local app -> browser snapshot + Screenpipe + local-only processors;
- virtualized list -> scroll sampling or UI-specific extractor;
- code repository -> repo analyzer;
- meeting/audio -> audio transcript + meeting summarizer.

This should happen after capture, based on context, user intent, privacy policy,
and available plugins.

## Current system mapping

Already present:

- browser extension sensor;
- Screenpipe connector draft;
- local project/git snapshot;
- AI session locator;
- SQLite `ContextStore`;
- `ContextRecord`;
- `ContextArtifact`;
- `ContextView`;
- `RuntimeEvent`;
- `RuntimeState`;
- Context Broker / ContextPack;
- timeline compiler;
- language-learning plugin;
- reader enrichment;
- runtime tick / daemon;
- short-window browser snapshot dedupe.

Concepts to converge:

- `WorkThread` -> `ContextView` with `view_type: "work_thread"`;
- candidate WorkThread proposals -> `work_threads` materialized index and `work_thread` view;
- thread evidence map -> `work_thread.content.evidence_map` unless it grows
  enough to deserve its own view.

## Minimal implementation path

Do not start by building every plugin. First make the runtime shape real.

1. Keep capture raw and reliable.
2. Define lightweight trigger/action types.
3. Evaluate triggers from `RuntimeEvent` + subject context object.
4. Compile a useful `work_thread` ContextView for coding as a first plugin-like built-in.
5. Make the broker prefer compiled views, then attach supporting raw records.
6. Record `trigger_matched`, `view_compiled`, and plugin run events.
7. Add idempotence with stable view IDs and input hashes where needed.

First success criterion:

```text
observation.browser_page_snapshot / local_project / ai_session
  -> RuntimeEvent(record_ingested or schedule_tick)
  -> Trigger match
  -> ContextView(work_thread)
  -> Broker ContextPack
```

`analysis.content_classification` is a View, not a Record. Prefer trigger-first plugin routing for durable runtime behavior.

# View-First Proactive Agent OS

This is the canonical architecture doctrine for Info's next stage. Older
documents remain useful background, but this document is the tie-breaker when
there is tension between program-centric, project-centric, memory-centric, and
view-centric language.

Info's memory model is Adaptive ViewGraph Memory:

```text
One observation
  -> many task-specific Views
  -> many future tasks
  -> feedback
  -> better Views, processors, apps, and routing
```

The system is not optimized for storing history. It is optimized for reducing
future search space. Different processors exist to produce different Views, and
different Views exist to help different tasks. Real task outcomes decide which
Views should be created, updated, forked, merged, split, retained, or retired.

## Architecture Invariants

Core owns protocols, not categories.

Info's kernel must not encode a closed ontology such as project/task/topic or
course/person/document as TypeScript enums. Domains emerge as registered view
families and processors. The stable loop is:

```text
Observation -> Processor -> View -> Action -> Observation
```

`feedback.*` and `memory.*` are not outside this loop. They are View families.
A user click, conversation correction, browser action result, or agent result
first appears as a new Observation. Processors can then turn that evidence into
`feedback.*`, `memory.candidate`, `memory.daily`, or `memory.profile` Views.

The practical rule is:

```text
New capability = ViewSpec(s) + ProcessorSpec(s) + optional UI/CLI rendering.
```

New application = ViewSpec(s) + ProcessorSpec(s) + app surface over the
ViewGraph.

It must not require:

```text
editing core domain enums
changing the ContextView storage schema
adding runtime switch-cases for a domain category
```

## Hybrid Work Routing

Proactive context uses a hybrid router instead of sending every observation to
an LLM.

```text
Raw observations
  |
  +--> processor.surface_state          // realtime, no LLM
  |       -> state.surface
  |
  +--> processor.route_candidate        // realtime rules, no LLM
  |       -> observation.route_candidate
  |
  +--> processor.work_router_batch      // scheduled batch / idle / on demand
          -> work.focus_set
          -> processor.project_current
              -> project.current
```

`state.surface` answers what is in front of the user right now. It fuses
browser, editor, media, and screen observations and must not wait for scheduled
AI consolidation.

`observation.route_candidate` is a machine intermediate. It stores extracted
features, candidate routes, rule hits, evidence fields, and numeric scores. It
does not store natural-language rationales.

`work.focus_set` groups recent route candidates into multiple active lanes such
as `project:/Users/junjie/info`, `topic:midscene`, and
`communication:messages`.

`project.current` is downstream from `work.focus_set`. It updates only from
strong, fresh, provenance-backed project lanes so unrelated browser pages and
message interruptions do not pollute project state.

## Core Objects

### Observation

An Observation is raw evidence. It records what happened, where it happened,
when it happened, and how it was acquired. It does not decide what the event
means.

Examples:

```text
observation.browser_page_snapshot
observation.editor.text_changed
observation.youtube.caption_state
observation.screenpipe_frame
observation.codex.message
feedback.output.edited
```

### Processor

A Processor consumes observations and/or views and produces observations,
views, events, or tasks. Processors can be deterministic code, local scripts,
LLM calls, external HTTP functions, ACP agents, iii workers, or long-running
background jobs.

The minimum processor contract is:

```ts
type ProcessorSpec = {
  id: string;
  consumes: {
    observations?: string[];
    views?: string[];
  };
  produces: {
    views?: string[];
    observations?: string[];
    events?: string[];
  };
  runtime: "local" | "llm" | "agent_task" | "http" | "cli";
  policy?: {
    speed?: "reflex" | "glance" | "think" | "work" | "background";
    autonomy?: "manual" | "suggest" | "draft" | "sandbox_auto" | "full_auto";
    privacy?: "inherit" | "private" | "workspace" | "public";
  };
};
```

### View

A View is a derived data product. It is compressed, interpreted, organized, or
application-ready state that other processors, agents, CLIs, and UIs can
consume.

Views remain open by namespace:

```text
state.surface
work.focus_set
project.current
task.background_research
result.browser_action
feedback.analysis.useful
advice.writing_assist
learning.youtube_fragment
brief.research
memory.daily
memory.profile
automation.outcome
```

The stored shape is still `ContextView`. The open fields that matter most are:

```ts
type ViewIdentity = {
  view_type: string;
  title?: string;
  summary?: string;
  source_records?: string[];
  source_views?: string[];
  purpose?: string;
  scope?: Record<string, unknown>;
  content?: Record<string, unknown>;
  stability?: "ephemeral" | "session" | "project" | "long_term";
  metadata?: Record<string, unknown>;
};
```

### ViewSpec

A ViewSpec describes a view family without forcing all instances into one rigid
schema. It is an operational contract for humans, agents, CLI tooling, and
processor diagnostics.

```ts
type ViewSpec = {
  view_type: string;
  title: string;
  purpose: string;
  lifecycle: "ephemeral" | "session" | "project" | "long_term";
  subject?: {
    description?: string;
    examples?: Array<Record<string, unknown>>;
  };
  producers?: Array<{
    id: string;
    kind: "processor" | "agent" | "manual" | "runtime" | "legacy";
  }>;
  consumes?: {
    observations?: string[];
    views?: string[];
  };
  content_schema?: unknown;
  examples?: Array<Record<string, unknown>>;
  default_query?: Record<string, unknown>;
  tags?: string[];
};
```

### ProcessorSpec

ProcessorSpec is the inspectable form of a processor declaration. It lets the
system answer:

```text
What can run?
What does it read?
What does it write?
How fast should it be?
How autonomous is it allowed to be?
Which outputs are unregistered or risky?
```

### ViewGraph

The ViewGraph is provenance and reuse:

```text
Observation A
  -> View X
  -> View Y
  -> Agent output Z
  -> Observation B
  -> feedback.* View
  -> memory.* View
```

Each view should preserve enough `source_records`, `source_views`, compiler
metadata, freshness, status, and scope to explain why it exists and how it was
produced. Agent-facing contracts should expose provenance summaries instead of
treating `confidence` as a universal quality signal.

Graph operations are first-class. A View family is extended in code with a
`ViewSpec` and optional processor, while a materialized View instance can be
operated through the agent CLI:

```bash
pnpm mf --json view upsert ./view.json --actor agent
pnpm mf --json view fork view:source --id view:task --view-type task.browser_brief --patch ./patch.json
pnpm mf --json view update view:task --status accepted --patch ./patch.json
pnpm mf --json view children view:source
pnpm mf --json view delete view:task --reason "superseded"
```

The default delete mode is archive. Hard delete is available for generated or
incorrect Views, but normal agent workflows should prefer archive so the graph
can still explain what happened.

The first built-in View Promotion Engine is:

```text
processor.view_promotion_engine
  -> view.promotion_candidates
```

It scans recent observations, materialized Views, and runtime events, then
proposes `create_view`, `update_view`, `combine_views`, `retire_view`, and
`create_processor` actions. It writes candidates rather than mutating the graph
directly, keeping adaptive memory evolution inspectable and reversible.

### Feedback

Feedback is another observation stream. It includes explicit user actions such
as dismiss, insert, edit, open, save, accept, reject, retry, and undo, plus
automation outcomes.

Feedback should update routing, surfacing, autonomy, and memory through
processors. It should not directly mutate old observations.

### Memory

Memory is not a separate storage primitive. Memory is a retained view whose
purpose is to change future behavior.

Memory is dynamic and editable. A processor, human, or authorized agent may
revise a memory View, but the revision must preserve provenance and audit
evidence. The first stable memory families are intentionally small:

```text
Observations / Views / Feedback
        |
        v
memory.daily      // one editable markdown-backed day record
        |
        v
memory.profile    // editable durable preferences, style, patterns, principles
```

`memory.daily` summarizes one calendar day's work, decisions, active projects,
useful context, and notable evidence. `memory.profile` is derived from daily
memories and explicit feedback, then curated into durable user preferences,
thinking style, workflow patterns, project principles, and stable context.

Candidate/gate processors can still exist as legacy or experimental
projections, but they are not the default memory contract for agents.

EverOS-style memory backends can be attached behind an adapter boundary, but
Info remains the source of truth for Views, provenance, and privacy policy.

Examples:

```text
memory.daily
memory.profile
```

Long-term memory needs higher standards than ordinary views: provenance,
stability, feedback, staleness, reversibility, and edit history.

## Built-In View Families Are Not Kernel Objects

Project and Personal Memory are important, but they are not kernel objects.
They are built-in view families that prove the protocol works.

```text
project.current
project.inbox
project.memory
project.tasks
project.decisions

memory.profile
memory.daily
```

This leaves room for non-programmer domains without changing the kernel:

```text
learning.youtube_fragment
advice.writing_assist
brief.research
automation.outcome
```

## Fast And Slow Paths

Processors declare speed because not every helpful action should run the same
way.

```text
reflex      milliseconds to ~1s, local state fusion, no LLM
glance      ~1-5s, lightweight summaries or simple rules
think       ~5-30s, LLM synthesis, side-panel/inbox output
work        multi-step agent work, explicit task or user-approved automation
background  long-running research, memory consolidation, scheduled jobs
```

Writing suggestions are not automatically intrusive just because they are fast.
The view and policy decide whether output is silent, inboxed, suggested, or
rendered inline.

## Scenario Test Matrix

The architecture must be tested through multiple domains so it does not become
project-only by accident.

| Scenario | Example observations | Example processors | Example views |
|---|---|---|---|
| Project / coding | `observation.codex.message`, `observation.browser_page_snapshot` | project context builder, decision extractor | `project.current`, `project.decisions`, `project.tasks` |
| Writing | `observation.editor.text_changed` | writing ambient processor | `advice.writing_assist`, `draft.writing_continuation` |
| YouTube learning | `observation.youtube.caption_state`, `observation.youtube.caption_fragment` | caption segmenter, review queue builder | `learning.youtube_fragment`, `learning.review_queue`, `memory.skill_gaps` |
| Web research | `observation.browser_page_snapshot`, `observation.browser_text_selected` | source extractor, brief builder | `research.source`, `brief.research`, `research.open_questions` |
| Personal memory | `feedback.output.edited`, `observation.codex.message` | preference updater, workflow pattern miner | `memory.preferences`, `memory.workflow_patterns`, `memory.agent_collaboration_style` |
| Current surface | `observation.browser_page_heartbeat`, `observation.screenpipe_frame` | surface state fusion | `state.surface` |
| Automation | `task.browser_action`, `feedback.automation_result` | automation planner, outcome recorder | `automation.plan`, `automation.outcome`, `memory.workflow_patterns` |

The tests should prove each scenario can register specs, declare processors,
query views, and show up in CLI output without editing the core schema.

## Adding a New View Family

Adding a new family is a protocol operation:

1. Register one or more ViewSpecs.
2. Register processors that consume observations/views and produce those
   view_types.
3. Add focused tests or scenario tests.
4. Optionally add UI/CLI rendering.

Example:

```ts
registerViewSpec({
  view_type: "learning.youtube_fragment",
  title: "YouTube Learning Fragment",
  purpose: "A timestamped caption fragment that can become review material.",
  lifecycle: "session",
  subject: {
    description: "Any YouTube video segment, not a core enum value.",
    examples: [{ type: "video", title: "Agent skills talk" }],
  },
  producers: [{ id: "processor.youtube_learning", kind: "processor" }],
  consumes: {
    observations: ["observation.youtube.caption_fragment"],
  },
  examples: [{
    view_type: "learning.youtube_fragment",
    content: {
      video_url: "https://youtube.com/watch?v=...",
      start_seconds: 120,
      end_seconds: 146,
      caption_text: "The relevant transcript text.",
      difficulty: "medium",
    },
  }],
});
```

No core object enum needs to know that YouTube, learning, captions, or videos
exist.

## Migration Rule

Existing `packages/views` compilers and catalog entries are legacy/reference
material. They should be adapted into ViewSpecs where useful, not deleted or
rewritten wholesale.

The migration direction is:

```text
legacy catalog entry -> ViewSpec
legacy compiler -> ProcessorDefinition / ProcessorSpec
legacy UI family list -> mf view / view-system registry
```

## Legacy Catalog Migration Notes

`packages/views/catalog.ts` is still allowed as compatibility material for
older UI and server routes. New work should not add more closed domain
assumptions there by default.

Use this rule:

```text
If the goal is to describe a view family, add or update a ViewSpec.
If the goal is to compile data, add or update a ProcessorDefinition/compiler.
If the goal is to present data, query the registry and stored ContextViews.
```

The migration can be incremental:

1. Convert existing catalog definitions through a legacy adapter.
2. Register new families directly in `@info/view-system`.
3. Move UI/CLI lists to the registry.
4. Keep old compilers working until their processor equivalents are ready.

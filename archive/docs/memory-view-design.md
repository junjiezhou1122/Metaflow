# Memory View Design

> Dedicated design note for how Info turns fixed observations into reusable,
> composable Memory Views.

## 1. Core Idea

Info should not treat memory as a raw storage problem.

The core model is:

```text
Observation
  -> EvidenceView
  -> ActivityView
  -> IntentView / WorkflowView
  -> Memory Views
  -> Agent / App consumption
```

More precisely:

```text
Fixed Observations
  -> normalized evidence nodes
  -> time/activity compression
  -> goal/workflow interpretation
  -> memory-oriented views
  -> consumed by agents, apps, and other compilers
```

The important separation:

```text
Observation = raw source of truth about what was captured
EvidenceView     = normalized evidence from one or more observations
VisualFrameView  = AI-compressed screen semantics from frame evidence
AudioView        = AI-compressed speech/transcript semantics from audio evidence
ActivityView     = time-based compression of evidence into "what happened"
ActivityBlockView= AI-compressed short work block from visual/audio/activity views
IntentView       = hypothesis about goal or task
WorkflowView     = structured task/session composed from activities and intents
MemoryView       = high-level memory-oriented View consumed by agents/apps
ProposalView     = control View that decides what Views should be created next
```

The system is therefore not a single summarizer. It is a View graph:

```text
Observation
  -> EvidenceView
  -> ActivityView
  -> IntentView
  -> WorkflowView
  -> Memory Views

Any View can become input to another View.
Agents and applications consume Views, not raw sensor logs by default.
```

## 2. Why Observation And View Must Be Separate

Observation is the source of truth.

It should record facts:

```text
browser heartbeat
selected text
screen OCR
UI click
app/window focus
local project snapshot
agent session pointer
```

It should not decide:

```text
what the user intended
whether something is important
which project this belongs to
whether this should become long-term memory
```

Those are inferences. They belong in Views.

This separation matters because the same Observation can support many different
Views:

```text
One YouTube watch session
  -> EvidenceView(kind="page")
  -> ActivityView(kind="resource_consumption")
  -> IntentView(kind="learning_candidate")
  -> WorkflowView(kind="learning_session")
  -> EpisodeMemoryView(kind="learning_episode")
  -> SemanticMemoryView(kind="learning_interest")
```

The original data stays fixed. The interpretations can evolve.

## 3. View As Compression Lens

A View is not just a summary.

A View is a typed compression result with a purpose.

Every View should answer:

```text
What did this compress?
Why was this compression useful?
What was preserved?
What was lost?
What queries can this View answer?
What queries should not use this View?
What source records/views prove it?
How confident is it?
When does it expire?
```

Minimal contract:

```ts
type ContextView = {
  id?: string;
  view_type: string;
  status?: "candidate" | "accepted" | "archived" | "rejected";

  source_records?: string[];
  source_views?: string[];

  compiler?: {
    id: string;
    version?: string;
    mode?: "deterministic" | "llm" | "hybrid";
  };

  purpose?: string;
  scope?: {
    project?: string;
    project_path?: string;
    repo?: string;
    domain?: string;
    app?: string;
    plugin_id?: string;
    time_range?: { start?: string; end?: string };
  };

  content?: Record<string, unknown>;
  confidence?: number;
  stability?: "ephemeral" | "session" | "project" | "long_term";
  lossiness?: "none" | "low" | "medium" | "high";
  validity?: {
    valid_from?: string;
    valid_until?: string;
    stale_after?: string;
  };
  metadata?: Record<string, unknown>;
};
```

## 4. View Layers

The View hierarchy should be explicit.

```text
L0 Observation
  raw evidence, not a View

L1 EvidenceView
  cleaned, normalized evidence

L2 ActivityView
  time-based compression of what the user did

L3 IntentView / TaskView
  hypothesis about what the user may be trying to do

L4 WorkflowView
  structured session or task flow

L5 MemoryView
  stable knowledge that should affect future behavior
```

### L0 Observation

Examples:

```text
observation.browser_page_heartbeat
observation.browser_text_selected
observation.screenpipe_activity_summary
observation.screenpipe_input_event
observation.screenpipe_workspace_signal
observation.local_project
```

Rules:

```text
immutable when possible
raw facts only
high volume allowed
not directly used as memory
```

### L1 EvidenceView

EvidenceViews normalize sensor-specific records into reusable evidence.

The preferred concept name is `EvidenceView`.

```text
EvidenceView
```

In storage, keep the View family simple:

```text
view_type = "evidence"
content.kind = "page" | "screen" | "focus" | "input" | "selection" | "project" | "agent_session" | "resource" | "other"
```

Do not create a new top-level `view_type` for every sensor-specific evidence
shape unless there is a strong product reason. New data sources should usually
extend `content.kind`, `content.subject`, `content.signals`, or
`content.data`.

Minimal content contract:

```ts
type EvidenceViewContent = {
  kind: string;
  observed_at: string;

  origin: {
    schema: string;
    source: string;
    connector?: string;
  };

  subject: {
    type?: string;
    app?: string;
    title?: string;
    window?: string;
    url?: string;
    domain?: string;
    path?: string;
    project?: string;
  };

  signals?: {
    text?: string;
    event?: string;
    selected_text?: string;
    duration_seconds?: number;
    frame_ids?: Array<string | number>;
    metrics?: Record<string, number>;
  };

  claims?: string[];
  quality?: {
    confidence?: number;
    reason?: string;
  };

  data?: Record<string, unknown>;
};
```

`claims` and `quality.confidence` are optional helper indexes. They should come
from deterministic source mapping, not LLM interpretation.

Example page evidence:

```json
{
  "view_type": "evidence",
  "title": "Stanford CS153 Frontier Systems - YouTube",
  "content": {
    "kind": "page",
    "observed_at": "2026-05-25T16:23:57Z",
    "origin": {
      "schema": "observation.browser_page_heartbeat",
      "source": "browser",
      "connector": "chrome-extension"
    },
    "subject": {
      "type": "page",
      "app": "Chrome",
      "title": "Stanford CS153 Frontier Systems - YouTube",
      "url": "https://www.youtube.com/watch?v=Lri2LNYtERM",
      "domain": "youtube.com"
    },
    "signals": {
      "duration_seconds": 26751,
      "metrics": {
        "scroll_depth": 0.54,
        "selection_count": 6
      }
    },
    "claims": ["page_visible", "resource_seen"],
    "quality": {
      "confidence": 0.9,
      "reason": "browser extension reported current page URL"
    }
  },
  "source_records": ["..."]
}
```

This layer should be mostly deterministic.
It should not say what the user intended. It only says what was observed and
what this evidence can directly support.

### L2 ActivityView

ActivityViews compress EvidenceViews over time.

They answer:

```text
What was the user doing during this interval?
```

Examples:

```text
ActivityView(kind="segment")
ActivityView(kind="resource_consumption")
ActivityView(kind="app_focus")
```

Suggested storage shape:

```text
view_type = "activity"
content.kind = "segment" | "resource_consumption" | "app_focus" | "debugging" | "coding" | "reading" | "other"
```

Example:

```json
{
  "view_type": "activity",
  "title": "Watched YC startup lecture",
  "content": {
    "kind": "resource_consumption",
    "start": "2026-05-25T14:11:27Z",
    "end": "2026-05-25T14:25:27Z",
    "duration_minutes": 14,
    "app": "chrome",
    "resource": {
      "type": "url",
      "url": "https://www.youtube.com/watch?v=...",
      "title": "Lecture 1 - How to Start a Startup"
    },
    "action": "watching_or_reading",
    "evidence_summary": {
      "browser_heartbeats": 53,
      "selected_texts": 2,
      "screen_frames": 3
    }
  },
  "source_views": ["evidence:..."],
  "confidence": 0.92,
  "lossiness": "medium"
}
```

This is the first layer that should drive the main timeline product.

### L3 IntentView / TaskView

IntentViews are hypotheses.

They should never pretend to be certain.

Examples:

```text
IntentView(kind="candidate")
TaskView(kind="thread")
work_thread
```

Suggested storage shape:

```text
view_type = "intent"
content.kind = "candidate" | "explicit_goal" | "task_thread" | "question" | "other"
```

Example:

```json
{
  "view_type": "intent",
  "title": "Possible study intent: startup/product feedback",
  "content": {
    "kind": "candidate",
    "hypothesis": "User may be studying startup and product feedback concepts.",
    "supporting_signals": [
      "14 minutes on YC startup lecture",
      "selected lecture title",
      "OCR contains product feedback and founder topics"
    ],
    "counter_signals": [
      "No explicit note was written",
      "No follow-up query yet"
    ]
  },
  "source_views": ["activity:..."],
  "confidence": 0.68,
  "lossiness": "high"
}
```

### L4 WorkflowView

WorkflowViews compose multiple activities and intents into a task/session.

Examples:

```text
WorkflowView(kind="learning_session")
WorkflowView(kind="research_session")
WorkflowView(kind="coding_session")
WorkflowView(kind="recipe")
WorkflowView(kind="trace")
WorkflowView(kind="attempt")
```

Suggested storage shape:

```text
view_type = "workflow"
content.kind = "learning_session" | "research_session" | "coding_session" | "recipe" | "trace" | "attempt" | "other"
```

Example:

```json
{
  "view_type": "workflow",
  "title": "YC startup lecture study session",
  "content": {
    "kind": "learning_session",
    "phases": [
      "watched lecture",
      "selected key text",
      "opened Info timeline",
      "discussed memory architecture"
    ],
    "topic_candidates": ["startup", "product feedback", "memory architecture"],
    "open_questions": ["How should ActivitySegment feed IntentView?"]
  },
  "source_views": ["activity:...", "intent:..."],
  "confidence": 0.74
}
```

### L5 MemoryView

MemoryView is a family name, not a single final artifact.

The important point is not "long-term only". The important point is:

```text
MemoryView = AI-compressed View that is meant to be consumed by an agent/app
```

Some MemoryViews are short-lived episode memories. Some are stable user or
project memories. Some are procedural memories. They can feed each other and
can be recompressed into higher-level MemoryViews.

Examples:

```text
MemoryView(kind="episode")
MemoryView(kind="semantic_fact")
MemoryView(kind="user_profile")
MemoryView(kind="project_context")
MemoryView(kind="workflow_recipe")
MemoryView(kind="agent_case")
MemoryView(kind="agent_skill")
MemoryView(kind="surfacing_policy")
```

Suggested storage shape:

```text
view_type = "memory"
content.kind = "episode" | "semantic_fact" | "user_profile" | "project_context" | "workflow_recipe" | "agent_case" | "agent_skill" | "surfacing_policy" | "other"
```

Entry conditions depend on the memory kind:

```text
episode memory:
  created when a meaningful activity/workflow unit closes

semantic/user/project memory:
  created or updated when stable facts/preferences/context are observed

procedural/skill memory:
  created when a workflow or agent case has reusable steps

policy/surfacing memory:
  created when feedback changes what should be shown, hidden, or routed

promotion to long-term:
  requires explicit user instruction, repetition, positive feedback, or reuse
```

Example:

```json
{
  "view_type": "memory",
  "title": "Info architecture pattern: Observation to View",
  "content": {
    "kind": "project_pattern",
    "claim": "The user prefers an architecture where raw observations remain fixed and multiple Views are generated through typed compression.",
    "applies_to": ["Info runtime", "memory architecture", "agent context"],
    "future_use": [
      "Prefer View-based derived state over mutating raw records",
      "Preserve provenance when summarizing user activity",
      "Do not treat timeline as memory directly"
    ]
  },
  "source_views": ["workflow:...", "brief.research:..."],
  "confidence": 0.84,
  "stability": "project",
  "lossiness": "high"
}
```

## 5. ProposalView As View Proposal

`MetaView` should not mean "metadata for a View".

In this system, if we use the word `MetaView`, it should mean:

```text
A proposal/control View that decides what Views should be created from existing observations/views.
```

Recommended concrete type:

```text
ProposalView
view_type = "proposal"
content.kind = "view_proposal"
```

Example:

```json
{
  "view_type": "proposal",
  "title": "Possible learning session around startup/product building",
  "content": {
    "kind": "view_proposal",
    "hypothesis": "These observations look like a focused learning session.",
    "scope": {
      "start": "2026-05-25T14:11:27Z",
      "end": "2026-05-25T14:25:27Z",
      "apps": ["chrome"],
      "domains": ["youtube.com"]
    },
    "proposed_views": [
      {
        "view_type": "resource",
        "kind": "learning_material",
        "priority": 0.9,
        "confidence": 0.93,
        "cost": "low",
        "decision": "materialize_now",
        "reason": "continuous YouTube dwell with selected title text"
      },
      {
        "view_type": "intent",
        "kind": "candidate",
        "priority": 0.7,
        "confidence": 0.68,
        "cost": "medium",
        "decision": "defer_or_agent",
        "reason": "intent is plausible but not explicit"
      },
      {
        "view_type": "workflow",
        "kind": "learning_session",
        "priority": 0.55,
        "confidence": 0.5,
        "cost": "medium",
        "decision": "defer",
        "reason": "needs more evidence from notes, searches, or chat"
      }
    ]
  },
  "source_views": ["activity:..."],
  "compiler": {
    "id": "program.view_proposal",
    "mode": "hybrid"
  },
  "confidence": 0.78,
  "stability": "session"
}
```

ProposalView answers:

```text
What can be compressed next?
Why is it worth doing?
Which ViewType should be used?
Should it be materialized now, deferred, rejected, or sent to an agent?
```

## 6. View Composition

Views should compose through `source_views`, not by copying entire upstream
content.

Preferred provenance path:

```text
MemoryView
  -> WorkflowView
  -> IntentView
  -> ActivityView
  -> EvidenceView
  -> observation.browser_page_heartbeat
```

This keeps high-level Views compact while preserving explainability.

Composition rules:

```text
L1 EvidenceView can cite raw observations directly.
L2 ActivityView should cite L1 EvidenceViews plus key records.
L3 IntentView should cite L2 ActivityViews.
L4 WorkflowView should cite L2/L3 Views.
L5 MemoryView should cite L4/L3 Views, not thousands of raw records.
```

Agents and applications should normally consume the highest View that matches
their job:

```text
timeline UI       -> ActivityView + selected EvidenceView attribution
debug inspector   -> EvidenceView
daily summary     -> ActivityView / WorkflowView
coding assistant  -> WorkflowView / work_thread / MemoryView
preference router -> MemoryView / ProposalView
external answer   -> local Views + external extraction Views
```

Raw Observations remain available for audit and recompilation, but they are not
the default interface for agents.

## 7. Query Answering With Memory Views

User questions should retrieve multiple View families.

Example:

```text
Question: "我刚刚在研究什么？"

Retrieve:
  ActivityView
  EvidenceView
  IntentView
  WorkflowView
  brief.research
  MemoryView

If missing source content:
  external retrieval
  -> source.content / extraction.video_transcript
  -> answer
```

Answer output should include:

```ts
type MemoryAnswer = {
  answer: string;
  confidence: number;
  used_views: string[];
  used_records: string[];
  external_sources?: string[];
  missing_context?: string[];
};
```

External retrieval should not bypass Views.

It should write:

```text
source.content
extraction.reader_snapshot
extraction.video_transcript
```

Then the answer uses those Views.

## 8. Deterministic First, Agent When Needed

Not every View needs an LLM.

Deterministic:

```text
EvidenceView
ActivityView
source URL normalization
duration / dwell calculations
basic proposal rules
```

Hybrid / agent:

```text
IntentView
WorkflowView
brief.research
MemoryView
contradiction detection
view proposal prioritization
```

Rule:

```text
Use deterministic compilers for structure.
Use agents for ambiguous meaning.
```

This should be read as a compiler strategy rule, not as a product shortcut.
The current deterministic `IntentView`, `WorkflowView`, and `MemoryView`
builders are scaffolding. They are useful for proving the graph and UI, but
they are not the final intelligence layer.

### 8.1 What EverCore / HyperMem Suggest

EverCore and HyperMem both use a similar pattern:

```text
raw stream
  -> LLM boundary detection
  -> compact event unit
  -> type-specific LLM extractors
  -> retrieval indexes / graph / later consolidation
```

EverCore names the compact event unit `MemCell`.

```text
conversation messages
  -> MemCell boundary detection
  -> EpisodeMemory
  -> AtomicFact
  -> Profile
  -> Foresight
  -> AgentCase
  -> AgentSkill
```

HyperMem names the hierarchy differently:

```text
conversation
  -> Episode
  -> Topic
  -> Fact
  -> hypergraph edges
  -> coarse-to-fine retrieval
```

The transferable lesson is not the exact names. The lesson is:

```text
Do cheap structure first.
Use AI where the system must decide semantic boundaries, intent, importance,
future usefulness, or reusable patterns.
Store each AI result as a typed View with provenance.
```

### 8.2 Compression Strategy By View

Info should treat each View family as having its own compression strategy.

```text
EvidenceView
  mode: deterministic
  input: Observation
  job: normalize source-specific records into auditable evidence
  reason: this is attribution, not interpretation

ActivityView
  mode: deterministic first, hybrid later
  input: EvidenceView
  job: merge nearby evidence into time/activity blocks
  reason: duration, app, URL, and focus windows are mostly structural

ProposalView
  mode: deterministic + heuristic
  input: ActivityView
  job: decide which expensive View compilers are worth running
  reason: it is a cost-control and routing View

ResourceView
  mode: deterministic + external retrieval
  input: EvidenceView / ProposalView / URL
  job: normalize resources and enrich missing source content
  reason: URL/title/domain are structural; content extraction may call external tools

IntentView
  mode: llm / agent
  input: ActivityView + ResourceView + recent user prompts
  job: infer what the user was probably trying to do
  reason: intent is ambiguous and cannot be reliably rule-derived

WorkflowView
  mode: llm / agent
  input: ActivityView + IntentView + ResourceView
  job: compress a working session into steps, decisions, blockers, outputs
  reason: workflow structure requires semantic judgment

MemoryView
  mode: llm / agent + promotion gates
  input: ActivityView / IntentView / WorkflowView / existing MemoryView
  job: create or update agent-consumable memory views
  reason: memory requires semantic compression, not just structural grouping
```

### 8.3 When To Compress

Compression should not run only because new data exists. It should run when
the input has become a useful unit.

Recommended triggers:

```text
Observation -> EvidenceView
  immediately or on short runtime tick
  cheap and deterministic

EvidenceView -> ActivityView
  every runtime tick
  after enough elapsed time
  when app/domain/project changes

ActivityView -> ProposalView
  after ActivityView creation
  cheap gate for later expensive work

ProposalView -> IntentView
  when activity duration is meaningful
  when there is a resource, selection, prompt, or repeated focus
  when user asks "what was I doing?"

IntentView + ResourceView -> WorkflowView
  when a focus block closes
  when app/project/domain changes
  at session end
  on explicit user request

WorkflowView -> MemoryView
  when a meaningful workflow/session closes
  when repeated across sessions
  when explicitly confirmed by the user
  when reused successfully by an agent
  during daily/session consolidation

Views + external retrieval -> query response
  on user query
  answer can be ephemeral for now; no first-class AnswerView yet
```

This creates two loops:

```text
online loop:
  cheap deterministic Views keep the UI and timeline current

consolidation loop:
  slower AI compilers turn meaningful closed units into Intent, Workflow,
  and Memory Views
```

### 8.4 Compression Registry

The implementation should move toward a registry rather than hard-coded
compiler calls.

```ts
type CompressionStrategy = {
  id: string;
  output_view_type: string;
  output_kind: string;
  input_view_types: string[];
  mode: "deterministic" | "llm" | "agent" | "hybrid";
  trigger: string;
  prompt_id?: string;
  max_input_views?: number;
  cost: "low" | "medium" | "high";
  promotion?: {
    required_repetition?: number;
    requires_user_confirmation?: boolean;
    requires_successful_reuse?: boolean;
  };
};
```

Example:

```ts
{
  id: "ai.workflow.session.v1",
  output_view_type: "workflow",
  output_kind: "research_session",
  input_view_types: ["activity", "intent", "resource"],
  mode: "llm",
  trigger: "focus_block_closed OR session_end OR explicit_request",
  prompt_id: "workflow_session_v1",
  max_input_views: 40,
  cost: "medium"
}
```

Every AI-compressed View should record:

```text
compiler.id
compiler.version
compiler.mode
prompt_id
model/provider if applicable
source_views
source_records only when directly cited
lossiness
confidence or quality note
```

## 9. Lifecycle

View lifecycle:

```text
candidate
  -> accepted
  -> archived
  -> rejected
```

Additional validity:

```text
valid_from
valid_until
stale_after
```

MemoryView should only become long-term when it survives feedback or reuse.

```text
single signal        -> candidate
repeated / confirmed -> accepted
unused / stale       -> archived
wrong                -> rejected
```

## 10. First Implementation Slice

The first slice should be:

```text
Observation
  -> EvidenceView
  -> ActivityView
  -> ProposalView
```

Then:

```text
ProposalView
  -> ResourceView(kind="learning_material")
  -> IntentView
```

Only after that:

```text
WorkflowView
  -> MemoryView(kind="project_pattern")
  -> MemoryView(kind="learning_interest")
```

Do not start by generating long-term memory directly from raw observations.

## 11. Naming Recommendations

Use human-facing concept names for architecture discussion:

```text
EvidenceView
ActivityView
IntentView
TaskView
WorkflowView
MemoryView
ProposalView
ResourceView
```

Use simple storage `view_type` families where possible:

```text
evidence
activity
intent
task
workflow
memory
proposal
resource
```

Use `content.kind` for specialization:

```text
EvidenceView:
  view_type = evidence
  content.kind = page | screen | focus | input | selection | project | agent_session | resource | other

ActivityView:
  view_type = activity
  content.kind = segment | resource_consumption | app_focus | debugging | coding | reading | other

IntentView:
  view_type = intent
  content.kind = candidate | explicit_goal | task_thread | question | other

WorkflowView:
  view_type = workflow
  content.kind = learning_session | research_session | coding_session | recipe | trace | attempt | other

MemoryView:
  view_type = memory
  content.kind = episode | semantic_fact | user_profile | project_context | workflow_recipe | agent_case | agent_skill | surfacing_policy | other
```

This keeps the graph easy to query:

```text
find all evidence        -> view_type = evidence
find screen evidence     -> view_type = evidence AND content.kind = screen
find all memory          -> view_type = memory
find user preferences    -> view_type = memory AND content.kind = user_preference
```

Backward compatibility:

Existing names can remain while the system migrates. They are concrete product
views or legacy names, not the long-term conceptual naming style.

Keep:

```text
timeline.activity
timeline.observations
project.current_context
brief.research
memory.*
routing.shortcut
analysis.browser_page
extraction.reader_snapshot
app.language.learning_pack
work_thread
```

Add:

```text
evidence
activity
proposal
intent
workflow
memory
resource
answer
source.content
extraction.video_transcript
```

Gradually migrate:

```text
analysis.browser_agent_task -> analysis.browser_page
project_timeline            -> timeline.project
thread.active_work          -> work_thread or activity/workflow View
thread.display_card         -> app/thread UI View
advice.browser_ambient      -> analysis/advice namespace only if reused
```

## 12. Current Implementation Contract

The runtime now materializes the new View family design directly:

```text
Observation
  -> EvidenceView   view_type = evidence
  -> ActivityView   view_type = activity
  -> ProposalView   view_type = proposal
  -> ResourceView   view_type = resource
  -> IntentView     view_type = intent
  -> WorkflowView   view_type = workflow
  -> MemoryView     view_type = memory, only after promotion rules
```

Implementation files:

```text
packages/views/evidence/evidence-view.ts
  deterministic Observation -> EvidenceView compiler

packages/views/_shared/memory-views.ts
  EvidenceView -> ActivityView compiler
  ActivityView -> ProposalView compiler
  ProposalView -> ResourceView compiler
  ProposalView -> IntentView compiler
  IntentView + ResourceView + ActivityView -> WorkflowView compiler
  repeated WorkflowView topic -> MemoryView compiler
  MemoryView builder contract

src/runtime/runtime.ts
  runtime tick compiles evidence, activity, proposal, resource, intent,
  workflow, then memory

packages/ui/src/main.tsx
  displays current View family counts in the Timeline page
```

The current `EvidenceView` content shape is:

```ts
{
  kind: "page" | "screen" | "focus" | "input" | "selection" | "project" | "agent_session" | "resource" | "other";
  observed_at: string;
  origin: {
    schema: string;
    source: string;
    connector?: string;
  };
  subject: {
    type?: string;
    app?: string;
    title?: string;
    window?: string;
    url?: string;
    domain?: string;
    path?: string;
    project?: string;
  };
  signals?: {
    text?: string;
    event?: string;
    selected_text?: string;
    duration_seconds?: number;
    frame_ids?: Array<string | number>;
    metrics?: Record<string, number>;
  };
  claims?: string[];
  quality?: {
    confidence?: number;
    reason?: string;
  };
  data?: Record<string, unknown>;
}
```

The current `ActivityView` content shape is:

```ts
{
  kind: "resource_consumption" | "app_focus" | "coding" | "segment";
  start: string;
  end: string;
  duration_minutes: number;
  app?: string;
  domain?: string;
  project?: string;
  resource?: {
    type: "url";
    url: string;
    title?: string;
    domain?: string;
  };
  action: "watching_or_reading" | "using_app" | "working_in_project" | "working_or_browsing";
  evidence_summary: {
    evidence_views: number;
    kinds: Record<string, number>;
    origins: Record<string, number>;
    frame_ids?: string[];
  };
}
```

The current `ProposalView` content shape is:

```ts
{
  kind: "view_proposal";
  hypothesis: string;
  scope: {
    start?: string;
    end?: string;
    apps?: string[];
    domains?: string[];
  };
  proposed_views: Array<{
    view_type: "resource" | "intent" | "workflow" | string;
    kind: string;
    priority: number;
    confidence: number;
    cost: "low" | "medium" | "high";
    decision: "materialize_now" | "defer_or_agent" | "defer" | "reject";
    reason: string;
  }>;
}
```

The current `ResourceView` content shape is:

```ts
{
  kind: "learning_material" | "web_resource" | string;
  resource: {
    type: "url" | string;
    url: string;
    title?: string;
    domain?: string;
  };
  observed_activity: {
    start?: string;
    end?: string;
    duration_minutes?: number;
    action?: string;
  };
  evidence_summary?: Record<string, unknown>;
  use_cases: string[];
  proposal: {
    decision?: string;
    reason?: string;
    priority?: number;
  };
}
```

The current `IntentView` content shape is:

```ts
{
  kind: "candidate";
  hypothesis: string;
  supporting_signals: string[];
  counter_signals: string[];
  suggested_workflow_kind: "learning_session" | "research_session" | "coding_session" | string;
  proposed_by?: string;
}
```

The current `WorkflowView` content shape is:

```ts
{
  kind: "learning_session" | "research_session" | "coding_session" | string;
  phases: string[];
  topic_candidates: string[];
  open_questions: string[];
  activity: {
    kind?: string;
    start?: string;
    end?: string;
    duration_minutes?: number;
    action?: string;
  };
  resources: Array<Record<string, unknown>>;
  intent: {
    hypothesis?: string;
    confidence?: number;
  };
}
```

The current automatic `MemoryView` compiler is intentionally strict:

```text
single WorkflowView topic      -> no MemoryView
repeated WorkflowView topic(s) -> MemoryView(kind="learning_interest")
```

Current generated `MemoryView` content extends the minimal contract with
promotion evidence:

```ts
{
  kind: "learning_interest";
  claim: string;
  applies_to: string[];
  future_use: string[];
  evidence: {
    workflow_count: number;
    workflow_titles: string[];
  };
}
```

## 13. MemoryView Catalog

`MemoryView` is the family of AI-compressed Views that agents/apps consume as
memory. It is not only the final long-term layer.

Some MemoryViews are near-term, like episode memory. Some are stable, like user
profile or project context. Some are reusable procedures, like workflow recipes
or agent skills.

Recommended `content.kind` catalog:

```text
episode
  A compressed record of one meaningful activity/session.
  Example: "The user compared EverCore and HyperMem to design Info's View system."

semantic_fact
  A stable fact extracted from one or more episodes/workflows.
  Example: "EverCore uses MemCell boundary detection before memory extraction."

user_profile
  A user preference, trait, goal, or working style.
  Example: "The user prefers simple schemas with family + kind over many top-level view types."

project_context
  Stable project architecture, conventions, constraints, or current direction.
  Example: "Info keeps Observations fixed and generates purpose-specific Views."

workflow_recipe
  A reusable way to perform a task.
  Example: "When changing View compilers, write tests first, then update runtime, then verify UI."

agent_case
  A compressed record of how an agent handled one task.
  Example: "The agent inspected EverCore extractors, then updated the design doc."

agent_skill
  A reusable skill or procedure distilled from multiple cases.
  Example: "For memory-system design, inspect boundary detection, extractors, prompts, and retrieval."

surfacing_policy
  A learned rule for showing, hiding, ranking, or routing Views.
  Example: "Hide low-level Screenpipe recorder activity by default, keep it available in debug."
```

Minimal `MemoryView` content:

```ts
{
  kind: string;
  summary: string;
  extracted_from: string[];
  use_for: string[];
}
```

Promotion rule:

```text
EvidenceView and ActivityView can be deterministic candidates.
IntentView and WorkflowView can be agent hypotheses.
MemoryView can be created from meaningful closed units.
Only the stable subset should be promoted to long-term behavior-changing memory.
```

## 14. Summary

The design should preserve this invariant:

```text
Raw observations stay fixed.
Compression creates purpose-specific View nodes.
Views compose through provenance.
ProposalView decides what to materialize.
Agents and apps consume Views by default.
Only durable, useful, behavior-changing Views become MemoryViews.
```

Short version:

```text
Observation is raw source of truth.
EvidenceView is normalized evidence.
ActivityView is what happened over time.
IntentView is a hypothesis.
WorkflowView is task/session structure.
ProposalView is control.
MemoryView is reusable behavior-shaping knowledge.
```

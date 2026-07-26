# Adaptive ViewGraph Memory

Info is a dynamic and adaptive memory system.

It does not store the past as a pile of searchable history. It learns
task-specific representations that make future work cheaper.

```text
One observation
  -> many possible processors
  -> many task-specific Views
  -> many future tasks
  -> feedback
  -> better Views and processors
```

## Core Thesis

Different processors exist to create different Views.

Different Views exist to serve different tasks.

Different tasks verify whether those Views actually reduced future search.

The system uses observations and task distribution to infer:

- which Views should exist
- which Views should be updated
- which Views should be forked for a task
- which Views should be merged
- which Views should be split
- which Views should be retired
- which processors need to be created or improved

The goal is not perfect recall. The goal is lower future search cost and better
task outcomes.

## Why This Is Not RAG

Traditional retrieval systems usually do this:

```text
history -> chunks -> embeddings -> retrieve later
```

Info does this:

```text
experience
  -> task discovery
  -> processor selection or creation
  -> task-specific View generation
  -> future task execution
  -> search-cost feedback
  -> ViewGraph and processor evolution
```

RAG stores the past for retrieval. Info learns task-specific representations to
reduce future search.

## The Loop

```text
┌──────────────────────┐
│ Observation Stream    │
│ conversations, code,  │
│ browser, Screenpipe,  │
│ docs, failures        │
└───────────┬──────────┘
            ▼
┌──────────────────────┐
│ Task Discovery        │
│ recurrence, search    │
│ cost, failures, reuse │
└───────────┬──────────┘
            ▼
┌──────────────────────┐
│ Dynamic Processors    │
│ rules, LLM, scripts,  │
│ agents, ACP, batches  │
└───────────┬──────────┘
            ▼
┌──────────────────────┐
│ ViewGraph             │
│ task-specific compact │
│ states with evidence  │
└───────────┬──────────┘
            ▼
┌──────────────────────┐
│ Future Tasks / Apps   │
│ learning, research,   │
│ project, browser work │
└───────────┬──────────┘
            ▼
┌──────────────────────┐
│ Verification          │
│ steps, time, tokens,  │
│ success, edits        │
└───────────┬──────────┘
            ▼
┌──────────────────────┐
│ Evolution             │
│ create, update, fork, │
│ merge, split, retire  │
└──────────────────────┘
```

## Observations

Observations are raw experience. They are not yet memory.

Examples:

- a conversation with an agent
- a browser page snapshot
- a Screenpipe OCR or audio item
- a code edit
- a terminal error
- a failed automation
- a paper, note, or decision
- a user edit or rejection

The same observation can contribute to many Views.

One conversation might update:

```text
project.current
work.focus_set
task.background_research
memory.daily
memory.profile
method.view
failure.view
agent.case_memory
```

## Processors

A processor is a representation maker.

It consumes observations and/or Views, then produces observations, Views,
events, or tasks.

Processors can be:

- deterministic TypeScript functions
- shell commands
- local scripts
- LLM prompts
- Claude Code tasks
- Codex tasks
- ACP browser tasks
- HTTP functions
- scheduled batch jobs

Processors should be dynamic. When the system needs a new kind of future
compression, an agent can create or improve a processor.

The minimum question for a processor is:

```text
What future task does this processor make cheaper?
```

## Views

A View is a task-specific compressed representation.

It is not just a summary. It is a coordinate system optimized for a future task.

Examples:

| View | Future task it helps |
|---|---|
| `state.surface` | understand the current screen quickly |
| `work.focus_set` | recover active work lanes |
| `project.current` | continue project work without rediscovery |
| `research.hypothesis` | evaluate an idea |
| `research.evidence` | write or verify a report |
| `research.failure` | avoid repeated mistakes |
| `research.method` | reuse validated workflows |
| `learning.review_queue` | practice what was actually encountered |
| `memory.daily` | preserve one day's useful state |
| `memory.profile` | adapt future collaboration |
| `agent.task_list` | route slow work to agent runtimes |

Views are materialized and inspectable. Agents can query, fork, update, archive,
delete, and trace them through CLI.

## ViewGraph

The ViewGraph connects observations, Views, tasks, results, feedback, and
memory.

```text
Observation A
  -> View X
  -> View Y
  -> task.background_research
  -> brief.background_research
  -> feedback.output.used
  -> memory.daily
  -> memory.profile
```

This graph matters because future agents should not guess why a View exists.
They should be able to inspect:

- source observations
- source Views
- processor/compiler
- freshness
- scope
- status
- feedback
- downstream task outcomes

## View Operations

The ViewGraph must be editable because task needs change.

Current CLI operations:

```bash
pnpm mf --json view upsert ./view.json --actor agent
pnpm mf --json view fork view:source --id view:task --view-type task.browser_brief --patch ./patch.json
pnpm mf --json view update view:task --status accepted --patch ./patch.json
pnpm mf --json view children view:source
pnpm mf --json view delete view:task --reason "superseded"
pnpm mf --json view delete view:task --hard
```

Expected graph operations:

- create
- update
- fork
- archive
- delete
- merge
- split
- promote
- demote
- supersede
- diff

Archive is the default delete mode because provenance is useful. Hard delete is
reserved for generated mistakes or explicitly unwanted data.

## Task Discovery

Task discovery decides what Views are worth creating.

Signals include:

- repeated task clusters
- expensive search patterns
- repeated failures
- recurring project states
- reusable methods
- user edits
- dismissed suggestions
- accepted agent outputs
- stalled browser or coding work
- frequent language learning gaps

The system should ask:

```text
Is the same kind of future task likely to happen again?
Would a specialized View reduce search cost?
Can multiple observations be compressed into a reusable coordinate system?
Are existing Views enough, or is a new View needed?
```

The first runnable implementation is:

```text
processor.view_promotion_engine -> view.promotion_candidates
```

It scans recent observations, materialized Views, and runtime events, then
proposes graph operations:

- `create_view`
- `update_view`
- `combine_views`
- `retire_view`
- `create_processor`

This processor does not directly mutate long-term memory. It writes an
inspectable candidate View so agents, CLIs, and future UI surfaces can decide
what to apply.

## Feedback

Feedback is not just liking or disliking.

Feedback measures whether a View or processor reduced future search.

Useful signals:

- search steps decreased
- time decreased
- tokens decreased
- success rate increased
- user edits decreased
- repeated failures decreased
- agent needed fewer clarification turns
- user accepted or reused the output
- generated application surface was actually opened or used

Feedback can update:

- View status
- View content
- processor prompts
- processor routing
- task queue policy
- memory retention
- app surfaces
- future task discovery

## Memory

Memory is a retained View.

It is not a separate storage primitive. It is a View whose purpose is to change
future behavior.

The first durable memory surfaces are intentionally simple:

```text
memory.daily      -> editable markdown-backed daily state
memory.profile    -> durable user preferences, style, patterns, principles
```

More memory Views can be added when they make future tasks cheaper:

```text
memory.workflow_patterns
memory.agent_collaboration_style
memory.project.patterns
memory.skill_gaps
agent.case_memory
```

## Personal Applications

Applications are specialized surfaces over the ViewGraph.

They do not need to own the data. They need to choose the right Views and make a
future task easier.

Examples:

- English learning app: builds review material from real language exposure.
- Research app: organizes hypotheses, evidence, methods, failures, and open questions.
- Project command center: shows current project state, agent task queues, and outcomes.
- Memory inbox: reviews candidate memories and profile updates.
- Browser task cockpit: shows current tab state, browser plans, attempts, and outcomes.
- Workflow miner: turns repeated successful traces into reusable methods.
- Writing studio: uses drafts, edits, profile, and evidence Views.
- Agent debugging lab: uses failure, causal, timeline, and tool-call Views.

The pattern is:

```text
ViewSpec + Processor + App Surface = personal application
```

## Quality Metrics

A View is useful if it improves future work.

Measure at three levels:

| Level | Example metrics |
|---|---|
| Mechanism | recall, source coverage, provenance completeness, evidence hit rate |
| Task | search steps, time, token cost, success rate, edit distance, repeated failure rate |
| System | latency, View count, retention, stale View rate, hallucination rate, privacy violations |

The most important metric is simple:

```text
Did this View make the next task easier?
```

## Release Contract

For the current release, Info should make these claims:

- raw context enters as observations
- processors convert observations and Views into new Views
- Views are materialized, inspectable, and editable
- agents can operate Views through CLI
- canonical memory is View-backed
- Chrome ACP can use the same View/task surfaces
- personal applications can be built as projections over the ViewGraph

The system is dynamic by design. New domains should add ViewSpecs, processors,
and optional app surfaces without changing the core storage model.

## Related Documents

- `docs/view-first-proactive-agent-os.md`: protocol doctrine for observations, processors, Views, feedback, and memory.
- `docs/agent-surface-cli.md`: agent-facing CLI contract.
- `docs/application-surface-contract.md`: how personal applications are built as ViewGraph projections.
- `docs/evolution-engine.md`: how promotion candidates are applied, verified, and rolled back.

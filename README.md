# Info

Info is a local-first, agent-native context runtime for adaptive personal
memory.

It does not merely store the past. It continuously learns better
task-specific Views so future work starts from compressed, organized state
instead of expensive search.

The short version is:

```text
One observation -> many Views -> many future tasks
```

![Info loop architecture](assets/info-loop.svg)

## The Idea

Traditional memory systems store history and hope retrieval will find the right
chunk later.

Info turns raw experience into a dynamic ViewGraph:

```text
Observations
  -> Dynamic Processors
  -> Task-specific Views
  -> Personal apps and agent actions
  -> Feedback
  -> Better Views, better processors, better apps
```

Different processors exist to create different Views. Different Views exist to
help different future tasks. Real task outcomes decide which Views should be
created, updated, forked, merged, split, retired, or promoted into long-term
memory.

The value of a View is not that it records the past. The value is that it
reduces future search: fewer steps, less time, fewer tokens, fewer repeated
failures, and better task success.

## Core Loop

Info has one loop:

```text
Observation -> Processor -> View -> Task/App/Action -> Feedback -> Evolution
```

Everything useful becomes a View:

- current state is a View
- a task is a View
- a result is a View
- feedback is a View family
- memory is a View family
- an application surface is a projection over Views

The point is simple: what a human can inspect, an agent should be able to inspect too. What a human can operate, an agent should be able to operate too.

## Framework

```text
1. Observation Stream
   conversations, browser activity, code, logs, Screenpipe, docs, failures

2. Task Discovery
   detect recurring work, expensive searches, repeated failures, reusable methods

3. Dynamic Processors
   deterministic code, LLM prompts, scripts, agent tasks, ACP browser jobs

4. ViewGraph
   task-specific compressed representations with provenance

5. Personal Applications
   learning apps, research apps, project dashboards, memory inboxes, browser cockpits

6. Verification & Feedback
   measure search cost, task success, latency, usefulness, edits, dismissals

7. Evolution
   create/update/fork/merge/split/retire Views and improve processors
```

## Current Canonical Views

These are the main top-level View families today:

- `state.surface`
- `work.focus_set`
- `project.current`
- `memory.daily`
- `memory.profile`
- `task.*`
- `result.*`
- `feedback.*`

Use `pnpm mf --json state` and `pnpm mf --json view latest <view_type>` to inspect them.

## What The System Can Do Today

- Read and write canonical Views
- Fork, update, archive, delete, and trace View graph instances
- Run processors and inspect processor output
- Route agent work through task Views
- Pull Screenpipe evidence through CLI
- Track daily markdown memory and user preference memory
- Expose Chrome ACP tools for current-tab read, observe, act, debugger, and task surfaces

## CLI

This is the main agent surface.

```bash
pnpm mf --json help
pnpm mf --json state
pnpm mf --json view list
pnpm mf --json view latest project.current
pnpm mf --json view fork view:source --id view:task --view-type task.browser_brief --patch ./patch.json
pnpm mf --json view update view:task --status accepted --patch ./patch.json
pnpm mf --json view children view:source
pnpm mf --json view delete view:task --reason "superseded"
pnpm mf --json processor list
pnpm mf --json processor report
pnpm mf --json processor run processor.view_promotion_engine --record obs:example
pnpm mf --json task list --refresh
pnpm mf --json task queue --limit 8
pnpm mf --json sensor screenpipe status
pnpm mf --json sensor screenpipe search --focused --app Cursor --start "30m ago"
pnpm mf --json memory daily show --date 2026-06-17
pnpm mf --json memory profile show
```

## Personal Applications

Applications are not separate silos. They are specialized surfaces over the
same ViewGraph.

Examples:

- English learning app: uses language exposure, difficult segments, review queue, and memory Views.
- Research app: uses hypothesis, evidence, method, failure, timeline, and open-question Views.
- Project command center: uses `project.current`, `project.tasks`, `agent.task_list`, and automation outcomes.
- Memory inbox: uses `memory.candidate`, `memory.daily`, `memory.profile`, and feedback Views.
- Browser task cockpit: uses current surface, browser task Views, Chrome ACP results, and automation outcomes.
- Workflow miner: uses traces, repeated task clusters, failures, and successful methods.

## Adaptive View Promotion

The first runnable View Promotion Engine is available as a processor:

```bash
pnpm mf --json processor run processor.view_promotion_engine --record obs:example
pnpm mf --json view latest view.promotion_candidates
```

It scans recent observations, Views, and runtime events, then writes
`view.promotion_candidates` with proposed graph operations such as
`create_view`, `combine_views`, `retire_view`, and `create_processor`. This is
the first concrete implementation of task discovery feeding adaptive ViewGraph
evolution.

## Chrome ACP

`apps/chrome-acp/packages/chrome-extension/` is the current browser surface.
It gives the agent the same practical powers a user has in the active Chrome tab:

- read the current tab
- observe interactive elements
- act on a tab by intent or direct selector
- use current-tab debugger tools when needed
- query task Views and View state from the side panel

This is important because the browser is not just a display surface.
It is a source of evidence and an action surface.

Load it unpacked from:

```text
apps/chrome-acp/packages/chrome-extension/
```

## Memory

Memory is not a separate primitive. Memory is a retained View whose job is to
change future behavior.

The first durable memory surfaces are two editable View-backed files:

- `memory/daily/YYYY-MM-DD.md`
- `memory/profile/user.md`

`memory.daily` is for one-day summaries.
`memory.profile` is for durable preferences, style, and working patterns.

## Start here

```bash
pnpm install
pnpm run dev
```

HTTP runtime defaults to `http://localhost:3111`.

UI:

```bash
pnpm run ui:dev
pnpm run ui:build
```

## Design docs

- `docs/adaptive-viewgraph-memory.md`
- `docs/view-first-proactive-agent-os.md`
- `docs/application-surface-contract.md`
- `docs/evolution-engine.md`
- `docs/info-design-consensus.md`
- `docs/agent-surface-cli.md`
- `docs/info-ambient-runtime-architecture.md`

## Status

This is a mature working system with a live CLI, View system, runtime processors, memory surfaces, and a Chrome ACP browser agent surface.
The implementation is still evolving, but the contract is no longer a sketch.

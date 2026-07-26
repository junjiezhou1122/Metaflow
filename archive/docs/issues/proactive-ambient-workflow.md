# Proactive Ambient Workflow Slice

## Problem

Info should not only store observations. When observation density is high enough, it should proactively improve the user's workflow:

- prepare background research when the user is focused on a project;
- intervene lightly while the user is writing;
- notice repeated work and suggest or draft small tools.

The risk is turning this into one unbounded agent. This slice keeps the existing runtime shape:

```text
Observation / View
  -> Program attention
  -> speed + autonomy
  -> optional capability.agent_task.submit
  -> task/advice/draft/opportunity Views
  -> user surface + feedback
```

## Current Slice

Implemented built-in Programs:

```text
program.proactive_research
program.writing_ambient
program.toolsmith_ambient
```

### Proactive Research

Input:

```text
thread.active_work
project.current_context
brief.project_next_state
brief.research
```

Behavior:

- runs at `background` speed;
- uses `suggest` autonomy by default;
- submits a read-only `capability.agent_task.submit` task when available;
- always writes local `task.background_research` and `advice.research` Views.

Output:

```text
task.background_research
advice.research
brief.background_research    // from AgentTask when delegation succeeds
```

### Writing Ambient

Input:

```text
observation.editor.text_changed
observation.editor.text_inserted
observation.note.text_changed
observation.document.text_changed
observation.codex.message
observation.browser_text_selected
observation.browser_text_copied
```

Behavior:

- runs at `glance` speed;
- uses `suggest` autonomy by default;
- creates inline-safe writing help without mutating editor text.

Output:

```text
advice.writing_assist
draft.writing_continuation
```

Browser extension inline loop:

```text
textarea/input/contenteditable input
  -> observation.editor.text_changed
  -> program.writing_ambient
  -> advice.writing_assist / draft.writing_continuation
  -> inline browser bubble
  -> user Insert/Dismiss
  -> feedback.analysis.useful / feedback.analysis.dismissed
  -> post-insert user edits
  -> feedback.output.edited
  -> memory.surfacing_preference
  -> memory.output_edit_pattern
```

The inline bubble is intentionally user-gated. It may suggest or insert a draft only after the user clicks; it does not mutate the writing field on its own.
Insert is treated as accepted/useful feedback. Dismiss is treated as show-less feedback. The browser extension posts this through the existing `/feedback?process=true` path with `application_id: editor.inline_assist`, so the normal feedback-learning Program can update future surfacing without introducing a second feedback protocol.
If the user edits the inserted draft within the short inline window, the content script posts `feedback.output.edited` with the original draft and edited text so future writing assistance can learn style preferences.

### Toolsmith Ambient

Input:

```text
workflow
workflow.recipe
workflow.trace
memory.routine_patterns
memory.project.patterns
brief.project_next_state
thread.active_work
```

Behavior:

- runs at `background` speed;
- uses `draft` autonomy by default;
- writes a tool opportunity;
- asks AgentTask only for a no-file-edit `draft.tool_prototype`.

Output:

```text
opportunity.tool
draft.tool_prototype       // from AgentTask when delegation succeeds
tool.prototype_artifact    // sandbox artifact compiled from a prototype draft
```

Sandbox artifact loop:

```text
draft.tool_prototype / opportunity.tool
  -> runtime.toolsmith_artifacts
  -> observation.toolsmith_sandbox_artifact
  -> context artifact file under data/toolsmith-sandbox
  -> tool.prototype_artifact View
```

This is the first implementation path for "automatically make small tools" without directly editing project files. The generated artifact is a local markdown plan/interface/prototype bundle. Turning it into a real project file still requires explicit user approval or a future `sandbox_auto` policy.

## Boundaries

This slice intentionally does not let ambient Programs directly search, edit files, post messages, or mutate remote systems.

Rules:

- background research is read-only and returns Views;
- writing intervention produces suggestions/drafts only;
- toolsmith work proposes a tool and drafts a prototype plan;
- real file edits require explicit user action or a future `sandbox_auto` policy path.
- live background AgentTask delegation is opt-in through `PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME`; otherwise the Programs create task/advice/draft Views without blocking ingest.

## Runtime Scheduling

Default Program processing now considers all registered built-in Programs unless a caller explicitly passes `max_programs`.

This matters because proactive Programs are useful only if they can run from ordinary observation/view processing:

```text
editor text observation -> program.writing_ambient
workflow View           -> program.toolsmith_ambient
active work View        -> program.proactive_research
```

Registration order should not silently disable ambient help. If the Program set grows large, the next step is a cheap router prefilter rather than a fixed registration-order cutoff.

## Background Task Processing

Ambient Programs may create task Views without doing live agent work during ingest. The runtime can later process those task Views asynchronously:

```text
task.background_research
  -> runtime background task processor
  -> capability.agent_task.submit
  -> brief.background_research
```

Realtime vs queued policy:

```text
reflex / glance / think  -> direct processor or realtime LLM path
work / background        -> task View + agent.task_list queue surface
```

`agent.task_list` is the canonical queue View for slow AgentTask work. It
summarizes `task.background_research` Views with status, runtime, output type,
provenance counts, and the realtime/queued policy.
Chrome ACP, the Info UI, HTTP clients, and other agents should read this View or
the `/agent/tasks` HTTP endpoint instead of each inventing a task list.

Entry points:

```text
pnpm run background-tasks
pnpm run runtime:tick -- --background-tasks
pnpm run daemon -- --background-tasks
pnpm mf --json task list --refresh
pnpm mf --json task queue --limit 8
pnpm mf --json task process --runtime local_mock --limit 8
```

Environment controls:

```text
RUNTIME_BACKGROUND_TASKS=1
RUNTIME_BACKGROUND_TASK_LIMIT=8
PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME=local_mock | claude_code | ...
RUNTIME_TOOLSMITH_ARTIFACTS=1
TOOLSMITH_SANDBOX_DIR=data/toolsmith-sandbox
```

If no task runtime is configured, background processing records the skip in runtime diagnostics and leaves the task View unprocessed. This keeps proactive behavior visible and cheap by default while allowing live agent delegation to be enabled explicitly.

## UI Visibility

The runtime UI includes the proactive View types in the Views tab:

```text
advice.research
advice.writing_assist
task.background_research
draft.writing_continuation
opportunity.tool
draft.tool_prototype
```

The Ambient tab groups the same family by workflow:

```text
Queue: agent.task_list
Research: advice.research, task.background_research, brief.background_research
Writing: advice.writing_assist, draft.writing_continuation
Toolsmith: opportunity.tool, draft.tool_prototype, tool.prototype_artifact
```

HTTP clients can use:

```text
GET  /agent/tasks?refresh=true
POST /agent/tasks { "mode": "queue" }
POST /agent/tasks { "mode": "process", "runtime": "local_mock" }
```

Feedback is available from both the runtime UI and the browser writing bubble. Runtime UI actions post as `runtime.ui.ambient`; inline browser writing actions post as `editor.inline_assist`.
`tool.prototype_artifact` Views expose their sandbox file URI directly in the Ambient card and inspector so generated tool prototypes are inspectable without digging through raw JSON.

## Next Work

- Add a richer AttentionDecision action set for `suggest`, `observe`, and `ask_user`.
- Add policy tests for the future `sandbox_auto` tool implementation path.

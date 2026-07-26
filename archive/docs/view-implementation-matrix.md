# View Implementation Matrix

This matrix tracks whether each View type is only described, registered in the
runtime catalog, produced by code, and surfaced in the current UI.

Status legend:

- **Runtime-ready**: queryable and produced by the current runtime/compiler/program path.
- **Spec-ready**: defined in `@info/view-system` and has a processor or handler shape, but is not fully wired into the main runtime catalog/UI path.
- **Modeled**: appears as a target or durable memory type, but does not yet have a mature direct producer.
- **Alias**: overlapping old/new naming exists but is retained only as compatibility metadata while canonical names are migrated.
- **Missing**: no meaningful implementation found beyond incidental mentions.

Key sources:

- `packages/views/catalog.ts`: current HTTP/UI runtime family catalog.
- `packages/view-system/builtins.ts`: newer open ViewSpec registry.
- `packages/views/processors.ts`: current view compiler worker definitions.
- `packages/processor-runtime/builtins/*`: processor-runtime producers.
- `packages/programs/builtins/*`: ambient/program producers.
- `packages/runtime/runtime.ts`: periodic tick orchestration.

## Summary

The mature online chain is:

```text
evidence -> activity/audio/visual_frame -> activity_block/proposal
  -> resource/intent/workflow/memory
  -> work_thread/work.focus_set/project.current
  -> timeline.activity/project_timeline
```

The application-facing ambient chain is also mostly live:

```text
project.current_context/thread.active_work
  -> advice.research/advice.writing_assist/opportunity.tool
  -> task.background_research
  -> draft.writing_continuation/draft.tool_prototype
  -> agent.task_list/tool.prototype_artifact
```

The less mature area is the newer ViewSpec families for project memory,
learning, durable memory subtypes, and naming aliases. Those need catalog
unification and runtime wiring before they should be treated as first-class UI
surfaces.

## Core Views

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `state.surface` | Runtime-ready, catalog gap | Yes | No | Yes | Fallback only | Produced by `processor.surface_state` and runtime tick, but missing from `packages/views/catalog.ts`. |
| `work.focus_set` | Runtime-ready, catalog gap | Yes | No | Yes | Fallback only | Produced by view compiler and scheduled runtime; should be added to runtime catalog. |
| `project.current` | Runtime-ready, catalog gap | Yes | No | Yes | Fallback only | Produced by `compileProjectCurrent`; missing from current HTTP catalog. |
| `memory.daily` | Spec-ready | Yes | No | Partial | Partial | Spec exists; view-promotion can propose it, but no mature direct daily writer in main runtime chain. |
| `memory.profile` | Spec-ready | Yes | No | Partial | Partial | `memory-profile-update` can derive it from `memory.daily` and feedback. |

## Project

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `project.current_context` | Runtime-ready | Legacy + Spec | Yes | Yes | Yes | Produced by `program.project_ambient`. |
| `project.decisions` | Spec-ready | Yes | No | Yes | No | `processor.project_decision_extractor` exists, but not in current runtime catalog/UI. |
| `project.inbox` | Spec-ready | Yes | No | Yes | No | `processor.project_inbox` exists, not fully wired into main runtime UI. |
| `project.memory` | Modeled | Yes | No | Partial | No | Durable memory target via memory candidate/gate, no mature direct producer. |
| `project.tasks` | Spec-ready | Yes | No | Yes | No | `processor.project_tasks` exists, not in runtime catalog/UI. |
| `project_timeline` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced by `compileProjectTimeline`. |

## Task

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `task.background_research` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced by proactive ambient program/manual path and queued into agent tasks. |
| `agent.task_list` | Runtime-ready | Legacy + Spec | Yes | Yes | Yes | Built by runtime agent task list. |

## Memory

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `memory` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced by memory compiler from workflow views. |
| `memory.preferences` | Spec-ready | Yes | No | Partial | No | Produced by `memory-profile-update` and memory gate targets. |
| `memory.workflow_patterns` | Modeled | Yes | No | Partial | No | Durable memory target, candidate/gate support exists. |
| `memory.skill_gaps` | Modeled | Yes | No | Partial | No | Durable memory target, candidate/gate support exists. |
| `memory.agent_collaboration_style` | Modeled | Yes | No | Partial | No | Durable memory target, candidate/gate support exists. |
| `memory.language.difficult_segments` | Spec-ready | Yes | No | Yes | Partial | Produced by YouTube learning processor/program variants, naming needs unification. |

## Learning

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `learning.review_queue` | Spec-ready | Yes | No | Yes | No | Produced by YouTube learning processor, but not in current runtime catalog. |
| `learning.youtube_fragment` | Spec-ready | Yes | No | Yes | No | Produced by YouTube learning processor. |

## Research And Advice

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `brief.research` | Runtime-ready | Legacy | Yes | Yes | Yes | Main runtime name for research brief. |
| `brief.background_research` | Runtime-ready | Legacy | Yes | Yes | Yes | Agent/background research output. |
| `advice.research` | Runtime-ready | Legacy | Yes | Yes | Yes | Proactive ambient research advice. |
| `advice.writing_assist` | Runtime-ready | Legacy | Yes | Yes | Yes | Current writing assist path. |
| `research.brief` | Alias / Compat-only | Yes | No | Partial | No | Canonical runtime name is `brief.research`; keep as read alias only. |
| `writing.advice` | Alias / Compat-only | Yes | No | Partial | No | Canonical runtime name is `advice.writing_assist`; keep as read alias only. |

## Draft And Prototype

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `draft.tool_prototype` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced by toolsmith agent/program path. |
| `draft.writing_continuation` | Runtime-ready | Legacy | Yes | Yes | Yes | Current inline writing draft path. |
| `tool.prototype_artifact` | Runtime-ready | Legacy | Yes | Yes | Yes | Built by runtime toolsmith artifact processor. |
| `opportunity.tool` | Runtime-ready | Legacy | Yes | Yes | Yes | Proactive tool opportunity. |

## Activity And Timeline

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `activity` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced from evidence views. |
| `activity_block` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced from activity/audio/visual-frame views. |
| `timeline.activity` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced by activity timeline compiler and used by UI. |
| `summary.project_work_episode` | Runtime-ready | Legacy | Yes | Yes | Yes | Registered runtime family; episode summary compiler exists under timeline cluster. |
| `thread.active_work` | Runtime-ready | Legacy + Spec | Yes | Yes | Yes | Produced by project ambient program. |
| `work_thread` | Runtime-ready | Legacy | Yes | Yes | Yes | Produced by work-thread compiler/runtime. |

## Misc

| View type | Status | Spec | Runtime catalog | Producer | UI | Notes |
|---|---:|---:|---:|---:|---:|---|
| `audio` | Runtime-ready | Legacy | Yes | Yes | Yes | Audio compiler from evidence views. |
| `visual_frame` | Runtime-ready | Legacy | Yes | Yes | Yes | Visual frame compiler from evidence views. |
| `evidence` | Runtime-ready | Legacy | Yes | Yes | Yes | Normalized evidence from observations. |
| `intent` | Runtime-ready | Legacy | Yes | Yes | Yes | Deterministic and LLM compilers exist. |
| `proposal` | Runtime-ready | Legacy | Yes | Yes | Yes | Control/proposal compiler. |
| `resource` | Runtime-ready | Legacy | Yes | Yes | Yes | Resource compiler plus manual/agent support. |
| `workflow` | Runtime-ready | Legacy | Yes | Yes | Yes | Deterministic and LLM compilers exist. |
| `agent.case_memory` | Modeled | Yes | No | Partial | No | Durable memory target via memory gate, no mature direct producer. |
| `view.promotion_candidates` | Spec-ready | Yes | No | Yes | Partial | Processor exists; not in main runtime catalog/UI yet. |

## Consolidation Work

Before calling this whole taxonomy "implemented", do these in order:

1. Add `state.surface`, `work.focus_set`, `project.current`, and the mature
   Spec-ready project/memory/learning types to `packages/views/catalog.ts`, or
   make HTTP catalog read from `@info/view-system` as the single source.
2. Keep aliases as compatibility metadata only:
   `research.brief` -> `brief.research`, `writing.advice` ->
   `advice.writing_assist`, `app.language.review_queue` ->
   `learning.review_queue`.
3. Decide which Spec-ready processors should run in the periodic runtime tick,
   which should stay on-demand, and which should be manual-only.
4. Update the UI group rail to read groups from catalog/spec metadata instead
   of maintaining a local fallback list.
5. Add a test that fails if a ViewSpec claims a producer but no registered
   processor/program/runtime path can produce that view type.

# Evolution Engine

The Evolution Engine turns task-discovery evidence into controlled ViewGraph,
processor, and application changes.

It should not blindly mutate memory. It should propose, apply, verify, and
rollback changes with provenance.

```text
evidence
  -> view.promotion_candidates
  -> review / policy gate
  -> apply operation
  -> task verification
  -> keep, refactor, rollback, or retire
```

## Current Seed

The first runnable seed is:

```text
processor.view_promotion_engine
  -> view.promotion_candidates
```

It scans recent observations, materialized Views, and runtime events, then
proposes graph operations:

```text
create_view
update_view
combine_views
retire_view
create_processor
```

The current processor writes candidates only. Applying the candidates is a
separate step.

## Why Candidate First

Adaptive systems can damage memory if they automatically rewrite long-term
state.

Candidate-first evolution gives us:

- inspectability
- provenance
- human or agent review
- policy gates
- dry runs
- rollback
- evaluation before promotion

The system should be dynamic, but not opaque.

## Candidate Shape

Each promotion candidate should answer:

```text
What should change?
Why now?
What evidence supports it?
Which future task gets cheaper?
How will we verify that?
How do we undo it?
```

Suggested structure:

```ts
type PromotionCandidate = {
  id: string;
  action:
    | "create_view"
    | "update_view"
    | "fork_view"
    | "merge_views"
    | "split_view"
    | "retire_view"
    | "promote_memory"
    | "demote_memory"
    | "create_processor"
    | "improve_processor"
    | "create_app_surface";
  target_view_type?: string;
  target_view_id?: string;
  target_processor_id?: string;
  source_record_ids?: string[];
  source_view_ids?: string[];
  evidence_event_ids?: string[];
  priority: "low" | "medium" | "high";
  reason: string;
  expected_future_task: string;
  expected_search_reduction: string;
  verification?: {
    metric: string;
    baseline?: unknown;
    target?: unknown;
    time_window?: string;
  };
  rollback?: {
    strategy: "archive_created" | "restore_previous" | "disable_processor" | "manual";
    affected_views?: string[];
  };
};
```

## Apply Modes

Evolution should support multiple apply modes.

| Mode | Meaning | Example |
|---|---|---|
| `manual` | Human explicitly applies | accept memory/profile update |
| `agent_draft` | Agent creates draft artifacts or Views | create `processor.candidate` |
| `sandbox_auto` | Agent applies in reversible sandbox | fork View for browser task |
| `full_auto` | System applies directly | archive stale ephemeral View |

Most long-term memory and processor changes should start as `manual` or
`agent_draft`.

## Operation Semantics

### create_view

Create a new materialized View from source records or source Views.

Use when:

- repeated task cluster exists
- existing Views do not fit the future task
- evidence can be compressed into a reusable coordinate system

### update_view

Patch an existing View.

Use when:

- the View is still the right coordinate system
- new evidence changes content or freshness
- provenance can be preserved

### fork_view

Create a task-specific branch from an existing View.

Use when:

- one source View supports multiple future tasks
- a task needs a specialized representation
- the original View should remain stable

### merge_views

Combine multiple Views into one higher-level View.

Use when:

- future tasks repeatedly need the same group of Views
- multiple Views duplicate the same concept
- search cost is caused by having to gather context each time

### split_view

Divide a View into smaller task-specific Views.

Use when:

- a View has become too broad
- tasks only need different subsets
- retrieval or UI surfacing is noisy

### retire_view

Archive a stale or low-value View.

Use when:

- a View is outdated
- feedback says it is not useful
- a better View supersedes it
- it increases search cost by cluttering active state

### promote_memory

Move a candidate or session View into long-term memory.

Use when:

- feedback is positive
- evidence repeats
- the View changes future behavior
- the claim is stable enough

### demote_memory

Move a long-term memory View back to project/session scope or archive it.

Use when:

- the memory is stale
- the user rejects it
- it causes bad behavior
- it only applies to one project or context

### create_processor

Create a processor candidate when the system sees a repeated need for a View
that no processor currently produces.

Use when:

- task evidence repeats
- a target View type is useful
- existing processors do not produce it
- an agent can implement and test a processor

### improve_processor

Change an existing processor's logic, prompt, routing, or policy.

Use when:

- outputs are repeatedly edited
- feedback is negative
- task success is low
- failures have a common cause

### create_app_surface

Create an application surface over a stable group of Views.

Use when:

- users or agents repeatedly inspect the same Views
- a task needs interaction, not just data
- feedback from that task would improve memory

## Suggested CLI Shape

Current CLI can inspect and operate Views:

```bash
pnpm mf --json processor run processor.view_promotion_engine --record obs:example
pnpm mf --json view latest view.promotion_candidates
pnpm mf --json view fork view:source --id view:task --view-type task.browser_brief --patch ./patch.json
pnpm mf --json view update view:task --status accepted --patch ./patch.json
pnpm mf --json view delete view:task --reason "superseded"
```

Future CLI should add an apply layer:

```bash
pnpm mf --json evolution candidates
pnpm mf --json evolution show <candidate_id>
pnpm mf --json evolution apply <candidate_id> --mode agent_draft
pnpm mf --json evolution verify <candidate_id>
pnpm mf --json evolution rollback <candidate_id>
```

The apply command should write an `evolution.applied` event and one or more
Views describing what changed.

## Verification

A candidate should not be considered successful just because it was applied.

Verification should compare future task cost before and after:

- search steps
- task time
- token cost
- success rate
- retry count
- user edit distance
- dismissal rate
- repeated failure rate
- source hit rate

The simplest verification View is:

```text
evolution.verification
```

It can record:

```ts
type EvolutionVerification = {
  candidate_id: string;
  operation_id: string;
  metric: string;
  baseline?: unknown;
  observed?: unknown;
  verdict: "keep" | "refactor" | "rollback" | "inconclusive";
  evidence_records?: string[];
  evidence_views?: string[];
};
```

## Rollback

Every applied operation should be reversible unless it is explicitly marked as
irreversible.

Default rollback strategies:

| Operation | Rollback |
|---|---|
| create_view | archive created View |
| update_view | restore previous View snapshot or fork old version |
| fork_view | archive fork |
| merge_views | archive merged View, reactivate sources |
| split_view | archive split Views, reactivate source |
| retire_view | unarchive View |
| promote_memory | archive promoted memory, restore candidate |
| create_processor | disable processor candidate |
| improve_processor | restore previous processor version |
| create_app_surface | archive app surface spec |

## Policy Gates

Before applying a candidate, check:

- privacy: no secret or do-not-store source
- scope: project/session/long-term boundary is correct
- autonomy: operation mode is allowed
- reversibility: rollback is defined
- evidence: source records or Views exist
- blast radius: long-term memory and processor changes need stricter gates

Long-term memory changes should require stronger evidence than ephemeral View
changes.

## Processor Evolution

Processors should be evolvable but audited.

Recommended View families:

```text
processor.definition
processor.candidate
processor.version
processor.evaluation
processor.failure
processor.policy
```

Flow:

```text
view.promotion_candidates
  -> processor.candidate
  -> agent implements code or prompt
  -> processor.evaluation
  -> enable / refactor / archive
```

Agents can still edit code directly, but the system should retain a View trail
explaining why that processor exists and what future task it makes cheaper.

## Application Evolution

Applications should also be evolvable.

Recommended View families:

```text
app.surface_spec
app.usage
app.feedback_summary
app.retirement_candidate
```

Flow:

```text
repeated task + stable View group
  -> create_app_surface candidate
  -> app.surface_spec
  -> user/agent usage
  -> feedback
  -> keep, refine, or retire
```

## Minimal Implementation Plan

1. Keep `processor.view_promotion_engine` candidate-only.
2. Add `evolution.*` CLI commands for candidate listing and dry-run apply.
3. Implement `view merge/split/promote/demote/diff`.
4. Add `processor.candidate` and `processor.evaluation` ViewSpecs.
5. Add `app.surface_spec` ViewSpec.
6. Add verification Views for applied candidates.
7. Add UI panels for promotion candidates, memory inbox, and app surface specs.

## Design Rule

Evolution should be dynamic, but every change must be explainable.

```text
No silent mutation.
No untraceable memory.
No processor without a task.
No app without feedback.
```


# Application Surface Contract

Applications in Metaflow are projections over the ViewGraph.

They should not own the user's personal context as a separate silo. They choose
the Views that matter for a task, render them into an interface, and write
feedback observations when the user or agent acts.

```text
ViewSpecs + Processors + App Surface + Feedback Contract = Personal Application
```

## Principle

An application exists to make a future task cheaper.

It should answer:

```text
Which task does this app help?
Which Views does it read?
Which actions can the user or agent take?
Which feedback does it write?
How do we know it reduced future search?
```

The app is not the source of truth. The ViewGraph is.

## Contract Shape

Each application surface should have a small manifest:

```ts
type ApplicationSurfaceSpec = {
  id: string;
  title: string;
  purpose: string;
  task: {
    description: string;
    success_signals: string[];
    failure_signals: string[];
  };
  reads: {
    views: string[];
    optional_views?: string[];
  };
  writes?: {
    observations?: string[];
    views?: string[];
  };
  actions?: Array<{
    id: string;
    title: string;
    permission: "observe" | "suggest" | "draft" | "sandbox_auto" | "execute";
    writes_feedback?: string[];
  }>;
  feedback: {
    useful?: string;
    dismissed?: string;
    edited?: string;
    completed?: string;
    failed?: string;
  };
};
```

This does not need to be a heavy framework at first. A markdown or JSON manifest
is enough if it lets agents and UIs understand the app's View contract.

## App Lifecycle

```text
1. Task appears repeatedly
2. View Promotion Engine proposes a useful surface
3. Agent creates ApplicationSurfaceSpec
4. UI or Chrome ACP renders the selected Views
5. User/agent acts through the surface
6. Surface writes feedback observations
7. Processors update Views, memory, and routing
8. Promotion Engine keeps, refactors, or retires the app
```

## Required Properties

Every app surface should be:

- View-backed: it reads materialized Views, not private ad-hoc state.
- Feedback-producing: it writes observations when users accept, edit, dismiss, retry, or complete work.
- Agent-operable: an agent can inspect the same Views and invoke the same safe actions.
- Reversible: generated or stale app state can be archived without corrupting memory.
- Measurable: it has at least one task-level success signal.

## Feedback

Application feedback is raw evidence first.

Examples:

```text
feedback.language.review_completed
feedback.language.word_known
feedback.research.brief_used
feedback.research.missing_context
feedback.browser_task.completed
feedback.browser_task.failed
feedback.memory.accepted
feedback.memory.edited
feedback.memory.rejected
```

Processors can then turn feedback into:

```text
memory.preferences
memory.profile
memory.workflow_patterns
research.method
research.failure
view.promotion_candidates
```

## Example: English Learning App

Task:

```text
Practice language fragments the user actually encountered.
```

Reads:

```text
learning.review_queue
learning.youtube_fragment
memory.language.difficult_segments
memory.profile
```

Actions:

```text
mark_known
mark_difficult
replay_segment
complete_review
```

Writes:

```text
feedback.language.word_known
feedback.language.segment_difficult
feedback.language.review_completed
```

Success signals:

```text
review completion
fewer repeated difficult segments
faster recognition
less manual search for source clips
```

## Example: Research App

Task:

```text
Evaluate and reuse research context without re-reading raw history.
```

Reads:

```text
research.hypothesis
research.evidence
research.failure
research.method
research.open_questions
timeline.activity
memory.daily
```

Actions:

```text
promote_evidence
mark_stale
fork_hypothesis
create_background_task
write_report
```

Writes:

```text
feedback.research.evidence_used
feedback.research.hypothesis_rejected
feedback.research.missing_context
task.background_research
```

Success signals:

```text
fewer source-search steps
faster report writing
fewer repeated failed directions
more reusable methods
```

## Example: Browser Task Cockpit

Task:

```text
Let an agent operate the current browser task with visible context and recoverable state.
```

Reads:

```text
state.surface
screenpipe.surface
task.browser_brief
automation.plan
automation.outcome
research.failure
```

Actions:

```text
observe_page
act_by_intent
retry_with_dom
retry_with_vision
cancel_task
record_failure
```

Writes:

```text
feedback.browser_task.completed
feedback.browser_task.failed
automation.outcome
research.failure
```

Success signals:

```text
task completion rate
lower retry count
fewer repeated site-specific failures
less manual agent instruction
```

## Example: Memory Inbox

Task:

```text
Curate which generated memories should influence future behavior.
```

Reads:

```text
memory.candidate
memory.daily
memory.profile
view.promotion_candidates
```

Actions:

```text
accept
edit
reject
merge
archive
```

Writes:

```text
feedback.memory.accepted
feedback.memory.edited
feedback.memory.rejected
memory.daily
memory.profile
```

Success signals:

```text
fewer bad memory recalls
better agent collaboration
lower correction frequency
more useful proactive suggestions
```

## Agent Requirements

An agent should be able to operate an application without a private UI API:

```bash
pnpm mf --json view latest learning.review_queue
pnpm mf --json view update view:review:item --status accepted --patch ./patch.json
pnpm mf --json processor run processor.view_promotion_engine --record obs:example
```

For browser surfaces, Chrome ACP should expose the same state through its tool
layer so the agent can inspect, act, and write feedback.

## Anti-Patterns

Avoid:

- app-specific memory that bypasses Views
- hidden local state that agents cannot inspect
- UI actions that do not write feedback
- app surfaces that cannot explain their source Views
- hard-coded domain categories in core
- generated apps with no success or retirement signal

## Design Rule

If a surface is useful more than once, give it a View contract.

If a View contract is useful across tasks, give it a processor.

If the processor repeatedly improves future work, let the Promotion Engine keep
or strengthen it.

## Question

Can a scheduled Trigger summarize an explicit time-bounded set of Views and
deliver it to the inbox without introducing a special batch intelligence path?

## Depends on

- Specify Ambient traces and failure behavior

## Acceptance criteria

- A timezone-aware schedule emits one idempotent occurrence per period.
- Context selection freezes Views inside the declared time window and category
  filters.
- The summary runs through an ordinary Transformation and Operator.
- Missed, delayed, duplicate, and manually replayed periods remain observable.
- The result is delivered to inbox and linked feedback can request rerun or
  correction.

## Verification method

- Use a fake clock across normal, restart, missed-run, duplicate, and DST
  fixtures.
- Inspect the complete occurrence-to-feedback trace.

## Answer

Yes. Scheduled Ambient behavior is an ordinary Automation invocation. The
Scheduler adapter emits a deterministic signal containing one IANA-timezone
cron period `[start,end)`. Context resolution maps that period plus declared
Schema categories into an epoch-based View Store query, authorizes the complete
set, freezes exact revisions, and passes them through the existing
Automation-to-Execution bridge. The daily summary is an ordinary Agent
Transformation and its result is an ordinary Derived View delivered to Inbox.

The Scheduler keeps a durable compare-and-swap cursor per exact Automation
revision and schedule definition. It advances only after a terminal or
duplicate occurrence. Restart enumerates missed periods up to the declared
bound; exceeding that bound fails rather than dropping periods. Manual replay
uses a new explicit identity and does not alter the schedule cursor. Period,
dispatch state, replay identity, context decisions, Run, Delivery, and Feedback
remain on the correlation trace.

## Implementation

- `packages/adapters/scheduler-automation`
- `packages/adapters/inbox-automation`
- `packages/automation/contracts.ts`
- `packages/automation/context.ts`
- `packages/view/repository.ts`
- `packages/adapters/storage-sqlite/index.ts`
- `apps/ambient-daemon/definitions.ts`
- `apps/ambient-daemon/composition.ts`
- `tests/scheduler-automation.test.ts`
- `tests/view-query-time-range.test.ts`
- `tests/scheduled-summary-vertical.test.ts`

Focused scheduled-summary verification passes 10/10; combined Ambient,
Automation, Browser, Delivery, Trace, and Execution regression passes 50/50.

## Question

What does Ambient own, and which responsibilities remain in Capture, View,
Transformation, Execution, Agent Adapter, and delivery surfaces?

## Acceptance criteria

- One end-to-end lifecycle names the owner of trigger admission, context
  resolution, Transformation creation, Agent handoff, delivery, and feedback.
- Ambient is explicitly excluded from View persistence, Connector behavior,
  Agent session management, Operator execution, and UI rendering.
- User, event, schedule, and accumulation triggers share one contract.
- The first implementation package and dependency direction are fixed.
- The canonical architecture document and `AGENTS.md` use the same language.

## Verification method

- Review the lifecycle against one macOS voice request, one GitHub DOM trigger,
  and one daily summary.
- Audit proposed imports against v1 package boundaries and reject legacy
  `@info/core` dependencies.

## Resolution

Ambient is not a new Agent or data model. It is the user-facing behavior formed
when an editable Automation View binds a deterministic Trigger to an exact Core
Operation or Transformation revision, maps trigger evidence into exact context
Views, and requests Delivery of progress or results.

Ownership is:

- Capture admits fresh voice, selection, Browser DOM, Accessibility, and other
  source evidence as Raw Views.
- View owns evidence and derived information identity and revision semantics.
- Transformation declares how selected Views become output Views and which
  Operator performs the work.
- Execution resolves and authorizes exact inputs, creates the Run, invokes the
  Operator or Agent Adapter, validates output, and commits result or Failure
  Views.
- Automation owns Trigger adapter ports, occurrence admission and idempotency,
  target invocation, Delivery ports, and end-to-end correlation.
- Browser, macOS, scheduler, notch, panel, and inbox are adapters or app
  composition roots. They do not own decision logic.

The first reusable package is `packages/automation`, not a second
`packages/ambient-layer`. New code depends inward on `view`, `transformation`,
and `execution` ports and never on legacy `@info/core`.

Canonical design: `wiki/architecture/ambient-automation-runtime.md`.

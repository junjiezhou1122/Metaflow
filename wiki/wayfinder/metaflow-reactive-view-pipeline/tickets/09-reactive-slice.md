## Question

Does one realistic local scenario prove that lossless capture, search, commit events, Automation matching, III queues, Execution, recursive Derived Views, and failure/replay behavior work as one system?

## Acceptance criteria

- Run Browser manual-save and Screenpipe evidence through their ordinary Connectors and Capture Runtime into immutable searchable Raw Views.
- Publish exact `ViewCommitted` events and match configured Automations without source-specific trigger construction.
- Execute at least one Function and one Agent Operator through III plus the shared Execution Runtime.
- Commit a summary View and a personalized learning/material View, then let one Derived View trigger a bounded second transformation.
- Demonstrate duplicate delivery, denied input, stale revision, invalid candidate, Worker crash/restart, DLQ terminal failure, cycle stop, and explicit replay/repair.
- Expose one correlated trace spanning source event, Capture batch, View revisions, outbox, Automation occurrence, III receipt, Run, result/Failure View, and recursive child.
- Keep deterministic CI evidence separate from optional live Browser/Screenpipe/Agent smoke evidence.

## Verification method

- Add one deterministic v1 reactive vertical test and focused package tests for every failure boundary.
- Run `pnpm typecheck:v1`, `pnpm check:boundaries`, the active v1 suite, and the reactive vertical test.

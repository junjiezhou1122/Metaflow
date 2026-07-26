## Question

Can the first Agent Adapter slice make Ambient useful by handing the user's
prompt and current Mac context to an agent that already has skills and View
tools?

## Depends On

- Decide when ACP session reuse is useful
- Design the ViewGraph tool bridge
- Specify traces, failures, and repair

## Acceptance Criteria

- Ambient or CLI can ask: "research how this page relates to our current
  project and write what can transfer."
- The adapter passes the user's prompt plus current voice/screen/app context.
- The agent uses its own installed skills and Metaflow View CLI/MCP tools to
  find project.current and related Views.
- The agent produces a project.transfer_brief Candidate View artifact.
- The output is validated, committed, and linked to exact input revisions.
- Direct CLI, ACP cold spawn, and ACP warm prompt latency can be measured
  separately when applicable.
- A forced adapter failure creates a Failure View with enough evidence to
  debug.

## Verification Method

- Run one scripted demo with a fake current screen context, a project.current
  View, and a mock, CLI, or ACP adapter.
- Record adapter mode, timing, trace id, output View id, and Failure View id.

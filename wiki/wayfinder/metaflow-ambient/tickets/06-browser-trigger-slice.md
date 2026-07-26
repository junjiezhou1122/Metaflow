## Question

Can a user-authored GitHub page Trigger create a full-page context handoff and
deliver one deduplicated summary without continuous Agent polling?

## Depends on

- Specify Ambient traces and failure behavior

## Acceptance criteria

- A declarative URL/DOM condition matches a GitHub repository page.
- Browser Capture supplies the exact full-page View and current selection when
  present.
- The configured Transformation or Agent produces a summary View.
- Repeated DOM mutations do not create duplicate work within the declared
  cooldown.
- Browser or inbox delivery and feedback are fully correlated in trace.

## Verification method

- Run a deterministic extension fixture and one live GitHub smoke scenario.
- Inspect Trigger occurrence, context revisions, Run, result View, delivery,
  dedupe, and feedback.

## Answer

Yes. The implemented Browser slice is:

```text
Chrome URL/DOM/manual-or-dwell event
  -> cheap declarative match
  -> exact page and optional selection Raw Views
  -> exact Automation context bindings
  -> AutomationExecutionTarget
  -> ExecutionRuntime and OperatorExecutionRouter
  -> ACP Agent Operator
  -> atomically committed summary View
  -> Browser result card
  -> accept/later/dismiss interaction
  -> Feedback View and one durable correlation trace
```

The extension does not poll an Agent. It emits deterministic source events;
the durable occurrence repository owns cooldown and dedupe. A missing optional
selection is passed to Execution as an explicit empty role, so Execution never
resolves a stale selection selector. Browser code captures evidence and renders
exact result refs but never constructs output candidates or commits results.

The app composition requires an explicit ACP command and registers the Agent
bridge through `OperatorExecutionRouter`. There is no mock or model fallback.
ACP streamed text chunks are reconstructed before strict JSON output
validation; malformed output remains a structured Execution Failure View.

## Implementation

- `apps/chrome-acp/packages/chrome-extension/src/lib/ambient/browser-trigger.ts`
- `packages/adapters/browser-automation`
- `packages/adapters/automation-execution`
- `apps/ambient-daemon`
- `packages/server/http-server.ts`
- `tests/automation-execution-adapter.test.ts`
- `tests/ambient-daemon-vertical.test.ts`

## Verification evidence

- Live `https://github.com/openai/codex` DOM smoke found the repository header,
  repository content, README, and about 6,078 readable characters.
- The focused Automation, Browser, Agent, and Execution suite passes 65/65;
  package boundaries pass 19/19; root and v1 TypeScript pass; the Chrome
  extension production build passes.
- A real `claude-agent-acp` daemon run committed
  `summary.github.repository@1`, returned it through exact View HTTP, recorded
  an `accept` Feedback View, and reported a replay from the same navigation as
  `duplicate` without a second Run.
- The durable trace contains Trigger, context authorization, one exact Run,
  streamed Agent events, committed result, Browser delivery, Feedback, and the
  dedupe decision under one correlation id.

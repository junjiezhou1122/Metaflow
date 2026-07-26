## Question

Can a global push-to-talk shortcut capture an utterance plus current macOS
selection/window context, delegate to the chosen Agent, and return quickly to a
lightweight surface?

## Depends on

- Specify Ambient traces and failure behavior

## Acceptance criteria

- Press-and-hold and release semantics are explicit and globally registered.
- ASR output and AX snapshot are admitted as source-attributed Raw Views.
- Browser foreground context can request Browser DOM through an explicit
  bridge; non-browser applications use AX or an explicit screenshot attempt.
- The user can name Codex or use the configured default Agent.
- Progress, cancellation, result, and feedback work through the shared delivery
  contract.
- Trigger-to-visible-progress and trigger-to-first-result latency are measured.

## Verification method

- Run one scripted AX fixture and one live macOS smoke test with selected text.
- Force denied Accessibility permission, ASR failure, missing selection,
  Agent failure, and delivery failure.

## Current implementation

- `@info/macos-automation-adapter` owns the strict event, Raw View admission,
  explicit Chrome DOM bridge, macOS Delivery mailbox, and HTTP transport.
- `apps/mac` freezes AX context on `Option+Space` key-down, uses Apple
  Speech while held, submits on key-up, and renders or acts on shared Delivery.
- Explicit Agent aliases propagate through Trigger, Automation, Execution Run,
  and `AgentOperatorExecutionBridge`; unknown aliases fail fast.
- Browser/Ambient supply exact invocation refs only. Execution owns candidate
  validation, Derived or Failure View commit, cancellation, and replay.

## Evidence

- `tests/macos-ambient-vertical.test.ts`: 6/6. It covers selected AX text
  reaching `codex`, frozen runtime override, accepted/result timing, exact
  Feedback, Chrome DOM round trip, denied Accessibility, ASR failure, missing
  selection, cancellation, Agent failure, and Delivery failure.
- Fixed-clock trace emits `release_to_accepted_ms: 70` and
  `release_to_result_ms: 150`, with explicit 250 ms and 1,000 ms test bounds.
  These are accounting assertions, not live ACP latency.
- `swift build --package-path apps/mac` passes.
- Swift smoke contract tests: 5/5.
- `pnpm mac:bundle` produces a verified ad-hoc signed `Metaflow.app` whose
  identifier is `com.metaflow.mac.visible` and whose sealed
  `Info.plist` contains Microphone and Speech Recognition usage descriptions.
- Signed-bundle `--permission-smoke` reports Accessibility and Microphone
  `authorized`, Speech Recognition `not_determined`, and exits 5.
- Signed-bundle `--ax-smoke --require-selected-text` reports
  `selected_text_unavailable`, `likely_screen_locked: true`, and exits 4 while
  the console is locked.
- Full `pnpm test` still has six pre-existing failures outside this slice: three
  legacy HTTP backfill/watermark assertions, two old Agent prompt/context
  assertions, and one old UI copy assertion. Focused Ambient and v1 boundary
  suites remain green.

## Remaining acceptance evidence

The console session was locked during the live attempt, so the strict smoke
correctly rejected `com.apple.loginwindow` and no selected text. The ticket
remains open until Speech Recognition is authorized, an unlocked run exits zero
with non-empty `selected_text` from a real application, and the push-to-talk
Apple Speech press/release path is exercised.

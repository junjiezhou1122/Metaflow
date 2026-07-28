---
name: architecture/ambient-automation-runtime
title: Ambient and Automation Runtime
desc: Canonical Metaflow v1 design for editable Ambient Automations, deterministic Triggers, exact current-context resolution, shared execution, delivery, feedback, and traceability.
category: architecture-decision
tags: [ambient, automation, trigger, context, agent, delivery, feedback]
created: 2026-07-26T16:00:00+08:00
updated: 2026-07-26T22:30:00+08:00
---

# Ambient and Automation Runtime

> Status: canonical design baseline for the Metaflow Ambient v1 implementation
> slice. Existing `packages/ambient-layer`, Programs, browser content scripts,
> and macOS polling behavior are evidence, not target architecture authority.

## Goal

Make Ambient behavior easy to create and change without creating a second
intelligence system:

```text
editable Automation View
  + deterministic Trigger
  + exact current-context Views
  + ordinary Core Operation or Transformation
  + lightweight Delivery
  + Feedback Views
```

Ambient does not continuously ask an Agent to read the user's context. Cheap
source adapters may observe shortcuts, DOM events, View commits, schedules, or
bounded counters. Expensive work starts only after a declared Trigger occurs.

## The key distinction

Automation and Transformation answer different questions:

```text
Automation:     when should work start, with which context, and where should
                the result be delivered?

Transformation: how do exact input Views become output Views, and which
                Operator performs that work?
```

An Agent, Workflow, function, model, human, or service remains an Operator in a
Transformation. Ambient never introduces an `AmbientAgent`, `AmbientTask`, or
parallel Agent session model.

The user's editable Ambient behavior is an ordinary Derived View with a strict
`metaflow.automation` Schema. Editing it creates a new immutable View revision.
An Agent may propose or revise that View through an ordinary Transformation;
activation remains explicit and policy-governed.

## Committed View triggers

Generic reactive work begins from the exact `view.committed@1` event owned by
View Core. A storage outbox publishes that event only after its View batch
commits. `packages/adapters/committed-view-trigger` resolves the event's exact
refs, discovers the latest Automation Views, constructs ordinary event
`TriggerSignal` values, and performs deterministic bounded matching.

The View Store never invokes Automation, and III never decides which
Automation matched. Persisted Trigger payloads always contain only a
Representation descriptor. When an Automation explicitly predicates on
`view.representation.*`, the adapter may use bounded local content for the
matching operation only when `policy.allow_local_search` is not false; it then
passes a predicate result bound to the exact Automation revision, canonical
predicate digest, trigger id, and signal id together with the descriptor-only
signal. Representation content is never copied into the occurrence or
Automation trace before authorization. Oversized or forbidden content is
denied before invocation. Normal context resolution and View-access
authorization still re-resolve and authorize the exact View before it reaches
the target Operator. The Automation-owned invocation port accepts either a
direct Runtime result or a durable queue receipt, so III can add transport
without redefining this adapter's contract. One event may match many Automations; duplicate delivery
retains one event identity and is stopped by occurrence idempotency. Derived
output Views use the same boundary, which permits recursive pipelines without
introducing a second trigger or execution model.

That recursion is never an implicit Worker loop. The committed-View adapter
requires a durable cascade ledger and one frozen root policy, atomically admits
the full set of matching Transformation targets, and carries exact lineage,
parent, depth, fan-out, budget, time, and replay evidence through the ordinary
Automation signal. Cycle or limit stops are passed to Execution as terminal
invocations so they create a Run and Failure View without calling a Worker.
Context authorization denial and exact-Operator concurrency exhaustion follow
the same pre-execution failure boundary; the cascade ledger never becomes the
only terminal evidence.

Running attempts keep recoverable leases and their exact Operator and Run.
Expired work reconciles the original Run instead of starting a second Worker.
If Execution commits output before Automation can finalize the cascade, retry
reuses that terminal Run. III DLQ handling calls the canonical terminalizer in
`packages/adapters/automation-execution`; III itself never constructs or
commits a Failure View, and an already successful Run remains successful even
when queue acknowledgement later exhausts retries.

Browser and macOS controllers remain useful for source-specific user events,
current-context capture, and Delivery. They are not required for ordinary
committed-View triggers and must not manually reproduce this generic bridge.

## Automation View

The first Representation contract is deliberately small:

```text
enabled
trigger        user | event | schedule | accumulation
target         exact Core Operation or Transformation revision
input_mapping  trigger evidence plus required and optional View selectors
delivery       requested surfaces, urgency, expiry, and actions
limits         idempotency, cooldown, concurrency, and latency budget
```

An active Automation always references an exact Automation View revision and
an exact target revision. A new purpose forks a new Automation View; a changed
condition, selector, target, or delivery rule creates a new revision.

The Representation contains no credentials, runtime session id, UI component,
or executable provider code.

## Trigger model

Ambient v1 supports four Trigger families:

| Trigger | Examples | Evaluation owner |
| --- | --- | --- |
| user | push-to-talk, selection action, manual launch | macOS or browser Trigger adapter |
| event | URL/DOM match, View committed, source event | source-specific or View-event adapter |
| schedule | daily summary, weekly review | scheduler adapter |
| accumulation | dwell threshold, session ended, item count | bounded deterministic adapter state |

Trigger adapters receive validated Trigger definitions and emit a normalized
occurrence:

```text
occurrence id
Automation View id and revision
Trigger identity and source
occurred time
idempotency key
exact evidence View references
match evidence
small source payload
```

Trigger matching is deterministic. A Trigger cannot silently invoke a model to
decide whether it matched. Cooldown, debounce, expiry, replay, and concurrency
are declared and observable.

Continuous cheap observation is allowed; continuous Agent invocation is not.
For example, a browser adapter may listen to navigation and DOM mutation, but
it invokes the Automation only after its declared GitHub condition matches and
its dedupe reservation succeeds.

For durable reactive work, the committed-View trigger adapter may submit the
ordinary Automation invocation through `packages/adapters/iii-runtime`:

```text
committed exact View refs
  -> deterministic Automation match
  -> descriptor-only named III queue
  -> exact Automation revision
  -> Automation Runtime
  -> exact Execution input bindings
  -> Operator Worker
```

This queue is an admission and delivery boundary, not a second Automation
runtime. Automation still owns occurrence, context, target, delivery, and
correlation semantics; Execution still owns authorization, Run, candidate
validation, Failure Views, provenance, and atomic output commit. The III Worker
may host code or Agent Operator implementations, but it receives/returns the
same Operator input/output contract and never commits a View itself.

## Current context

There is no Ambient-owned context database. Context is a set of ordinary exact
Views selected at trigger time.

For an interactive user Trigger, source adapters capture fresh evidence on
demand:

```text
voice utterance Raw View
+ selected text Raw View
+ current app/window Raw View
+ Browser DOM Raw View when the foreground browser can provide it
+ optional project or history Views selected by the target
```

The default fidelity order is not a hidden fallback chain:

```text
explicit selection
  -> Browser DOM
  -> macOS Accessibility text
  -> screenshot/OCR/Vision
```

An Automation declares which role is required and which alternatives are
allowed. Missing required Browser DOM fails the invocation. AX or Vision is
attempted only when the Automation explicitly declares it, and every attempt
appears in trace.

Automation resolves declared trigger-time context roles and passes every role
to Execution as an invocation binding, including an explicit empty list for an
optional role with no match. Execution validates each supplied exact revision
against the frozen Transformation source, freezes and authorizes the complete
input set, and never selector-resolves a supplied role again. Ambient does not
build output candidates or private context packs behind that boundary. An
external Agent may use its installed skills and authorized View CLI or MCP
tools to retrieve further related Views.

## Invocation and Agent handoff

The Automation Runtime submits one target request:

```text
Automation revision
+ Trigger occurrence
+ explicit evidence View refs
+ target revision
+ frozen exact context bindings
+ Automation policy snapshot and requested Delivery
+ budget
```

Execution Runtime creates the Run before Operator execution, resolves and
freezes inputs, and invokes the Operator adapter. If the Operator is an Agent,
the shared Agent Adapter receives the user's instruction plus current context.
The Automation domain does not start ACP, pool sessions, choose permission
answers, validate Agent output, or commit result Views. The Ambient daemon
composition root may own an Agent runtime adapter as infrastructure.

An explicit instruction such as "send this page to Codex" is an Operator
override request. Execution Runtime freezes the accepted override in the Run.
Without an explicit override, the target Transformation's configured Operator
is used. Any alternative Agent is a separate observable attempt, never a
fallback hidden inside Ambient.

The current Execution bridge projects every frozen invocation input into
`current_context.raw.metaflow_inputs` with its role, exact View ref, Schema, and
either inline Representation or external reference. It also derives bounded
voice, screen, app, current-page, and selection fields for immediate Agent use.
Static Operator context may add fields but cannot replace evidence-owned fields.
The Transformation's `max_input_tokens` bounds the complete projection; large
inline values become explicit previews while external references are retained.
If even the minimum exact evidence cannot fit, Execution fails with
`input_context_budget_exceeded` and commits Failure evidence. Ambient must not
truncate, rebuild, or silently omit the input set itself.

The implemented Agent boundary is an `AgentOperatorPort` in
`packages/execution`. `packages/adapters/agent-runtime` implements that port
for mock, CLI, and ACP runtimes. `AgentOperatorExecutionBridge` converts the
semantic Agent result into an untrusted candidate, while `ExecutionRuntime`
alone validates, commits Derived or Failure Views atomically, and persists the
Run and replay trace. `OperatorExecutionRouter` selects the port from the
frozen Operator kind, so Agent and Function implementations can share one
Execution Runtime without introducing fallback selection in Ambient.

One invocation freezes the Transformation and Run ids, prompt, current
voice/screen/app context, exact input View policies, View tools, output
contract, execution mode, and accepted runtime override. Runtime selection,
capability rejection, progress, permission requests, and cancellation remain
correlated to the same Automation occurrence and Run. ACP text output is a
stream of ordered `agent_message_chunk` updates; the adapter reconstructs a
contiguous message before strict JSON and `AgentTaskOutput` validation and
reports chunk counts and parse failure details when reconstruction fails.

### Resident ACP and Metaflow MCP

`apps/ambient-daemon` uses the existing `AcpStdioAgentRuntimeAdapter` in
`persistent` lifecycle mode. It starts one ACP stdio child process on the first
Agent invocation and reuses that process to avoid repeated initialization cost.
Every Transformation Run still receives a distinct ACP session and exact MCP
server injection. Process warmth is not durable memory and cannot replace Views,
Run trace, or exact input provenance.

The daemon exposes stateless Streamable HTTP MCP at `/mcp`. The MCP server is a
projection of the same in-process `OperationService` used by the HTTP operation
surface, so it does not open a nested daemon, use a second SQLite graph, or
reimplement View and Execution behavior. ACP receives this endpoint through
`httpMcpServer("metaflow", url)` and can call the canonical `metaflow_*` tools.

Session close runs in a `finally` path after success, cancellation, invalid
Agent output, or prompt failure. Daemon shutdown stops new work, waits for the
resident child process to exit, and only then closes SQLite repositories.
Runtime events retain process id, session id, process reuse, stderr, orphan
updates, cancellation, and cleanup failures.

## Delivery and feedback

Execution success and delivery success are separate facts. A validated result
View may exist even when the requested display surface is unavailable.

Automation produces a Delivery Request referencing exact progress or result
Views:

```text
surface       notch | browser | panel | inbox
urgency       glance | interrupt | background
expires_at
actions       accept | dismiss | later | cancel | retry | correct
correlation   Automation occurrence and Transformation Run
```

Delivery adapters only render and return interaction events. The notch is a
small display and decision surface, not the attention policy or Agent. It
shows at most one immediate item; long-running work belongs in a panel or
inbox and may project compact progress to the notch.

Each Delivery Request has a stable request id, exact Automation and result or
progress View refs, occurrence and optional Run correlation, a replacement
policy, and one terminal attempt result:

```text
delivered | expired | suppressed | unavailable | failed
```

A single-capacity renderer implements `replace` or `keep_existing` exactly as
requested. Browser, panel, and inbox renderers may have multiple active items.
Renderer state may remain in memory, but Delivery request/result history is a
durable ledger keyed by request id with a unique delivered id. This preserves
idempotent replay and lets a restarted daemon validate an interaction from an
already displayed card. Rendering is not acknowledged as delivered until its
ledger entry commits. If persistence fails after rendering, the coordinator
withdraws the unrecorded item and fails loudly.

User interactions become Feedback Views linked to the exact Automation
revision, occurrence, Run, result View, and delivery attempt. Ambient v1 uses
feedback for inspection and explicit edits; it does not yet learn interruption
timing or invent new workflows automatically.

The strict actions are `accept`, `dismiss`, `later`, `cancel`, `retry`, and
`correct`. `later` requires an exact snooze time and `correct` requires the
user's correction. The Feedback View commits before any interaction command is
dispatched. Command dispatch uses the interaction id as its idempotency key;
replaying an existing Feedback View never repeats the command.

## Runtime lifecycle

```text
load and validate enabled Automation View revisions
  -> configure Trigger adapters
  -> receive occurrence and reserve idempotency key
  -> emit immediate accepted/progress Delivery when requested
  -> start target through Execution Runtime
  -> observe Run progress and committed result or Failure View
  -> issue Delivery Request
  -> record delivery status and Feedback Views
```

The runtime does not acknowledge success before its durable idempotency
reservation. Restart replay must either find the existing correlated Run or
start one new Run; it cannot duplicate work silently.

## Observability and failures

One correlation id links:

```text
Automation revision
Trigger occurrence and match evidence
dedupe decision
context candidates and selected exact revisions
policy decisions
Transformation Run and Agent events
result or Failure View
delivery attempts
Feedback Views
```

This is implemented as a strict append-only `AutomationTraceStore`, not a
best-effort logger. Each record has a schema version, ordered durable sequence,
event and recording times, source, exact Automation revision, correlation id,
optional occurrence and Run ids, optional attempt/parent-attempt ids, duration,
structured failure, and JSON payload. SQLite is the first adapter; querying by
correlation id reconstructs the same timeline after daemon restart.

The trace records both sides of disclosure policy. Every Context attempt keeps
candidate and selected exact View refs plus allowed and denied decision ids and
reasons. This answers not only what was withheld, but why each View was allowed
to reach an Agent.

Agent Adapter events enter through `createAutomationAgentTraceBridge`. The
bridge rejects mismatched correlation ids or non-JSON payloads before mapping
runtime selection, progress, permission, completion, cancellation, and failure
to the same Automation timeline. Ambient still does not own ACP sessions or
Agent routing.

Critical stages emit structured events such as:

```text
automation.occurrence_received
automation.occurrence_deduped
automation.context_resolved
automation.run_started
automation.result_committed
automation.delivery_attempted
automation.delivery_succeeded
automation.delivery_failed
automation.feedback_recorded
```

Failures use a closed stage vocabulary with a specific code and message:

| Stage | Examples | Failure View |
| --- | --- | --- |
| occurrence | reservation storage failure | none; no Run exists |
| context | required View missing, access denied, resolution failed | none; execution never starts |
| execution | Operator or Agent runtime failure | required from Execution Runtime |
| validation | output contract rejected | required from Execution Runtime |
| commit | atomic result commit conflict | required from Execution Runtime |
| delivery | renderer unavailable or failed | no; successful result View remains valid |
| finalization | occurrence terminal state could not persist | preserves prior Run evidence |
| trace | append-only trace could not persist | fail fast; do not continue silently |

An `AutomationTargetExecutor` must return execution, validation, and commit
failures as a structured result with an exact Failure View. A thrown target
exception is reserved for infrastructure failure before a structured Execution
result and is recorded as `target_execution_failed`; Automation does not invent
a fake Failure View outside Execution Runtime.

Retries and alternative context, Agent, or Delivery choices are new explicit
attempts with `attempt_id`, `parent_attempt_id`, and reason. They are never
silent fallback branches inside an existing attempt.

Trigger validation, required context, access policy, target validation,
execution, result validation, and delivery have distinct error codes. A
duplicate is an observable skip, not an error. Execution failure is represented
by Execution Runtime's Failure View. Delivery failure never rewrites an
otherwise successful Run as an execution failure.

## Package ownership

```text
packages/
  automation/       Automation View schema, Trigger adapter port, occurrence
                    admission, idempotency, target invocation, delivery port,
                    and correlation trace
  transformation/   reusable Transformation and Operator contracts
  execution/        input resolution, authorization, Run, Operator execution,
                    validation, commit, and Failure Views
  view/             View model and View Store port
  adapters/         browser/macOS/scheduler and committed-View Trigger adapters,
                    Agent Operator adapters, Automation-to-Execution bridging,
                    durable Automation state, and notch/browser/inbox Delivery
                    adapters

apps/
  chrome-extension/ mac/ ambient-daemon/ scripts/v1/
                    composition roots only
```

Dependencies point inward:

```text
automation -> view + transformation + execution ports
execution  -> view + transformation
adapters   -> the ports they implement
apps       -> capabilities and adapters they compose
```

`packages/ambient-layer`, v0 `Program` attention decisions, and direct browser
or macOS AgentTask submission are archived migration evidence outside the
canonical workspace. Active v1 code cannot import them or legacy `@info/core`.
Temporary Chrome/macOS transport callers and their removal conditions are
listed in `wiki/architecture/v0-migration-inventory.md`.

The first implementation foundation is now present:

- `packages/automation` validates strict Automation Views, deterministic
  Trigger predicates, Trigger signals and exact occurrences, and runs the
  occurrence-to-target-to-Delivery lifecycle through required ports;
- `packages/adapters/automation-sqlite` atomically reserves occurrences and
  enforces exact replay idempotency, cooldown, concurrency, and final-state
  conflicts across restarts; it also persists exact Delivery attempts and
  rejects conflicting request or delivery ids, and stores ordered correlation
  timelines across restart;
- `tests/automation-v1.test.ts`, `tests/automation-sqlite.test.ts`, and
  `tests/ambient-agent-integration.test.ts` verify the contracts, failure
  behavior, persistence, and current voice/screen handoff to the shared Agent
  Adapter;
- `tests/automation-delivery.test.ts` verifies notch replacement and
  suppression, independent surfaces, expiry, unavailable delivery, exact
  progress/result feedback, six user actions, replay idempotency, and
  interaction recovery after coordinator restart.
- `tests/automation-trace.test.ts` verifies a complete Trigger-to-Feedback
  timeline, exact allowed policy decisions, Agent correlation, restart query,
  every failure stage, fail-fast trace persistence, and explicit retry links.
- `packages/adapters/automation-execution` maps exact Automation context roles
  into `ExecutionRuntime.invocation_inputs`, including empty optional roles,
  and replays correlated Agent events without constructing candidates or
  committing Views;
- `packages/adapters/iii-runtime` durably enqueues descriptor-only Automation
  invocations, resolves their exact Automation revisions, and hosts versioned
  Function and Agent Operator ports through III. It records queue receipts,
  retry/DLQ, cancellation, registration, and Operator events while canonical
  Automation and Execution remain the only state owners;
- `packages/adapters/browser-capture` owns strict factual Browser events and
  atomic page/save-intent/selection Raw View admission through the shared
  Connector Runtime. Extension, HTTP, and adapter share its browser-safe wire
  schema; MV3 visit/focus/document/frame facts stay Capture evidence rather
  than Automation state;
- `packages/adapters/browser-automation` owns Browser event validation, cheap
  URL/DOM matching, the exact-evidence port call, mailbox projection, and
  interaction transport. It does not construct Capture candidates, execute
  Operators, or commit result Views;
- `packages/adapters/scheduler-automation` uses `cron-parser` for timezone and
  DST semantics, emits one deterministic signal per exact half-open period,
  persists a compare-and-swap cursor in SQLite, and bounds restart catch-up;
- `packages/adapters/inbox-automation` supplies a multiple-capacity Inbox
  mailbox plus HTTP delivery and interaction projection. Feedback still commits
  through the shared Delivery coordinator before any command;
- `apps/ambient-daemon` composes SQLite View/Execution and Transformation
  repositories, strict
  authorization, the Operator router, ACP Agent adapter, Automation runtime,
  Browser/macOS/Scheduler adapters, Inbox HTTP bridge, Delivery ledger,
  shared OperationService, pure v1 HTTP handler, Feedback service, and trace
  store. Automation Agent Operators still use the explicit ACP adapter. Direct
  assist defaults to the resident Claude Code ACP process and one persistent
  exact session per `conversation_id`; Pi RPC is a lazily started, user-selected
  alternative. The direct notch conversation sends a bounded current-screen
  image, streams Markdown deltas, and has no `@info/core` or `@info/server`
  dependency. The parent process remains resident, but only four conversation
  sessions may remain open. Capacity or ten minutes of inactivity closes the
  least-recent inactive session; revisiting it uses ACP `session/load` with the
  exact retained session id;
- `tests/automation-execution-adapter.test.ts` and
  `tests/ambient-daemon-vertical.test.ts` verify exact invocation bindings and
  the complete Browser-to-Execution-to-Feedback path.
- `tests/agent-runtime-adapter.test.ts` verifies one resident ACP process across
  distinct sessions, exact MCP injection, targeted cancellation, and session
  cleanup after invalid output. `tests/ambient-mcp-http.test.ts` performs a real
  Streamable HTTP MCP initialize, tool listing, and `metaflow_catalog_list`
  call against the daemon handler.

## First implementation slices

### Browser GitHub summary

```text
GitHub URL/DOM condition + dwell
  -> Browser Trigger occurrence with full-page View
  -> summary Transformation or Agent Operator
  -> summary View
  -> browser or inbox Delivery
```

DOM mutation is cheap observation. The Agent runs once per declared dedupe
window, not on every mutation.

This slice is implemented and verified. The Chrome extension emits one strict
Browser Automation event only after its declarative match. The daemon asks the
Browser Capture adapter to atomically admit an exact Raw page View and optional
selection, invokes the exact GitHub summary
Transformation through ACP, commits the summary through Execution, exposes the
exact result View to the Browser card, records `accept` as a Feedback View, and
deduplicates another event from the same navigation without a second Agent Run.
The deterministic vertical test and a live `claude-agent-acp` smoke both pass.

### macOS push-to-talk

```text
hold Right Option and speak over selected text
  -> freeze the current Accessibility snapshot
  -> Doubao realtime ASR
  -> POST prompt + immediate context to /ambient/v1/assist
  -> resident Claude Code ACP conversation
  -> streaming Markdown notch answer
```

The current notch implementation is a deliberately thin interaction slice
ahead of View integration. It reuses the old Ambient panel geometry and voice
interaction, but does not admit Views, invoke Automation, poll Delivery, submit
Feedback, or register MCP tools. Claude retains its native ACP tools and the
direct-assist permission broker selects an allow option offered by the Agent.
Pi starts only when selected and then retains its ordinary extensions, skills,
prompt templates, project context files, session persistence, and default tool
permissions. Metaflow does not replace or narrow either harness; it supplies
only the prompt and supplemental immediate screen context. The TypeScript
daemon streams strict NDJSON deltas plus a terminal success or failure event.
Ordinary Direct Assist turns must complete in the foreground. A background
Agent, Task, worktree, or repository write is allowed only when the current user
message explicitly asks for that behavior. If the HTTP client disconnects, its
AbortSignal reaches the conversation runtime and invokes ACP cancellation.
Daemon shutdown closes live HTTP connections after stopping admission, causing
the same cancellation path to run before ACP and persistence are closed.
The one startup compatibility migration accepts only the exact historical
`metaflow-mac-companion` Automation revision and appends an exact-lineage
revision using the canonical `metaflow-mac` source; other drift still fails.
It also projects native ACP and Pi tool execution as bounded `tool_activity`
events containing correlation id, title/name, kind, and status, never raw tool
input or result content. A completed tool-launch event carrying
`run_in_background=true` remains running until the containing Agent turn is
terminal. The notch briefly buffers initial text to distinguish a
direct answer from a tool-using turn. Direct answers then stream; a tool-using
turn shows its live tool timeline, suppresses provisional prose, and reveals the
complete final answer only after the Agent turn completes. Progress never owns
notch presentation: an already expanded notch may show live text and tools, but
a docked notch remains docked through every delta and tool update. Docking during
an active turn is also sticky until terminal success or failure expands it.
This direct route must remain visibly separate
from the canonical Automation runtime until a later migration explicitly binds
the prompt and current context to exact Views.

Holding Right Option freezes the Accessibility snapshot and begins Doubao
realtime ASR; releasing it finalizes and submits the utterance with the frozen
app, window, focused text, selected text, and current-display JPEG. The notch
remains docked while listening and while the Agent is working, then expands when
the turn finishes. The shortcut is persisted and user-configurable; custom
modifier/key combinations use the same press/release push-to-talk lifecycle.
Missing Doubao credentials fail explicitly. There is no Apple Speech or hidden
model fallback. The macOS request uses 900 seconds as a final hard deadline;
client disconnect cancellation and foreground turn settlement remain the
primary lifecycle controls.

Selection resolution is invocation-scoped. It checks direct selected text,
standard character ranges, WebKit/Chromium text-marker ranges, and at most 120
Accessibility elements over 12 descendant levels. This bounded traversal is
never part of periodic macOS observation, which remains focused-element-only.
The direct-assist request preserves selected-text whitespace for code and
structured prose. A one-line notch preview may normalize whitespace for layout.
When an application does not expose selection through Accessibility, capture is
explicitly unavailable; the app does not synthesize Copy or mutate the system
clipboard as an implicit fallback.

The native composition must run as an application bundle. `pnpm mac:bundle`
builds, ad-hoc signs, verifies, and installs the one canonical bundle at
`~/Applications/Metaflow.app`. Running `swift run` directly is not an equivalent
voice test because the raw executable has no bound Microphone usage description.
The bundle exposes two fail-fast diagnostics:

```text
--permission-smoke
  -> Accessibility + Microphone authorization
  -> exit 5 until both are authorized

--asr-smoke
  -> one real microphone + Doubao realtime ASR request
  -> exit 7 with a structured provider error or empty transcript

--ax-smoke --require-selected-text
  -> exact frontmost AX snapshot
  -> exit 2 permission denied
  -> exit 3 no frontmost app
  -> exit 4 selected text unavailable
  -> exit 0 only with non-empty selected text
```

The companion exposes an explicit `Request Microphone Permission` command so
TCC authorization is completed before, and remains separate from, the first
push-to-talk request.

### Scheduled summary

```text
timezone-aware schedule occurrence
  -> explicit time-window View selector
  -> ordinary summary Transformation
  -> inbox Delivery
```

Missed, delayed, duplicate, and replayed periods remain explicit occurrences.

This slice is implemented without a batch intelligence path. The schedule
definition freezes a cron expression, IANA timezone, catch-up policy, and
maximum period count. `cron-parser` computes adjacent boundaries, including DST
transitions. Every signal carries:

```text
schedule expression and timezone
period [start,end)
detected_at
dispatch state: on_time | delayed | missed | manual_replay
optional explicit replay identity, reason, and parent signal
```

The first tick processes the most recent completed period. After that, the
durable cursor enumerates every due boundary through the current clock. A gap
larger than `max_periods` fails with `catch_up_limit_exceeded`; it never skips
history silently. The cursor advances through compare-and-swap only after
Automation returns `succeeded`, `failed`, or `duplicate`, or throws a
`context_resolution_failed` or `target_execution_failed` error after durably
finalizing the occurrence as failed. Scheduler records those two terminal
errors as `period_failed` before advancing. Reservation, trace, finalization,
catch-up, and cursor failures remain infrastructure errors and do not advance.
If an infrastructure failure happens after an occurrence committed, normal
occurrence idempotency returns `duplicate` on retry and lets the cursor advance.
Manual replay uses a new signal and idempotency identity and does not change the
ordinary cursor.

Context mapping declares `time_range: occurrence_period` and a timestamp basis.
The View Store applies Schema categories plus the half-open range using SQLite
epoch comparison. `observed_at` queries exclude Views without `observed_at` and
do not fall back to creation time. The resolver authorizes and freezes the
resulting exact revisions, then passes only those refs through the same
Automation-to-Execution bridge used by Browser and macOS.

The seeded daily slice runs `transformation.ambient.daily_summary@1` through the
ordinary Agent Operator and commits `summary.ambient.daily@1`. Its result is
sent to the Inbox Delivery adapter and exposed at
`GET /automation/v1/inbox/deliveries`; retry and correction interactions enter
through `POST /automation/v1/inbox/interactions` and create exact Feedback Views
before command dispatch.

Verification uses fake-clock fixtures for normal startup, restart, multiple
missed periods, a crash-window duplicate, bounded catch-up, manual replay, and a
23-hour New York DST period. The vertical fixture proves period/category
selection, ACP context projection, Execution commit, Inbox delivery, HTTP
interaction, Feedback Views, and the complete correlation trace.

## v1 exclusions

- continuous Ambient LLM polling;
- learned interruption policy;
- automatic repeated-workflow discovery;
- automatic code or Automation self-modification without a proposed revision;
- a separate Ambient memory store;
- full visual design for notch, browser, panel, or inbox;
- hidden context, Agent, or delivery fallback.

# Info Runtime Implementation Plan

> Engineering plan for building Info without drifting away from the highest-level architecture.

## 1. Architectural target

Info is a local-first ambient context runtime.

The product should not be implemented as one giant proactive agent, one browser extension, or one plugin system. Those are only instances or packaging layers.

The stable runtime loop is:

```text
Observation
  -> Context Graph
  -> Program attention
  -> Capability / Agent execution
  -> View
  -> Application / Agent consumption
  -> Feedback Observation
  -> Learning View / Memory View / Routing View
```

Everything we build should preserve this separation.

## 2. Non-negotiable invariants

```text
Raw observations stay clean.
Everything intelligent is a View.
Views circulate through the context graph.
Memory is a View that changes future behavior.
Programs are user-value loops.
Capabilities are reusable powers.
Applications are replaceable surfaces.
Feedback is training signal.
Autonomy grows through trust.
Privacy is architecture.
```

Practical meaning:

- A browser page capture is an `Observation`.
- “This page is relevant to the current project” is a `View`.
- “The user often uses GitHub repo pages while coding in this project” is a `Memory` or `Routing` View.
- “Submit this analysis to Claude Code / Multica” is an `AgentTask` through `capability.agent_task.submit`.
- “Browser Ambient” is a `Program`.
- The browser popup/sidebar is an `Application`.
- A plugin is only a package that may contain these pieces.

## 3. Current implementation baseline

Current runtime already supports the important spine:

```text
ContextRecord       -> Observation
ContextView         -> View
RuntimeEvent        -> provenance / audit trail
ProgramRuntime      -> Program execution engine
Program             -> scenario loop
Capability          -> reusable tool / agent / transform
ContextBroker       -> policy-aware context pack builder
browser-extension   -> sensor + small application
```

Implemented Programs:

```text
program.browser_ambient
program.project_ambient
program.language_learning
program.routing_learning
```

Implemented Capability:

```text
capability.browser_ambient.explore
```

Important current behavior:

- Programs can process Observations and Views.
- Programs can call Capabilities through `runCapability`.
- Capability execution is policy-gated.
- Browser Ambient prefers AgentTask output `analysis.browser_agent_task`; `analysis.browser_page` is the deterministic fallback, not a direct action.
- Project Ambient can consume Browser Ambient analysis Views.
- Feedback can be ingested as raw Observations.
- Routing Learning can convert positive feedback into `routing.shortcut` Views.
- Context packs include source records and source Views with bounded provenance expansion.
- Applications can poll View updates with `GET /context/views?...&cursor=...` and advance using `next_cursor`.

Feature specs maintained separately:

- `docs/feature-workflow-crystallization.md` — Workflow Crystallization（工作流结晶）: agent explores unknown workflows, successful traces become reusable recipes, deterministic execution is tried first next time, and stale recipes fall back to agent exploration.

## 4. Module ownership

### 4.1 Sensors

Sensors only capture facts.

Examples:

```text
browser extension
screenpipe
git watcher
terminal watcher
agent conversation importer
GitHub issue importer
```

They write Observations.

They should not decide:

- project membership;
- user intent;
- importance;
- whether to call Claude;
- whether to create tasks.

Those belong to Programs and Views.

### 4.2 Context Graph

The Context Graph stores:

```text
Observations
Views
Events
Relations
Policy
```

It must support:

```text
timeline query
source/app query
URL/domain query
project/workspace query
keyword query
vector query
relation/provenance query
policy-constrained query
```

Do not treat the graph as “just a database”. It is the substrate that lets Programs compose.

### 4.3 Programs

A Program is a living loop around a user-value scenario.

Examples:

```text
Browser Ambient        -> understand current browser context
Project Ambient        -> understand and advance current project
Language Learning      -> turn real exposure into personalized learning
Daily Summary          -> compress activity timeline
Research Shadow        -> follow user research and gather supporting material
Coding Companion       -> connect code, issues, docs, agent chats, diffs
```

Program responsibilities:

```text
attention decision
context request
capability orchestration
View creation
event/provenance emission
feedback interpretation
learning hooks
```

### 4.4 Capabilities

A Capability is a reusable power.

Default runtime capabilities stay small:

```text
capability.agent_task.submit
capability.browser_ambient.explore  // deterministic classification/fallback only
```

Specialized PDF/GitHub/code extractors are plugin or explicitly registered capabilities, not default runtime capabilities. External runtimes such as Claude Code or Multica may also own those skills internally.

Capabilities should be scenario-neutral. They should return structured results that Programs can turn into Views.

Bad:

```text
capability.browser_ambient_do_everything
```

Better:

```text
capability.agent_task.submit
```

Browser Ambient should prefer the generic AgentTask boundary. During experiments the task goes to local Claude Code, and the external agent runtime owns any repo/PDF/search/code skills it decides to use.

### 4.5 Views

Views are the circulation layer.

Important View classes:

```text
analysis.*      explain one object
extraction.*    make raw artifact usable
space.*         group related context
timeline.*      organize time
summary.*       compress activity
brief.*         synthesize for a purpose
app.*           feed an application
intent.*        represent current or learned intent
task.*          represent delegated or planned work
memory.*        change future behavior
routing.*       optimize future dispatch
policy.*        constrain autonomy/privacy
```

Rule:

```text
Not every View is Memory.
But every Memory is a View.
```

This prevents “memory” from becoming a dumping ground for processed data.

### 4.6 Applications

Applications are replaceable UI / interaction surfaces.

Examples:

```text
browser popup
browser sidebar
project cockpit
language learning web app
daily briefing page
research inbox
generated work canvas
```

Applications should:

```text
read Views
render useful interaction
let user accept / dismiss / edit / ask follow-up
write feedback Observations
```

Applications should not own the core intelligence loop.

## 5. How scenarios compose

### 5.1 Browser reading a GitHub repo

```text
browser extension
  -> POST /context/ingest?process=true&cascade_views=true
  -> observation.browser_ambient_requested

program.browser_ambient
  -> capability.agent_task.submit
  -> local Claude Code during experiments; future external runtimes own skills/tools
  -> analysis.browser_agent_task
  -> fallback only when AgentTask is unavailable: analysis.browser_page

program.project_ambient
  -> consumes analysis.browser_agent_task or fallback analysis.browser_page + git diff + cwd + agent chats + GitHub issues
  -> project.current_context
  -> thread.active_work

application.project_cockpit
  -> renders project.current_context
  -> user dismisses / accepts / edits

feedback Observation
  -> program.routing_learning
  -> routing.shortcut or memory.project.*
```

Key point:

Browser Ambient does not need to know the whole project. It writes a reusable View. Project Ambient decides whether that View matters to the project.

### 5.2 Language learning

```text
browser/screen/selection observations
  -> program.language_learning
  -> extraction.language_examples
  -> app.language.learning_pack
  -> memory.language.vocabulary
  -> memory.language.mistakes
```

The language learning web app is not the intelligence. It is a surface over `app.language.*` and `memory.language.*` Views.

### 5.3 Daily summary

```text
timeline observations + project views + browser analyses + feedback
  -> program.daily_summary
  -> summary.daily
  -> brief.tomorrow
  -> memory.routine_patterns
```

Daily Summary is a timeline-attention Program. It should reuse Views produced by other Programs instead of re-analyzing all raw records from scratch.

## 6. Autonomy model

Autonomy should be gradual and policy-backed.

```text
manual        user explicitly clicks or asks
suggest       system proposes, user decides
draft         system prepares artifacts, user commits
sandbox_auto  reversible local actions within scope
full_auto     trusted automation within explicit scope
```

Default:

```text
local observation and local analysis can be low-friction
external LLM, external readers, file writes, network actions, and irreversible actions require policy
```

Programs and Capabilities should never bypass the same policy gate.

## 7. Routing and learning

Initial routing can use simple rules, but the long-term design is learned attention.

Runtime path:

```text
new Observation/View
  -> router selects candidate Programs
  -> Program attention decides ignore/observe/defer/run
  -> repeated successful routing becomes routing.shortcut
  -> feedback updates routing confidence
```

The router should be:

```text
small
inspectable
policy-aware
shortcut-aware
fallback-safe
```

It should not become a giant rules engine.

## 8. Events and debuggability

Every important transition should produce an Event:

```text
program_runtime.signal_received
program.attention_decision
program.attention_failed
program.run.started
program.run.completed
program.run.failed
capability.run.started
capability.run.completed
capability.run.failed
capability.run.skipped
policy.denied_action
feedback.received
```

Events should answer:

```text
what ran
why it ran
what it read
what it wrote
which policy applied
what failed
```

This is required because ambient systems are otherwise impossible to trust.

## 9. Implementation order

Do not build by inventing many UI features first. Build by strengthening the runtime spine.

Recommended next slices:

### Slice A: Runtime diagnostics

Goal:

```text
make routing/capability/program behavior inspectable in UI and tests
```

Tasks:

- expose missing routing target diagnostics;
- expose selected Program IDs;
- expose skipped Programs and reasons;
- expose policy denial reasons.

Tests first:

```text
routing shortcut missing target is visible
policy denial appears in process result
attention failure does not block later Programs
```

### Slice B: Capability generalization

Goal:

```text
move Browser Ambient away from one special capability toward reusable capabilities
```

Tasks:

- keep the generic `capability.agent_task.submit` boundary;
- keep `capability.browser_ambient.explore` as deterministic fallback/classification only;
- make AgentTask result payloads typed enough for Programs to convert into Views.

Tests first:

```text
Program can call generic AgentTask capability
privacy denial blocks AgentTask through provenance
AgentTask output can become analysis View
```

### Slice C: View subscription / application consumption

Goal:

```text
Applications consume Views without owning intelligence
```

Tasks:

- add query endpoints for recent Views by type/category/source;
- add endpoint for a View’s provenance chain;
- add feedback endpoint coverage for app interactions.

Tests first:

```text
GET recent analysis.browser_agent_task Views
GET source records for View
POST feedback related_to View writes feedback Observation
```

### Slice D: Project Ambient as multi-source synthesis

Goal:

```text
prove that independent observations/views can combine into one project context
```

Inputs:

```text
browser analysis Views
git diff Observations
agent chat Observations
GitHub issue Observations
terminal command Observations
```

Outputs:

```text
project.current_context
thread.active_work
brief.project_next_state
memory.project.patterns
```

Tests first:

```text
Project Ambient combines browser analysis + git diff
inactive source Views are ignored
privacy-denied source records do not leak into agent context
```

### Slice E: Learning loop

Goal:

```text
feedback changes future routing and context selection
```

Tasks:

- compile repeated positive feedback into `routing.shortcut`;
- compile repeated edits/dismissals into `memory.*`;
- age or lower confidence for stale Views.

Tests first:

```text
positive feedback increases routing confidence
dismissal lowers future surfacing priority
expired memory is not injected into context pack
```

## 10. Coding rules

For every feature:

1. Write the test first.
2. Keep raw Observations factual.
3. Put all inference into Views.
4. Emit Events for runtime decisions.
5. Use Policy for autonomy and privacy.
6. Keep Applications thin.
7. Make derived outputs reusable.
8. Prefer small composable functions over framework-level abstraction.
9. Do not rename core concepts casually.
10. Do not optimize for one demo at the cost of the runtime model.

Definition of done:

```text
tests pass
typecheck passes
provenance is visible
policy behavior is tested
View output can be consumed by another Program or Application
```

## 11. Current recommended next move

The next best engineering move is **Slice A: Runtime diagnostics**.

Reason:

- it strengthens the core runtime instead of adding a one-off feature;
- it helps debug Browser Ambient, Project Ambient, and future Programs;
- it makes routing/attention/policy behavior visible to Applications;
- it reduces confusion before adding more autonomous behavior.

Concrete first test:

```text
ProgramRuntime result includes selected routing shortcut, missing routing targets, and selected Program IDs.
```

Then implement the smallest result-shape change needed to expose that data.

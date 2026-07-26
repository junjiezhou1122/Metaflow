# Info Ambient Context Runtime

> This document captures the current design consensus for Info after the May 2026 architecture discussion.

## 1. One-sentence definition

Info is a **local-first, self-evolving context runtime**.

Programs transform raw observations into circulating Views through reusable Capabilities. Applications and agents consume those Views to help the user across different speeds and autonomy levels.

```text
Observations in.
Views circulate.
Programs evolve.
Applications and agents consume.
Feedback teaches the system.
```

Info is not primarily a notes app, a chatbot, or a plugin marketplace. It is the substrate that lets many personal AI programs grow from the user's real workflow.

---

## 2. Core thesis

The user's real work and life continuously produce valuable information:

- pages read;
- text selected or copied;
- Codex / Claude conversations;
- code changes;
- GitHub issues;
- terminal commands;
- meetings;
- app/window/screen activity;
- accepted, rejected, or edited AI outputs.

Most of this context normally evaporates. Info turns it into durable, queryable, provenance-backed context that can be reused by programs, agents, applications, and future work.

The gap is not only a storage problem. It is a **presence problem**: the system should notice what matters, remember what matters, and help at the right moment.

---

## 3. Design principles

```text
Raw observations stay clean.
Everything intelligent is a View.
Views circulate through the context graph.
Memory is a View that changes future behavior.
Programs create user-value loops.
Capabilities are reusable.
Applications are replaceable.
Events make the system trustworthy.
Feedback makes the system self-evolving.
Autonomy grows through demonstrated trust.
```

A more operational version:

```text
Observe -> Route -> Attend -> Transform -> View -> Present -> Feedback -> Learn
```

---

## 4. Core concepts

The core mental model has six concepts.

```text
Observation
Program
Capability
View
Application
Event
```

Plugin is not a core concept. A plugin is only a packaging/distribution format that may contain Programs, Capabilities, Applications, schemas, connectors, and assets.

### 4.1 Observation

An Observation is a raw fact captured from a Channel or Application.

Examples:

```text
observation.browser.page
observation.browser.search_query
observation.browser.text_selected
observation.browser.text_copied
observation.codex.message
observation.git.diff
observation.github.issue
observation.screen.ocr
observation.terminal.command
feedback.advice.dismissed
feedback.language.word_known
```

Rules:

- Observations should record what was directly observed.
- Do not put inferred project/thread/objective meaning into a raw Observation.
- Inference belongs in Views with confidence, source objects, and reasons.

Example:

```json
{
  "schema": { "name": "observation.browser.text_copied", "version": 1 },
  "source": { "type": "browser", "connector": "browser-extension" },
  "content": {
    "title": "Event-driven agent runtime design",
    "url": "https://example.com/agent-runtime",
    "text": "Capabilities should write outputs back to the context graph."
  },
  "scope": {
    "domain": "example.com",
    "app": "browser"
  }
}
```

The browser sensor should not invent `project_path`. If the page is likely related to `/Users/junjie/info`, that belongs in a derived View or relation with evidence.

### 4.2 View

A View is any derived, organized, interpreted, compressed, planned, or application-ready context object.

Examples:

```text
space.learning.english
space.project.info
work_thread
project.current_context
summary.daily
brief.research
app.language.learning_pack
app.language.review_queue
advice.research
opportunity.tool
task.plan
policy.autonomy_profile
routing.shortcut
memory.channel.codex.collaboration_style
memory.project.info.architecture_principles
intent.current
```

Important rule:

```text
Not every View is memory.
But every Memory is a View.
```

View categories:

| Category | Examples | Purpose |
|---|---|---|
| Collection View | `space.learning.english`, `space.project.info` | Groups related context objects |
| Extraction View | `extraction.pdf_text`, `reader.article_snapshot` | Makes raw artifacts usable |
| Summary View | `summary.daily`, `summary.meeting` | Compresses time or events |
| Brief View | `brief.research`, `brief.project` | Gives task-focused synthesis |
| App Data View | `app.language.learning_pack`, `app.language.review_queue` | Feeds applications |
| Advice View | `advice.research`, `advice.coding` | Just-in-time suggestion |
| Opportunity View | `opportunity.tool`, `opportunity.automation` | Suggests a new improvement or automation |
| Task View | `task.plan`, `task.agent_assignment`, `task.result` | Represents planned/delegated work |
| Policy View | `policy.autonomy_profile` | Stores user/project/program permissions |
| Routing View | `routing.shortcut` | Stores learned routing shortcuts |
| Memory View | `memory.*` | Learned patterns that change future behavior |
| Intent View | `intent.current`, `memory.intent.*` | Current and learned intent |

Views must be:

```text
addressable
queryable
provenance-backed
policy-scoped
available for circulation
```

Default rule:

```text
Views circulate by default within local policy.
External sharing requires permission.
```

### 4.3 Program

A Program is a **living context loop** for a user-value scenario.

It watches Observations and Views, uses Capabilities, writes Views, learns from feedback, and adapts its future behavior.

Examples:

```text
program.language_learning
program.project_ambient
program.research_shadow
program.daily_summary
program.meeting_assistant
program.personal_crm
```

A Program answers:

```text
Why does this scenario exist?
What does it attend to?
Which Capabilities does it use?
Which Views does it produce?
Which Applications present the output?
What feedback teaches it?
What autonomy/policy does it need?
```

A Program is not static. It can adapt low-risk strategy automatically:

```text
attention
schedule
output format
ranking
difficulty
view content
routing preferences
```

But it must propose or request permission before expanding risk:

```text
using external search
adding new capabilities
creating/modifying applications
delegating coding work
performing irreversible external actions
```

#### Example: Language Learning Program

```text
Purpose:
  Turn the user's real English exposure into personalized learning material.

Attends to:
  English text read, selected, copied, searched, or asked about.

Uses capabilities:
  language.detect
  vocabulary.extract
  example.compile
  review.schedule
  story.generate

Produces views:
  app.language.learning_pack
  app.language.review_queue
  memory.language.known_words
  memory.language.exposure_pattern

Applications:
  language dashboard
  browser tooltip / sidebar

Learns from:
  word_known feedback
  review_completed feedback
  card skipped behavior
  user later searches a word meaning
```

#### Example: Project Ambient Program

```text
Purpose:
  Help the user continue and improve active projects by assembling cross-channel context,
  researching missing knowledge, suggesting next steps, and optionally delegating work.

Attends to:
  git diffs
  terminal cwd
  Codex/Claude sessions
  GitHub issues/PRs
  browser docs
  project-related research

Uses capabilities:
  project.assemble
  ai_session.locate
  github.issue.fetch
  research.search
  task.plan
  agent.delegate
  code.review

Produces views:
  project.current_context
  work_thread
  issue_context
  brief.project_research
  advice.project
  task.plan
  task.agent_assignment

Applications:
  Codex context injection
  project dashboard
  task inbox
```

### 4.4 Capability

A Capability is a reusable executable ability.

It can be:

```text
deterministic code
an LLM call
an agent
an external HTTP service
an iii worker
a script
a workflow
```

Examples:

```text
capability.agent_task.submit
capability.browser_ambient.explore

Plugin/explicit capabilities may add:
pdf.extract
reader.snapshot
language.detect
vocabulary.extract
research.search
research.summarize
project.assemble
thread.assemble
daily.summarize
task.plan
agent.delegate
code.modify
```

Rules:

```text
Capabilities do not call each other as a hidden private graph.
Capabilities write Views / Observations / Events.
Other Programs and Capabilities observe those outputs through the context graph.
```

### 4.5 Application

An Application is a user-facing interface that reads Views and writes user feedback.

Examples:

```text
language learning dashboard
research inbox
project dashboard
daily summary page
browser sidebar
Codex context injection
```

Applications should not own the core intelligence. They consume and contribute to the shared context graph.

Example:

```text
language dashboard reads app.language.learning_pack and app.language.review_queue
user clicks "I know this word"
application writes feedback.language.word_known Observation
language_learning Program learns from that feedback
```

### 4.6 Event

An Event records runtime/provenance activity.

Examples:

```text
observation.ingested
view.created
view.updated
capability.run.started
capability.run.completed
program.run.completed
router.route.learned
agent.task.assigned
agent.task.completed
policy.denied
```

Events answer:

```text
What happened?
Why did it happen?
Which inputs were used?
Which capability/program produced the output?
What policy allowed or denied it?
```

---

## 5. Plugin as packaging

Plugin is only the packaging format.

```text
Plugin = installable bundle
```

A plugin may contain:

```text
Programs
Capabilities
Applications
View schemas
Connectors
Assets
Default policies
```

Example:

```text
language-learning-plugin
  program.language_learning
  capability.language.detect
  capability.vocabulary.extract
  capability.review.schedule
  app.language_dashboard
  view schemas for language learning
```

Avoid saying "the language learning plugin is the app." More precise:

```text
The language-learning plugin provides a language-learning Program,
several language Capabilities,
and a language dashboard Application.
```

---

## 6. Channels and sensors

A Channel is an input/output channel, not a core data object.

Examples:

```text
browser
screen
codex
terminal
git
github
email
calendar
language_app
browser_sidebar
```

A sensor observes a Channel and emits Observations.

Examples:

```text
browser-extension = browser channel sensor + possible browser output surface
screenpipe = ambient OS/screen sensor across many channels
local-project snapshot = git/project sensor
Codex/Claude importer = AI session channel sensor
```

Relationship:

```text
Channel -> Sensor -> Observation
Application/Channel <- View
```

---

## 7. Router, Attention, and Intent

### 7.1 Router

Router is a runtime service that sees lightweight signals from new Observations/Views and routes them to candidate Programs.

It should not perform all business judgment.

```text
Router learns where context usually goes.
Program attention decides what context means.
Capability transforms selected context.
```

Router can learn shortcuts:

```text
browser.text_copied + language=en -> program.language_learning
browser.page + url ends .pdf -> AgentTask or installed pdf plugin / research_shadow
codex session + git diff + github issue -> project_ambient
```

Routing shortcuts are themselves Views:

```text
routing.shortcut
```

### 7.2 Attention

Attention is the selection logic inside a Program.

It decides:

```text
Is this relevant?
Should we ignore, defer, attach, run, search, or suggest?
Which context should be loaded?
Which speed tier should be used?
```

Attention is shaped by:

```text
Program definition
current intent
memory views
routing history
user feedback
policy
```

### 7.3 Intent

Intent is represented as Views.

```text
intent.current
memory.intent.*
```

`intent.current` should eventually be layered by speed:

```json
{
  "view_type": "intent.current",
  "content": {
    "reflex": {
      "hypothesis": "user is naming a concept",
      "confidence": 0.65
    },
    "glance": {
      "hypothesis": "user is clarifying Info architecture",
      "confidence": 0.84
    },
    "workblock": {
      "hypothesis": "user is designing a self-evolving context runtime",
      "confidence": 0.91
    }
  }
}
```

Learned intent patterns become memory Views:

```text
memory.intent.design_before_code
memory.intent.research_depth_preference
```

---

## 8. Real-time layer and accumulation layer

Info has two complementary layers.

### Real-time layer

Focus:

```text
current input
current window
current action
current intent
reflex/glance support
```

Examples:

```text
typing prediction
browser tooltip
PDF opened -> summarize card
selected text -> relevant context card
```

### Accumulation layer

Focus:

```text
long-term observations
feedback
diffs
daily/weekly patterns
memory views
routing shortcuts
program evolution
objective/opportunity discovery
```

Examples:

```text
daily summary
research brief
learned collaboration style
project architecture memory
language known-words model
```

The two layers reinforce each other:

```text
Accumulation produces memory Views used by real-time help.
Real-time captures feedback used by accumulation.
```

---

## 9. Five speeds

Info adopts Paperboy-style speed tiers as a delivery/runtime dimension.

Speed is not autonomy. Speed describes latency, cost, output shape, and interruption level.

```text
reflex      immediate local adaptation
glance      1-2 second card/tooltip/chip
think       conversational response, seconds to a minute
work        deep task/artifact/branch/generated UI
background  ongoing low-visibility processing
```

Examples:

| Speed | Example |
|---|---|
| reflex | autocomplete, local highlight, result re-ranking |
| glance | selected text tooltip, PDF summary card, relevant memory chip |
| think | answer a question using context, draft reply, explain a decision |
| work | prepare report, create branch, build prototype, generate canvas |
| background | daily summary, research watcher, objective discovery, routing learning |

Programs may support multiple speeds.

Example research flow:

```text
Glance: current page is related to your Info objective.
Think: explain why and summarize it.
Work: deep research 20 sources and generate a dossier.
Background: monitor new sources daily.
```

---

## 10. Autonomy and trust ramps

Autonomy controls what the system may do automatically.

Recommended profiles:

```text
manual
suggest
draft
sandbox_auto
full_auto_with_allowlist
```

Risk levels:

```text
L0 Observe
L1 Derive
L2 Propose
L3 Draft
L4 Execute in sandbox
L5 External / irreversible
```

Default posture:

```text
Observe and derive locally.
Suggest opportunities by default.
Draft after user confirms a Program/objective.
Execute only in authorized sandboxes.
Require explicit confirmation for external or irreversible actions.
```

Principle:

```text
Reversible, scoped, provenance-backed actions can become automatic.
Irreversible or external actions require explicit trust/policy.
```

---

## 11. Feedback and loss signals

Feedback is the fuel for self-evolution.

Feedback is captured as Observations.

Types:

### Explicit feedback

```text
accept
reject
dismiss
correct
approve
pause
mark known
```

### Behavioral feedback

```text
opened
ignored
copied
edited
shared
reran
continued conversation
closed quickly
```

### Diff-based feedback

```text
agent draft -> user final text
agent patch -> user final patch
agent task plan -> user reordered plan
```

### Absence / counterfactual feedback

```text
user manually searched something the system should have found
user repeated a question the system should have remembered
user handled a routine task the background program should have caught
```

These feedback observations compile into memory Views:

```text
memory.user.preference
memory.channel.codex.collaboration_style
memory.project.info.coding_patterns
memory.routing.failure
memory.language.known_words
memory.intent.design_before_code
```

Paperboy's loss signals map well:

```text
accuracy  -> facts and corrections
latency   -> value delivered relative to cost/time
autonomy  -> user had to do what system should have handled
taste     -> diff between draft and final user output
absence   -> what should have been noticed but was not
```

---

## 12. View circulation

This is one of Info's core design rules.

```text
View is not an endpoint.
View is the next input.
```

A language learning View may be consumed by:

```text
language dashboard
daily summary
research summarizer
Codex context injection
```

A research brief may be consumed by:

```text
project ambient program
task planner
daily summary
browser sidebar
external coding agent
```

A memory View may influence:

```text
router
attention
context injection
autonomy suggestions
application layout
```

Default rule:

```text
Views are shared, addressable, provenance-backed context objects.
They are not private plugin outputs unless policy restricts them.
```

---

## 13. Program sources

Programs can come from three sources.

```text
Built-in Programs
Installed Programs
Generated Programs
```

### Built-in Programs

Official baseline scenarios:

```text
daily_summary
language_learning
research_shadow
project_ambient
```

### Installed Programs

Provided by plugins/community/users.

### Generated Programs

Proposed or generated by AI from the user's context.

Example:

```text
The system observes that the user has been researching Info, Paperboy, iii-sdk, and ambient agents.
It proposes: program.research.personal_ai_runtime.
```

Generated Programs should begin as proposal Views and require user approval/policy before elevated autonomy.

---

## 14. Example flows

### 14.1 Language learning

```text
Browser channel observes copied English text
  -> Observation: browser.text_copied
  -> Router routes to program.language_learning
  -> Program attention decides it is useful exposure
  -> Capabilities extract vocabulary and examples
  -> Views: app.language.learning_pack, app.language.review_queue
  -> Application displays cards
  -> User marks a word known
  -> Feedback Observation
  -> memory.language.known_words updates future packs
```

### 14.2 Project ambient

```text
Channels observe:
  Codex conversation
  Git diff
  GitHub issue
  Browser docs
  Terminal commands

Program project_ambient assembles:
  project.current_context
  work_thread
  issue_context
  brief.project_research

It can then:
  advise next steps
  generate task plans
  inject context into Codex
  delegate sandboxed work to external agents if authorized

User edits/rejects/accepts results.
Feedback updates project memories and autonomy trust.
```

### 14.3 PDF paper discovery

```text
Browser observes PDF URL
  -> default Browser Ambient submits AgentTask, or an installed pdf plugin writes extraction.pdf_text View
  -> research program consumes agent/pdf Views and writes brief.research
  -> project program links brief to current project
  -> language program extracts vocabulary if useful
  -> daily program includes the paper in summary if important
```

No capability needs to directly call every other capability. Outputs flow through Views.

---

## 15. Current code mapping

The existing code already maps well to this model.

```text
ContextRecord  -> Observation
ContextView    -> View
RuntimeEvent   -> Event
Connector      -> Channel sensor
Plugin         -> packaging / current Program-like unit
Broker         -> context injection / pack builder
Runtime        -> router / scheduler / assembler beginnings
WorkThread     -> View, not raw fact
Language plugin -> Program + Capabilities + Views
```

The implementation should evolve toward the mental model without requiring an immediate rewrite.

---

## 16. Open design questions

These remain intentionally open:

1. What is the exact schema for Program definitions and Program learned state?
2. How should View type namespaces be governed?
3. Which Views are living/current-state vs immutable snapshots?
4. How should routing shortcuts be learned, validated, and expired?
5. How should absence feedback be detected without becoming noisy?
6. How should generated Programs be reviewed, sandboxed, and upgraded?
7. What is the first killer Program to implement end-to-end?

Current best candidate for first killer Program:

```text
Project Ambient Program
```

because it exercises cross-channel observations, research, advice, task planning, external agent delegation, and feedback learning.

But language learning is also an excellent product demo because it shows personal context becoming application data.

---

## 17. Compact final model

```text
Observation
  raw fact from the user's workflow

Program
  living context loop for a user-value scenario

Capability
  reusable ability/tool/agent/function

View
  circulating derived context object

Application
  user interface that consumes Views and writes feedback

Event
  provenance/runtime log
```

Core loop:

```text
Program watches Observations,
uses Capabilities,
writes Views,
Applications display Views,
Feedback becomes Observation,
Events record everything,
Views feed future Programs.
```

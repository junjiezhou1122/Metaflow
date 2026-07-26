# Info Ambient Runtime Architecture

> Highest-level design baseline for Info. Local demos such as Browser Ambient, Language Learning, or external agent runtimes must follow this architecture rather than redefine it.
>
> Current doctrine: see `docs/view-first-proactive-agent-os.md`. Ambient runtime
> work should treat Project, Personal Memory, Learning, Writing, and Research as
> registered view families over the open View/Processor protocol, not as core
> domain enums.

## 0. North Star

Info is a **local-first ambient context runtime**.

It turns raw observations into circulating views through self-evolving programs and reusable capabilities, so agents and applications can understand the user’s work over time.

```text
Raw Observation
  -> Context Graph
  -> Program Attention
  -> Capability / Agent
  -> View
  -> Application / Agent Consumption
  -> Feedback Observation
  -> Learning
```

Short version:

```text
Observe facts. Derive Views. Let Views circulate. Learn from feedback.
```

Memory is one View family inside this loop, not a replacement runtime. The
Info-native memory path is:

```text
Observation / View evidence
  -> processor.memory_candidate
  -> memory.candidate
  -> processor.memory_gate
  -> durable memory Views
```

The gate is deliberately conservative. It promotes only candidates with allowed
privacy, provenance, confidence, and evidence count; otherwise it holds or
rejects them. Optional EverOS-style storage belongs behind a `MemoryBackend`
adapter so local Info Views remain the canonical traceable state.

Info is not primarily:

- a chatbot;
- a notes app;
- a rule engine;
- a plugin marketplace;
- a single proactive agent.

Info is the substrate where many personal AI loops can grow.

---

## 1. Design Commitments

These are architectural invariants.

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
Local-first is architecture, not policy copy.
```

Every new feature should answer:

1. Is this an Observation, View, Program, Capability, Application, Event, or Feedback?
2. Does it preserve raw facts separately from inference?
3. Does it write useful derived state back as a View?
4. Can other Programs / agents / Applications reuse that View?
5. Is provenance visible?
6. Is privacy and autonomy policy explicit?
7. Can user feedback improve future routing or behavior?

If not, the implementation is probably drifting from the architecture.

---

## 2. Core Objects

The core model has seven objects.

```text
Observation
View
Program
Capability
Application
Event
Policy
```

`Plugin` is not a core object. Plugin is packaging: it may bundle Programs, Capabilities, Applications, schemas, prompts, assets, and policies.

### 2.1 Observation

An Observation is a raw fact captured from the world.

Examples:

```text
observation.browser.page_visit
observation.browser.ambient_requested
observation.screen.ocr
observation.git.diff
observation.codex.message
observation.claude.message
observation.github.issue
observation.terminal.command
observation.file.changed
feedback.view.opened
feedback.analysis.dismissed
feedback.output.edited
```

Rules:

- Observations should describe what happened, not what it means.
- Observations can include weak metadata such as source, domain, app, time, URL, path, selected text, and privacy policy.
- Observations should not invent project membership, objective, importance, or long-term meaning.
- If something is inferred, it belongs in a View with provenance and confidence.

Example:

```json
{
  "schema": { "name": "observation.browser.ambient_requested", "version": 1 },
  "source": { "type": "browser", "connector": "chrome-extension" },
  "scope": { "app": "chrome", "domain": "github.com" },
  "time": { "observed_at": "2026-05-24T10:26:25Z" },
  "content": {
    "title": "junjiezhou1122/TypeLearn",
    "url": "https://github.com/junjiezhou1122/TypeLearn",
    "text": "captured page text..."
  },
  "acquisition": { "mode": "manual", "actor": "user", "reason": "ambient explore button" },
  "privacy": { "level": "private", "allow_external_llm": false }
}
```

Do not add `project_path` here unless the browser actually observed it. A later View may infer that this URL relates to `/Users/junjie/info`.

### 2.2 View

A View is any derived, organized, interpreted, compressed, analyzed, policy-shaped, or application-ready context object.

Examples:

```text
analysis.browser_page
summary.daily
brief.research
project.current_context
thread.active_work
space.learning.english
app.language.learning_pack
memory.user.communication_style
memory.project.architecture_principles
intent.current
routing.shortcut
policy.autonomy_profile
```

Key rule:

```text
Not every View is Memory.
But every Memory is a View.
```

Views are the system’s circulating intelligence layer. They should be:

```text
addressable
queryable
provenance-backed
confidence-scored
policy-scoped
reusable by agents and apps
```

A View can be consumed by:

- another Program;
- an agent prompt;
- an Application UI;
- a context pack;
- a future View compiler.

Common View categories:

| Category | Purpose | Examples |
|---|---|---|
| Analysis View | Explain one object | `analysis.browser_page`, `analysis.repo` |
| Collection View | Group related objects | `space.project.info`, `space.learning.english` |
| Timeline View | Compress time | `timeline.activity`, `summary.daily` |
| Brief View | Synthesize for a purpose | `brief.research`, `brief.meeting` |
| App Data View | Feed UI/app | `app.language.review_queue` |
| Memory View | Change future behavior | `memory.project.patterns` |
| Intent View | Current or learned goals | `intent.current`, `memory.intent.learning` |
| Routing View | Learned dispatch | `routing.shortcut.browser_repo_to_project_ambient` |
| Policy View | Permissions/trust | `policy.autonomy_profile` |

### 2.3 Program

A Program is a living context loop for a user-value scenario.

It watches Observations and Views, decides attention, calls Capabilities, writes Views, and learns from feedback.

Examples:

```text
program.browser_ambient
program.project_ambient
program.research_shadow
program.language_learning
program.daily_summary
program.coding_companion
program.personal_crm
```

A Program owns the loop, not the tool.

It answers:

```text
What user value does this loop create?
What does it attend to?
What context does it need?
Which Capabilities can it call?
Which Views does it produce?
Which Applications present those Views?
What feedback teaches it?
What autonomy level is allowed?
```

Program lifecycle:

```text
trigger -> attention -> context pack -> capability calls -> view writes -> event log -> feedback -> learned routing/memory
```

### 2.4 Capability

A Capability is a reusable power. It does not own a user scenario.

Examples:

```text
capability.agent_task.submit
capability.web.fetch
capability.timeline.cluster
capability.language.extract_vocabulary
```

Programs compose Capabilities.

Example:

```text
Browser Ambient Program
  -> capability.agent_task.submit
  -> external agent runtime owns repo/PDF/search/code skills

Project Ambient Program
  -> consumes Views from Browser Ambient, local project Observations, issue Observations, and agent sessions
  -> may submit a generic AgentTask when deeper work is needed
```

A Capability should return structured output that can become a View. It should not directly become product behavior unless a Program wraps it with policy and provenance.

### 2.5 Application

An Application is a presentation or interaction surface.

Examples:

```text
browser popup
browser sidebar
project cockpit
language learning web app
daily briefing page
research inbox
```

Applications should primarily read Views and write Observations/Feedback. They should not contain the core intelligence loop.

Good Application behavior:

```text
read relevant Views
show them clearly
let user accept / dismiss / edit / ask follow-up
write feedback Observations
```

### 2.6 Event

An Event records runtime provenance.

Examples:

```text
record_ingested
program.attention_decision
program.run.completed
capability.run.failed
view.updated
feedback.received
policy.denied_action
```

Events answer:

```text
What ran?
Why did it run?
What did it read?
What did it write?
Which policy applied?
Did it succeed?
```

Events make the system inspectable and debuggable.

### 2.7 Policy

Policy controls privacy, trust, and autonomy.

Policy can live on Observations, Views, Programs, Capabilities, Applications, or global/user scopes.

Autonomy levels:

```text
manual        // user explicitly asks
suggest       // system can propose only
draft         // system can prepare artifacts but not commit irreversible action
sandbox_auto  // reversible local actions in sandbox are allowed
full_auto     // trusted automatic action within explicit scope
```

Default principle:

```text
Automatic observation and analysis are allowed locally.
Irreversible external action requires explicit trust.
```

---

## 3. Context Graph

The Context Graph stores Observations, Views, Events, and relations.

It must support multiple query modes:

```text
timeline query
project query
source/app query
URL/domain query
keyword query
entity query
vector similarity query
relation/provenance query
active work thread query
policy-constrained query
```

The graph does not need to be perfect at first. It needs to be inspectable, provenance-backed, and composable.

Important distinction:

```text
Storage is not intelligence.
The graph becomes intelligent through Views and learned routing.
```

---

## 4. Attention and Routing

The system should not hard-code every rule forever.

Initial routing can be rule-assisted, but the long-term design is dynamic attention.

Recommended architecture:

```text
Observation/View arrives
  -> lightweight router finds candidate Programs
  -> each Program performs attention decision
  -> stable repeated patterns become routing shortcuts
  -> feedback adjusts future attention
```

Attention output:

```text
ignore
observe only
defer
attach to existing View/thread
run Program
ask user
```

Learned routing examples:

```text
GitHub repo page + user working in /Users/junjie/info
  -> often relevant to Project Ambient
  -> create routing.shortcut after repeated confirmations

English article + user language learning goal
  -> Language Learning Program

Repeated code docs during implementation
  -> Project Ambient + Research Shadow
```

The central router should not become a giant brittle rules engine. It should be a fast candidate selector plus learned shortcut store.

---

## 5. View Circulation

View circulation is the core self-evolving mechanism.

```text
Observation creates View.
View becomes context for another Program.
Program creates richer View.
User feedback creates Observation.
Feedback updates Memory/Routing Views.
Future Programs use those Views.
```

Example:

```text
browser repo page observation
  -> analysis.browser_agent_task
  -> fallback if AgentTask is unavailable: analysis.browser_page
  -> project.relevance_hypothesis
  -> project.current_context
  -> memory.project.reusable_pattern
```

This is why derived outputs must be written back as Views, not only shown once in UI.

---

## 6. Memory

Memory is not a separate storage universe.

Memory is a class of View whose purpose is to change future behavior.

Examples:

```text
memory.user.prefers_concise_analysis
memory.project.info.architecture_principles
memory.language.known_words
memory.routing.browser_github_to_project_ambient
memory.agent.correction_patterns
```

Memory should include:

```text
source evidence
confidence
stability
validity/staleness
scope
how it affects future behavior
```

The system should distinguish:

```text
session memory
project memory
long-term user memory
learned routing memory
```

---

## 7. Agent Integration

Agents are Capabilities or external workers, not the whole system.

Current preferred integration:

```text
Info Program
  -> capability.agent_task.submit
  -> external agent runtime session, e.g. Claude Code / Multica
  -> structured output
  -> View
```

Why external agent runtime protocols matter:

- structured protocol instead of ad-hoc UI scraping;
- sessions and streaming updates;
- permission model;
- tool-call visibility;
- future compatibility with multiple agents.

But agent output must still enter Info as Views with provenance. The agent should not silently become the source of truth.

Agent modes:

```text
read-only analysis
research synthesis
code inspection
sandbox draft
reversible local edit
external action
```

Each mode maps to Policy.

---

## 8. Example Programs

### 8.1 Browser Ambient

Purpose: analyze current browser context when the user asks or when confidence is high.

```text
Observation:
  observation.browser.ambient_requested

Program:
  program.browser_ambient

Capabilities:
  capability.agent_task.submit       // generic task boundary; experiment default runtime: local Claude Code
                                  // future external runtimes own their own skills/tools

Views:
  analysis.browser_agent_task   // preferred AgentTask output
  analysis.browser_page         // deterministic fallback
  project.relevance_hypothesis       // future

Application:
  browser popup/sidebar
```

Important: Browser Ambient is only one instance of the architecture. It must not define the whole system.

### 8.2 Project Ambient

Purpose: understand what the user is working on and help advance the project.

Sources:

```text
git diff
active cwd
files changed
Codex/Claude conversations
terminal commands
GitHub issues
browser docs/repo pages
screen context
```

Views:

```text
project.current_context
thread.active_work
analysis.code_change
brief.project_next_state
memory.project.patterns
```

### 8.3 Language Learning

Purpose: turn real English exposure into personalized learning material.

Sources:

```text
browser English pages
selected/copied text
user corrections
review behavior
```

Views:

```text
space.learning.english
app.language.learning_pack
memory.language.vocabulary
memory.language.mistakes
```

Application:

```text
language learning web app
browser tooltip
review dashboard
```

### 8.4 Daily Summary

Purpose: compress timeline into useful reflection and continuity.

Sources:

```text
timeline observations
project views
browser activity
agent outputs
feedback
```

Views:

```text
summary.daily
brief.tomorrow
memory.routine_patterns
```

---

## 9. Speeds

Inspired by Paperboy-style speed tiers, but implemented as runtime policy and UX expectations.

```text
reflex      // immediate local UI adaptation / autocomplete-like
glance      // lightweight card or popup, 1-2 seconds
think       // conversational analysis, seconds to a minute
work        // deeper agent work, minutes/background task
background  // continuous low-priority processing
```

Speed affects:

```text
latency budget
context budget
model/tool choice
UI surface
interrupt level
autonomy allowed
```

Examples:

```text
Browser button analysis -> glance/think
Project deep repo inspection -> work
Daily summary -> background
Typing prediction -> reflex
```

---

## 10. Feedback and Self-Evolution

Feedback is captured as Observation and compiled into Views/Memory.

Feedback sources:

```text
user accepts output
user dismisses output
user edits generated text
user opens a View repeatedly
user ignores a notification
user asks for the same kind of help again
user corrects an analysis
```

Learning targets:

```text
attention routing
view ranking
summary style
notification threshold
autonomy level
memory confidence
```

The system should learn gradually:

```text
one event -> evidence
repeated pattern -> hypothesis View
confirmed pattern -> Memory/Routing View
```

---

## 11. Development Rules

When implementing a local feature:

1. Start with clean Observations.
2. Write derived results as Views.
3. Log Program and Capability Events.
4. Keep Applications thin.
5. Use Policy for autonomy.
6. Keep local-first defaults.
7. Prefer reversible actions.
8. Make outputs reusable by future Programs.

Avoid:

```text
putting inferred meaning into raw observations
creating one-off UI-only outputs
hard-coding every scenario as rules
letting one demo define core abstractions
calling everything memory
making agents act without provenance
```

---

## 12. Current Implementation Mapping

Current code names do not have to be perfect, but should converge to this map.

```text
ContextRecord       -> Observation
ContextView         -> View
RuntimeEvent        -> Event
ProgramRuntime      -> Program execution engine
Program             -> user-value loop
Capability          -> reusable tool/agent power
browser-extension   -> sensor + small Application
External agent runtime -> capability.agent_task.submit
```

Existing Browser Ambient demo validates:

```text
browser observation
  -> program.browser_ambient
  -> capability.agent_task.submit
  -> local Claude Code during experiments / external agent runtime later
  -> advice/analysis View
```

But the architectural target is broader:

```text
many sensors
many Programs
many Capabilities
many Applications
one circulating local context graph
```

---

## 13. Open Design Questions

These should be resolved at the architecture level before overfitting implementation.

1. What is the minimal View schema that supports all major categories?
2. How should the router learn shortcuts from repeated Program decisions?
3. How should View relevance be queried: timeline, keyword, vector, relation, project, or hybrid?
4. How should Applications subscribe to View updates?
5. How should user feedback flow into Memory Views?
6. What is the default autonomy profile for each Program and Capability?
7. How much project context should be injected into each Program by default?
8. How do we prevent duplicate runs and noisy Views?
9. How do we handle stale Memory and stale project Views?
10. How do we make generated Applications consume Views without embedding intelligence inside the UI?

---

## 14. Principle to Remember

Local demos prove loops. They do not define the architecture.

```text
Browser Ambient proves Observation -> Program -> Agent -> View.
Language Learning proves Observation -> Program -> App Data View.
Project Ambient should prove multi-source View synthesis.
Daily Summary should prove timeline compression.
```

All of them must remain instances of the same simple runtime.

## 15. Hybrid Work Router Update

The proactive runtime now separates realtime state from scheduled
consolidation:

```text
observation.browser_page_snapshot
observation.ai_session_locator_result
observation.local_project
observation.screenpipe_*
        |
        +--> processor.surface_state
        |       -> state.surface
        |
        +--> processor.route_candidate
        |       -> observation.route_candidate
        |
        +--> processor.work_router_batch
                -> work.focus_set
                -> processor.project_current
                    -> project.current
```

Realtime processors are deterministic and do not require external LLM
credentials. Batch routing is LLM-ready, but the default implementation remains
deterministic and testable.

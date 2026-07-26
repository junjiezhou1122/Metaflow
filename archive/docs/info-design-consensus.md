# Info Design Consensus

> Shared design agreement for the long-term Info system.
>
> This document captures the product and architecture principles behind the
> current implementation. It should guide code decisions before we optimize any
> single demo such as Browser Ambient, Language Learning, or Project Ambient.
>
> Current doctrine: see `docs/view-first-proactive-agent-os.md`. When this
> document's older Program-centric language conflicts with that doctrine, the
> View-first / Processor-first protocol wins: core owns protocols, not
> categories.

## 1. One sentence

Info is a **local-first ambient context runtime** that observes the user's work,
turns raw evidence into reusable Views, lets Programs and agents act on those
Views, and learns from feedback over time.

Short version:

```text
Observe facts.
Derive Views.
Let Views circulate.
Learn from feedback.
Increase autonomy only through trust.
```

## 2. What Info is not

Info should not collapse into any one of these:

- one proactive agent;
- one browser extension;
- one plugin framework;
- one notes app;
- one chat UI;
- one rule engine;
- one Paperboy-style assistant clone.

Those can all exist on top of Info. They are not the substrate.

The substrate is:

```text
Observation -> Context Graph -> Program -> Capability / Agent -> View -> Application -> Feedback
```

## 3. Core objects

The stable vocabulary is:

```text
Observation
View
Program
Capability
Application
Event
Policy
Plugin
```

### Observation

An Observation is raw evidence.

Examples:

```text
browser page visited
browser ambient button clicked
screen OCR captured
git diff changed
terminal command ran
Codex message created
Claude Code message created
GitHub issue viewed
PDF URL opened
user dismissed a View
user edited generated text
```

Rule:

```text
Observation records what happened, not what it means.
```

For example, a browser sensor can say:

```text
The user clicked "analyze" on this GitHub repo page.
```

It should not say:

```text
This repo is part of the current project.
```

That second sentence is inference. It belongs in a View.

### View

A View is any derived, organized, compressed, interpreted, or app-ready object.

Examples:

```text
analysis.browser_page
analysis.repo
extraction.pdf_text
brief.research
project.current_context
thread.active_work
summary.daily
app.language.learning_pack
memory.language.vocabulary
memory.project.patterns
routing.shortcut
policy.autonomy_profile
```

Important rule:

```text
Not every View is memory.
Every memory is a View.
```

This solves the earlier naming problem:

- a vocabulary profile is memory;
- a generated English exercise pack is an app data View;
- a group of related browser/code/issue records is a collection/thread View;
- a repo analysis is an analysis View;
- a project state summary is a project View.

All of them circulate through the same graph.

### Program

A Program is a user-value loop.

It decides what to attend to, asks for context, calls capabilities or agents,
writes Views, and learns from feedback.

Examples:

```text
program.browser_ambient
program.project_ambient
program.research_shadow
program.language_learning
program.daily_summary
program.coding_companion
program.routing_learning
program.feedback_learning
```

Program is the right abstraction for:

- "when I browse a GitHub repo, analyze it";
- "when I work in ~/info, connect code, issues, agent chats, docs";
- "when I read English, create personalized learning material";
- "summarize my day";
- "notice research threads and prepare briefs".

### Capability

A Capability is a reusable power.

Examples:

```text
capability.agent_task.submit
capability.web.fetch
capability.timeline.cluster
capability.language.extract_vocabulary
```

Capabilities should be scenario-neutral.

Bad:

```text
capability.browser_ambient_do_everything
```

Better:

```text
program.browser_ambient
  -> capability.agent_task.submit
  -> external agent runtime owns repo/PDF/search/code skills
  -> writes analysis.browser_agent_task; fallback writes analysis.browser_page
```

### Application

An Application is a surface where the user sees or edits Views.

Examples:

```text
browser popup
browser sidebar
project cockpit
language learning web app
research inbox
daily briefing page
generated one-off UI
```

Applications should stay thin:

```text
read Views
render Views
let user accept / dismiss / edit
write Feedback Observations
```

Applications should not become the hidden brain.

### Event

An Event is runtime provenance.

Examples:

```text
program.run.started
program.run.completed
capability.run.started
capability.run.failed
view.created
policy.denied
feedback.received
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

### Policy

Policy controls privacy, trust, and autonomy.

Autonomy levels:

```text
manual        // user explicitly clicks or asks
suggest       // system may suggest only
draft         // system may prepare artifacts
sandbox_auto  // reversible local/sandbox action is allowed
full_auto     // trusted action inside explicit scope
```

Default:

```text
Local observation and local analysis can be automatic.
External calls and irreversible actions require explicit policy.
```

### Plugin

Plugin is packaging, not a core intelligence object.

A plugin may bundle:

```text
Programs
Capabilities
Applications
schemas
prompts
assets
policies
```

Example:

```text
language-learning plugin
  -> program.language_learning
  -> capability.language.extract_vocabulary
  -> app.language.learning_pack View schema
  -> language learning web Application
```

## 4. Views, spaces, surfaces, and work threads

Earlier terms were useful but confusing. The resolved model:

```text
View = derived context object
Application = UI surface
Program = value loop
Sensor = observation source
Space / Thread = a kind of View that groups context
Surface = optional product framing, not core runtime vocabulary
```

### Space

A Space is a collection View around a broad context.

Examples:

```text
space.project.info
space.learning.english
space.research.personal_ai
```

It is not an application. An application may render it.

### Work thread

A WorkThread is a time-bound or objective-bound View.

Example:

```text
thread.active_work
  contains:
    - Codex conversation
    - current git diff
    - terminal command history
    - browser docs
    - GitHub issue
    - related project Views
```

It answers:

```text
What is the user currently doing?
What context belongs together right now?
```

### Surface

Paperboy-style "surface" roughly maps to a combination of:

```text
sensor source + application surface + domain-specific Programs + memory Views
```

For example, "coding surface" is not one object. It may include:

```text
git sensor
terminal sensor
Codex importer
GitHub issue importer
project cockpit Application
program.project_ambient
program.coding_companion
memory.project.patterns
thread.active_work
```

So the codebase should prefer the clearer terms above.

## 5. The central loop

The system loop is:

```text
1. Sensors write Observations.
2. Router finds candidate Programs.
3. Programs perform attention decisions.
4. Programs request context packs from the graph.
5. Programs call Capabilities or agents when useful.
6. Programs write derived Views.
7. Applications and other Programs consume those Views.
8. User behavior writes Feedback Observations.
9. Feedback Programs compile learning Views and routing shortcuts.
10. Future routing and context packing improve.
```

The key self-evolving mechanism is View circulation:

```text
Observation
  -> analysis View
  -> project/research/language View
  -> app View
  -> feedback Observation
  -> memory/routing View
  -> better future attention
```

## 6. Dynamic attention

The long-term system should not require manually writing rules for every case.

The router should work like this:

```text
new Observation/View
  -> cheap candidate selection
  -> relevant Programs decide attention
  -> repeated successful routes become routing.shortcut Views
  -> rejected/dismissed routes lose confidence
```

Attention outputs:

```text
ignore
observe only
defer
attach to existing thread
run Program
ask user
```

This gives us both:

- deterministic first examples;
- long-term dynamic behavior learned from the user's context and feedback.

## 7. Speeds

The Paperboy speed idea is useful, but in Info it should be implemented as
runtime policy and UX expectation, not as separate architectures.

```text
reflex      immediate local prediction or UI adaptation
glance      lightweight card or hint
think       short analysis or conversation
work        deeper agent task
background  continuous low-priority processing
```

Speed controls:

```text
latency budget
context budget
model/tool choice
interrupt level
autonomy level
UI form
```

Examples:

```text
typing prediction                         -> reflex
browser "analyze this page" button         -> glance / think
repo + issue + codebase synthesis          -> work
daily timeline compression                 -> background
English word tooltip while reading         -> glance
personalized English review pack           -> background / app View
```

## 8. Canonical scenarios

### Browser Ambient

Purpose:

```text
Understand the current browser object when user intent is explicit or confidence is high.
```

Flow:

```text
observation.browser_ambient_requested
  -> program.browser_ambient
  -> capability.agent_task.submit
  -> local Claude Code during experiments
  -> analysis.browser_agent_task
  -> fallback: analysis.browser_page
  -> consumed by research_shadow / project_ambient / applications
```

Rule:

```text
Browser Ambient should analyze and write Views.
It should not directly create unrelated tasks or irreversible actions.
```

### Project Ambient

Purpose:

```text
Understand and help advance the user's active project.
```

Inputs:

```text
git diff
current cwd
changed files
terminal commands
Codex/Claude conversations
GitHub issues
browser docs/repo pages
research briefs
```

Outputs:

```text
project.current_context
thread.active_work
brief.project_next_state
memory.project.patterns
```

This is the example that proves cross-source synthesis.

### Language Learning

Purpose:

```text
Turn real English exposure into personalized learning material.
```

Inputs:

```text
English articles
selected text
browser reading history
unknown words
user corrections
review behavior
```

Outputs:

```text
space.learning.english
app.language.learning_pack
memory.language.vocabulary
memory.language.mistakes
memory.language.preferred_exercise_style
```

Important:

```text
The web app is an Application.
The generated exercises are Views.
The known vocabulary is Memory View.
The loop that creates them is Program.
```

### Research Shadow

Purpose:

```text
Follow what the user is researching and prepare reusable briefs.
```

Inputs:

```text
browser analysis
generic AgentTask analysis
optional extraction/repo Views produced by external agents or dedicated Programs
search results
user questions
```

Outputs:

```text
brief.research
space.research.topic
memory.research.preference
```

### Daily Summary

Purpose:

```text
Compress the timeline into continuity.
```

Inputs:

```text
timeline observations
project Views
browser Views
agent outputs
feedback
```

Outputs:

```text
summary.daily
brief.tomorrow
memory.routine_patterns
```

## 9. Agent integration

Agents are Capabilities or external workers, not the architecture itself.

Preferred shape:

```text
Program
  -> context pack
  -> capability.agent_task.submit
  -> external agent runtime such as Claude Code / Multica owns skills/tools
  -> structured result
  -> View with provenance
```

Agent output should not silently become truth.

It must be stored as:

```text
View
  source_records
  source_views
  confidence
  policy
  events
```

This keeps the system inspectable and reusable.

## 10. Privacy and local-first defaults

Privacy is architecture, not copywriting.

Defaults:

```text
raw observations stay local
large artifacts stay referenced, not blindly copied
external LLM access is denied unless explicitly allowed
external reader access is denied unless explicitly allowed
derived Views inherit restrictive provenance
applications only receive policy-allowed context packs
```

If a View was derived from private or external-denied sources, that restriction
must continue to affect downstream context packs.

## 11. Implementation discipline

Every feature should pass this checklist:

```text
1. What object is this: Observation, View, Program, Capability, Application, Event, Policy, Plugin?
2. Are raw facts separate from inference?
3. Does derived intelligence become a reusable View?
4. Can another Program or Application consume the View?
5. Is provenance stored?
6. Is policy explicit?
7. Can feedback improve the next run?
8. Is the UI thin?
9. Is the action reversible or permission-gated?
10. Is this generalizing the runtime, or overfitting one demo?
```

Code direction:

```text
small tests first
minimal implementation
no speculative abstraction
no hidden intelligence in UI
no one-off output that bypasses the graph
no destructive automation without policy
```

## 12. Current coding priority

Build the runtime spine before polishing any one application.

Priority order:

```text
1. Observation and View schemas stay clean.
2. ProgramRuntime routes and records provenance.
3. Capabilities are reusable and policy-gated.
4. Views circulate across Programs.
5. ContextBroker returns policy-aware packs.
6. Feedback creates learning/routing Views.
7. Applications subscribe to and render Views.
8. More sensors and generated apps can be added safely.
```

The browser demo is useful only if it proves the spine:

```text
browser Observation
  -> browser_ambient Program
  -> capability / agent
  -> analysis View
  -> project/research/language Program
  -> richer View
  -> Application
  -> Feedback
  -> learned routing / memory
```

## 13. Final principle

The product moat is not one prompt, one model, or one UI.

The moat is the user's accumulated local context:

```text
observations
views
feedback
memories
routing shortcuts
project patterns
language patterns
work threads
trust history
```

Info should make that context usable by many agents and applications without
losing provenance, privacy, or user control.

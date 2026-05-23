# Personal Context Ecology

## Purpose

This document positions `~/info` relative to the broader `ecology` research project and the Paperboy / Screenpipe personal AI direction.

The key distinction:

```text
ecology
  = research lab for scalable intelligence patterns and artifact ecology

~/info
  = concrete implementation of a programmable personal context runtime

Paperboy-like assistant
  = one possible application experience on top of that runtime
```

In short:

> Paperboy is an application scenario. `~/info` should become the personal context substrate that can support many Paperboy-like and non-Paperboy applications.

## Core thesis

The future personal AI layer should not be a single assistant that owns everything.

It should be:

```text
local-first personal context substrate
  + normalized context records
  + lightweight correlation
  + work threads
  + app-specific memory compilers
  + scoped context packs
  + permissioned plugins
```

The last interface is not one assistant.

```text
The last interface is a programmable personal context substrate.
```


## Reality-first design: what actually happens

Design should start from the real user flow, not from a perfect ontology.

In practice, the user will often be doing several overlapping things:

- reading a blog post or tweet thread
- asking Codex / Claude to design or implement something
- editing files and changing git state
- searching the web for missing information
- saving useful posts manually or through an agent
- switching between projects, notes, chat, terminal, and browser
- later asking an agent to continue, summarize, advise, or learn from that context

The runtime should therefore treat context as an evolving evidence stream. A record does not need to be perfectly understood at ingest time. It only needs enough metadata to be replayed, linked, filtered, and reinterpreted later.

Important implication:

```text
Do not force early truth.
Keep raw evidence.
Attach weak relations.
Let plugins compile their own memory views.
```

Example:

```text
Browser page about Paperboy
+ Codex discussion about Screenpipe
+ git diff in ~/info
+ saved tweet about personal AI memory
+ Obsidian note about adaptive language learning

=> likely WorkThread: personal-context-runtime
=> possible MemoryViews:
   - product design insight
   - language-learning source
   - research queue
   - daily summary
```

## Relationship to ecology

`/Users/junjie/agent/ecology` studies general structures:

- first principles
- thinking operators
- frames and taste
- tacit knowledge and aha moments
- general structures of coordination
- pattern cards
- price-like signals
- artifact learning loops
- trace-based selection
- memory decay
- source-of-truth hierarchy

`~/info` applies those structures to personal context.

Mapping:

| Ecology concept | `~/info` concept |
|---|---|
| Artifact | ContextRecord / MemoryView / Episode |
| Trace | Browser/screenpipe/git/codex/terminal event |
| Goal | WorkThread / plugin goal / user query |
| Signal | salience, freshness, trust, urgency, cost |
| Routing | context pack building / plugin selection |
| Shared substrate | local context store |
| Memory compression | app-specific MemoryView |
| Pattern | plugin, compiler, routing policy, rubric |
| Governance | permissions, provenance, privacy policy |

## Relationship to Paperboy

Paperboy proposes:

```text
always-on personal AI presence
surface agents
five speeds
personal knowledge graph
user corrections as learning signals
```

Useful ideas:

- AI should be present in the user's actual work context.
- Agents should be organized around surfaces such as Slack, Code, Email, Browser, Meeting.
- Interaction has multiple speeds: Reflex, Glance, Think, Work, Background.
- Absence is a real error: the system can fail by not noticing what should have been noticed.
- Taste and correction are learning signals.

Limitations:

- It is too centered on one personal AI product.
- Surface agents may create memory silos.
- Knowledge graph as weights is too coarse.
- Trust ramp is not fully engineered.
- Provenance, permissions, and plugin ecosystems need to be first-class.

`~/info` should absorb the good ideas but implement a lower-level runtime:

```text
not one assistant
but a context operating system for many assistants/plugins
```

## Relationship to Screenpipe

Screenpipe is a strong perception layer:

- screen capture
- OCR fallback
- accessibility tree
- audio transcription
- input events
- app/window/browser URL
- local searchable timeline

But Screenpipe should not be the whole system.

In `~/info`:

```text
Screenpipe = ambient sensor
Browser extension = web semantic sensor
Git connector = project state sensor
Codex importer = reasoning/session sensor
Terminal connector = execution feedback sensor
```

All sources normalize into `ContextRecord`.

## Core architecture

```text
Capture / Observation
  -> ContextRecord Store
  -> Lightweight Correlation
  -> WorkThread / Episode
  -> App-specific MemoryView
  -> Scoped ContextPack
  -> Plugin Runtime
  -> Reflex / Glance / Think / Work / Background interfaces
```

### 1. Capture / Observation

Collect raw context from many sensors:

- browser page visits, snapshots, selected text, manual saves
- screenpipe frames / OCR / accessibility / audio / UI events
- browser URL, window title, app name, active time, scroll depth
- git status/diff/log and touched files
- terminal commands and outputs
- Codex / Claude Code conversations and tool traces
- Obsidian / Notion / local notes
- files and local project state
- saved tweets/posts/articles/papers
- agent-discovered resources, such as a tweet-save connector
- manual notes and explicit saves

Principle:

```text
capture first, interpret later
```

Raw observations should be close to fact and should not be overwritten by derived interpretations.

### 2. ContextRecord Store

Everything enters a stable envelope:

```text
ContextRecord {
  schema          // what kind of observation or memory this is
  source          // which connector produced it
  scope           // user / project / repo / app / session / domain
  time            // observed_at / captured_at
  content         // human-readable title/text/url/path
  acquisition     // passive / manual / sync / agent / derived
  signal          // importance / confidence / status
  privacy         // local/external sharing and retention policy
  relations       // links to source records, threads, episodes
  validity        // stale_after / valid_until
  memory          // observation/fact/todo/decision/memory_view metadata
  payload         // source-specific structured details
}
```

The stable part is the envelope. Source-specific variation belongs in:

```text
schema.name + schema.version + payload
```

### 3. Lightweight Correlation

Do not try to understand everything in real time.

Real-time should do cheap, reliable linking:

- timestamp normalization
- app/window detection
- repo/cwd/project detection
- URL/domain extraction
- session/thread candidate assignment
- same-tab / same-repo / near-time links
- privacy classification

Avoid real-time heavy LLM interpretation for every UI change.

Principle:

```text
real-time builds indexes
agents do deep interpretation on demand
```

### 4. WorkThread

A user often works on multiple things at once. Time continuity is not enough.

Use two distinct concepts:

```text
TimelineSession = time container
WorkThread = semantic activity line
```

A record may belong to multiple WorkThreads with confidence.

```ts
type ThreadMembership = {
  thread_id: string;
  confidence: number;
  reasons: string[];
};
```

Strong signals for thread assignment:

- same repo / cwd
- same Codex session
- same browser tab lineage
- same file paths
- explicit user goal
- manual save
- URL/domain cluster
- keyword overlap
- operation chain: read -> discuss -> edit -> run -> fail/fix

Weak signals:

- time proximity alone
- same app alone
- broad topic words alone

Unknown records should be allowed to remain in an inbox rather than forced into a thread.

### 5. Episode

An Episode is a lightweight summary of a time/activity span.

It should record:

- time range
- candidate title
- project/repo
- active apps
- source records
- visited URLs
- touched files
- terminal commands
- codex sessions
- rough summary
- candidate decisions/TODOs/blockers

Episode summaries are useful indexes, not canonical truth.

### 6. MemoryView

Memory is not a single database.

```text
Memory = app-specific compression of raw context
```

The same raw context can compile into different memories depending on application goal.

Examples:

#### Language learning memory

- vocabulary exposure graph
- topic profile
- weak words
- example sentence bank
- review schedule
- mastery score

#### Coding memory

- project state
- decision log
- TODOs
- blockers
- failed attempts
- architecture map

#### Productivity memory

- open loops
- attention patterns
- context-switching graph
- meeting load
- stale commitments

MemoryView should include:

- app_id
- memory_type
- source_records
- confidence
- validity
- privacy
- version

### 7. PluginManifest

A plugin is not just a prompt. A plugin is:

```text
attention policy + memory compiler + action surface + permission manifest
```

Example shape:

```ts
type PluginManifest = {
  id: string;
  name: string;
  needs: string[];
  attention_policy: {
    include?: string[];
    exclude?: string[];
    time_window?: string;
    ranking?: string[];
  };
  memories: string[];
  actions: string[];
  permissions: {
    context_scopes: string[];
    allow_network?: boolean;
    allow_external_llm?: boolean;
    allow_write_memory?: boolean;
    max_privacy_level?: "public" | "workspace" | "private" | "secret";
  };
};
```

### 8. ContextPack

A ContextPack is the scoped context delivered to a plugin or agent.

It is built from:

- goal
- plugin attention policy
- work thread
- time window
- token budget
- privacy constraints
- provenance requirements

A plugin should never receive unlimited raw context.

Principle:

```text
shared substrate exists globally
plugins attend locally
```

### 9. Permission tiers

Personal context needs action levels.

Suggested tiers:

```text
L0 observe
  record only

L1 derive
  local summary/classification/memory candidate

L2 suggest
  user-visible suggestion

L3 draft
  produce draft but do not send/execute

L4 execute local
  reversible local action

L5 external act
  send email, post message, mutate remote system; requires strong confirmation or long-term grant
```

Every plugin action should declare a tier.


## Schema and connector growth model

The schema should grow from use. The connector set should also be dynamic.

The runtime should not assume a fixed list like `browser`, `screenpipe`, `git`, `notes`. Instead, it should provide a connector registry. A connector declares:

- who it is
- what schemas it can produce
- what default privacy policy it applies
- whether it can use network or external readers/LLMs
- whether its records are passive, manual, synced, agent-created, or derived

Example connector manifest:

```ts
type ContextConnector = {
  id: string;
  name: string;
  type: "ambient" | "semantic" | "reasoning" | "execution" | "explicit" | "agent" | "other";
  schemas_produced?: Array<{ name: string; version: number }>;
  default_scope?: ContextRecord["scope"];
  default_privacy?: ContextRecord["privacy"];
  permissions?: {
    allow_network?: boolean;
    allow_external_reader?: boolean;
    allow_external_llm?: boolean;
    max_privacy_level?: "public" | "workspace" | "private" | "secret";
  };
};
```

This supports normal connectors and agent-driven connectors.

Example: `tweet-save-agent`

```text
User is designing a personal context runtime.
Agent searches or monitors public posts.
Agent saves a useful tweet/thread as observation.social_post_saved.
The record says acquisition.mode = agent and explains why it was saved.
Later plugins can reinterpret it as product insight, language material, or research reference.
```

The important distinction is provenance:

```text
manual save  = user explicitly endorsed it
agent save   = agent found it relevant, needs confidence/reason
passive save = observed in activity stream, not necessarily important
derived save = compiled from other records, must link to sources
```

## Interface speeds

Paperboy's five speeds become runtime modes:

### Reflex

- local rules
- cache lookup
- hot context pack preloading
- no expensive LLM
- sub-100ms to very low latency

### Glance

- lightweight card or tooltip
- 1–2 seconds
- small context pack
- low-risk suggestion

### Think

- interactive agent conversation
- seconds to minutes
- provenance-backed answer

### Work

- async job queue
- minutes to hours
- output may be document, UI, PR, report, memory update

### Background

- scheduled monitors
- open-loop detection
- stale memory detection
- anomaly detection
- absence signal detection

## Absence signal

The system can fail by not noticing what should have been noticed.

Examples:

- missed deadline
- missed follow-up
- missed stale TODO
- missed contradiction
- missed relevant artifact
- missed learning opportunity

Absence should become a feedback category, not only visible mistakes.

## Plugin ecosystem

The strongest product direction is:

```text
personal context substrate + community plugins
```

Plugins can include:

- adaptive language learning
- coding memory
- meeting intelligence
- research scout
- personal CRM
- writing coach
- finance review
- health habit reflection
- creative journaling
- productivity coach

Developers should not need to rebuild capture. They should define:

```text
what context they need
how they attend to it
how they compile memory
what actions they provide
what permissions they require
```

## First plugin candidate: adaptive language learning

This is a strong wedge because it demonstrates app-specific memory clearly.

Raw context:

- browser pages
- screenpipe text
- AI chats
- research notes
- selected text

MemoryViews:

- language.topic_profile
- language.vocabulary_candidates
- language.known_words
- language.weak_words
- language.example_bank
- language.review_schedule

Daily flow:

```text
recent context
  -> extract candidate words/phrases
  -> filter by level and relevance
  -> generate personalized story
  -> quiz / cloze / recall
  -> update mastery memory
```

Example words from the current discussion:

- substrate
- provenance
- retention
- ambient
- adaptive
- compiler
- fallback
- attention policy
- compression
- salience

This turns real personal context into adaptive learning material.

```text
your life -> your vocabulary -> your story -> your review schedule
```

## Privacy and governance

This runtime will know too much. Privacy is architecture, not policy text.

Required structures:

- local-first raw data
- permission manifest
- plugin sandbox
- external LLM gate
- network access declaration
- secret scanner
- access audit log
- delete last N minutes
- pause capture
- exclude app/domain/folder
- derived memory provenance
- memory deletion / regeneration

Raw context and derived memory must be separated:

```text
raw_context = immutable append-only fact layer
memory_view = derived, versioned, replaceable compression
```

If a plugin compiles memory badly, delete/regenerate that memory without corrupting raw context.

## What should be built next

### Near-term schema additions

Extend `ContextRecord` with:

```ts
relations?: {
  derived_from?: string[];
  supersedes?: string[];
  related_to?: string[];
  thread_memberships?: Array<{
    thread_id: string;
    confidence: number;
    reasons?: string[];
  }>;
};

validity?: {
  valid_from?: string;
  valid_until?: string;
  stale_after?: string;
};

memory?: {
  kind?: "observation" | "episode" | "fact" | "preference" | "todo" | "decision" | "procedure" | "memory_view";
  stability?: "ephemeral" | "session" | "project" | "long_term";
};
```

Privacy should include external sharing flags:

```ts
allow_external_llm?: boolean;
allow_external_reader?: boolean;
```

### MVP path

1. Add schema support for relations, validity, memory, and external permission flags.
2. Add connector registry APIs so new context sources can register themselves at runtime.
3. Add an agent-driven `tweet-save-agent` example to prove connectors are not only passive sensors.
4. Add WorkThread and Episode concepts.
5. Add PluginManifest and AttentionPolicy schema.
6. Build ContextPack v2 around project/thread/plugin.
7. Add Screenpipe connector.
8. Build adaptive-language-learning plugin.

### First runnable loop

The first product loop should be deliberately small:

```text
register connectors
  - browser-extension
  - codex-chat-importer
  - git/project connector
  - tweet-save-agent

ingest evidence
  - one browser page
  - one Codex discussion
  - one git/project snapshot
  - one saved tweet/post

attach weak relations
  - same project path
  - same keywords
  - same time window
  - explicit save / agent reason

compile one memory view
  - adaptive-language-learning

produce one output
  - 5 vocabulary candidates
  - 1 personalized micro-story
  - provenance links back to source records
```

This proves the full thesis without needing the whole future system.

## Final framing

`ecology` says:

```text
Agents are transient. Artifacts persist.
```

`~/info` evolves this into:

```text
Agents are transient.
Raw context persists.
Memory is compiled.
Plugins attend differently.
Actions require provenance and permission.
```

This is the personal context ecology.

## Runtime implementation note: Screenpipe as live workspace signal

For `~/info`, Screenpipe integration is deliberately split into two layers:

```text
raw perception evidence
  /activity-summary, /search

workspace resolving signals
  /elements, /frames/{id}/context
```

The second layer exists because the product needs to answer:

> Which project/folder is the user working in right now?

Useful signals include:

- terminal/window title such as `Warp - info`
- editor title such as `project — Cursor`
- browser_url if it contains a local file or project route
- accessibility text containing cwd or file paths
- OCR fallback paths from terminal/editor
- top frame context around recent UI elements

These signals should not automatically become user-facing memory. They are routing evidence. The WorkThread remains an evidence index with provenance, while app-specific memories are compiled later by plugins.


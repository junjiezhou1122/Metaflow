---
name: vision/founder-dream
title: Founder Dream
desc: The evolving vision for a personal ambient intelligence that can understand lived digital context and turn it into useful action.
category: vision
tags: [life-os, ambient, personal-agent, viewgraph, automation]
sources: [founder-conversation-2026-07-24]
created: 2026-07-24T03:49:25Z
updated: 2026-07-24T17:01:16Z
---
# Founder Dream

> Status: evolving product dream, not a locked architecture or implementation
> specification.

## One sentence

Metaflow should understand what the user sees, says, and does, turn that
evidence into reusable personal context, and proactively help complete
meaningful work.

## The desired experience

Metaflow is always available but does not require the user to manually organize
every piece of context.

It should:

- record useful evidence from screens, speech, browsers, editors, files, agent
  conversations, photos, and future devices such as AI glasses;
- decode raw media into searchable representations using OCR, speech
  transcription, Accessibility information, browser structure, captions, and
  multimodal models;
- reuse source-native and open-source capabilities when they satisfy the
  required contract, while allowing their implementations and models to change;
- treat image, video/timeline, audio, and text as primary representation
  families that may all contribute to later Views;
- preserve where every interpretation came from;
- organize relevant subsets of evidence into stable task-specific
  representations instead of sending all evidence to every task or producing
  one universal summary;
- build editable personal and project memory over time;
- notice recurring work and propose or create useful Workflows and Automations;
- proactively research, summarize, prepare, remind, and schedule when the
  evidence suggests that help would be valuable;
- let the user explicitly request immediate help from a global Launch surface;
- delegate work to the appropriate local or remote Agent Runtime;
- show background progress, permission requests, results, and failures through
  the Notch and deeper application surfaces;
- learn from accepts, edits, dismissals, failures, and completed work;
- eventually create personalized applications over the user's own ViewGraph.

## The interaction model

### Launch

Launch is the immediate command surface.

The user can invoke it with a shortcut while looking at any screen and say:

- explain this;
- summarize this;
- save this;
- help me complete this task;
- create a Workflow for this;
- do this now.

Launch should automatically use the highest-quality context available from the
current application. A browser page may provide DOM and extension data. A local
application may provide Accessibility state and a screenshot. A coding task may
also use repository, editor, terminal, and Agent Session context.

### Notch

The Notch is the glanceable attention surface.

It should show:

- the most relevant current suggestion;
- a permission request;
- background task progress;
- completion or failure;
- a reminder that is useful now.

It is not the intelligence engine or a general dashboard.

### Ambient

Ambient is the proactive behavior of the system.

It may:

- recognize a repeated workflow;
- prepare relevant research in the background;
- summarize a day or a collection of saved items;
- suggest what to learn next;
- remind the user about commitments and plans;
- notice a project focus and prepare missing context;
- propose a new View, Workflow, Automation, or personal application.

Ambient actions must remain attributable, observable, interruptible, and
learnable from feedback.

## Example journeys

### A task arrives through WeChat

1. A mentor sends a PPT or document through WeChat.
2. The user invokes Launch and asks Metaflow to handle the task.
3. Metaflow identifies the current conversation and locates the relevant local
   file.
4. It delegates conversion, analysis, or document work to an appropriate Agent
   Runtime.
5. The work runs in the background.
6. Progress and permission requests appear in the Notch.
7. The result is saved to an inspectable location and linked to its sources.
8. Completion is visible in the Notch and task inbox.

### A GitHub repository looks useful

1. The user is viewing a GitHub repository.
2. The user asks Launch to clone and analyze it.
3. Browser context identifies the exact repository.
4. A coding or research Agent Runtime clones it into the authorized local
   location.
5. The agent evaluates how it could help another active project.
6. The analysis becomes a reusable View with repository and project
   provenance.
7. The completed result appears in an inbox and is announced through the
   Notch.

### YouTube becomes personalized learning material

1. The user watches an English-language YouTube video.
2. Watch behavior, source-provided captions, and page context become
   Observations; Metaflow-created transcripts or interpretations become
   provenance-linked Views.
3. A language-learning ViewSpec selects relevant English pages, videos,
   excerpts, vocabulary, difficulty signals, and learning status while
   excluding unrelated code and terminal evidence.
4. Processors materialize and update language-learning Views without copying
   or replacing their source evidence.
5. Personal learning applications, agents, and Workflows reuse those Views to
   create review material from content the user genuinely cared about.
6. Daily activity and feedback determine future recommendations.

### Repeated work becomes Automation

1. Metaflow observes repeated PPT, document, research, or coding workflows.
2. Ambient identifies a stable pattern and expected future value.
3. It proposes a Workflow or Automation.
4. The user can request changes, approve it, or reject it.
5. An approved workflow becomes versioned, testable, observable, and
   reversible.

## Emerging architectural principles

These principles are provisional until the Wayfinder architecture discussion
resolves them:

- raw evidence and derived interpretation are different things;
- Observations are the smallest source-grounded units; every Metaflow-created
  extraction, selection, comparison, or composition is a View;
- searchable text is a representation, not a replacement for source media;
- decoded representations should remain linked to their original artifacts,
  source, time, and interpretation method;
- ViewSpecs define stable task-specific representation contracts while View
  instances and their contents evolve;
- different tasks select different evidence, and the same Observation may
  contribute to several Views;
- agents, Workflows, and applications should reuse Views instead of each
  rebuilding relevance from the complete Observation store;
- Processor contracts should remain stable while source-native, local, remote,
  Workflow, and Agent implementations evolve behind them;
- Workers and frameworks such as III are execution infrastructure rather than
  owners of Metaflow's Observation, View, policy, or provenance semantics;
- selecting an implementation and trying an alternative must remain explicit
  Processor Run evidence, never a silent fallback;
- a stable Personal Agent may delegate execution to specialized workers;
- Agents may have stable identities and execution continuity, but durable
  personal, project, and Application state belongs to Views rather than private
  Agent memory;
- source-root Observations and derived Views should share one traversable
  representation space while preserving their different provenance and
  lifecycle invariants;
- humans, Functions, models, Agents, Workflows, and external services may all
  derive Views through the same provenance requirements;
- external Agent runtimes may own detailed Agent definitions and orchestration;
  Metaflow only needs enough reference, authority, run, and output information
  to integrate them safely;
- proactive help and explicit commands should use the same capabilities;
- Personal Applications own stable purposes and Application View Spaces while
  reusing shared personal and project Views rather than creating isolated data
  stores;
- Application View Spaces are composable subgraphs whose Views retain
  independent identity, provenance, privacy, lifecycle, and reuse across
  multiple parents or Applications;
- learning materials, sessions, feedback, profiles, strategies, and plans form
  a closed graph loop that improves future learning behavior;
- teaching strategies, histories, tasks, feedback, and learned state must
  survive replacement of the Agent or runtime that processes them;
- background work must expose progress, failure, provenance, and outputs;
- new Views and Automations need an inbox or candidate state before promotion;
- all important actions should be accessible to both humans and authorized
  agents through shared operations;
- generated Workflows, Views, plugins, and applications should be testable,
  versioned, and reversible.

## Open architecture questions

- What is continuously captured, and how long are raw screen and audio
  artifacts retained?
- What authority does one Launch command grant for a multi-step task?
- Which actions may run automatically, and which require confirmation?
- How should Personal Agent identity differ from an underlying model or Agent
  Runtime?
- Which responsibilities require a fixed Agent, and what identity, state,
  ownership, and lifecycle make that Agent persistent?
- Should Processor remain a narrow View-derivation term, or should View
  Producer and other more precise concepts replace it?
- Is Observation the canonical source-root term, or should the product expose
  it as Raw View or Source View beneath a shared Representation concept?
- What is the minimum stable Agent Reference needed to use Multica or another
  external Agent Runtime without mirroring its internal Agent model?
- Which English-learning rules belong to versioned Application logic, and which
  personalized strategies should evolve as Views?
- What belongs in personal memory, project memory, or temporary task context?
- How does an unclassified capture move from Inbox into a stable View family?
- When does repeated behavior justify creating an Automation?
- How are background task results organized and surfaced after completion?
- Which capabilities must stay local, and which may use remote runtimes?

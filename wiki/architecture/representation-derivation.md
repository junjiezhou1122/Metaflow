---
name: architecture/representation-derivation
title: Representation and Derivation
desc: A design draft for one traversable representation space, open derivation actors, and thin external Agent references.
category: design-draft
tags: [representation, observation, view, derivation, actor, agent-runtime]
sources: [vision/dream-log, current-v0-inspection]
created: 2026-07-24T16:48:58Z
updated: 2026-07-24T16:54:43Z
---

# Representation and Derivation

> Status: superseded as a canonical model by
> [[architecture/view-model|View Model and View Algebra]]. This page remains as
> discussion history; its Observation/View split and `Derivation` terminology
> must not be used as the current architecture decision.

## Goal

Any relevant information node should be usable as input regardless of whether
the next useful interpretation is created by a person, fixed code, a model, an
Agent, a Workflow, an external service, or a future mechanism. This openness
must not erase the difference between source assertions and derived results.

## One representation space, two invariants

```text
Representation
├── Observation
│   source-root · immutable · directly attributable
└── View
    derived · versioned · task-shaped · lifecycle-managed
```

`Raw View` is a useful product intuition for Observation because both are
representations and both can be searched, traversed, selected, and used as
inputs. It is not yet the canonical domain term. Calling both simply View
without a subtype would hide the invariant that a derived result must never be
presented as a source assertion.

An Observation may comprehensively represent one source at one instant. It is
not normally the complete user state across sources:

```text
screen-frame Observation
+ browser-DOM Observation
+ Accessibility-focus Observation
+ audio Observation
+ active-task Views
        ↓
current-state View
```

The current-state View is comprehensive precisely because it is a derived,
time-bounded fusion over several source roots and existing Views.

## Derivation instead of a universal Processor

A Derivation is the provenance-bearing activity that reads any number of
Representations and creates a new or versioned View:

```text
Observation | View | Observation[] | View[]
                    ↓
              Derivation Run
                    ↓
                  View
```

Inputs remain immutable. Even a human edit creates a new View version or an
explicit mutation event according to the View lifecycle; it does not rewrite
source evidence.

The actor is deliberately open:

```text
human
fixed Function
model call
Agent
Workflow
external service
future actor
```

ViewSpec declares which producer identities or capability classes may write a
View family. Every Derivation Run records input references, Actor Reference,
implementation or runtime version, policy decision, output, timing, and error.

## Actor Reference, not universal Actor ownership

Metaflow needs enough information to attribute and authorize work, but it does
not need to reproduce every execution system's internal actor model. A
provisional Actor Reference needs only concepts such as:

```text
actor identity
actor kind
runtime/provider identity
external identity when applicable
declared or discovered capabilities
authorization and privacy scope
availability and version metadata
```

This reference may point to a human identity, local Function, Metaflow-owned
Agent, Multica Agent or team, Codex session, Workflow, or remote service.

## Application owns durable domain context

A domain experience such as English learning should not be identified with the
Agent currently performing the work:

```text
Personal Application: English Learning
├── ViewSpecs
│   ├── learning.material
│   ├── learning.profile
│   ├── learning.mistake
│   ├── learning.strategy
│   ├── learning.plan
│   └── learning.session
├── Core Operations
├── Automations and policies
├── Surfaces
└── Application View Space
        ↓ read/write through contracts
    human | Function | Agent | Workflow | external service
```

Teaching strategy has two forms that should not be conflated. General teaching
algorithms and invariant behavior may be versioned Application logic.
Personalized strategy, learner state, past tasks, mistakes, feedback, and
progress are data and remain provenance-linked Views.

Agent runtime memory is allowed as a reconstructable cache or session
scratchpad. It is not authoritative domain storage. Before a result should
affect future English-learning behavior, it must be validated and written into
the Application View Space. Replacing Multica with Codex, Hermes, a Workflow,
or deterministic code therefore changes execution but not the learner's state.

## Thin Multica integration

```text
Metaflow task or Derivation request
→ selected Views and Observation references
→ authorization and output contract
→ Multica adapter
→ Multica-managed Agent or team
→ streamed run events and artifacts
→ validated View with provenance
```

Provisional ownership boundary:

| Metaflow owns | Multica may own |
| --- | --- |
| task intent and scope | Agent creation and role definitions |
| Observation and View identity | prompts and reconstructable session memory |
| selected input references | team topology and delegation |
| authorization and privacy policy | model and tool configuration |
| run linkage and user-visible events | internal planning and execution |
| output ViewSpec, validation, and provenance | provider-specific checkpoints |

Metaflow therefore needs a thin Agent Reference and runtime adapter, not a
complete local copy of every Multica Agent definition. If Metaflow later owns a
native Agent, the same reference may point to that local definition.

## Automation remains separate

Automation answers when work starts, not who the actor is or how intelligence
works:

```text
Trigger + target reference + input mapping + policy
```

The target may be a Core Operation, Derivation, Workflow, Agent assignment, or
external runtime request. Manual Launch, Ambient decisions, schedules, state
changes, and incoming events can all invoke the same targets without changing
their identity.

## Open questions

- Should `Representation` become a first-class public domain term or remain an
  internal graph abstraction?
- Should Observation remain canonical, or should it be exposed as `Raw View`
  or `Source View`?
- Is `Derivation` the right name for every View-producing activity, including
  human edits and long-running Agent work?
- Which Actor Reference fields are stable across Multica, Codex, Hermes, local
  Functions, Workflows, and people?
- Are capabilities declared by Metaflow, discovered from the external runtime,
  or both with an explicit reconciliation rule?

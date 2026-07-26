---
name: architecture/application-view-spaces
title: Application View Spaces
desc: A design draft for Personal Applications as composable, reusable ViewGraph subgraphs.
category: design-draft
tags: [application, viewgraph, subview, composition, feedback]
sources: [vision/dream-log, current-v0-inspection]
created: 2026-07-24T17:01:16Z
updated: 2026-07-24T17:01:16Z
---

# Application View Spaces

> Status: design draft for discussion, not a committed implementation.

## A space is a subgraph

A Personal Application does not own an isolated database or one large mutable
document. Its durable data is a logical subgraph within the shared ViewGraph:

```text
Application: English Learning
│
├── learning.materials
│   ├── learning.material:youtube-123
│   │   ├── learning.excerpt:01
│   │   ├── learning.vocabulary:01
│   │   └── learning.expression:01
│   └── learning.material:webpage-456
│
├── learning.profile
│   ├── learning.ability:vocabulary
│   ├── learning.ability:listening
│   ├── learning.preference:video
│   └── learning.goal:speaking
│
├── learning.strategy
├── learning.plan:today
├── learning.session:2026-07-25
└── learning.feedback
    ├── learning.feedback:too-hard
    ├── learning.feedback:useful
    └── learning.feedback:confused
```

The indentation is a navigation projection, not physical nesting or an
absolute abstraction level. Every included element is an independently
addressable View with its own schema, provenance, privacy, lifecycle, and
version history.

## Every View remains reusable

One View may have several parents:

```text
learning.material:youtube-123
├── part_of → learning.materials
├── referenced_by → learning.plan:today
├── used_by → learning.session:2026-07-25
├── member_of → application:english-learning
└── member_of → application:research-library
```

Removing it from today's plan only removes that relationship. It does not
delete the material or remove it from another Application. Retiring one View
does not implicitly retire Views that it selected or referenced.

## Provisional edge vocabulary

Different relationships need different invariants:

| Edge | Meaning | Mutation rule |
| --- | --- | --- |
| `derived_from` | evidence lineage | append-only and acyclic |
| `part_of` | structural composition | attach/detach, no node deletion, acyclic |
| `references` | semantic dependency or citation | mutable with provenance; cycles allowed |
| `supersedes` | lifecycle and version succession | append-only and acyclic |
| `member_of` | Application View Space membership | attach or detach by policy |

These names remain provisional. The important decision is that provenance,
composition, reference, lifecycle, and membership are not one generic
`related_to` edge.

This distinction permits semantic feedback loops while preventing a View from
containing itself, evidence from deriving from its own output, or versions from
superseding each other in a cycle.

## The learning loop is graph-shaped

```text
learning.material
      ↓
learning.session
      ↓
learning.feedback
      ↓
learning.profile + learning.strategy
      ↓
learning.plan
      └────────────→ next learning.session
```

Feedback remains an independent View linked to the exact material, session,
task, response, and actor that produced it. A Derivation may update the learner
profile or personalized strategy, but it cannot erase the original feedback.

This supports several execution methods over the same state:

- fixed code updates spaced-repetition timing;
- a human edits a goal or rejects a strategy;
- an Agent interprets repeated confusion;
- a Workflow assembles the next lesson;
- an Automation starts the daily review.

## Traversal and safety

Application queries should specify entry Views, edge types, direction, depth,
time range, and privacy scope. A generic recursive traversal must not silently
cross into private or unrelated spaces.

Privacy and provenance follow the View and its source lineage, not the parent
that happens to display it. Adding a private View to a public Application Space
does not weaken its policy.

## Open questions

- Does every Application View Space need one explicit root, or can it expose
  several entry Views?
- Which edge types are user-editable, Agent-editable, or append-only?
- Should `member_of` be stored explicitly or computed from reachable roots?
- How should a UI project a multiply-connected graph into understandable navigation?
- When should feedback update another View immediately, remain pending, or
  require explicit promotion?

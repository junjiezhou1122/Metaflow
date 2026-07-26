---
name: architecture/application-view-spaces
title: Application View Spaces
desc: The accepted v1 boundary for Personal Applications as composable, reusable ViewGraph subgraphs.
category: accepted-design
tags: [application, viewgraph, subview, composition, feedback]
sources: [vision/dream-log, current-v0-inspection]
created: 2026-07-24T17:01:16Z
updated: 2026-07-27T08:00:00Z
---

# Application View Spaces

> Status: v1 Application Space View and graph projection boundary accepted by
> issue 71. Explorer UI remains future work.

## v1 contract

An Application Space is one ordinary immutable Derived View using the strict
`application.space@1` Schema. Its inline JSON Representation freezes exact
entry refs and declares `membership` or `composition` for each entry. The root
stores matching outgoing `application_member` or `application_composition`
relations; these explicit inverse-style names avoid overloading the earlier
provisional child-to-parent vocabulary.

`application.space@1` also declares a generic strict-Schema
`relation_projection@1`. View admission and View Package conformance derive the
expected managed relations from `/entries` and reject missing, extra, or
mismatched exact targets, types, and metadata. The JSON Schema rejects
whitespace-only `view_id` values before that cross-envelope check.
Raw exact refs must also already equal their parsed normalized form, so leading
or trailing whitespace cannot make Representation and relation evidence differ.

Attach and detach create a new revision of the root with an exact `supersedes`
edge. Historical roots and members are never mutated or deleted. A member may
remain the target of any number of exact Application Space revisions.

`view.graph.project` is the only bounded graph projection Operation. It accepts
exact roots, direction, an edge allowlist, and depth/node/edge limits. Every
discovered revision is authorized before it can affect returned nodes, edges,
paths, summaries, truncation, or frontier. Denied boundaries expose only the
coarse `redacted_boundary` boolean. Relation pages are validated and authorized
before consuming the fixed projection-wide scan budget, so denied-only
cardinality cannot turn a redacted success into a threshold error. All pages
and summaries come from a single storage read snapshot, preventing concurrent
incoming commits from fracturing keyset pagination. File-backed stores use a
WAL read transaction; in-memory stores freeze an explicit query-only SQLite
memory backup before traversal without writing that content to disk. Full
content remains an exact `view.get`.

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

One View may have several parents without carrying mutable parent state:

```text
application:english-learning ──application_member──────┐
application:research-library ─application_member──────┼─→ learning.material:youtube-123
learning.plan:today ───────────application_composition─┘
```

Removing it from today's plan only removes that relationship. It does not
delete the material or remove it from another Application. Retiring one View
does not implicitly retire Views that it selected or referenced.

## Broader edge vocabulary

Different relationships need different invariants:

| Edge | Meaning | Mutation rule |
| --- | --- | --- |
| `derived_from` | evidence lineage | append-only and acyclic |
| `part_of` | structural composition | attach/detach, no node deletion, acyclic |
| `references` | semantic dependency or citation | mutable with provenance; cycles allowed |
| `supersedes` | lifecycle and version succession | append-only and acyclic |
| `application_member` | root-to-entry Application membership | attach/detach by root revision |
| `application_composition` | root-to-entry structural composition | attach/detach by root revision |

The non-Application names remain provisional. The important decision is that provenance,
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

## Remaining questions

- Which edge types are user-editable, Agent-editable, or append-only?
- How should a UI project a multiply-connected graph into understandable navigation?
- When should feedback update another View immediately, remain pending, or
  require explicit promotion?

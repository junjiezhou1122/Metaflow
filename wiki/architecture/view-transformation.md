---
name: architecture/view-transformation
title: View Transformation Architecture
desc: Active design of the path from Raw or Derived Views through View Algebra and the Operator Runtime to a committed Derived View.
category: active-wayfinder-draft
tags: [view, view-algebra, operator, runtime, agent, provenance]
sources: [architecture/view-model, wayfinder/metaflow-v1-architecture/map]
created: 2026-07-25T00:00:00+08:00
updated: 2026-07-25T00:00:00+08:00
---

# View Transformation Architecture

> Status: superseded by
> [[architecture/view-core-transformation-runtime|View Core and Transformation
> Runtime]]. In particular, the final design does not retain separate Operator
> contract, implementation-selection, and Worker domain layers.

## Design method

Schema, naming, and Operator vocabulary are derived scenario-first:

```text
real source material
    -> desired user-visible result
    -> information that result must preserve
    -> semantic objects and relations
    -> View schema
    -> required transformations
    -> reusable Operator vocabulary
```

Existing papers, databases, and agent frameworks may test or implement the
result, but they do not define Metaflow's ontology.

## Scope

This architecture owns every transformation with the closed form:

```text
View[] -> View
```

An input may be a Raw View (Observation) or Derived View. OCR, transcription,
selection, merge, semantic comparison, summarization, clustering, inference,
verification, and revision all use the same path.

Because every View may be an element of another View, Algebra uses one closed
contract without creating View classes for collections or live results. A
provisional operational vocabulary is:

```text
select      View -> View
union       View[] -> View
intersect   View[] -> View
difference  View[] -> View
group       View -> View
map         Operator x View -> View
split       View -> View
merge       View[] -> View
compress    View -> View
expand      View -> View
```

These names remain hypotheses until concrete scenarios prove the minimal
vocabulary.

## Confirmed skeleton

```text
Input Views
    -> View Algebra expression
    -> Operator contract
    -> Operator Runtime
    -> Operator Implementation
    -> candidate View
    -> schema/policy/provenance validation
    -> committed View revision
```

The responsibilities are intentionally separated:

| Concept | Responsibility |
| --- | --- |
| View Algebra | Formally describes what information transformation is requested. |
| Operator contract | Declares input and output schemas, semantics, policy, and validation requirements. |
| Operator Implementation | Performs the work through code, a model, an Agent, a Workflow, a remote service, or a human. |
| Operator Runtime | Selects an implementation and owns authorization, execution, events, cancellation, failure, and trace. |
| View Store | Validates and commits the resulting logical View revision and its provenance. |

## Observable execution path

```text
1. Resolve input View identities and revisions
2. Type-check the View Algebra expression
3. Resolve the referenced Operator contracts
4. Authorize access and intended output
5. Select one eligible implementation explicitly
6. Create an Operator Run before execution starts
7. Execute and emit durable run events
8. Validate the candidate View against its declared schema
9. Commit the View revision and full provenance
10. Complete the run with output identity or an explicit error
```

An alternative implementation after failure is a new linked attempt. It is
never a silent fallback.

## Running example

```text
Raw View: YouTube reference
+ Derived View: personal interests
+ Derived View: mastered expressions
    -> resolve transcript only when the task requires it
    -> select(language = English)
    -> relate(to = personal interests)
    -> subtract(mastered expressions)
    -> compress(goal = five useful expressions)
    -> Derived View: learning.daily-material
```

The algebra describes the desired transformation. The runtime may execute
structural steps with code and the semantic `relate` and `compress` steps with
an Agent, while preserving one typed expression and one traceable run graph.

## First design exercise

Derive the first View schemas, names, and Operator forms from
[[architecture/examples/youtube-english-learning|YouTube to Personal English
Learning]]. Only after the example works end to end should the architecture
decide whether View Algebra is:

1. a fixed catalog of built-in operators;
2. an unrestricted natural-language operator system; or
3. a small stable typed kernel plus registered, AI-creatable higher-level
   Operators.

The current recommendation is option 3, but it is not yet decided.

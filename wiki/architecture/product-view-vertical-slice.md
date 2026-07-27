# Product View Vertical Slice

## Goal

Prove that a Metaflow View is a user-meaningful information product, not only
an envelope, graph node, or generic JSON document. The first vertical slice is:

```text
Audio View[] -> Activity Timeline View -> Daily Summary View
```

Each exact View remains an ordinary immutable v1 View. The product behavior is
declared by one View Package and includes a strict Schema, Representation
profile, exact Transformation, Processor descriptor, and exact Web Renderer
descriptor. A separate Function Worker adapter forms Timeline and Daily
Summary candidates through the ordinary Execution Runtime.

## Scope

This slice owns exactly three Schema families:

- `personal.audio.semantic@1`: one bounded semantic audio occurrence with its
  time range, transcript, speakers, topics, decisions, and action items.
- `personal.timeline.activity@1`: one bounded period arranged into ordered time
  blocks whose entries retain exact source View refs.
- `personal.summary.daily@1`: one readable daily synthesis containing themes,
  highlights, decisions, unfinished threads, and tomorrow's focus.

The executable acceptance begins with already admitted Audio Views. Formation
of `personal.audio.semantic@1` from `capture.screenpipe.audio@1` remains a
declared Processor boundary and is not presented as implemented by this slice.

Screenpipe evidence Views are a separate, now executable layer:

```text
capture.screenpipe.* Raw View[]
  -> screenpipe.timeline.compress@1
  -> metaflow.screenpipe.timeline@1

capture.screenpipe.audio Raw View[]
  -> screenpipe.audio.compose@1
  -> metaflow.screenpipe.audio@1
```

These are deterministic evidence compressions. They preserve exact source
revisions and do not claim to be the semantic `personal.audio.semantic@1` or
`personal.timeline.activity@1` Views. A future semantic Processor must expose
that second Transformation explicitly.

The View Explorer remains a graph navigation surface. Selecting one of these
Views mounts the Renderer declared by the exact installed View Package:

- Audio renders as a transcript with time, speaker, topics, and extracted
  follow-ups.
- Timeline renders as a chronological vertical timeline, not a JSON tree.
- Daily Summary renders as a continuous editorial article, not a dashboard or
  collection of cards.

Graph relations expose provenance between exact revisions. They do not replace
the selected View's content Renderer.

## Non-goals

This slice does not add or redesign Connectors, semantic Audio formation,
Search, embeddings,
Automations, authoring, Marketplace, external media materialization, or Graph
traversal controls. It does not migrate the archived v0 implementations as
runtime owners; those files are evidence for product semantics only.

## Interface

The View Package is the authoring interface. Callers need only the exact View
Schema and Representation. Renderer selection is exact on:

```text
Schema name + Schema version + surface + Representation kind + media type
```

There is no product-View fallback to the generic JSON Renderer. Missing,
ambiguous, malformed, or unregistered Renderer evidence is a visible typed
failure.

## Acceptance

1. All three strict fixture Representations pass View Package conformance and
   malformed content fails Schema validation.
2. The graph contains multiple exact Audio Views, one Timeline View derived
   from them, and one Daily Summary View derived from the Timeline.
3. Selecting each node opens its dedicated Renderer and shows its real content.
4. Timeline entries and provenance retain exact input revisions.
5. Execution forms Timeline and Daily Summary Views atomically, and an exact
   base View produces the next immutable revision with `supersedes` lineage.
6. Cross-day Timeline input and unchanged-base Summary input fail explicitly
   rather than silently changing semantics.
7. Desktop and mobile screenshots show readable, non-overlapping content.
8. Renderer loading is lazy, observable, disposable, and remains within an
   explicit bundle budget.
9. Typecheck, package boundaries, unit tests, View Package conformance, and
   Playwright acceptance all pass.

The `product-views` in-memory fixture proves only deterministic UI behavior.
Real product acceptance is the opt-in Screenpipe SQLite test: it backs up a
real database snapshot, resolves exact Timeline and Audio refs through shared
Operations, projects their provenance graphs, clicks each View in the real
Explorer, and asserts the committed transcript and source counts in the exact
Renderer. No fixture transport or direct table read is accepted at that seam.

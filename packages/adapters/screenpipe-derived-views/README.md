# Screenpipe Derived Views

This package owns two deterministic Function Operator implementations over
already admitted Screenpipe Raw Views:

- `screenpipe.timeline.compress@1` produces a bounded chronological multimodal
  `metaflow.screenpipe.timeline@1` View.
- `screenpipe.audio.compose@1` produces an ordered transcript-only
  `metaflow.screenpipe.audio@1` View.

The Operators accept at most 500 exact inputs. They retain canonical exact input
provenance and `derived_from` relations, inherit the strictest source policy,
and return untrusted candidate envelopes for ordinary Execution validation and
atomic commit. Timeline previews are capped at 500 characters. Audio preserves
source transcript text without speaker identification, summarization, or other
semantic inference; pending, missing, or over-bound transcripts fail explicitly.
Both Capture and derivation validate modality payloads through the single
`@info/screenpipe-contracts` wire contract.

The package does not call Screenpipe, read its SQLite database, select moving
View heads, commit Views, or own capture checkpoints. `@info/screenpipe-capture-adapter`
and the shared Connector Runtime own REST capture and Raw View admission.

For a bounded local capture and derivation run:

```bash
pnpm screenpipe:derive -- --minutes 15 --limit 50
```

The command obtains the local API credential through `screenpipe auth token`
without printing it, accepts only an explicit HTTP loopback endpoint
(`127.0.0.1` or `[::1]`), uses REST only, and writes to
`METAFLOW_DATA_DIR/metaflow.sqlite` (default `data/ambient-v1/metaflow.sqlite`).
Each one-shot query derives a stable connection identity only from its
normalized local endpoint. Modalities, limits, content bounds, and time windows
may change over the same per-modality checkpoint without forking Raw View
identity; changing a true content selector still fails with an explicit
checkpoint scope mismatch.

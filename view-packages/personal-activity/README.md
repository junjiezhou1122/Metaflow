# Personal Activity View Package

This package defines the first product-View vertical slice:

```text
personal.audio.semantic@1[]
  -> personal.timeline.activity@1
  -> personal.summary.daily@1
```

All three are strict ordinary Views. Their Representations contain the
information a person expects to read, while exact input lineage remains in the
View provenance graph. The package declares the Timeline and Daily Summary
Transformations plus Processor and Renderer identities; it does not execute
Workers, mount UI, read storage, or select moving View heads.

`@info/personal-activity-operator-adapter` implements the two Function Workers.
It is composed through the generic Function Operator adapter and returns only
untrusted candidates for Execution to validate and commit. Optional exact
`base_timeline` and `base_summary` inputs evolve the same View identity by
immutable revision rather than mutating prior content.

This executable slice starts from existing `personal.audio.semantic@1` Views.
The declared Raw Screenpipe audio to semantic Audio Processor is a separate
formation step and is not implemented by this package.

The Web surface must exact-match the package Renderer descriptor. Audio uses a
transcript surface, Timeline uses chronological blocks, and Daily Summary uses
a continuous editorial reading surface. A generic JSON rendering is not an
accepted fallback for these Schemas.

# Personal Activity Operator Adapter

This adapter implements the executable Function Workers for the Personal
Activity View Package:

```text
personal.audio.semantic@1[] -> personal.timeline.activity@1
personal.timeline.activity@1 -> personal.summary.daily@1
```

It returns untrusted candidate envelopes only. `ExecutionRuntime` retains input
freezing, authorization, strict Schema validation, policy inheritance,
provenance validation, revision compare-and-swap, atomic commit, Failure Views,
and durable trace ownership.

The adapter supports optional exact base Timeline and Daily Summary Views. A
base produces the next immutable revision of the same View identity with an
explicit `supersedes` relation. It never mutates an earlier revision.

## Question

What explicit identities, limits, and terminal evidence make recursively triggered Derived Views powerful without creating hidden cycles, duplicate work, unbounded fan-out, or silent partial completion?

## Acceptance criteria

- Freeze root correlation, parent event/run, exact lineage, depth, fan-out, budget, and cascade-policy revision on every reactive attempt.
- Define idempotency across outbox delivery, Automation occurrence, III queue retry, Execution replay, and output commit.
- Detect repeated fingerprints and lineage cycles before execution; enforce explicit maximum depth, fan-out, cost/time, and per-Operator concurrency limits.
- Commit inspectable stop/failure evidence for denied, exhausted, cyclic, timed-out, cancelled, crashed, and DLQ-terminal attempts without invalidating source Views.
- Permit many matching Operators and recursive Derived View triggers when all declared limits allow them.
- Support explicit replay/repair as a new linked attempt rather than an invisible retry.

## Verification method

- Property-test acyclic chains, deliberate cycles, diamond fan-out, duplicate delivery, concurrent retries, budget exhaustion, crash, and explicit repair.
- Verify every terminal path can be reconstructed from durable View, Automation, Run, outbox, and III evidence.

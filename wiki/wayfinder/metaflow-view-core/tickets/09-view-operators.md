## Question

How should split, merge, grouping, compression, and AI-created operations use one extensible Transformation contract without hard-coding a closed Operator catalog?

## Depends on

- Implement the observable Execution Runtime and atomic commit path

## Acceptance criteria

- `split` and `merge` demonstrate stable operation shapes without fixing semantic partition or reconciliation rules.
- A function Operator and an Agent Operator execute through the same Runtime contract.
- Split outputs are ordinary Views and preserve the input View.
- Grouped View revisions freeze exact membership and evolve through new revisions.
- Trace-based deterministic grouping and semantic Agent grouping are both expressible.
- Adding a new Operator kind or reference does not require changing View Core.

## Verification method

- Test deterministic split/merge and a fake Agent grouping Operator against the same Run and provenance assertions.
- Verify no fixed cluster taxonomy is required by Core.

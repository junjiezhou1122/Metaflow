## Question

How should Manual, Smart Approve, and Approve All control View disclosure while allowing explicit deny rules to override broad approval?

## Depends on

- Implement the minimum immutable View contract
- Define the versioned Transformation and Operator contract

## Acceptance criteria

- Policy supports Manual, Smart Approve, and Approve All profiles.
- Explicit deny may match View, source, Schema, or Operator and wins over allow.
- Runtime can compute a deterministic decision for exact input revisions.
- Every decision includes rule provenance and the exact Views permitted or rejected.
- Failure and repair Views inherit the strictest relevant input policy.
- The contract does not claim authority over external side effects.

## Verification method

- Run a policy decision matrix including global allow with local deny, global deny with explicit allow where permitted, mixed inputs, and repair inheritance.
- Verify serialized policy snapshots are stable and auditable.

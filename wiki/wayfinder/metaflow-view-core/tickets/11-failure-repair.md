## Question

How should failed execution create queryable Failure Views that can be split, grouped, diagnosed, and repaired by ordinary Transformations without infinite hidden recovery loops?

## Depends on

- Implement extensible View-to-View Operators
- Implement Feedback Views and explicit Transformation evolution

## Acceptance criteria

- Failed Runs create valid Failure Views without admitting invalid candidates as success.
- Failure View references Run, error evidence, candidate artifact, policy snapshot, and causal chain.
- Failure Views can be split or grouped using ordinary Operators.
- Repair Transformations may create Diagnosis Views, new Transformation revisions, and repair Runs.
- Runtime exposes cancellation, budgets, idempotency keys, and cycle evidence; repair policy is not hard-coded in Core.
- Repeated or cyclic repair stops observably and remains available for human or Agent inspection.

## Verification method

- Test quota, schema-invalid, policy-denied, timeout, code-crash, and unknown failures.
- Test successful repair, failed repair, repeated fingerprint, and causal-cycle scenarios.

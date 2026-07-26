## Question

How should Execution Runtime resolve and freeze inputs, authorize disclosure, execute an Operator, emit durable trace, validate candidates, and atomically commit output Views?

## Depends on

- Implement View Store and SQLite revision persistence
- Define the versioned Transformation and Operator contract
- Implement View access approval profiles and deny overrides

## Acceptance criteria

- A Run exists before Operator execution begins.
- Input selector, candidates, selected exact revisions, Operator, policy, output contract, and budget are frozen in trace.
- Operator adapters execute through one runtime port.
- Candidate envelope, Schema, policy, provenance, and base revision are validated before commit.
- Successful output revisions and relations commit atomically.
- Attempts, cancellation, timing, costs, events, and errors are observable.
- Alternative execution is a linked explicit attempt, never a hidden fallback.

## Verification method

- Use deterministic fake Operators to test success, schema rejection, policy rejection, stale base, cancellation, timeout, adapter crash, and transaction rollback.
- Verify replay can explain every committed output from frozen Run evidence.

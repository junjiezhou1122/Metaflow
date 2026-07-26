## Question

How should Agent Runtime traces, protocol logs, failed attempts, and repairs
become inspectable Metaflow evidence?

## Depends On

- Define RuntimeAdapter contracts
- Define policy, permission, and side-effect gates

## Acceptance Criteria

- Every AgentRun records frozen inputs, OperatorProfile, adapter capabilities,
  session id, events, permissions, artifacts, timing, costs, errors, and stop
  reason.
- Invalid output is never admitted as a successful View.
- Adapter crash, timeout, policy denial, schema rejection, permission denial,
  and cancellation produce queryable Failure Views.
- Repair is an ordinary Transformation that targets the Failure View and may
  choose the same or different Operator explicitly.
- Repeated repair loops stop observably with causal-cycle evidence.

## Verification Method

- Test successful output, malformed candidate, adapter crash, timeout,
  cancelled permission, cancellation, and repair with deterministic fake
  adapters.
- Verify trace replay explains why each committed View or Failure View exists.

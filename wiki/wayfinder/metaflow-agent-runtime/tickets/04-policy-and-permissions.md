## Question

How should Metaflow control agent permissions, computer-use, filesystem access,
network access, and user approvals during Agent Runtime execution?

## Depends On

- Define RuntimeAdapter contracts
- Design the ViewGraph tool bridge

## Acceptance Criteria

- View disclosure policy is separate from external side-effect authorization.
- Permission requests are represented as trace events with runtime, session,
  requested action, source View revisions, and user or policy decision.
- Approve All still respects explicit deny rules.
- Browser, filesystem, shell, network, and computer-use permissions are gated
  separately.
- Runtime permission denial creates an explicit failure or alternate attempt,
  not hidden degradation.

## Verification Method

- Run a permission decision matrix covering read-only View access, denied View,
  shell denied, browser action approved, computer-use cancelled, and timeout.
- Inspect trace and Failure View evidence for each denied path.

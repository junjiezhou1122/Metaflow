# @info/committed-view-trigger-adapter

This package is the provider-neutral boundary from durable `view.committed@1`
events to ordinary Automation invocation. It is not a new View kind, an
Automation owner, or a Worker runtime.

```text
ViewCommitted exact ref
  -> resolve exact View and active Automation Views
  -> deterministic bounded Trigger matching
  -> Automation-owned invocation port (direct Runtime or durable queue receipt)
  -> existing occurrence, context, authorization, Execution, and Delivery owners
```

An Operator is Metaflow's stable callable contract: input Views become output
Views through code, an Agent, a Workflow, a human, or a remote service. A
Worker is one runtime implementation or host of that callable contract. Worker
definitions and configuration may themselves be persisted as Views, but this
adapter neither executes nor defines Workers.

The invocation payload is always descriptor-only. An Automation that
explicitly predicates on `view.representation.*` may use a bounded local
projection inside this adapter only when `policy.allow_local_search` is not
false. Content never enters the persisted Trigger occurrence or Automation
trace. The invocation carries the exact View ref plus a predicate result bound
to the exact Automation revision, canonical predicate digest, trigger id, and
signal id; the normal Automation context authorizer still decides
whether that View may reach the target Operator. Oversized, policy-denied,
missing, malformed, or unbounded evidence becomes a strict observable outcome.

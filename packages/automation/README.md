# @info/automation

`@info/automation` is the v1 runtime boundary behind Ambient behavior. It does
not contain an Ambient Agent. It validates editable Automation Views, matches
deterministic Trigger signals, creates exact Trigger occurrences, reserves
idempotency, invokes a target port, emits correlated trace events, and requests
Delivery.

```text
Automation View + TriggerSignal
  -> exact TriggerOccurrence
  -> atomic occurrence reservation
  -> AutomationTargetExecutor
  -> result or Failure View refs
  -> AutomationDeliveryPort
```

The package has no default store, logger, target executor, or Delivery adapter.
Composition roots must provide all critical ports explicitly.

`AutomationTraceStore` is the shared append-only observability boundary. Its
strict events use one correlation id across Trigger matching, exact context and
policy decisions, target Runs, Agent runtime events, Delivery attempts, and
Feedback Views. `createAutomationAgentTraceBridge` validates shared Agent
Adapter events before forwarding them into that timeline. Retry and alternative
attempts carry an explicit parent attempt id.

`@info/automation-sqlite` is the first durable occurrence and Delivery ledger
adapter, and also implements the durable Automation trace store. Delivery
renderers keep only active presentation state; persisted request/result history
lets interactions resolve exact deliveries after a daemon restart. Browser,
macOS, scheduler, Execution Runtime, Agent Operator, notch, panel, and inbox
implement other ports outside this package.

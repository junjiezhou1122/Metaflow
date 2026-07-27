# III Runtime Adapter

This package hosts existing Metaflow Operators as versioned III Functions and
uses a named III queue to deliver reactive Automation invocations.

The ownership boundary is intentionally narrow:

```text
ViewCommitted event -> Automation match -> III named queue
                                          -> AutomationRuntime
                                          -> ExecutionRuntime
                                          -> Operator Worker
                                          -> validated atomic View commit
```

- `Operator` remains the stable Metaflow input/output contract.
- An III Worker is one replaceable runtime that can execute an Operator.
- Automation only decides when to invoke an Operator and which exact View refs
  are evidence.
- III never owns canonical View, Transformation, Automation, Run, policy,
  provenance, validation, or commit state.
- Queue handlers throw on unexpected failure so III retries and eventually
  preserves the message in its DLQ. There is no in-process fallback.
- Durable Automation envelopes are descriptor-only. Raw text, transcript,
  HTML, image/audio data, and other content must remain in governed Views and
  cross the queue as exact refs.
- Startup verifies the live engine version, named-queue concurrency, and every
  registered Function contract through engine introspection.
- The adapter forces `III_DISABLE_TRACE_PAYLOADS=true` before connecting so
  full authorized Operator inputs are not copied into OpenTelemetry spans.

`iii-config.yaml` is JSON-form YAML so both III and ordinary JSON tooling can
parse it. It uses the file-backed builtin queue for local crash/restart
durability. Multi-instance deployments should supply a RabbitMQ queue adapter
with the same named queue contract.

The adapter uses `iii-sdk@0.22.0` against the pinned III 0.19.2 engine. The
production graph overrides the complete OpenTelemetry family coherently to
core 2.9.0 and its matching 0.220.0 packages; the checked-in helpers patch
replaces the removed `Resource` constructor with `resourceFromAttributes` and
passes log processors through the current `LoggerProvider` constructor. III
runtime tests initialize the production client telemetry and exercise
registration, queueing, DLQ, execution, and cancellation against that exact
install. III 0.19.2
reports named-queue concurrency but does not expose retry/backoff
configuration through its inspection API. Those values remain pinned by this
package's queue contract and checked-in engine config; startup rejects a
different local contract and verifies the live queue name and concurrency.
The SDK also exposes no public idle connection-state callback. The adapter
therefore records a correlated `iii.worker.disconnected` event when an active
Automation or Operator invocation is stopped by disconnect; it does not claim
to observe internal idle reconnect attempts that the SDK does not publish.

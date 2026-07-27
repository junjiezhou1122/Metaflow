# v1 III Worker and queue adapter

`packages/adapters/iii-runtime` binds Metaflow's existing ports to III without
introducing another Worker, Operator, Automation, or View domain:

```text
Input Views -> Operator -> Output Views
                    ^
                    |
 code | Agent | Workflow | human | service | III Worker
```

Operator is the stable input/output contract. Worker names the replaceable
runtime implementation or host. Automation decides when that contract is
invoked and freezes exact View evidence; it does not execute or commit the
result.

The adapter pins `iii-sdk` and the expected engine to `0.19.2`, registers strict
versioned Automation, Operator, and cancellation Functions, and uses the named
`metaflow-automation-v1` queue. The checked-in builtin file-backed queue config
sets concurrency 4, three retries, 1 second backoff, 100 millisecond polling,
and DLQ inspection. Startup introspects the live engine version, queue
concurrency, and registered Function metadata and fails on incompatibility. No
in-process fallback exists.

Durable Automation messages contain the exact Automation revision, exact
trigger evidence, and bounded match descriptors. Raw text, transcript, HTML,
image/audio content, and inline Representation values are rejected; content
remains in governed Views. Operator Functions receive the frozen authorized
Execution invocation and return an untrusted candidate. Only Execution
validates Schema, policy, provenance, and base revision and atomically commits a
Derived or Failure View.

Registration, queue admission and receipt, retry, duplicate delivery, DLQ,
cancellation, disconnect, Operator progress, completion, and failure emit
correlated runtime events. III payload tracing is forcibly disabled before the
connection so authorized View contents are not copied into OpenTelemetry spans.

## Real III probe

`pnpm test:iii-runtime:live` starts the checked-in III 0.19.2 engine and a real
`IiiRuntimeWorker.start()` at `ws://127.0.0.1:49134`. It executes the exact
Markdown Parser through Execution, stops and restarts the engine, waits for the
official SDK to reconnect and re-register Functions, verifies exact Function
metadata through engine introspection, and executes a second successful Run.
The probe then stops the engine and verifies that no listener remains.

III 0.19.2 exposes live named-queue concurrency, but its inspection surface
does not expose retry and backoff configuration. Those values are therefore
pinned by the immutable adapter contract and checked-in engine config, while
startup verifies the live queue name and concurrency. Crash/restart queue
behavior is covered by the adapter contract tests and III's file-backed config;
the probe establishes real compatibility and registration, not a destructive
engine-crash durability proof.

The SDK also exposes no public idle connection-state callback. A disconnect
that stops an active Automation or Operator invocation is recorded with its
message, Automation, Run, and attempt correlation before the error propagates;
internal idle reconnect attempts remain SDK-owned and are not presented as
observable facts.

## Verification

- `pnpm test:iii-runtime`: 11/11 passed.
- `pnpm test:iii-runtime:live`: two successful Parser Runs with startup and
  restart readiness evidence against the installed III 0.19.2 binary.
- `corepack pnpm verify:v1:boundaries`: typecheck and dependency checks passed;
  package boundary tests 23/23 passed.
- `corepack pnpm test:committed-view-trigger`: 6/6 passed.
- `corepack pnpm test:execution-runtime`: 12/12 passed.
- `corepack pnpm test:v1-vertical`: 1/1 passed.
- `pnpm test:v1`: 437 total, 436 passed, one opt-in live Screenpipe smoke
  skipped, zero failed.
- `git diff --check`: passed.
- A real Derived View is committed by routing the existing Agent adapter through
  III and back through `ExecutionRuntime`; the III Function never constructs the
  committed View envelope.

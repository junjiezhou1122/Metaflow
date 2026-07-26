# Capture Core

`@info/capture` owns provider-neutral evidence admission. It turns source
deliveries into immutable Raw View revisions without allowing a Connector to
write the View Store directly.

```text
provider API / SDK / filesystem / webhook / MCP
  -> ConnectorPort
  -> ConnectorRuntime
  -> CaptureIngress
  -> CaptureRuntimeRepository
  -> Raw View revisions + checkpoint + trace
```

## Ownership

Capture Core owns:

- versioned Connector manifests and Source Connections;
- secret references, delivery kinds, and capability negotiation;
- Capture Batches, Raw View Candidates, and checkpoint transitions;
- retry, pause/resume, backpressure, health, dead letters, and replay;
- candidate normalization and atomic Raw View admission.

A Connector owns only provider protocol details. It may use a native SDK,
REST, filesystem, stdio, webhook, MCP, or a hosted integration service behind
`ConnectorPort`. It yields validated `CaptureBatch` values and never receives a
View repository.

Provider implementations are independent packages under `packages/adapters`;
Capture Core contains no Browser, Screenpipe, SaaS, or provider-specific API
client.

New source adapters start with [CONNECTOR-KIT.md](./CONNECTOR-KIT.md).
`defineConnectorKit` supplies strict manifest, configuration, and payload
validation; explicit source-identity and external-reference helpers;
non-weakening policy propagation; canonical candidate and batch construction;
and the shared `runConnectorConformance` harness. It does not own source API,
SDK, filesystem, or native event access.

Transformations own OCR, transcription, summarization, clustering, and other
semantic enrichment. Action adapters own external side effects. Neither
belongs in Capture Core.

## Main contracts

| Contract | Meaning |
| --- | --- |
| `ConnectorManifest` | Versioned capabilities, transports, delivery kinds, and emitted Schema declarations. |
| `SourceConnection` | One configured provider source with secret references and privacy defaults. |
| `RawViewCandidate` | Source-attributed evidence that has not entered the View Store. |
| `CaptureBatch` | One atomic delivery and its optional explicit checkpoint transition. |
| `ConnectorPort` | Health and pull/stream/reference access to a provider. |
| `ConnectorRuntime` | State machine coordinating delivery, retries, health, and admission. |
| `CaptureIngress` | The only boundary that normalizes candidates into Raw View drafts. |
| `CaptureRuntimeRepository` | Atomic persistence for Views, checkpoints, attempts, trace, and dead letters. |
| `ConnectorKit` | Small deterministic source payload to Raw View Candidate and Capture Batch authoring API. |
| `runConnectorConformance` | Reusable malformed-input, determinism, Schema, lossless, multi-candidate, and exact-replay harness. |

`push` and `manual_import` callers submit a batch through
`ConnectorRuntime.submitBatch`. `pull`, `stream`, and `reference` callers use
`ConnectorRuntime.run`, which checks health and opens the matching Connector.
All five paths converge on the same `submitBatch -> ingestBatch` operation.

## Checkpoint and identity rules

A checkpoint is an opaque Connector cursor plus a Metaflow revision. The
repository compares the batch's `expected_revision` and `previous` cursor to
the durable checkpoint, then advances it in the same transaction as the whole
Raw View batch. A rejected candidate rolls back every View and the checkpoint.

The batch idempotency fingerprint is checked before checkpoint staleness. An
exact replay returns the original receipts without advancing the checkpoint;
reusing a key with different evidence fails. A stable source object keeps one
View id and gains immutable revisions. Source occurrences get independent View
ids. Similar evidence from different Connectors is never deduplicated.

## Failure state machine

```text
registered
  -> health check (pull / stream / reference)
  -> attempt started
  -> batch committed atomically
     or retry scheduled
     or dead-lettered

paused / disabled / backpressured before attempt start
  -> fail explicitly
  -> no provider call and no dead letter

restart with abandoned in-flight attempt
  -> recover connection as degraded
  -> append connection.recovered
  -> permit a new explicit attempt
```

Retry policy is versioned and code-based. There is no implicit fallback.
Terminal attempted batches retain their sanitized batch, structured safe
error, and attempt count in a queryable dead letter. Replay is explicit and
resolves the dead letter only after admission succeeds.

Every candidate gets `capture.started`. Candidate normalization, stable-source
lookup, strict Schema validation, and storage commit share the same observable
failure boundary, so an admission error also emits `capture.failed`. Durable
runtime trace records attempt start, retry, failure, commit, checkpoint, health,
pause/resume, restart recovery, dead-letter, and replay transitions.

## Secrets and large sources

Connections contain only `SecretReference` values. Candidate metadata,
Representations, batches, errors, trace payloads, and dead letters reject
credential-shaped keys. Untrusted provider exception text is normalized before
it can enter admission events, logs, health, trace, or dead letters.

Large media and documents normally use an `external_reference`
Representation. Fetching, decoding, OCR, transcription, or summarization later
creates a new Derived View through a Transformation; it never mutates the Raw
View.

## External patterns reused

- Kafka manual offset control separates reading from committing a consumed
  position. Metaflow similarly advances a checkpoint only after atomic
  admission: <https://kafka.apache.org/42/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html#manual-offset-control-heading>
- Airbyte State Messages are opaque to the protocol, and a destination emits a
  state only after all preceding records were written. Metaflow keeps the
  Connector cursor opaque and commits it with the admitted batch:
  <https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol#state--checkpointing>
- Amazon SQS DLQs isolate exhausted work for inspection and explicit redrive.
  Metaflow stores sanitized terminal batches and exposes explicit replay:
  <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html>

These are behavioral patterns, not runtime dependencies.

## Verification

```bash
node --experimental-sqlite --import tsx --test tests/capture-runtime.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.v1.json
node --import tsx scripts/check-v1-package-manifests.ts
```

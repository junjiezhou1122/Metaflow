import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureBatchSchema,
  CaptureIngress,
  CaptureRuntimeError,
  ConnectorProtocolError,
  ConnectorRuntime,
  RawViewCandidateSchema,
  SourceConnectionSchema,
  type CaptureBatch,
  type CaptureDeliveryKind,
  type CaptureEvent,
  type ConnectorOpenRequest,
  type ConnectorPort,
  type RawViewCandidate,
  type SourceConnection,
} from "@info/capture";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { PrivacyForgetService, ViewRepositoryError, exactViewRef } from "@info/view";

const policy = {
  owner: "user:test",
  visibility: "private" as const,
  privacy: "private" as const,
  retention: "normal" as const,
  allow_external_model: false,
  allow_embedding: false,
  labels: [],
};

const manifest = {
  id: "fixture-connector",
  version: "1.0.0",
  display_name: "Fixture Connector",
  protocols: ["rest" as const],
  capabilities: ["checkpoint", "health"],
  delivery_kinds: ["push", "pull", "stream", "reference", "manual_import"] as CaptureDeliveryKind[],
  emitted_schemas: [{ name: "capture.fixture.item", version: 1, mode: "freeform" as const }],
};

function connection(id = "connection:fixture"): SourceConnection {
  return SourceConnectionSchema.parse({
    id,
    connector_id: manifest.id,
    connector_version: manifest.version,
    display_name: "Fixture source",
    endpoint: "https://fixture.example/api",
    enabled: true,
    delivery_kinds: manifest.delivery_kinds,
    secret_refs: { fixture_token: { provider: "keychain", key: "metaflow.fixture.token" } },
    configuration: { project: "metaflow" },
    privacy: policy,
  });
}

function candidate(
  id: string,
  options: {
    connector?: string;
    connectionId?: string;
    identity?: "stable_source" | "occurrence";
    value?: unknown;
    representation?: RawViewCandidate["representation"];
    relations?: RawViewCandidate["relations"];
  } = {},
): RawViewCandidate {
  return RawViewCandidateSchema.parse({
    idempotency_key: `${options.connector ?? manifest.id}:${id}`,
    name: `Captured ${id}`,
    purpose: "Exercise provider-neutral Capture admission",
    aliases: [],
    schema: { name: "capture.fixture.item", version: 1, mode: "freeform" },
    observed_at: "2026-07-26T12:00:00.000Z",
    captured_at: "2026-07-26T12:00:01.000Z",
    source: {
      connector: options.connector ?? manifest.id,
      connection_id: options.connectionId ?? "connection:fixture",
      source_id: id,
      source_kind: "fixture",
      identity: options.identity ?? "occurrence",
      assertion: "direct",
    },
    representation: options.representation ?? {
      form: "inline",
      kind: "source_record",
      value: options.value ?? { id },
      metadata: {},
    },
    policy,
    relations: options.relations ?? [],
    metadata: {},
  });
}

function batch(
  id: string,
  delivery: CaptureDeliveryKind,
  candidates: RawViewCandidate[],
  options: { key?: string; sequence?: number; checkpoint?: CaptureBatch["checkpoint"] } = {},
): CaptureBatch {
  return CaptureBatchSchema.parse({
    id,
    idempotency_key: options.key ?? `batch-key:${id}`,
    connector: { id: manifest.id, version: manifest.version },
    connection_id: "connection:fixture",
    delivery,
    sequence: options.sequence ?? 1,
    candidates,
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    created_at: "2026-07-26T12:00:02.000Z",
    metadata: {},
  });
}

class FixtureConnector implements ConnectorPort {
  readonly manifest = manifest;
  readonly deliveries = new Map<CaptureDeliveryKind, CaptureBatch[]>();
  healthFailure?: Error;
  healthChecks = 0;
  requests: ConnectorOpenRequest[] = [];

  async health() {
    this.healthChecks += 1;
    if (this.healthFailure) throw this.healthFailure;
    return { capabilities: [...manifest.capabilities] };
  }

  async *open(_connection: SourceConnection, request: ConnectorOpenRequest): AsyncIterable<CaptureBatch> {
    this.requests.push(request);
    for (const item of this.deliveries.get(request.delivery) ?? []) yield item;
  }
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T12:00:10.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

function tempDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-capture-runtime-"));
  return { directory, path: join(directory, "capture.sqlite") };
}

async function setup(
  repository: SqliteViewRepository = new SqliteViewRepository(":memory:"),
  onEvent?: (event: CaptureEvent) => void,
) {
  const connector = new FixtureConnector();
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({
    repository,
    ...(onEvent ? { onEvent } : {}),
  }), {
    retry_policy: {
      id: "capture-retry:test",
      revision: 1,
      max_attempts: 3,
      retryable_codes: ["storage_failure", "connector_protocol_error", "connector_crash"],
      non_retryable_codes: ["checkpoint_conflict", "idempotency_conflict", "source_identity_conflict", "connection_paused", "backpressure"],
    },
    now: deterministicClock(),
  });
  runtime.registerConnector(connector);
  await runtime.registerConnection(connection());
  return { runtime, connector, repository };
}

test("Capture contracts reject inline credentials and retain only secret references", () => {
  assert.equal(SourceConnectionSchema.safeParse({
    ...connection(),
    configuration: { api_key: "must-not-enter-state" },
  }).success, false);
  assert.equal(RawViewCandidateSchema.safeParse({
    ...candidate("secret-candidate"),
    metadata: { access_token: "must-not-enter-view" },
  }).success, false);
  assert.equal(connection().secret_refs.fixture_token?.key, "metaflow.fixture.token");
  assert.doesNotMatch(JSON.stringify(connection()), /must-not-enter/);
  assert.equal(RawViewCandidateSchema.safeParse(candidate("documentation", {
    value: { text: "The documentation contains an api_key=example placeholder." },
  })).success, true);
});

test("strict Representation mismatch emits failed admission evidence and no partial state", async () => {
  const repository = new SqliteViewRepository(":memory:");
  const connector = new FixtureConnector();
  const events: CaptureEvent[] = [];
  const runtime = new ConnectorRuntime(
    repository,
    new CaptureIngress({ repository, onEvent: event => { events.push(event); } }),
    { now: deterministicClock() },
  );
  runtime.registerConnector(connector);
  await runtime.registerConnection(connection());
  const invalid = RawViewCandidateSchema.parse({
    ...candidate("strict-mismatch"),
    schema: {
      name: "capture.fixture.strict",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
        additionalProperties: false,
      },
    },
    representation: {
      form: "inline",
      kind: "source_record",
      value: { title: 42 },
      metadata: {},
    },
  });
  try {
    await assert.rejects(
      runtime.submitBatch(batch("strict-mismatch", "push", [invalid])),
      (error: unknown) => error instanceof CaptureRuntimeError
        && error.code === "representation_schema_mismatch",
    );
    assert.deepEqual(events.map(event => event.type), ["capture.started", "capture.failed"]);
    assert.equal(events[1]?.error?.code, "representation_schema_mismatch");
    assert.equal((await repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);
    assert.equal((await repository.getCaptureCheckpoint("connection:fixture"))?.revision, 0);
    const trace = await repository.getCaptureTrace("connection:fixture");
    assert.ok(trace.some(event => event.type === "capture.attempt_failed"
      && event.error?.code === "representation_schema_mismatch"));
    const deadLetters = await repository.listCaptureDeadLetters("connection:fixture", "pending");
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]?.error.code, "representation_schema_mismatch");
  } finally {
    repository.close();
  }
});

test("push, paginated pull, stream, reference, and manual import share one atomic ingress", async () => {
  const { runtime, connector, repository } = await setup();
  try {
    const push = await runtime.submitBatch(batch("push-1", "push", [candidate("push-1")]));
    assert.equal(push.receipts[0]?.status, "stored");
    const pushEvent = (await repository.listEvents())[0];
    assert.equal(pushEvent?.event.batch_id, "push-1");
    assert.deepEqual(pushEvent?.event.origin, { kind: "capture", id: "connection:fixture" });
    assert.deepEqual(pushEvent?.event.views.map(item => item.ref), push.receipts.flatMap(receipt => (
      receipt.status === "stored" ? [{ view_id: receipt.view_id, revision: receipt.revision }] : []
    )));

    connector.deliveries.set("pull", [
      batch("pull-1", "pull", [candidate("pull-1")], { sequence: 1 }),
      batch("pull-2", "pull", [candidate("pull-2")], { sequence: 2 }),
    ]);
    const pulled = await runtime.run("connection:fixture", "pull", { page_size: 1 });
    assert.equal(pulled.length, 2);
    assert.equal(connector.requests[0]?.checkpoint.revision, 1);

    connector.deliveries.set("stream", [batch("stream-1", "stream", [candidate("stream-1")])]);
    assert.equal((await runtime.run("connection:fixture", "stream")).length, 1);

    connector.deliveries.set("reference", [batch("reference-1", "reference", [candidate("reference-1", {
      representation: {
        form: "external_reference",
        kind: "document",
        uri: "https://fixture.example/document.pdf",
        media_type: "application/pdf",
        metadata: {},
      },
    })])]);
    const referenced = await runtime.run("connection:fixture", "reference", { uri: "https://fixture.example/document.pdf" });
    assert.equal(referenced[0]?.receipts[0]?.status, "stored");
    if (referenced[0]?.receipts[0]?.status === "stored") {
      const stored = await repository.get({ view_id: referenced[0].receipts[0].view_id, revision: 1 });
      assert.equal(stored?.representation.form, "external_reference");
      assert.equal(stored?.materialization.primary.location.kind, "uri");
    }

    const manual = await runtime.submitBatch(batch("manual-1", "manual_import", [candidate("manual-1")]));
    assert.equal(manual.receipts[0]?.status, "stored");
    assert.equal((await repository.getCaptureCheckpoint("connection:fixture"))?.revision, 6);
    assert.equal((await repository.query({ role: "raw", revisions: "all", limit: 20 })).length, 6);
  } finally {
    repository.close();
  }
});

test("same-source duplicate delivery replays exactly while conflicting reuse fails", async () => {
  const { runtime, repository } = await setup();
  try {
    const input = batch("duplicate", "push", [candidate("duplicate")]);
    const first = await runtime.submitBatch(input);
    const replay = await runtime.submitBatch(input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipts, first.receipts);
    assert.equal((await repository.getCaptureCheckpoint("connection:fixture"))?.revision, 1);
    assert.equal((await repository.listEvents()).length, 1, "Capture replay must not enqueue another commit event");
    await assert.rejects(
      runtime.submitBatch(batch("duplicate-mutated", "push", [candidate("mutated")], { key: input.idempotency_key })),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "idempotency_conflict",
    );
  } finally {
    repository.close();
  }
});

test("Privacy Forget makes persisted Capture batch replay fail closed", async () => {
  const { runtime, repository } = await setup();
  try {
    const input = batch("forgotten-replay", "push", [candidate("forgotten-replay")]);
    const first = await runtime.submitBatch(input);
    const receipt = first.receipts[0];
    assert.equal(receipt?.status, "stored");
    if (!receipt || receipt.status !== "stored") throw new Error("Fixture capture did not commit a View");
    const stored = await repository.get({ view_id: receipt.view_id, revision: receipt.revision });
    assert.ok(stored);

    let tick = 0;
    const forget = new PrivacyForgetService({
      views: repository,
      requests: repository,
      now: () => new Date(Date.parse("2026-07-26T12:01:00.000Z") + tick++ * 10).toISOString(),
    });
    const preview = await forget.request({
      request_id: "forget:capture-replay",
      actor: "user:test",
      requested_at: "2026-07-26T12:01:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(stored!) }],
      mixed_source_rule: "purge",
    });
    await forget.execute({
      request_id: preview.plan.request_id,
      authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
      actor: "user:test",
    });

    await assert.rejects(
      runtime.submitBatch(input),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "policy_violation",
    );
    assert.equal(await repository.get(exactViewRef(stored!)), undefined);
  } finally {
    repository.close();
  }
});

test("cross-Connector evidence remains separate even when source ids and content match", async () => {
  const { runtime, repository } = await setup();
  try {
    const first = await runtime.submitBatch(batch("cross-source-a", "push", [candidate("shared-source", { value: { title: "Same entity" } })]));
    const secondManifest = { ...manifest, id: "fixture-connector-two", display_name: "Fixture Connector Two" };
    const secondConnector: ConnectorPort = {
      manifest: secondManifest,
      async health() { return { capabilities: [...secondManifest.capabilities] }; },
      async *open() {},
    };
    runtime.registerConnector(secondConnector);
    const secondConnection = SourceConnectionSchema.parse({
      ...connection("connection:fixture-two"),
      connector_id: secondManifest.id,
      display_name: "Second fixture source",
    });
    await runtime.registerConnection(secondConnection);
    const secondCandidate = candidate("shared-source", {
      connector: secondManifest.id,
      connectionId: secondConnection.id,
      value: { title: "Same entity" },
    });
    const secondBatch = CaptureBatchSchema.parse({
      id: "cross-source-b",
      idempotency_key: "batch-key:cross-source-b",
      connector: { id: secondManifest.id, version: secondManifest.version },
      connection_id: secondConnection.id,
      delivery: "push",
      sequence: 1,
      candidates: [secondCandidate],
      created_at: "2026-07-26T12:00:02.000Z",
      metadata: {},
    });
    const second = await runtime.submitBatch(secondBatch);
    assert.equal(first.receipts[0]?.status, "stored");
    assert.equal(second.receipts[0]?.status, "stored");
    if (first.receipts[0]?.status === "stored" && second.receipts[0]?.status === "stored") {
      assert.notEqual(second.receipts[0].view_id, first.receipts[0].view_id);
    }
    assert.equal((await repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 2);
  } finally {
    repository.close();
  }
});

test("stable source state advances immutable revisions with one source identity", async () => {
  const { runtime, repository } = await setup();
  try {
    const first = await runtime.submitBatch(batch("stable-1", "pull", [candidate("repository:metaflow", {
      identity: "stable_source",
      value: { stars: 1 },
    })]));
    const secondCandidate = candidate("repository:metaflow", { identity: "stable_source", value: { stars: 2 } });
    secondCandidate.idempotency_key = "fixture-connector:repository:metaflow:state-2";
    const second = await runtime.submitBatch(batch("stable-2", "pull", [secondCandidate]));
    assert.equal(first.receipts[0]?.status, "stored");
    assert.equal(second.receipts[0]?.status, "stored");
    if (first.receipts[0]?.status === "stored" && second.receipts[0]?.status === "stored") {
      assert.equal(second.receipts[0].view_id, first.receipts[0].view_id);
      assert.equal(second.receipts[0].revision, 2);
      assert.ok((await repository.get({ view_id: first.receipts[0].view_id, revision: 1 })));
    }
  } finally {
    repository.close();
  }
});

test("rejected batch rolls back every View and checkpoint then enters a queryable dead letter", async () => {
  const { runtime, repository } = await setup();
  try {
    const invalid = candidate("invalid-relation", {
      relations: [{ type: "references", target: { view_id: "view:missing", revision: 1 }, metadata: {} }],
    });
    await assert.rejects(runtime.submitBatch(batch("rollback", "push", [candidate("would-have-committed"), invalid])));
    assert.equal((await repository.query({ role: "raw", revisions: "all", limit: 20 })).length, 0);
    assert.equal((await repository.getCaptureCheckpoint("connection:fixture"))?.revision, 0);
    const deadLetters = await repository.listCaptureDeadLetters("connection:fixture", "pending");
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]?.batch.id, "rollback");
    assert.equal((await runtime.health("connection:fixture")).status, "unhealthy");
  } finally {
    repository.close();
  }
});

test("retry is explicit, exhaustion is durable, and provider secrets never reach trace or dead letter", async () => {
  const base = new SqliteViewRepository(":memory:");
  const admissionEvents: CaptureEvent[] = [];
  let remainingFailures = 2;
  const repository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "commitCaptureBatch") {
        return async (...args: Parameters<SqliteViewRepository["commitCaptureBatch"]>) => {
          if (remainingFailures-- > 0) {
            throw new ViewRepositoryError(
              "storage failed with access_token=provider-secret",
              "storage_failure",
              { operation: "capture_commit_batch", phase: "forced_test_failure" },
            );
          }
          return target.commitCaptureBatch(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { runtime } = await setup(repository, event => { admissionEvents.push(event); });
  try {
    const recovered = await runtime.submitBatch(batch("retry-success", "push", [candidate("retry-success")]));
    assert.equal(recovered.receipts[0]?.status, "stored");
    let trace = await repository.getCaptureTrace("connection:fixture");
    assert.equal(trace.filter(event => event.type === "capture.retry_scheduled").length, 2);

    remainingFailures = Number.POSITIVE_INFINITY;
    await assert.rejects(
      runtime.submitBatch(batch("retry-exhausted", "push", [candidate("retry-exhausted")])),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "storage_failure",
    );
    const deadLetters = await repository.listCaptureDeadLetters("connection:fixture", "pending");
    assert.equal(deadLetters.length, 1);
    trace = await repository.getCaptureTrace("connection:fixture");
    assert.doesNotMatch(JSON.stringify({ trace, deadLetters, admissionEvents }), /provider-secret|access_token/);
    assert.equal(trace.filter(event => event.type === "capture.dead_lettered").length, 1);

    remainingFailures = 0;
    const replay = await runtime.replayDeadLetter(deadLetters[0]!.id);
    assert.equal(replay.receipts[0]?.status, "stored");
    assert.equal((await repository.getCaptureDeadLetter(deadLetters[0]!.id))?.status, "resolved");
    assert.ok((await repository.getCaptureTrace("connection:fixture")).some(event => event.type === "capture.dead_letter_replayed"));
  } finally {
    base.close();
  }
});

test("stale checkpoints, pause, and backpressure fail explicitly without partial admission", async () => {
  const { runtime, connector, repository } = await setup();
  try {
    await runtime.submitBatch(batch("checkpoint-base", "push", [candidate("checkpoint-base")]));
    await assert.rejects(
      runtime.submitBatch(batch("checkpoint-stale", "pull", [candidate("checkpoint-stale")], {
        checkpoint: { expected_revision: 0, previous: {}, next: { cursor: "stale" } },
      })),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "checkpoint_conflict",
    );
    await assert.rejects(
      runtime.submitBatch(batch("checkpoint-cursor-mismatch", "pull", [candidate("checkpoint-cursor-mismatch")], {
        checkpoint: { expected_revision: 1, previous: { wrong: true }, next: { cursor: "next" } },
      })),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "checkpoint_conflict",
    );
    await runtime.pause("connection:fixture");
    await assert.rejects(
      runtime.submitBatch(batch("paused", "push", [candidate("paused")])),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "connection_paused",
    );
    await assert.rejects(
      runtime.run("connection:fixture", "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "connection_paused",
    );
    assert.equal(connector.healthChecks, 0);
    assert.equal((await repository.listCaptureDeadLetters("connection:fixture")).length, 2);
    await runtime.resume("connection:fixture");
    const held = batch("held", "push", [candidate("held")]);
    await repository.beginCaptureAttempt({ connection_id: "connection:fixture", batch: held, attempt: 1, max_in_flight: 1, occurred_at: "2026-07-26T12:10:00.000Z" });
    await assert.rejects(
      runtime.submitBatch(batch("backpressure", "push", [candidate("backpressure")])),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "backpressure",
    );
    assert.equal((await repository.listCaptureDeadLetters("connection:fixture")).length, 2);
    const trace = await repository.getCaptureTrace("connection:fixture");
    assert.ok(trace.some(event => event.batch_id === "backpressure"
      && event.type === "capture.attempt_failed"
      && event.payload.attempt_started === false));
    assert.equal((await repository.query({ schema_name: "capture.fixture.item", role: "raw", revisions: "all", limit: 20 })).length, 1);
  } finally {
    repository.close();
  }
});

test("connector health failures are structured and redact untrusted provider messages", async () => {
  const { runtime, connector, repository } = await setup();
  try {
    connector.healthFailure = new ConnectorProtocolError("request leaked api_key=provider-secret", { token: "provider-secret" });
    await assert.rejects(
      runtime.run("connection:fixture", "pull"),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "connector_protocol_error",
    );
    const health = await runtime.health("connection:fixture");
    assert.equal(health.status, "degraded");
    const trace = await repository.getCaptureTrace("connection:fixture");
    assert.doesNotMatch(JSON.stringify({ health, trace }), /provider-secret|api_key/);
  } finally {
    repository.close();
  }
});

test("restart recovery clears abandoned in-flight state and preserves checkpoint and trace", async () => {
  const temp = tempDatabase();
  let repository = new SqliteViewRepository(temp.path);
  try {
    const initial = await setup(repository);
    const abandoned = batch("abandoned", "stream", [candidate("abandoned")]);
    await repository.beginCaptureAttempt({
      connection_id: "connection:fixture",
      batch: abandoned,
      attempt: 1,
      max_in_flight: 1,
      occurred_at: "2026-07-26T12:20:00.000Z",
    });
    repository.close();

    repository = new SqliteViewRepository(temp.path);
    const resumed = await setup(repository);
    assert.equal((await resumed.runtime.health("connection:fixture")).status, "degraded");
    const trace = await repository.getCaptureTrace("connection:fixture");
    assert.ok(trace.some(event => event.type === "connection.recovered"));
    const admitted = await resumed.runtime.submitBatch(batch("after-restart", "push", [candidate("after-restart")]));
    assert.equal(admitted.receipts[0]?.status, "stored");
    assert.equal((await repository.getCaptureCheckpoint("connection:fixture"))?.revision, 1);
    void initial;
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

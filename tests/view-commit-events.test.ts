import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivacyForgetService,
  ViewCommittedDispatchError,
  ViewCommittedEventValidationError,
  ViewCommittedOutboxDispatcher,
  ViewCommittedOutboxError,
  ViewRepositoryError,
  exactViewRef,
  parseViewDraft,
  parseViewCommittedEvent,
  publishViewCommittedEvent,
  type ViewCommittedEvent,
  type ViewCommittedEventPublisher,
  type ViewDraft,
} from "@info/view";
import { SqliteViewRepository } from "@info/storage-sqlite";

const committedAt = "2026-07-26T04:45:00.000Z";

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    event_id: "view-commit:event:1",
    event_type: "view.committed",
    event_version: 1,
    batch_id: "view-commit:batch:1",
    transaction_id: "sqlite:transaction:1",
    committed_at: committedAt,
    origin: { kind: "capture", id: "browser-batch:1" },
    views: [
      {
        ref: { view_id: "view:browser:page:1", revision: 3 },
        role: "raw",
        schema: { name: "capture.browser.page", version: 1, mode: "strict" },
        retention: "normal",
      },
      {
        ref: { view_id: "view:browser:selection:1", revision: 1 },
        role: "raw",
        schema: { name: "capture.browser.selection", version: 1, mode: "strict" },
        retention: "archive",
      },
    ],
    ...overrides,
  };
}

test("ViewCommitted freezes exact revisions and policy-safe commit identity", () => {
  const parsed = parseViewCommittedEvent(event());
  assert.equal(parsed.event_id, "view-commit:event:1");
  assert.equal(parsed.batch_id, "view-commit:batch:1");
  assert.equal(parsed.transaction_id, "sqlite:transaction:1");
  assert.deepEqual(parsed.views.map(item => item.ref), [
    { view_id: "view:browser:page:1", revision: 3 },
    { view_id: "view:browser:selection:1", revision: 1 },
  ]);
  assert.deepEqual(Object.keys(parsed.views[0]!).sort(), ["ref", "retention", "role", "schema"]);
  assert.deepEqual(parseViewCommittedEvent(parsed), parsed, "redelivery must retain one stable event identity");
});

test("ViewCommitted rejects policy, Representation, and other undeclared payload data", () => {
  const input = event() as Record<string, unknown>;
  const views = input.views as Array<Record<string, unknown>>;
  views[0] = {
    ...views[0],
    representation: { form: "inline", value: "secret page text" },
    policy: { owner: "user:test", privacy: "sensitive" },
  };
  assert.throws(
    () => parseViewCommittedEvent(input),
    (error: unknown) => error instanceof ViewCommittedEventValidationError
      && error.issues.some(issue => issue.code === "unrecognized_keys"),
  );
});

for (const retention of ["do_not_store", "session"] as const) {
  test(`ViewCommitted rejects ${retention} Views from durable publication`, () => {
    const input = event() as Record<string, unknown>;
    const views = input.views as Array<Record<string, unknown>>;
    views[0] = { ...views[0], retention };
    assert.throws(
      () => parseViewCommittedEvent(input),
      (error: unknown) => error instanceof ViewCommittedEventValidationError
        && error.issues.some(issue => issue.path.join(".") === "views.0.retention"),
    );
  });
}

test("ViewCommitted rejects duplicate exact revisions inside one commit batch", () => {
  const input = event() as Record<string, unknown>;
  const views = input.views as Array<Record<string, unknown>>;
  input.views = [views[0], views[0]];
  assert.throws(
    () => parseViewCommittedEvent(input),
    (error: unknown) => error instanceof ViewCommittedEventValidationError
      && error.issues.some(issue => issue.message.includes("duplicate exact View revisions")),
  );
});

test("publication validates first and propagates publisher failure without fallback", async () => {
  const delivered: ViewCommittedEvent[] = [];
  const publisher: ViewCommittedEventPublisher = {
    async publish(value) {
      delivered.push(value);
    },
  };
  await publishViewCommittedEvent(publisher, event());
  assert.equal(delivered.length, 1);

  const failure = new Error("queue unavailable");
  await assert.rejects(
    publishViewCommittedEvent({ async publish() { throw failure; } }, event()),
    (error: unknown) => error === failure,
  );
  assert.throws(
    () => parseViewCommittedEvent(event({ event_type: "capture.completed" })),
    ViewCommittedEventValidationError,
  );
});

test("SQLite atomically stores one ordered event for each newly created commit batch", async () => {
  await withOutbox(async repository => {
    const singleDraft = viewDraft("view:outbox:single");
    const single = await repository.commit({
      draft: singleDraft,
      expected_revision: 0,
      idempotency_key: "outbox:single",
    }, {
      batch_id: "batch:single",
      committed_at: "2026-07-26T05:00:00.000Z",
      origin: { kind: "operation", id: "request:single" },
    });
    let entries = await repository.listEvents();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.sequence, 1);
    assert.equal(entries[0]?.event.transaction_id, single.transaction_id);
    assert.equal(entries[0]?.event.batch_id, "batch:single");
    assert.deepEqual(entries[0]?.event.views.map(item => item.ref), [exactViewRef(single.view)]);
    assert.equal((await repository.getMaterializations(exactViewRef(single.view))).length, 1);

    const source = viewDraft("view:outbox:source");
    const derived = viewDraft("view:outbox:derived", {
      provenance: {
        inputs: [{ view_id: source.id, revision: 1 }],
        actor: "operator:test",
        operator_run_id: "run:outbox:batch",
      },
      relations: [{ type: "derived_from", target: { view_id: source.id, revision: 1 } }],
    });
    const batch = await repository.commitBatch([
      { draft: derived, expected_revision: 0, idempotency_key: "outbox:derived" },
      { draft: source, expected_revision: 0, idempotency_key: "outbox:source" },
    ], {
      batch_id: "batch:atomic",
      committed_at: "2026-07-26T05:01:00.000Z",
      origin: { kind: "execution", id: "run:outbox:batch" },
    });
    entries = await repository.listEvents();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(item => item.sequence), [1, 2]);
    assert.equal(entries[1]?.event.transaction_id, batch.transaction_id);
    assert.deepEqual(entries[1]?.event.views.map(item => item.ref), batch.results.map(item => exactViewRef(item.view)));
    assert.equal((await repository.traverseRelations({ ref: exactViewRef(batch.results[0]!.view) })).length, 1);

    const replay = await repository.commit({
      draft: singleDraft,
      expected_revision: 0,
      idempotency_key: "outbox:single",
    }, {
      batch_id: "batch:single:replay-attempt",
      committed_at: "2026-07-26T05:02:00.000Z",
      origin: { kind: "operation", id: "request:single:retry" },
    });
    assert.equal(replay.created, false);
    assert.equal((await repository.listEvents()).length, 2, "exact replay must not enqueue another event");

    const mixedNew = viewDraft("view:outbox:mixed-new");
    await repository.commitBatch([
      { draft: singleDraft, expected_revision: 0, idempotency_key: "outbox:single" },
      { draft: mixedNew, expected_revision: 0, idempotency_key: "outbox:mixed-new" },
    ], {
      batch_id: "batch:mixed",
      committed_at: "2026-07-26T05:03:00.000Z",
      origin: { kind: "system", id: "mixed-replay-test" },
    });
    entries = await repository.listEvents();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[2]?.event.views.map(item => item.ref), [{ view_id: mixedNew.id, revision: 1 }]);

    const rollback = viewDraft("view:outbox:rollback", {
      provenance: {
        inputs: [{ view_id: "view:missing", revision: 1 }],
        actor: "operator:test",
        operator_run_id: "run:outbox:rollback",
      },
    });
    await assert.rejects(
      repository.commitBatch([
        { draft: viewDraft("view:outbox:would-have-committed"), expected_revision: 0 },
        { draft: rollback, expected_revision: 0 },
      ]),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "referential_integrity",
    );
    assert.equal(await repository.getLatest("view:outbox:would-have-committed"), undefined);
    assert.equal((await repository.listEvents()).length, 3, "rolled-back batches must not enqueue an event");

    await assert.rejects(
      repository.commit({ draft: singleDraft, expected_revision: 0 }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "conflict",
    );
    assert.equal((await repository.listEvents()).length, 3, "conflicts must not enqueue an event");
  });
});

test("leases preserve order, survive restart, and redeliver one stable event identity after expiry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-outbox-restart-"));
  const database = join(directory, "views.sqlite");
  const repositoryOptions = { now: () => "2026-07-26T06:00:00.000Z" };
  let repository = new SqliteViewRepository(database, repositoryOptions);
  let eventIds: string[] = [];
  try {
    await repository.commit({ draft: viewDraft("view:outbox:restart:1"), expected_revision: 0 });
    await repository.commit({ draft: viewDraft("view:outbox:restart:2"), expected_revision: 0 });
    eventIds = (await repository.listEvents()).map(item => item.event.event_id);
    const firstLease = await repository.leaseEvents({
      consumer_id: "consumer:restart",
      leased_at: "2026-07-26T06:00:00.000Z",
      lease_duration_ms: 1_000,
      limit: 10,
    });
    assert.deepEqual(firstLease.map(item => item.sequence), [1, 2]);
    assert.deepEqual(firstLease.map(item => item.delivery_attempts), [1, 1]);
    repository.close();

    repository = new SqliteViewRepository(database, repositoryOptions);
    assert.deepEqual(await repository.leaseEvents({
      consumer_id: "consumer:restart",
      leased_at: "2026-07-26T06:00:00.999Z",
      lease_duration_ms: 1_000,
      limit: 10,
    }), []);
    const recovered = await repository.leaseEvents({
      consumer_id: "consumer:restart",
      leased_at: "2026-07-26T06:00:01.000Z",
      lease_duration_ms: 1_000,
      limit: 10,
    });
    assert.deepEqual(recovered.map(item => item.event.event_id), eventIds);
    assert.deepEqual(recovered.map(item => item.delivery_attempts), [2, 2]);

    const acknowledged = await repository.acknowledgeEvent({
      event_id: eventIds[0]!,
      consumer_id: "consumer:restart",
      acknowledged_at: "2026-07-26T06:00:01.500Z",
    });
    assert.equal(acknowledged.status, "acknowledged");
    assert.deepEqual(await repository.acknowledgeEvent({
      event_id: eventIds[0]!,
      consumer_id: "consumer:restart",
      acknowledged_at: "2026-07-26T06:00:01.600Z",
    }), acknowledged, "acknowledgement replay must be idempotent");

    const pending = await repository.failEvent({
      event_id: eventIds[1]!,
      consumer_id: "consumer:restart",
      failed_at: "2026-07-26T06:00:01.500Z",
      failure: { code: "queue_unavailable", message: "queue unavailable" },
      retry_at: "2026-07-26T06:00:02.000Z",
    });
    assert.equal(pending.status, "pending");
    const retried = await repository.leaseEvents({
      consumer_id: "consumer:restart",
      leased_at: "2026-07-26T06:00:02.000Z",
      lease_duration_ms: 1_000,
      limit: 10,
    });
    assert.equal(retried[0]?.event.event_id, eventIds[1]);
    assert.equal(retried[0]?.delivery_attempts, 3);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publisher failure becomes observable poison and explicit replay keeps the same event id", async () => {
  await withOutbox(async repository => {
    await repository.commit({ draft: viewDraft("view:outbox:poison"), expected_revision: 0 });
    const eventId = (await repository.listEvents())[0]!.event.event_id;
    const failedDispatcher = new ViewCommittedOutboxDispatcher({
      outbox: repository,
      publisher: { async publish() { throw new Error("injected publisher failure"); } },
      consumer_id: "consumer:poison",
      max_delivery_attempts: 1,
      now: timestampSequence("2026-07-26T07:00:00.000Z"),
    });
    await assert.rejects(
      failedDispatcher.dispatch(),
      (error: unknown) => error instanceof ViewCommittedDispatchError
        && error.report.poisoned[0] === eventId,
    );
    const poison = await repository.getEvent(eventId);
    assert.equal(poison?.status, "poison");
    assert.equal(poison?.delivery_attempts, 1);
    assert.equal(poison?.last_error?.code, "publisher_failure");

    const replay = await repository.replayEvent({
      event_id: eventId,
      requested_at: "2026-07-26T07:01:00.000Z",
    });
    assert.equal(replay.status, "pending");
    assert.equal(replay.event.event_id, eventId);
    const delivered: string[] = [];
    const successfulDispatcher = new ViewCommittedOutboxDispatcher({
      outbox: repository,
      publisher: { async publish(value) { delivered.push(value.event_id); } },
      consumer_id: "consumer:poison",
      now: timestampSequence("2026-07-26T07:01:00.000Z"),
    });
    assert.deepEqual((await successfulDispatcher.dispatch()).acknowledged, [eventId]);
    assert.deepEqual(delivered, [eventId]);
    assert.equal((await repository.getEvent(eventId))?.status, "acknowledged");
  });
});

test("Privacy Forget removes governed pending commit events before they can be leased", async () => {
  await withOutbox(async repository => {
    const committed = await repository.commit({
      draft: viewDraft("view:outbox:forgotten", {
        policy: { ...policy(), privacy: "sensitive" },
      }),
      expected_revision: 0,
    });
    const eventId = (await repository.listEvents())[0]!.event.event_id;
    const service = new PrivacyForgetService({
      views: repository,
      requests: repository,
      now: timestampSequence("2026-07-26T08:00:00.000Z"),
    });
    const result = await service.request({
      request_id: "forget:outbox:pending",
      actor: "user:test",
      requested_at: "2026-07-26T08:00:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(committed.view) }],
      mixed_source_rule: "purge",
      preauthorization: { kind: "preauthorized_sensitive", policy_id: "policy:forget-outbox" },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(await repository.getEvent(eventId), undefined);
    assert.deepEqual(await repository.leaseEvents({
      consumer_id: "consumer:privacy",
      leased_at: "2026-07-26T08:01:00.000Z",
      lease_duration_ms: 1_000,
      limit: 10,
    }), []);
    await assert.rejects(
      repository.replayEvent({ event_id: eventId, requested_at: "2026-07-26T08:01:00.000Z" }),
      (error: unknown) => error instanceof ViewCommittedOutboxError && error.code === "not_found",
    );
  });
});

function viewDraft(id: string, overrides: Partial<ViewDraft> = {}): ViewDraft {
  return parseViewDraft({
    id,
    name: id,
    purpose: "Verify the durable View commit outbox",
    schema: { name: "test.view-commit-outbox", version: 1, mode: "freeform" },
    role: "derived",
    time: { created_at: "2026-07-26T05:00:00.000Z" },
    representation: { form: "inline", kind: "test_record", value: { id } },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    relations: [],
    provenance: { inputs: [], actor: "test:view-commit-outbox" },
    policy: policy(),
    ...overrides,
  });
}

function policy() {
  return {
    owner: "user:test",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

function timestampSequence(start: string): () => string {
  let offset = 0;
  return () => new Date(Date.parse(start) + offset++ * 100).toISOString();
}

async function withOutbox(run: (repository: SqliteViewRepository) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-outbox-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"), { now: () => committedAt });
  try {
    await run(repository);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

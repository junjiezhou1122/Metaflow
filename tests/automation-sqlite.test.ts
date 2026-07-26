import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTriggerOccurrence,
  parseAutomationDefinition,
  parseTriggerSignal,
  type AutomationDeliveryLedgerEntry,
} from "../packages/automation/index.ts";
import {
  AutomationDeliveryLedgerError,
  SqliteAutomationDeliveryLedger,
  AutomationOccurrenceRepositoryError,
  SqliteAutomationOccurrenceRepository,
} from "../packages/adapters/automation-sqlite/index.ts";

function withRepository(fn: (repository: SqliteAutomationOccurrenceRepository, dbPath: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-sqlite-"));
  const dbPath = join(directory, "automation.sqlite");
  const repository = new SqliteAutomationOccurrenceRepository(dbPath);
  return fn(repository, dbPath).finally(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function occurrence(signalId: string, idempotencyKey: string) {
  const definition = parseAutomationDefinition({
    version: 1,
    trigger: { id: "github-summary", kind: "event", source: "browser", event: "page" },
    target: { kind: "operation", name: "summary.page", version: 1 },
  });
  const signal = parseTriggerSignal({
    id: signalId,
    kind: "event",
    source: "browser",
    event: "page",
    occurred_at: "2026-07-26T10:00:00.000Z",
    idempotency_key: idempotencyKey,
  });
  return createTriggerOccurrence({
    automation: { view_id: "automation:github-summary", revision: 1 },
    definition,
    signal,
  });
}

test("SQLite occurrence reservation is atomic, durable, and replay-idempotent", () => withRepository(async (repository, dbPath) => {
  const firstOccurrence = occurrence("signal:1", "source:1");
  const input = {
    idempotency_key: firstOccurrence.idempotency_key,
    correlation_id: firstOccurrence.id,
    occurrence: firstOccurrence,
    reserved_at: "2026-07-26T10:00:00.000Z",
    limits: { cooldown_ms: 0, max_concurrency: 1 },
  };
  assert.deepEqual(await repository.reserve(input), { created: true });
  await repository.finalize({
    idempotency_key: input.idempotency_key,
    correlation_id: input.correlation_id,
    status: "succeeded",
    run_id: "run:1",
  });
  repository.close();

  const reopened = new SqliteAutomationOccurrenceRepository(dbPath);
  try {
    assert.deepEqual(await reopened.reserve(input), {
      created: false,
      reason: "duplicate",
      correlation_id: firstOccurrence.id,
      status: "succeeded",
    });
    assert.equal(reopened.inspect(input.idempotency_key)?.run_id, "run:1");
  } finally {
    reopened.close();
  }
}));

test("SQLite reservation enforces cooldown and max concurrency separately", () => withRepository(async repository => {
  const first = occurrence("signal:1", "source:1");
  assert.deepEqual(await repository.reserve({
    idempotency_key: first.idempotency_key,
    correlation_id: first.id,
    occurrence: first,
    reserved_at: "2026-07-26T10:00:00.000Z",
    limits: { cooldown_ms: 60000, max_concurrency: 2 },
  }), { created: true });

  const cooling = occurrence("signal:2", "source:2");
  assert.deepEqual(await repository.reserve({
    idempotency_key: cooling.idempotency_key,
    correlation_id: cooling.id,
    occurrence: cooling,
    reserved_at: "2026-07-26T10:00:30.000Z",
    limits: { cooldown_ms: 60000, max_concurrency: 2 },
  }), {
    created: false,
    reason: "cooldown",
    correlation_id: first.id,
    status: "reserved",
  });

  const concurrent = occurrence("signal:3", "source:3");
  assert.deepEqual(await repository.reserve({
    idempotency_key: concurrent.idempotency_key,
    correlation_id: concurrent.id,
    occurrence: concurrent,
    reserved_at: "2026-07-26T10:01:01.000Z",
    limits: { cooldown_ms: 0, max_concurrency: 1 },
  }), {
    created: false,
    reason: "concurrency",
    correlation_id: first.id,
    status: "reserved",
  });
}));

test("SQLite finalization is idempotent only for the exact final state", () => withRepository(async repository => {
  const item = occurrence("signal:1", "source:1");
  await repository.reserve({
    idempotency_key: item.idempotency_key,
    correlation_id: item.id,
    occurrence: item,
    reserved_at: "2026-07-26T10:00:00.000Z",
    limits: { cooldown_ms: 0, max_concurrency: 1 },
  });
  const final = {
    idempotency_key: item.idempotency_key,
    correlation_id: item.id,
    status: "failed" as const,
    run_id: "run:failed",
    error: "schema rejected",
  };
  await repository.finalize(final);
  await repository.finalize(final);
  await assert.rejects(
    repository.finalize({ ...final, status: "succeeded", error: undefined }),
    (error: unknown) => error instanceof AutomationOccurrenceRepositoryError && error.code === "conflict",
  );
}));

test("expired occurrence lease is recovered and changed evidence never aliases to the old reservation", () => withRepository(async repository => {
  const item = occurrence("signal:lease", "source:lease");
  const input = {
    idempotency_key: item.idempotency_key,
    correlation_id: item.id,
    occurrence: item,
    reserved_at: "2026-07-26T10:00:00.000Z",
    attempt_id: "attempt:lease",
    lease_duration_ms: 1_000,
    limits: { cooldown_ms: 0, max_concurrency: 1 },
  };
  assert.deepEqual(await repository.reserve(input), { created: true });
  assert.deepEqual(await repository.reserve({ ...input, reserved_at: "2026-07-26T10:00:00.999Z" }), {
    created: false,
    reason: "duplicate",
    correlation_id: item.id,
    status: "reserved",
  });
  assert.deepEqual(await repository.reserve({ ...input, reserved_at: "2026-07-26T10:00:01.001Z" }), {
    created: true,
    recovered: true,
  });

  const changed = occurrence("signal:changed", "source:changed");
  await assert.rejects(repository.reserve({
    ...input,
    occurrence: changed,
    reserved_at: "2026-07-26T10:00:02.500Z",
  }), (error: unknown) => (
    error instanceof AutomationOccurrenceRepositoryError && error.code === "conflict"
  ));
}));

test("SQLite Delivery ledger replays exact attempts and rejects request or delivery id conflicts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-delivery-ledger-"));
  const ledger = new SqliteAutomationDeliveryLedger(join(directory, "automation.sqlite"));
  const entry: AutomationDeliveryLedgerEntry = {
    request: {
      id: "delivery-request:1",
      correlation_id: "occurrence:1",
      phase: "result",
      surface: "notch",
      urgency: "glance",
      replacement: "replace",
      actions: ["accept"],
      automation: { view_id: "automation:test", revision: 1 },
      occurrence_id: "occurrence:1",
      run_id: "run:1",
      views: [{ view_id: "result:test", revision: 1 }],
    },
    result: { status: "delivered", delivery_id: "notch:1" },
    recorded_at: "2026-07-26T10:00:00.000Z",
  };
  try {
    await ledger.record(entry);
    await ledger.record({ ...entry, recorded_at: "2026-07-26T10:00:01.000Z" });
    assert.deepEqual(await ledger.findByRequestId(entry.request.id), entry);
    assert.deepEqual(await ledger.findByDeliveryId("notch:1"), entry);
    await assert.rejects(
      ledger.record({ ...entry, result: { status: "failed", error: "renderer failed" } }),
      (error: unknown) => error instanceof AutomationDeliveryLedgerError && error.code === "conflict",
    );
    await assert.rejects(
      ledger.record({
        ...entry,
        request: { ...entry.request, id: "delivery-request:2" },
      }),
      (error: unknown) => error instanceof AutomationDeliveryLedgerError && error.code === "conflict",
    );
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

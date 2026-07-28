import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  ViewRepositoryError,
  exactViewRef,
  parseViewDraft,
  type View,
  type ViewDraft,
} from "@info/view";

const createdAt = "2026-07-26T12:00:00.000Z";

function tempDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-store-"));
  return { directory, path: join(directory, "views.sqlite") };
}

function derivedDraft(id: string, overrides: Record<string, unknown> = {}): ViewDraft {
  return parseViewDraft({
    id,
    name: `View ${id}`,
    purpose: "Exercise the durable View Store contract",
    schema: {
      name: "test.view-store",
      version: 1,
      mode: "freeform",
      search_projection: {
        version: 1,
        fields: [
          { path: "/name", category: "title" },
          { path: "/representation/value/text", category: "text" },
        ],
      },
    },
    role: "derived",
    time: { created_at: createdAt },
    representation: { form: "inline", kind: "document", value: { text: id } },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    provenance: { inputs: [], actor: "test:view-store" },
    policy: policy(),
    ...overrides,
  });
}

function rawDraft(input: {
  id: string;
  connector: string;
  sourceId: string;
  identity: "stable_source" | "occurrence";
  state?: number;
  traceId?: string;
  capturedAt?: string;
  observedAt?: string;
  relations?: ViewDraft["relations"];
}): ViewDraft {
  return parseViewDraft({
    id: input.id,
    name: `Raw ${input.sourceId}`,
    purpose: input.identity === "stable_source"
      ? "Preserve the latest observed state of one stable source object"
      : "Preserve one source occurrence",
    schema: { name: `capture.${input.connector}.test`, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: input.observedAt ?? createdAt, created_at: input.capturedAt ?? createdAt },
    representation: {
      form: "inline",
      kind: "source_record",
      value: { state: input.state ?? 1 },
    },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    relations: input.relations ?? [],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      trace_id: input.traceId ?? "trace:first",
      capture: {
        connector: input.connector,
        connection_id: `${input.connector}:default`,
        source_id: input.sourceId,
        source_kind: "test",
        identity: input.identity,
        assertion: "direct",
      },
    },
    policy: policy(),
  });
}

function policy(retention: "do_not_store" | "session" | "normal" | "archive" = "normal") {
  return {
    owner: "user:test",
    visibility: "private" as const,
    privacy: "private" as const,
    retention,
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

test("View Store exposes exact/latest lookup, search, relations, Representation, and Materializations", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  try {
    const source = await repository.commit({
      draft: rawDraft({ id: "view:raw:source", connector: "browser", sourceId: "visit:1", identity: "occurrence" }),
      expected_revision: 0,
      idempotency_key: "browser:visit:1",
    });
    const derived = await repository.commit({
      draft: derivedDraft("view:derived:summary", {
        representation: { form: "inline", kind: "markdown", value: { text: "# Searchable Metaflow summary" } },
        provenance: { inputs: [exactViewRef(source.view)], actor: "operator:summary", operator_run_id: "run:1" },
        relations: [{ type: "summarizes", target: exactViewRef(source.view), metadata: { confidence: 0.9 } }],
        materialization: {
          primary: {
            id: "canonical-json",
            format: "json",
            media_type: "application/json",
            location: { kind: "inline" },
          },
          alternatives: [{
            id: "markdown-file",
            format: "markdown",
            media_type: "text/markdown",
            location: { kind: "uri", uri: "file:///tmp/summary.md" },
          }],
        },
      }),
      expected_revision: 0,
    });

    assert.deepEqual(await repository.resolveLatest(derived.view.id), exactViewRef(derived.view));
    assert.equal((await repository.get(exactViewRef(derived.view)))?.revision, 1);
    assert.equal((await repository.getLatest(derived.view.id))?.id, derived.view.id);
    assert.equal((await repository.getRepresentation(exactViewRef(derived.view)))?.kind, "markdown");
    assert.deepEqual((await repository.query({ text: "Searchable Metaflow", limit: 10 })).map(view => view.id), [derived.view.id]);

    const outgoing = await repository.traverseRelations({
      ref: exactViewRef(derived.view),
      direction: "outgoing",
      type: "summarizes",
    });
    const incoming = await repository.traverseRelations({ ref: exactViewRef(source.view), direction: "incoming" });
    assert.equal(outgoing.length, 1);
    assert.deepEqual(outgoing[0]?.target, exactViewRef(source.view));
    assert.equal(incoming[0]?.id, outgoing[0]?.id);

    const materializations = await repository.getMaterializations(exactViewRef(derived.view));
    assert.deepEqual(materializations.map(item => [item.role, item.materialization.id, item.generation]), [
      ["primary", "canonical-json", 1],
      ["alternative", "markdown-file", 1],
    ]);
    assert.ok(derived.transaction_id);
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("commitBatch atomically admits forward exact references and rolls back a later storage failure", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  try {
    const sourceDraft = rawDraft({
      id: "view:raw:batch-source",
      connector: "browser",
      sourceId: "batch:source",
      identity: "occurrence",
    });
    const derived = derivedDraft("view:derived:batch-summary", {
      provenance: {
        inputs: [{ view_id: sourceDraft.id, revision: 1 }],
        actor: "operator:summary",
        operator_run_id: "run:batch",
      },
      relations: [{ type: "derived_from", target: { view_id: sourceDraft.id, revision: 1 } }],
    });
    const batch = await repository.commitBatch([
      { draft: derived, expected_revision: 0 },
      { draft: sourceDraft, expected_revision: 0, idempotency_key: "browser:batch:source" },
    ]);
    assert.deepEqual(batch.results.map(result => result.view.id), [derived.id, sourceDraft.id]);
    assert.equal((await repository.get({ view_id: sourceDraft.id, revision: 1 }))?.id, sourceDraft.id);

    const rollbackSource = derivedDraft("view:rollback:first");
    const storageFailure = derivedDraft("view:rollback:second");
    const faultDb = new DatabaseSync(temp.path);
    faultDb.exec(`
      create trigger reject_second_rollback_view
      before insert on view_revisions_v1
      when new.id = 'view:rollback:second'
      begin
        select raise(abort, 'injected rollback failure');
      end;
    `);
    faultDb.close();
    await assert.rejects(
      repository.commitBatch([
        { draft: rollbackSource, expected_revision: 0 },
        { draft: storageFailure, expected_revision: 0 },
      ]),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "storage_failure"
        && error.details.phase === "persist"
        && Boolean(error.details.transaction_id),
    );
    assert.equal(await repository.getLatest(rollbackSource.id), undefined);
    assert.equal(await repository.getLatest(storageFailure.id), undefined);
    assert.deepEqual(await repository.query({ text: "rollback first" }), []);
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("compare-and-swap serializes real concurrent writers without partial revisions", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  let repositoryClosed = false;
  try {
    const initial = await repository.commit({ draft: derivedDraft("view:concurrent"), expected_revision: 0 });
    const revisionA = revised(initial.view, { text: "writer A" });
    const revisionB = revised(initial.view, { text: "writer B" });
    repository.close();
    repositoryClosed = true;

    const outcomes = await commitFromConcurrentWorkers(temp.path, [revisionA, revisionB]);
    assert.equal(outcomes.filter(item => item.ok).length, 1);
    const rejected = outcomes.find(item => !item.ok);
    assert.equal(rejected?.code, "conflict");
    assert.equal(rejected?.details?.operation, "commit_batch");
    assert.equal(rejected?.details?.phase, "plan");
    assert.ok(rejected?.details?.transaction_id);

    const after = new SqliteViewRepository(temp.path);
    try {
      assert.equal((await after.getLatest(initial.view.id))?.revision, 2);
      assert.deepEqual(
        (await after.query({ revisions: "all" })).filter(view => view.id === initial.view.id).map(view => view.revision).sort(),
        [1, 2],
      );
    } finally {
      after.close();
    }
  } finally {
    if (!repositoryClosed) repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("legacy SQLite upgrades rebuild constraints and normalize empty Materialization metadata", async () => {
  const temp = tempDatabase();
  const draft = derivedDraft("view:legacy:migrated");
  seedLegacyDatabase(temp.path, draft, {});
  const repository = new SqliteViewRepository(temp.path);
  try {
    const migrated = await repository.get({ view_id: draft.id, revision: 1 });
    assert.equal(migrated?.id, draft.id);
    assert.equal("metadata" in (migrated?.materialization.primary ?? {}), false);
    assert.equal((await repository.getMaterializations({ view_id: draft.id, revision: 1 }))[0]?.materialization.id, "canonical-json");
    const snapshot = await repository.getQuerySnapshot();
    assert.equal(snapshot.commit_sequence, 1);
    assert.deepEqual((await repository.query({ snapshot })).map(view => [view.id, view.revision]), [[draft.id, 1]]);
    const replay = await repository.commit({
      draft,
      expected_revision: 0,
      idempotency_key: "legacy:migrated",
    });
    assert.equal(replay.created, false);
  } finally {
    repository.close();
  }

  const db = new DatabaseSync(temp.path, { enableForeignKeyConstraints: true });
  try {
    const fingerprint = (db.prepare("pragma table_info(view_idempotency_v1)").all() as Array<{ name: string; notnull: number }>)
      .find(column => column.name === "request_fingerprint");
    assert.equal(fingerprint?.notnull, 1);
    assert.equal(db.prepare("pragma foreign_key_list(view_heads_v1)").all().length, 2);
    assert.equal(db.prepare("pragma foreign_key_list(view_idempotency_v1)").all().length, 2);
    assert.ok(db.prepare("select name from sqlite_master where type = 'table' and name = 'view_commit_outbox_v1'").get());
    assert.equal((db.prepare("select version from view_store_schema_versions_v1 where component = 'view-store'").get() as { version: number }).version, 9);
    assert.ok(db.prepare("select name from sqlite_master where type = 'table' and name = 'capture_connection_lifecycle_receipts_v1'").get());
    assert.ok(db.prepare("select name from sqlite_master where type = 'table' and name = 'view_revision_commits_v1'").get());
    assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
    assert.throws(
      () => db.prepare(`
        insert into view_idempotency_v1 (idempotency_key, request_fingerprint, view_id, revision, created_at)
        values ('invalid:null-fingerprint', null, ?, 1, ?)
      `).run(draft.id, createdAt),
    );
  } finally {
    db.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v7 SQLite upgrades connector lifecycle invariants instead of trusting a reused version", () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  repository.close();

  const legacy = new DatabaseSync(temp.path, { enableForeignKeyConstraints: false });
  try {
    legacy.exec(`
      drop table capture_connection_lifecycle_receipts_v1;
      alter table capture_connections_v1 drop column generation;
      alter table capture_connections_v1 drop column lifecycle_status;
      alter table capture_connections_v1 drop column created_at;
      update view_store_schema_versions_v1 set version = 7 where component = 'view-store';
    `);
  } finally {
    legacy.close();
  }

  const migrated = new SqliteViewRepository(temp.path);
  migrated.close();

  const db = new DatabaseSync(temp.path, { enableForeignKeyConstraints: true });
  try {
    const columns = db.prepare("pragma table_info(capture_connections_v1)").all() as Array<{ name: string; notnull: number }>;
    for (const name of ["generation", "lifecycle_status", "created_at"]) {
      assert.equal(columns.find(column => column.name === name)?.notnull, 1);
    }
    assert.ok(db.prepare("select name from sqlite_master where type = 'table' and name = 'capture_connection_lifecycle_receipts_v1'").get());
    assert.equal((db.prepare("select version from view_store_schema_versions_v1 where component = 'view-store'").get() as { version: number }).version, 9);
    assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("v8 SQLite upgrades backfill stable View query snapshot sequences", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  const draft = derivedDraft("view:migration:v8-query-snapshot");
  try {
    await repository.commit({ draft, expected_revision: 0 });
  } finally {
    repository.close();
  }
  const legacy = new DatabaseSync(temp.path, { enableForeignKeyConstraints: false });
  try {
    legacy.exec(`
      drop table view_revision_commits_v1;
      drop table view_commit_sequences_v1;
      update view_store_schema_versions_v1 set version = 8 where component = 'view-store';
    `);
  } finally {
    legacy.close();
  }

  const upgraded = new SqliteViewRepository(temp.path);
  try {
    assert.deepEqual(await upgraded.getQuerySnapshot(), { commit_sequence: 1 });
    assert.deepEqual(
      (await upgraded.query({ snapshot: { commit_sequence: 1 } })).map(view => [view.id, view.revision]),
      [[draft.id, 1]],
    );
  } finally {
    upgraded.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("legacy migration rejects lossy Materialization metadata with exact row context", () => {
  const temp = tempDatabase();
  const draft = derivedDraft("view:legacy:unsafe");
  seedLegacyDatabase(temp.path, draft, { provider: "legacy" });
  try {
    assert.throws(
      () => new SqliteViewRepository(temp.path),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "corrupt_data"
        && error.details.phase === "normalize_legacy_views"
        && error.details.table === "view_revisions_v1"
        && error.details.view_ids?.[0] === draft.id
        && error.details.revision === 1
        && Boolean(error.details.transaction_id),
    );
  } finally {
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("idempotency accepts exact replay but rejects conflicting and cross-Connector evidence", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  try {
    const browser = rawDraft({
      id: "view:raw:browser:1",
      connector: "browser",
      sourceId: "same-page",
      identity: "occurrence",
      traceId: "trace:first-attempt",
    });
    const first = await repository.commit({ draft: browser, expected_revision: 0, idempotency_key: "capture:same-key" });
    const replay = await repository.commit({
      draft: rawDraft({
        id: browser.id,
        connector: "browser",
        sourceId: "same-page",
        identity: "occurrence",
        traceId: "trace:replay-attempt",
        capturedAt: "2026-07-26T12:00:05.000Z",
      }),
      expected_revision: 0,
      idempotency_key: "capture:same-key",
    });
    assert.equal(replay.created, false);
    assert.deepEqual(exactViewRef(replay.view), exactViewRef(first.view));

    const screenpipe = rawDraft({
      id: "view:raw:screenpipe:1",
      connector: "screenpipe",
      sourceId: "same-page",
      identity: "occurrence",
    });
    await assert.rejects(
      repository.commit({ draft: screenpipe, expected_revision: 0, idempotency_key: "capture:same-key" }),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "idempotency_conflict"
        && error.details.idempotency_key === "capture:same-key",
    );
    const separate = await repository.commit({
      draft: screenpipe,
      expected_revision: 0,
      idempotency_key: "screenpipe:same-page",
    });
    assert.notEqual(separate.view.id, first.view.id);
    assert.equal((await repository.query({ role: "raw" })).length, 2);
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("one stable Connector source cannot fork into parallel View identities", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  try {
    await repository.commit({
      draft: rawDraft({
        id: "view:stable:canonical",
        connector: "github",
        sourceId: "openai/codex",
        identity: "stable_source",
      }),
      expected_revision: 0,
      idempotency_key: "github:codex:first",
    });
    await assert.rejects(
      repository.commit({
        draft: rawDraft({
          id: "view:stable:parallel",
          connector: "github",
          sourceId: "openai/codex",
          identity: "stable_source",
          state: 2,
        }),
        expected_revision: 0,
        idempotency_key: "github:codex:second",
      }),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "source_identity_conflict"
        && Boolean(error.details.transaction_id),
    );
    assert.equal(await repository.getLatest("view:stable:parallel"), undefined);
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("stable Raw state can advance twice in one atomic batch and remains queryable as history", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  try {
    const first = rawDraft({
      id: "view:raw:stable",
      connector: "github",
      sourceId: "openai/codex",
      identity: "stable_source",
      state: 1,
    });
    const second = rawDraft({
      id: first.id,
      connector: "github",
      sourceId: "openai/codex",
      identity: "stable_source",
      state: 2,
      relations: [{ type: "supersedes", target: { view_id: first.id, revision: 1 } }],
    });
    const batch = await repository.commitBatch([
      { draft: first, expected_revision: 0, idempotency_key: "github:codex:state:1" },
      { draft: second, expected_revision: 1, idempotency_key: "github:codex:state:2" },
    ]);
    assert.deepEqual(batch.results.map(result => result.view.revision), [1, 2]);
    assert.equal((await repository.getLatest(first.id))?.revision, 2);
    assert.deepEqual(
      (await repository.query({ schema_name: "capture.github.test", revisions: "all" })).map(view => view.revision).sort(),
      [1, 2],
    );
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("derived Materialization rebuilds use generation CAS without changing semantic revision", async () => {
  const temp = tempDatabase();
  let repository = new SqliteViewRepository(temp.path);
  try {
    const committed = await repository.commit({ draft: derivedDraft("view:materialized"), expected_revision: 0 });
    const ref = exactViewRef(committed.view);
    const first = await repository.putDerivedMaterialization({
      view: ref,
      expected_generation: 0,
      updated_at: "2026-07-26T12:01:00.000Z",
      materialization: {
        id: "search-index",
        format: "sqlite-fts",
        media_type: "application/x-sqlite3",
        location: { kind: "content_addressed", store: "local-index", key: "summary:g1" },
      },
    });
    const rebuilt = await repository.putDerivedMaterialization({
      view: ref,
      expected_generation: 1,
      updated_at: "2026-07-26T12:02:00.000Z",
      materialization: {
        ...first.materialization,
        location: { kind: "content_addressed", store: "local-index", key: "summary:g2" },
      },
    });
    assert.equal(rebuilt.generation, 2);
    await assert.rejects(
      repository.putDerivedMaterialization({
        view: ref,
        expected_generation: 1,
        updated_at: "2026-07-26T12:03:00.000Z",
        materialization: rebuilt.materialization,
      }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "conflict",
    );
    await assert.rejects(
      repository.putDerivedMaterialization({
        view: ref,
        expected_generation: 1,
        updated_at: "2026-07-26T12:03:00.000Z",
        materialization: committed.view.materialization.primary,
      }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "conflict",
    );
    assert.equal((await repository.get(ref))?.revision, 1);

    repository.close();
    repository = new SqliteViewRepository(temp.path);
    const afterRestart = await repository.getMaterializations(ref);
    assert.equal(afterRestart.find(item => item.materialization.id === "search-index")?.generation, 2);
    assert.equal((await repository.get(ref))?.representation.kind, "document");
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("restart preserves exact replay, relation traversal, and moving heads", async () => {
  const temp = tempDatabase();
  let repository = new SqliteViewRepository(temp.path);
  try {
    const raw = rawDraft({
      id: "view:restart:raw",
      connector: "browser",
      sourceId: "restart:visit",
      identity: "occurrence",
    });
    const source = await repository.commit({
      draft: raw,
      expected_revision: 0,
      idempotency_key: "browser:restart:visit",
    });
    const summary = await repository.commit({
      draft: derivedDraft("view:restart:summary", {
        provenance: { inputs: [exactViewRef(source.view)], actor: "operator:summary", operator_run_id: "run:restart" },
        relations: [{ type: "summarizes", target: exactViewRef(source.view) }],
      }),
      expected_revision: 0,
    });
    repository.close();
    repository = new SqliteViewRepository(temp.path);

    const replay = await repository.commit({
      draft: rawDraft({
        id: raw.id,
        connector: "browser",
        sourceId: "restart:visit",
        identity: "occurrence",
        traceId: "trace:after-restart",
      }),
      expected_revision: 0,
      idempotency_key: "browser:restart:visit",
    });
    assert.equal(replay.created, false);
    assert.deepEqual(exactViewRef(replay.view), exactViewRef(source.view));
    assert.deepEqual(await repository.resolveLatest(summary.view.id), exactViewRef(summary.view));
    assert.equal((await repository.traverseRelations({
      ref: exactViewRef(source.view),
      direction: "incoming",
      type: "summarizes",
    }))[0]?.source.view_id, summary.view.id);
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("dangling exact references, unsupported retention, and empty batches fail closed", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path);
  try {
    await assert.rejects(
      repository.commit({
        draft: derivedDraft("view:dangling", {
          provenance: {
            inputs: [{ view_id: "view:missing", revision: 99 }],
            actor: "operator:test",
            operator_run_id: "run:dangling",
          },
        }),
        expected_revision: 0,
      }),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "referential_integrity"
        && Boolean(error.details.transaction_id),
    );
    assert.equal(await repository.getLatest("view:dangling"), undefined);

    await assert.rejects(
      repository.commit({
        draft: derivedDraft("view:session", { policy: policy("session") }),
        expected_revision: 0,
      }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "policy_violation",
    );
    await assert.rejects(
      repository.commitBatch([]),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "invalid_request",
    );
    await assert.rejects(
      repository.getMaterializations({ view_id: "view:missing", revision: 1 }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "referential_integrity",
    );
    await assert.rejects(
      repository.traverseRelations({ ref: { view_id: "view:missing", revision: 1 } }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "referential_integrity",
    );
    await assert.rejects(
      repository.query({ revisions: "future" as "latest" }),
      (error: unknown) => error instanceof ViewRepositoryError && error.code === "invalid_request",
    );
  } finally {
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("SQLite lock failures expose operation, phase, transaction, and native code", async () => {
  const temp = tempDatabase();
  const repository = new SqliteViewRepository(temp.path, { busy_timeout_ms: 1 });
  const locker = new DatabaseSync(temp.path, { timeout: 1 });
  try {
    locker.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      repository.commit({ draft: derivedDraft("view:locked"), expected_revision: 0 }),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "storage_failure"
        && error.details.operation === "commit_batch"
        && error.details.phase === "begin"
        && Boolean(error.details.transaction_id)
        && typeof error.details.sqlite_code === "string",
    );
    locker.exec("ROLLBACK");
    assert.equal(await repository.getLatest("view:locked"), undefined);
  } finally {
    if (locker.isTransaction) locker.exec("ROLLBACK");
    locker.close();
    repository.close();
    rmSync(temp.directory, { recursive: true, force: true });
  }
});

function revised(previous: View, value: Record<string, unknown>): ViewDraft {
  const { revision: _revision, ...draft } = previous;
  return parseViewDraft({
    ...draft,
    representation: { form: "inline", kind: "document", value },
    relations: [{ type: "supersedes", target: exactViewRef(previous) }],
  });
}

type WorkerOutcome = {
  ok: boolean;
  revision?: number;
  code?: string;
  details?: Record<string, unknown>;
  error?: string;
};

async function commitFromConcurrentWorkers(path: string, drafts: ViewDraft[]): Promise<WorkerOutcome[]> {
  const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerUrl = new URL("./helpers/view-store-writer.ts", import.meta.url);
  // Node does not install --import loaders inside Worker threads (tsx#354).
  // Register tsx inside each Worker before importing the TypeScript entrypoint.
  const bootstrapUrl = new URL("./helpers/tsx-worker-bootstrap.mjs", import.meta.url);
  const workers = drafts.map(draft => new Worker(bootstrapUrl, {
    execArgv: ["--experimental-sqlite"],
    workerData: { path, draft, start, typescript_entry: workerUrl.href },
  }));
  const ready = workers.map(worker => new Promise<void>((resolve, reject) => {
    const onMessage = (message: { type?: string; error?: string }) => {
      if (message.type === "ready") {
        worker.off("message", onMessage);
        resolve();
      } else if (message.type === "fatal") {
        worker.off("message", onMessage);
        reject(new Error(message.error));
      }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  }));
  await Promise.all(ready);
  const outcomes = workers.map(worker => new Promise<WorkerOutcome>((resolve, reject) => {
    worker.on("message", (message: { type?: string; outcome?: WorkerOutcome; error?: string }) => {
      if (message.type === "result" && message.outcome) resolve(message.outcome);
      if (message.type === "fatal") reject(new Error(message.error));
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      reject(new Error(`View Store writer worker exited before returning a result (code ${code})`));
    });
  }));
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0, workers.length);
  return Promise.all(outcomes);
}

function seedLegacyDatabase(path: string, draft: ViewDraft, materializationMetadata: Record<string, unknown>): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      create table view_revisions_v1 (
        id text not null,
        revision integer not null,
        schema_name text not null,
        schema_version integer not null,
        role text not null,
        name text not null,
        created_at text not null,
        view_json text not null,
        primary key (id, revision)
      );
      create table view_heads_v1 (
        id text primary key,
        revision integer not null,
        updated_at text not null
      );
      create table view_idempotency_v1 (
        idempotency_key text primary key,
        request_fingerprint text,
        view_id text not null,
        revision integer not null,
        created_at text not null
      );
      create table view_materializations_v1 (
        view_id text not null,
        revision integer not null,
        materialization_id text not null,
        role text not null,
        generation integer not null,
        updated_at text not null,
        materialization_json text not null,
        primary key (view_id, revision, materialization_id)
      );
    `);
    const legacyView = {
      ...draft,
      revision: 1,
      materialization: {
        ...draft.materialization,
        primary: { ...draft.materialization.primary, metadata: materializationMetadata },
      },
    };
    db.prepare(`
      insert into view_revisions_v1 (
        id, revision, schema_name, schema_version, role, name, created_at, view_json
      ) values (?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.id,
      draft.schema.name,
      draft.schema.version,
      draft.role,
      draft.name,
      draft.time.created_at,
      JSON.stringify(legacyView),
    );
    db.prepare("insert into view_heads_v1 (id, revision, updated_at) values (?, 1, ?)")
      .run(draft.id, draft.time.created_at);
    db.prepare(`
      insert into view_idempotency_v1 (
        idempotency_key, request_fingerprint, view_id, revision, created_at
      ) values ('legacy:migrated', 'legacy-fingerprint-v0', ?, 1, ?)
    `).run(draft.id, draft.time.created_at);
    db.prepare(`
      insert into view_materializations_v1 (
        view_id, revision, materialization_id, role, generation, updated_at, materialization_json
      ) values (?, 1, ?, 'primary', 1, ?, ?)
    `).run(
      draft.id,
      draft.materialization.primary.id,
      draft.time.created_at,
      JSON.stringify({ ...draft.materialization.primary, metadata: materializationMetadata }),
    );
  } finally {
    db.close();
  }
}

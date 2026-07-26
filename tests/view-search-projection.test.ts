import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  ViewRepositoryError,
  parseViewDraft,
  type ViewDraft,
  type ViewPolicy,
  type ViewSearchProjection,
} from "@info/view";

const createdAt = "2026-07-26T12:00:00.000Z";
const searchProjection: ViewSearchProjection = {
  version: 1,
  fields: [
    { path: "/name", category: "title" },
    { path: "/representation/value/body", category: "text" },
    { path: "/representation/value/id", category: "identifier" },
    { path: "/representation/value/url", category: "url" },
    { path: "/time/observed_at", category: "timestamp" },
    { path: "/provenance/capture/source_id", category: "provenance" },
  ],
};

function policy(allowLocalSearch = true): ViewPolicy {
  return {
    owner: "user:test",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: allowLocalSearch,
    labels: [],
  };
}

function rawDraft(input: {
  id: string;
  name?: string;
  body?: string;
  hidden?: string;
  sourceId?: string;
  url?: string;
  allowLocalSearch?: boolean;
  schemaVersion?: number;
  search?: ViewSearchProjection;
  supersedes?: number;
}): ViewDraft {
  return parseViewDraft({
    id: input.id,
    name: input.name ?? input.id,
    purpose: "Verify deterministic View search projection",
    aliases: [],
    schema: {
      name: "capture.test.searchable",
      version: input.schemaVersion ?? 1,
      mode: "freeform",
      search_projection: input.search ?? searchProjection,
    },
    role: "raw",
    time: { observed_at: createdAt, created_at: createdAt },
    representation: {
      form: "inline",
      kind: "test_record",
      value: {
        body: input.body ?? "",
        hidden: input.hidden ?? "",
        id: `record:${input.id}`,
        url: input.url ?? "https://example.com/default",
      },
    },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    relations: input.supersedes === undefined
      ? []
      : [{ type: "supersedes", target: { view_id: input.id, revision: input.supersedes } }],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test-search",
        connection_id: "test-search:default",
        source_id: input.sourceId ?? input.id,
        source_kind: "record",
        identity: "stable_source",
        assertion: "direct",
      },
    },
    policy: policy(input.allowLocalSearch ?? true),
  });
}

async function withRepository(run: (repository: SqliteViewRepository, path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-search-"));
  const path = join(directory, "views.sqlite");
  const repository = new SqliteViewRepository(path);
  try {
    await run(repository, path);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Schema-declared fields alone enter FTS and category weights produce stable ranking", () => withRepository(async repository => {
  await repository.commit({
    draft: rawDraft({ id: "view:body", body: "Metaflow appears in ordinary body text", hidden: "never-index-this" }),
    expected_revision: 0,
  });
  await repository.commit({
    draft: rawDraft({ id: "view:title", name: "Metaflow architecture", body: "ordinary words" }),
    expected_revision: 0,
  });

  assert.deepEqual((await repository.query({ text: "Metaflow" })).map(view => view.id), ["view:title", "view:body"]);
  assert.deepEqual(await repository.query({ text: "never-index-this" }), []);
  assert.deepEqual((await repository.query({ text: "record view:title" })).map(view => view.id), ["view:title"]);
  assert.deepEqual((await repository.query({ text: "https example.com default" })).map(view => view.id).sort(), ["view:body", "view:title"]);
  assert.deepEqual((await repository.query({ text: "view:title" })).map(view => view.id), ["view:title"]);
}));

test("unicode61 search is case/diacritic tolerant and punctuation compiles to safe AND tokens", () => withRepository(async repository => {
  await repository.commit({
    draft: rawDraft({ id: "view:tokenizer", body: "Résumé about MetaFlow graph-based retrieval" }),
    expected_revision: 0,
  });
  assert.deepEqual((await repository.query({ text: "resume" })).map(view => view.id), ["view:tokenizer"]);
  assert.deepEqual((await repository.query({ text: "METAFLOW graph" })).map(view => view.id), ["view:tokenizer"]);
  await assert.rejects(
    repository.query({ text: "---" }),
    (error: unknown) => error instanceof ViewRepositoryError
      && error.code === "invalid_request"
      && error.details.phase === "validate_input",
  );
}));

test("local-search policy exclusion, exact replay, and Schema evolution remain explicit", () => withRepository(async repository => {
  const excluded = rawDraft({ id: "view:excluded", body: "policy forbidden phrase", allowLocalSearch: false });
  await repository.commit({ draft: excluded, expected_revision: 0, idempotency_key: "search:excluded" });
  const replay = await repository.commit({ draft: excluded, expected_revision: 0, idempotency_key: "search:excluded" });
  assert.equal(replay.created, false);
  assert.deepEqual(await repository.query({ text: "forbidden" }), []);

  const evolving = rawDraft({ id: "view:evolving", body: "first searchable state" });
  await repository.commit({ draft: evolving, expected_revision: 0 });
  const nextProjection: ViewSearchProjection = {
    version: 1,
    fields: [...searchProjection.fields, { path: "/representation/value/hidden", category: "text" }],
  };
  await repository.commit({
    draft: rawDraft({
      id: evolving.id,
      body: "second searchable state",
      hidden: "new schema signal",
      schemaVersion: 2,
      search: nextProjection,
      supersedes: 1,
    }),
    expected_revision: 1,
  });
  assert.deepEqual((await repository.query({ text: "schema signal" })).map(view => [view.id, view.revision]), [[evolving.id, 2]]);
  assert.deepEqual((await repository.query({ text: "first searchable", revisions: "all" })).map(view => [view.id, view.revision]), [[evolving.id, 1]]);
}));

test("external media stays referenced while declared URI metadata is searchable", () => withRepository(async repository => {
  const draft = rawDraft({ id: "view:external", body: "placeholder" });
  draft.schema = {
    name: "capture.test.external",
    version: 1,
    mode: "freeform",
    search_projection: {
      version: 1,
      fields: [
        { path: "/name", category: "title" },
        { path: "/representation/uri", category: "url" },
        { path: "/provenance/capture/source_id", category: "provenance" },
      ],
    },
  };
  draft.representation = {
    form: "external_reference",
    kind: "video",
    uri: "https://media.example.com/library/ambient-demo.mp4",
    media_type: "video/mp4",
    metadata: {},
  };
  await repository.commit({ draft: parseViewDraft(draft), expected_revision: 0 });
  const result = await repository.query({ text: "ambient demo" });
  assert.equal(result[0]?.representation.form, "external_reference");
  assert.equal(result[0]?.representation.form === "external_reference" ? result[0].representation.uri : "", draft.representation.uri);
}));

test("invalid declared projection data rejects the whole View transaction", () => withRepository(async repository => {
  const draft = rawDraft({ id: "view:invalid-projection", body: "must roll back", url: "not a URL" });
  await assert.rejects(
    repository.commit({ draft, expected_revision: 0 }),
    (error: unknown) => error instanceof ViewRepositoryError
      && error.code === "invalid_request"
      && error.details.phase === "persist_search_projection"
      && error.details.view_ids?.includes(draft.id),
  );
  assert.equal(await repository.getLatest(draft.id), undefined);
  assert.deepEqual(await repository.query({ text: "must roll back" }), []);
}));

test("reindex is durable, idempotent, repairs missing rows, and rolls back failed rebuilds", () => withRepository(async (repository, path) => {
  await repository.commit({ draft: rawDraft({ id: "view:reindex", body: "durable projection evidence" }), expected_revision: 0 });
  const first = await repository.reindexSearch({ run_id: "reindex:1", requested_at: createdAt });
  assert.equal(first.scanned, 1);
  assert.equal(first.unchanged, 1);
  assert.deepEqual(await repository.reindexSearch({ run_id: "reindex:1", requested_at: createdAt }), first);

  const faultDb = new DatabaseSync(path);
  const row = faultDb.prepare("select search_rowid from view_search_projection_v1 where view_id = 'view:reindex'").get() as { search_rowid: number };
  faultDb.prepare("delete from view_search_fts_v1 where rowid = ?").run(Number(row.search_rowid));
  faultDb.close();
  assert.deepEqual(await repository.query({ text: "durable evidence" }), []);
  const repaired = await repository.reindexSearch({ run_id: "reindex:repair", requested_at: "2026-07-26T12:01:00.000Z" });
  assert.equal(repaired.indexed, 1);
  assert.deepEqual((await repository.query({ text: "durable evidence" })).map(view => view.id), ["view:reindex"]);

  const triggerDb = new DatabaseSync(path);
  triggerDb.prepare("update view_search_projection_v1 set projection_digest = ? where view_id = ?")
    .run("0".repeat(64), "view:reindex");
  triggerDb.exec(`
    create trigger reject_search_rebuild
    before insert on view_search_projection_v1
    when new.view_id = 'view:reindex'
    begin
      select raise(abort, 'injected search reindex failure');
    end;
  `);
  triggerDb.close();
  await assert.rejects(
    repository.reindexSearch({ run_id: "reindex:rollback", requested_at: "2026-07-26T12:02:00.000Z" }),
    (error: unknown) => error instanceof ViewRepositoryError
      && error.code === "storage_failure"
      && error.details.operation === "search_reindex"
      && error.details.phase === "rebuild_projection",
  );
  assert.deepEqual((await repository.query({ text: "durable evidence" })).map(view => view.id), ["view:reindex"]);
}));

test("adapter migration rebuilds the versioned projection after an interrupted older index", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-search-migration-"));
  const path = join(directory, "views.sqlite");
  let repository: SqliteViewRepository | undefined = new SqliteViewRepository(path);
  try {
    await repository.commit({ draft: rawDraft({ id: "view:migrate-search", body: "migration restores FTS" }), expected_revision: 0 });
    repository.close();
    repository = undefined;
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      delete from view_search_fts_v1;
      delete from view_search_projection_v1;
      update view_store_schema_versions_v1 set version = 4 where component = 'view-store';
    `);
    legacy.close();

    repository = new SqliteViewRepository(path);
    assert.deepEqual((await repository.query({ text: "migration restores" })).map(view => view.id), ["view:migrate-search"]);
  } finally {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an omitted legacy local-search flag keeps its View idempotency fingerprint across migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-search-policy-migration-"));
  const path = join(directory, "views.sqlite");
  let repository: SqliteViewRepository | undefined = new SqliteViewRepository(path);
  try {
    const draft = rawDraft({ id: "view:legacy-policy", body: "legacy policy replay" });
    const { allow_local_search: _default, ...legacyPolicy } = draft.policy;
    draft.policy = legacyPolicy;
    await repository.commit({ draft: parseViewDraft(draft), expected_revision: 0, idempotency_key: "legacy-policy:1" });
    repository.close();
    repository = undefined;
    const legacy = new DatabaseSync(path);
    legacy.prepare("update view_store_schema_versions_v1 set version = 4 where component = 'view-store'").run();
    legacy.close();

    repository = new SqliteViewRepository(path);
    const replay = await repository.commit({
      draft: parseViewDraft(draft),
      expected_revision: 0,
      idempotency_key: "legacy-policy:1",
    });
    assert.equal(replay.created, false);
    assert.deepEqual((await repository.query({ text: "legacy policy replay" })).map(view => view.id), [draft.id]);
  } finally {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

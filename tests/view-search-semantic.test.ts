import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { SearchService, type QueryEmbeddingPort } from "@info/search";
import {
  PrivacyForgetService,
  exactViewRef,
  parseView,
  parseViewDraft,
  type ExactViewRef,
  type View,
  type ViewDraft,
} from "@info/view";
import {
  SQLITE_VEC_EXTENSION_VERSION,
  SQLITE_VEC_PACKAGE_VERSION,
  SqliteVecEmbeddingViewSchema,
  SqliteViewRepository,
  sqliteVecSourceDigest,
  type SqliteVecProfile,
} from "@info/storage-sqlite";

const PROFILE: SqliteVecProfile = {
  id: "embedding:fixture-v1",
  revision: 1,
  provider: "fixture",
  model: "fixture-3d",
  dimension: 3,
  distance_metric: "cosine",
};
const SECOND_PROFILE: SqliteVecProfile = {
  id: "embedding:fixture-v2",
  revision: 1,
  provider: "fixture",
  model: "fixture-3d-second",
  dimension: 3,
  distance_metric: "cosine",
};
const CREATED_AT = "2026-07-27T08:00:00.000Z";

test("pinned sqlite-vec loads on Node 24 and preserves scoped vectors across rollback and WAL reopen", async () => {
  assert.equal(process.versions.node.startsWith("24."), true, `expected Node 24, received ${process.versions.node}`);
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-lifecycle-"));
  const database = join(directory, "views.sqlite");
  let repository: SqliteViewRepository | undefined = semanticRepository(database);
  try {
    const compatibility = repository.semantic_search!.compatibility;
    assert.equal(compatibility.package_version, SQLITE_VEC_PACKAGE_VERSION);
    assert.equal(compatibility.extension_version, SQLITE_VEC_EXTENSION_VERSION);
    const platformPackage = process.platform === "darwin"
      ? `sqlite-vec-darwin-${process.arch}@0.1.9`
      : process.platform === "linux"
        ? `sqlite-vec-linux-${process.arch}@0.1.9`
        : `sqlite-vec-windows-${process.arch}@0.1.9`;
    const extensionSuffix = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
    assert.equal(compatibility.extension_path.includes(platformPackage), true);
    assert.equal(compatibility.extension_path.endsWith(`vec0.${extensionSuffix}`), true);
    assert.equal(compatibility.journal_mode, "wal");
    assert.match(compatibility.sqlite_source_id, /^[0-9]{4}-[0-9]{2}-[0-9]{2}/u);

    const first = await commit(repository, targetDraft("view:semantic:first", "first semantic location"));
    const second = await commit(repository, targetDraft(
      "view:semantic:second",
      "second semantic location",
      { type: "contains", target: exactViewRef(first) },
    ));
    const firstEmbedding = await commit(repository, embeddingDraft("view:embedding:first", first, [1, 0, 0]));
    const secondEmbedding = await commit(repository, embeddingDraft("view:embedding:second", second, [0, 1, 0]));

    const scoped = await repository.semantic_search!.retrieve({
      vector: { values: [1, 0, 0], dimension: 3, distance_metric: "cosine" },
      profile: { id: PROFILE.id, revision: PROFILE.revision },
      refs: [exactViewRef(second)],
      target: { envelope: false, internal: true, related_views: false },
      candidate_limit: 10,
    });
    assert.deepEqual(scoped.map(candidate => candidate.ref), [exactViewRef(second)]);
    assert.deepEqual(scoped[0]!.matches[0]!.semantic_evidence_ref, exactViewRef(secondEmbedding));

    const hybrid = await hybridSearch(repository, first, [1, 0, 0]);
    assert.deepEqual(hybrid.modes.map(mode => [mode.mode, mode.status]), [
      ["keyword", "executed"],
      ["semantic", "executed"],
      ["relation", "executed"],
    ]);
    assert.equal(hybrid.hits.some(hit => hit.ref.view_id === second.id), true);

    const rollbackGood = embeddingDraft("view:embedding:rollback-good", first, [0.8, 0.2, 0]);
    const rollbackBad = embeddingDraft("view:embedding:rollback-bad", second, [0.5, 0.5]);
    await assert.rejects(repository.commitBatch([
      { draft: rollbackGood, expected_revision: 0 },
      { draft: rollbackBad, expected_revision: 0 },
    ]));
    assert.equal(await repository.get({ view_id: rollbackGood.id, revision: 1 }), undefined);
    assert.equal(await repository.get({ view_id: rollbackBad.id, revision: 1 }), undefined);

    repository.close();
    repository = undefined;
    repository = semanticRepository(database);
    const reopened = await semanticSearch(repository, [first, firstEmbedding, second, secondEmbedding], [1, 0, 0]);
    assert.deepEqual(reopened.hits.map(hit => hit.ref), [exactViewRef(first), exactViewRef(second)]);
    assert.deepEqual(reopened.hits[0]!.matches[0]!.semantic_evidence_ref, exactViewRef(firstEmbedding));
  } finally {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("semantic startup rejects missing or incompatible profile configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-startup-"));
  const database = join(directory, "views.sqlite");
  try {
    semanticRepository(database).close();
    assert.throws(
      () => new SqliteViewRepository(database),
      (error: unknown) => error instanceof Error && error.cause instanceof Error
        && "code" in error.cause && error.cause.code === "configuration_required",
    );
    assert.throws(
      () => semanticRepository(database, [{ ...PROFILE, dimension: 4 }]),
      (error: unknown) => error instanceof Error && error.cause instanceof Error
        && "code" in error.cause && error.cause.code === "profile_mismatch",
    );
    assert.throws(
      () => semanticRepository(database, [{ ...PROFILE, distance_metric: "l2" }]),
      (error: unknown) => error instanceof Error && error.cause instanceof Error
        && "code" in error.cause && error.cause.code === "profile_mismatch",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("profile-scoped rowids cannot cross-resolve and metadata corruption fails query and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-profile-integrity-"));
  const database = join(directory, "views.sqlite");
  let repository: SqliteViewRepository | undefined = semanticRepository(database, [PROFILE, SECOND_PROFILE]);
  try {
    const firstTarget = await commit(repository, targetDraft("view:profile:first", "first profile target"));
    const secondTarget = await commit(repository, targetDraft("view:profile:second", "second profile target"));
    await commit(repository, embeddingDraft("view:profile:first-embedding", firstTarget, [1, 0, 0], PROFILE));
    const secondEmbedding = await commit(
      repository,
      embeddingDraft("view:profile:second-embedding", secondTarget, [0, 1, 0], SECOND_PROFILE),
    );

    const scoped = await repository.semantic_search!.retrieve({
      vector: { values: [0, 1, 0], dimension: 3, distance_metric: "cosine" },
      profile: { id: SECOND_PROFILE.id, revision: SECOND_PROFILE.revision },
      refs: [exactViewRef(firstTarget), exactViewRef(secondTarget)],
      target: { envelope: false, internal: true, related_views: false },
      candidate_limit: 10,
    });
    assert.deepEqual(scoped.map(candidate => candidate.ref), [exactViewRef(secondTarget)]);
    assert.deepEqual(scoped[0]!.matches[0]!.semantic_evidence_ref, exactViewRef(secondEmbedding));

    const extensionPath = repository.semantic_search!.compatibility.extension_path;
    const audit = new DatabaseSync(database, { allowExtension: true });
    audit.loadExtension(extensionPath);
    const mappings = audit.prepare(`
      select profile_id, profile_revision, vector_rowid
      from view_search_vectors_v1 order by profile_id
    `).all() as Array<{ profile_id: string; profile_revision: number; vector_rowid: number }>;
    assert.deepEqual(mappings.map(row => [row.profile_id, Number(row.vector_rowid)]), [
      [PROFILE.id, 1],
      [SECOND_PROFILE.id, 1],
    ]);
    const secondTable = audit.prepare(`
      select table_name from view_search_vector_profiles_v1
      where profile_id = ? and profile_revision = ?
    `).get(SECOND_PROFILE.id, SECOND_PROFILE.revision) as { table_name: string };
    audit.prepare(`delete from "${secondTable.table_name}" where rowid = 1`).run();
    audit.prepare(`
      insert into "${secondTable.table_name}" (
        rowid, embedding, target_key, target_kind, profile_id, profile_revision
      ) values (?, ?, ?, ?, ?, ?)
    `).run(
      1n,
      new Float32Array([0, 1, 0]),
      `${secondTarget.id}@${secondTarget.revision}`,
      "representation",
      PROFILE.id,
      BigInt(PROFILE.revision),
    );
    audit.close();

    await assert.rejects(
      repository.semantic_search!.retrieve({
        vector: { values: [0, 1, 0], dimension: 3, distance_metric: "cosine" },
        profile: { id: SECOND_PROFILE.id, revision: SECOND_PROFILE.revision },
        refs: [exactViewRef(secondTarget)],
        target: { envelope: false, internal: true, related_views: false },
        candidate_limit: 10,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "vector_mapping_corrupt",
    );
    repository.close();
    repository = undefined;
    assert.throws(
      () => semanticRepository(database, [PROFILE, SECOND_PROFILE]),
      (error: unknown) => error instanceof Error && error.cause instanceof Error
        && "code" in error.cause && error.cause.code === "vector_mapping_corrupt",
    );
  } finally {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("embedding policies cannot weaken sensitive targets or cross owners", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-policy-"));
  const repository = semanticRepository(join(directory, "views.sqlite"));
  try {
    const strictPolicy = {
      ...semanticPolicy(),
      privacy: "sensitive" as const,
      labels: ["semantic-fixture", "sensitive-source"],
    };
    const target = await commit(repository, parseViewDraft({
      ...targetDraft("view:policy:target", "sensitive target"),
      policy: strictPolicy,
    }));
    const publicWeakening = parseViewDraft({
      ...embeddingDraft("view:policy:public", target, [1, 0, 0]),
      policy: {
        ...semanticPolicy(),
        visibility: "public",
        privacy: "public",
        labels: ["semantic-fixture"],
      },
    });
    await assert.rejects(
      repository.commit({ draft: publicWeakening, expected_revision: 0 }),
      (error: unknown) => semanticErrorCode(error) === "embedding_invalid",
    );
    assert.equal(await repository.get({ view_id: publicWeakening.id, revision: 1 }), undefined);

    const crossOwner = parseViewDraft({
      ...embeddingDraft("view:policy:cross-owner", target, [1, 0, 0]),
      policy: { ...strictPolicy, owner: "user:other" },
    });
    await assert.rejects(
      repository.commit({ draft: crossOwner, expected_revision: 0 }),
      (error: unknown) => semanticErrorCode(error) === "embedding_invalid",
    );
    assert.equal(await repository.get({ view_id: crossOwner.id, revision: 1 }), undefined);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("semantic projection preserves both same-batch forward-reference orders and rollback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-forward-reference-"));
  const repository = semanticRepository(join(directory, "views.sqlite"));
  try {
    const firstTarget = parseView({ ...targetDraft("view:batch:first-target", "embedding first target"), revision: 1 });
    const firstEmbedding = embeddingDraft("view:batch:first-embedding", firstTarget, [1, 0, 0]);
    await repository.commitBatch([
      { draft: firstEmbedding, expected_revision: 0 },
      { draft: targetDraft(firstTarget.id, "embedding first target"), expected_revision: 0 },
    ]);
    const secondTarget = parseView({ ...targetDraft("view:batch:second-target", "target first target"), revision: 1 });
    const secondEmbedding = embeddingDraft("view:batch:second-embedding", secondTarget, [0, 1, 0]);
    await repository.commitBatch([
      { draft: targetDraft(secondTarget.id, "target first target"), expected_revision: 0 },
      { draft: secondEmbedding, expected_revision: 0 },
    ]);
    const hits = await repository.semantic_search!.retrieve({
      vector: { values: [1, 0, 0], dimension: 3, distance_metric: "cosine" },
      profile: { id: PROFILE.id, revision: PROFILE.revision },
      refs: [exactViewRef(firstTarget), exactViewRef(secondTarget)],
      target: { envelope: false, internal: true, related_views: false },
      candidate_limit: 10,
    });
    assert.deepEqual(hits.map(hit => hit.ref), [exactViewRef(firstTarget), exactViewRef(secondTarget)]);

    const rollbackTarget = parseView({ ...targetDraft("view:batch:rollback-target", "rollback target"), revision: 1 });
    const invalidEmbedding = parseViewDraft({
      ...embeddingDraft("view:batch:rollback-embedding", rollbackTarget, [0, 0, 1]),
      policy: { ...semanticPolicy(), owner: "user:other" },
    });
    await assert.rejects(repository.commitBatch([
      { draft: invalidEmbedding, expected_revision: 0 },
      { draft: targetDraft(rollbackTarget.id, "rollback target"), expected_revision: 0 },
    ]));
    assert.equal(await repository.get(exactViewRef(rollbackTarget)), undefined);
    assert.equal(await repository.get({ view_id: invalidEmbedding.id, revision: 1 }), undefined);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Privacy Forget and durable reindex remove vector evidence and repair mapping orphans without embedding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-forget-"));
  const database = join(directory, "views.sqlite");
  let repository: SqliteViewRepository | undefined = semanticRepository(database);
  try {
    const forgottenTarget = await commit(repository, targetDraft("view:semantic:forgotten", "forgotten semantic location"));
    const retainedTarget = await commit(repository, targetDraft("view:semantic:retained", "retained semantic location"));
    const forgottenEmbedding = await commit(repository, embeddingDraft("view:embedding:forgotten", forgottenTarget, [1, 0, 0]));
    const retainedEmbedding = await commit(repository, embeddingDraft("view:embedding:retained", retainedTarget, [0, 1, 0]));

    const extensionPath = repository.semantic_search!.compatibility.extension_path;
    repository.close();
    repository = undefined;
    const audit = new DatabaseSync(database, { allowExtension: true });
    audit.loadExtension(extensionPath);
    const profile = audit.prepare(`
      select table_name, profile_id, profile_revision from view_search_vector_profiles_v1
    `).get() as { table_name: string; profile_id: string; profile_revision: number };
    const retainedMapping = audit.prepare(`
      select vector_rowid from view_search_vectors_v1 where embedding_view_id = ?
    `).get(retainedEmbedding.id) as { vector_rowid: number };
    audit.prepare("delete from view_search_vectors_v1 where vector_rowid = ?").run(BigInt(retainedMapping.vector_rowid));
    audit.prepare(`
      insert into "${profile.table_name}" (
        rowid, embedding, target_key, target_kind, profile_id, profile_revision
      ) values (?, ?, ?, ?, ?, ?)
    `).run(
      9_999_999n,
      new Float32Array([0.2, 0.2, 0.6]),
      "view:orphan@1",
      "representation",
      profile.profile_id,
      BigInt(profile.profile_revision),
    );
    audit.close();

    repository = semanticRepository(database);
    assert.deepEqual(repository.semantic_search!.maintenance, {
      status: "reindex_required",
      orphan_rows: 2,
      missing_rows: 0,
    });
    await assert.rejects(
      semanticSearch(repository, [retainedTarget], [0, 1, 0]),
      (error: unknown) => error instanceof Error
        && "code" in error && error.code === "retrieval_failed"
        && error.cause instanceof Error
        && "code" in error.cause && error.cause.code === "reindex_required",
    );
    const blockedEmbedding = embeddingDraft("view:embedding:blocked-until-reindex", retainedTarget, [0, 1, 0]);
    await assert.rejects(
      repository.commit({ draft: blockedEmbedding, expected_revision: 0 }),
      (error: unknown) => semanticErrorCode(error) === "reindex_required",
    );
    assert.equal(await repository.get({ view_id: blockedEmbedding.id, revision: 1 }), undefined);
    assert.throws(
      () => repository!.semantic_search!.delete(exactViewRef(retainedTarget)),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "reindex_required",
    );
    const report = await repository.reindexSearch({
      run_id: "semantic:reindex:repair",
      requested_at: "2026-07-27T08:10:00.000Z",
    });
    assert.deepEqual(report.semantic, {
      adapter: "sqlite-vec",
      extension_version: SQLITE_VEC_EXTENSION_VERSION,
      profiles: 1,
      scanned: 2,
      indexed: 2,
      excluded: 0,
      removed: 1,
      orphans_repaired: 2,
      missing_rows_repaired: 0,
    });
    assert.deepEqual(repository.semantic_search!.maintenance, { status: "ready" });
    assert.deepEqual(
      await repository.reindexSearch({ run_id: "semantic:reindex:repair", requested_at: "2026-07-27T08:10:00.000Z" }),
      report,
    );
    const repaired = await semanticSearch(repository, [retainedTarget, retainedEmbedding], [0, 1, 0]);
    assert.deepEqual(repaired.hits.map(hit => hit.ref), [exactViewRef(retainedTarget)]);

    let tick = 0;
    const forget = new PrivacyForgetService({
      views: repository,
      requests: repository,
      now: () => new Date(Date.parse("2026-07-27T08:20:00.000Z") + tick++ * 1_000).toISOString(),
    });
    const preview = await forget.request({
      request_id: "forget:semantic:target",
      actor: "user:semantic",
      requested_at: "2026-07-27T08:20:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(forgottenTarget) }],
      mixed_source_rule: "purge",
    });
    assert.equal(preview.plan.impact.some(item => item.ref.view_id === forgottenEmbedding.id), true);
    await forget.execute({
      request_id: preview.plan.request_id,
      authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
      actor: "user:semantic",
    });
    assert.equal(await repository.get(exactViewRef(forgottenTarget)), undefined);
    assert.equal(await repository.get(exactViewRef(forgottenEmbedding)), undefined);
    const remaining = await semanticSearch(repository, [retainedTarget, retainedEmbedding], [1, 0, 0]);
    assert.deepEqual(remaining.hits.map(hit => hit.ref), [exactViewRef(retainedTarget)]);

    repository.close();
    repository = undefined;
    repository = semanticRepository(database);
    const reopened = await semanticSearch(repository, [retainedTarget, retainedEmbedding], [0, 1, 0]);
    assert.deepEqual(reopened.hits.map(hit => hit.ref), [exactViewRef(retainedTarget)]);
  } finally {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("representative local corpus stays within the pinned sqlite-vec cost gate", async t => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-sqlite-vec-corpus-"));
  const database = join(directory, "views.sqlite");
  const profile: SqliteVecProfile = {
    id: "embedding:fixture-corpus",
    revision: 1,
    provider: "fixture",
    model: "fixture-32d",
    dimension: 32,
    distance_metric: "cosine",
  };
  const repository = semanticRepository(database, [profile]);
  try {
    const count = 512;
    const targets = await repository.commitBatch(Array.from({ length: count }, (_, index) => ({
      draft: targetDraft(`view:corpus:${index.toString().padStart(4, "0")}`, `representative corpus item ${index}`),
      expected_revision: 0,
    })));
    const targetViews = targets.results.map(result => result.view);
    const started = performance.now();
    await repository.commitBatch(targetViews.map((target, index) => ({
      draft: embeddingDraft(
        `view:corpus-embedding:${index.toString().padStart(4, "0")}`,
        target,
        fixtureVector(index, profile.dimension),
        profile,
      ),
      expected_revision: 0,
    })));
    const indexDurationMs = performance.now() - started;
    const queryStarted = performance.now();
    const hits = await repository.semantic_search!.retrieve({
      vector: { values: fixtureVector(17, profile.dimension), dimension: profile.dimension, distance_metric: "cosine" },
      profile: { id: profile.id, revision: profile.revision },
      refs: targetViews.map(exactViewRef),
      target: { envelope: false, internal: true, related_views: false },
      candidate_limit: 20,
    });
    const queryDurationMs = performance.now() - queryStarted;
    const sizeBytes = [database, `${database}-wal`]
      .filter(existsSync)
      .reduce((total, path) => total + statSync(path).size, 0);
    assert.equal(hits[0]!.ref.view_id, targetViews[17]!.id);
    assert.equal(indexDurationMs < 10_000, true, `index duration ${indexDurationMs}ms exceeded 10s`);
    assert.equal(queryDurationMs < 2_000, true, `query duration ${queryDurationMs}ms exceeded 2s`);
    assert.equal(sizeBytes < 32 * 1024 * 1024, true, `database size ${sizeBytes} exceeded 32 MiB`);
    t.diagnostic(JSON.stringify({ count, dimension: profile.dimension, index_duration_ms: indexDurationMs, query_duration_ms: queryDurationMs, database_bytes: sizeBytes }));
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function semanticRepository(path: string, profiles: SqliteVecProfile[] = [PROFILE]): SqliteViewRepository {
  return new SqliteViewRepository(path, { semantic_search: { profiles } });
}

async function commit(repository: SqliteViewRepository, draft: ViewDraft): Promise<View> {
  return (await repository.commit({ draft, expected_revision: 0 })).view;
}

function targetDraft(
  id: string,
  text: string,
  relation?: { type: string; target: ExactViewRef },
): ViewDraft {
  return parseViewDraft({
    id,
    name: id,
    purpose: "Provide an exact semantic Search target",
    schema: {
      name: "semantic.fixture.document",
      version: 1,
      mode: "freeform",
      search_projection: { version: 1, fields: [{ path: "/representation/value/text", category: "text" }] },
    },
    role: "derived",
    time: { created_at: CREATED_AT },
    representation: { form: "inline", kind: "semantic_fixture", value: { text } },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    relations: relation ? [relation] : [],
    provenance: { inputs: [], actor: "fixture:semantic-source" },
    policy: semanticPolicy(),
  });
}

async function hybridSearch(repository: SqliteViewRepository, root: View, vector: number[]) {
  const service = new SearchService({
    authorization: {
      authorize: async input => input.refs.map(ref => ({ ref, status: "allowed" as const })),
    },
    scope_source: repository.search,
    descriptors: repository.search,
    keyword: repository.search,
    semantic: repository.semantic_search,
    query_embedding: {
      embed: async () => ({ values: vector, dimension: PROFILE.dimension, distance_metric: PROFILE.distance_metric }),
    },
    observer: { async record() {} },
    now: () => CREATED_AT,
  });
  return service.search({
    request_id: "search:semantic:hybrid-same-connection",
    principal: { id: "user:semantic" },
    request: {
      contract_version: 1,
      query: { text: "semantic" },
      scope: {
        kind: "subgraph",
        roots: [exactViewRef(root)],
        direction: "incoming",
        relation_types: ["contains", "embedding_of"],
        max_depth: 3,
        max_nodes: 20,
      },
      target: { envelope: true, internal: true, related_views: true },
      modes: ["keyword", "semantic", "relation"],
      semantic: { embedding_profile: { id: PROFILE.id, revision: PROFILE.revision } },
      fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1, semantic: 1, relation: 1 } },
      failure_mode: "require_all",
      page: { limit: 20 },
    },
  });
}

function embeddingDraft(
  id: string,
  target: View,
  vector: number[],
  profile: SqliteVecProfile = PROFILE,
): ViewDraft {
  const text = (target.representation.form === "inline" && typeof target.representation.value === "object"
    && target.representation.value !== null && !Array.isArray(target.representation.value))
    ? target.representation.value.text
    : undefined;
  assert.equal(typeof text, "string");
  return parseViewDraft({
    id,
    name: `${target.name} embedding`,
    purpose: "Freeze one exact deterministic fixture embedding",
    schema: SqliteVecEmbeddingViewSchema,
    role: "derived",
    time: { created_at: CREATED_AT },
    representation: {
      form: "inline",
      kind: "metaflow.search.embedding",
      media_type: "application/json",
      value: {
        contract_version: 1,
        target: {
          ref: exactViewRef(target),
          location: { kind: "representation", path: "/representation/value/text" },
          source_digest: sqliteVecSourceDigest(text),
        },
        profile,
        vector,
      },
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    relations: [{ type: "embedding_of", target: exactViewRef(target) }],
    provenance: {
      inputs: [exactViewRef(target)],
      operator_run_id: `run:${id}`,
      actor: "fixture:embedder",
    },
    policy: semanticPolicy(),
  });
}

function semanticPolicy() {
  return {
    owner: "user:semantic",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: true,
    allow_local_search: true,
    labels: ["semantic-fixture"],
  };
}

function semanticErrorCode(error: unknown): unknown {
  return error instanceof Error && error.cause instanceof Error && "code" in error.cause
    ? error.cause.code
    : undefined;
}

async function semanticSearch(
  repository: SqliteViewRepository,
  scopeViews: View[],
  vector: number[],
) {
  const queryEmbedding: QueryEmbeddingPort = {
    embed: async () => ({ values: vector, dimension: PROFILE.dimension, distance_metric: PROFILE.distance_metric }),
  };
  const service = new SearchService({
    authorization: {
      authorize: async input => input.refs.map(ref => ({ ref, status: "allowed" as const })),
    },
    scope_source: repository.search,
    descriptors: repository.search,
    semantic: repository.semantic_search,
    query_embedding: queryEmbedding,
    observer: { async record() {} },
    now: () => CREATED_AT,
  });
  return service.search({
    request_id: `search:semantic:${scopeViews.map(view => view.id).join(":")}`,
    principal: { id: "user:semantic" },
    request: {
      contract_version: 1,
      query: { text: "fixture semantic query" },
      scope: { kind: "exact_views", refs: scopeViews.map(exactViewRef) },
      target: { envelope: false, internal: true, related_views: false },
      modes: ["semantic"],
      semantic: { embedding_profile: { id: PROFILE.id, revision: PROFILE.revision } },
      fusion: { strategy: "rrf@1", k: 60, weights: { semantic: 1 } },
      failure_mode: "require_all",
      page: { limit: 20 },
    },
  });
}

function fixtureVector(index: number, dimension: number): number[] {
  const values = Array.from({ length: dimension }, (_, item) => ((index + 1) * (item + 3)) % 101 + 1);
  const magnitude = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  return values.map(value => value / magnitude);
}

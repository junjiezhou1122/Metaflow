import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PrivacyForgetError,
  PrivacyForgetService,
  SOURCE_TOMBSTONE_REPRESENTATION_KIND,
  ViewRepositoryError,
  ViewRevisionTransitionError,
  buildSourceTombstone,
  exactViewRef,
  parseViewDraft,
  type ExactViewRef,
  type ForgetCleanupStore,
  type ForgetPlan,
  type ForgetRebuildPort,
  type View,
  type ViewDraft,
  type ViewPolicy,
} from "@info/view";
import { SqliteViewRepository } from "@info/storage-sqlite";

const timestamp = "2026-07-26T20:00:00.000Z";

test("source deletion appends a terminal immutable tombstone and preserves prior source evidence", async () => {
  await withRepository(async repository => {
    const source = (await repository.commit({
      draft: rawDraft("view:raw:deleted-occurrence", "source:deleted", normalPolicy(), {
        identity: "occurrence",
        text: "source payload remains because tombstone is not privacy erasure",
        strict: true,
      }),
      expected_revision: 0,
    })).view;
    const tombstoneDraft = buildSourceTombstone(source, {
      source: exactViewRef(source),
      reason: "deleted_upstream",
      occurred_at: "2026-07-26T20:01:00.000Z",
      actor: "user:test",
      trace_id: "trace:tombstone",
    });
    const tombstone = (await repository.commit({ draft: tombstoneDraft, expected_revision: 1 })).view;

    assert.equal(tombstone.revision, 2);
    assert.equal(tombstone.representation.kind, SOURCE_TOMBSTONE_REPRESENTATION_KIND);
    assert.equal((await repository.get(exactViewRef(source)))?.representation.kind, "source_record");
    assert.deepEqual(await repository.resolveLatest(source.id), exactViewRef(tombstone));
    assert.deepEqual(await repository.query({ text: "source payload remains" }), []);
    assert.deepEqual((await repository.query({ text: "source payload remains", revisions: "all" })).map(view => view.revision), [1]);

    const later = {
      ...tombstoneDraft,
      time: { ...tombstoneDraft.time, created_at: "2026-07-26T20:02:00.000Z" },
      relations: [{ type: "supersedes", target: exactViewRef(tombstone), metadata: {} }],
    };
    await assert.rejects(
      repository.commit({ draft: later, expected_revision: 2 }),
      (error: unknown) => error instanceof Error
        && error.cause instanceof ViewRevisionTransitionError
        && error.cause.code === "tombstone_is_terminal",
    );
  });
});

test("previewed Forget rebuilds mixed-source Views, cleans indexes, purges payloads, and retains a content-free audit", async () => {
  await withRepository(async (repository, database) => {
    const forgotten = await commit(repository, rawDraft(
      "view:raw:private-browser",
      "source:private-browser",
      normalPolicy(),
      { text: "FORGOTTEN_SECRET_PAGE_TEXT" },
    ));
    const retained = await commit(repository, rawDraft(
      "view:raw:public-browser",
      "source:public-browser",
      normalPolicy(),
      { text: "safe retained evidence" },
    ));
    const mixed = await commit(repository, derivedDraft(
      "view:derived:mixed-summary",
      [forgotten, retained],
      "FORGOTTEN_MIXED_SUMMARY",
    ));
    const child = await commit(repository, derivedDraft(
      "view:derived:child",
      [mixed],
      "FORGOTTEN_CHILD_SUMMARY",
    ));
    assert.ok((await repository.query({ text: "FORGOTTEN SECRET PAGE TEXT" })).some(view => view.id === forgotten.id));
    await repository.putDerivedMaterialization({
      view: exactViewRef(mixed),
      materialization: {
        id: "vector-index",
        format: "vector",
        media_type: "application/x-vector",
        location: { kind: "content_addressed", store: "vector", key: "mixed-summary" },
      },
      expected_generation: 0,
      updated_at: "2026-07-26T20:02:00.000Z",
    });

    const vector = new MemoryCleanupStore("vector", [forgotten, mixed, child]);
    const service = forgetService(repository, { cleanup_stores: [vector], rebuilder: new SafeRebuilder() });
    const preview = await service.request({
      request_id: "forget:normal:1",
      actor: "user:test",
      requested_at: "2026-07-26T20:03:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(forgotten) }],
      mixed_source_rule: "rebuild",
    });

    assert.equal(preview.status, "previewed");
    assert.ok(await repository.get(exactViewRef(forgotten)));
    assert.deepEqual(preview.plan.impact.map(item => [item.ref.view_id, item.action]), [
      ["view:derived:child", "purge"],
      ["view:derived:mixed-summary", "rebuild"],
      ["view:raw:private-browser", "purge"],
    ]);
    await assert.rejects(
      service.execute({
        request_id: preview.plan.request_id,
        authorization: { kind: "confirmed_preview", plan_digest: "0".repeat(64) },
        actor: "user:test",
      }),
      (error: unknown) => error instanceof PrivacyForgetError && error.code === "forget_confirmation_mismatch",
    );

    const succeeded = await service.execute({
      request_id: preview.plan.request_id,
      authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
      actor: "user:test",
    });
    assert.equal(succeeded.status, "succeeded");
    assert.ok(succeeded.receipts.every(receipt => receipt.status === "succeeded"));
    assert.equal(succeeded.replacements.length, 1);
    assert.equal(await repository.get(exactViewRef(forgotten)), undefined);
    assert.equal(await repository.get(exactViewRef(mixed)), undefined);
    assert.equal(await repository.get(exactViewRef(child)), undefined);
    assert.ok(await repository.get(exactViewRef(retained)));
    assert.deepEqual(await repository.query({ text: "FORGOTTEN" }), []);
    assert.deepEqual((await repository.query({ text: "safe retained evidence" })).map(view => view.id), [retained.id]);
    assert.equal(vector.has(exactViewRef(forgotten)), false);
    assert.equal(vector.has(exactViewRef(mixed)), false);
    const databaseCheck = new DatabaseSync(database);
    try {
      const storedMaterializations = databaseCheck.prepare(`
        select count(*) as count from view_materializations_v1
        where view_id in (?, ?, ?)
      `).get(forgotten.id, mixed.id, child.id) as { count: number };
      assert.equal(Number(storedMaterializations.count), 0);
      const storedSearchRows = databaseCheck.prepare(`
        select count(*) as count from view_search_projection_v1
        where view_id in (?, ?, ?)
      `).get(forgotten.id, mixed.id, child.id) as { count: number };
      assert.equal(Number(storedSearchRows.count), 0);
    } finally {
      databaseCheck.close();
    }

    const rebuiltRef = succeeded.replacements[0]!.rebuilt;
    const rebuilt = await repository.get(rebuiltRef);
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt?.provenance.inputs, [exactViewRef(retained)]);
    const incoming = await repository.traverseRelations({ ref: exactViewRef(retained), direction: "incoming" });
    assert.ok(incoming.some(relation => relation.source.view_id === rebuiltRef.view_id));
    const auditJson = JSON.stringify(await service.inspect(preview.plan.request_id, "user:test"));
    assert.doesNotMatch(auditJson, /FORGOTTEN_SECRET_PAGE_TEXT|FORGOTTEN_MIXED_SUMMARY|FORGOTTEN_CHILD_SUMMARY/);
  });
});

test("source identity and policy scope targets freeze complete exact impact sets", async () => {
  await withRepository(async repository => {
    const sourceV1 = await commit(repository, rawDraft(
      "view:raw:stable-source",
      "source:stable",
      normalPolicy(["forget-group"]),
      { text: "v1", identity: "stable_source" },
    ));
    const sourceV2Draft = rawDraft(
      sourceV1.id,
      "source:stable",
      normalPolicy(["forget-group"]),
      { text: "v2", identity: "stable_source" },
    );
    sourceV2Draft.relations = [{ type: "supersedes", target: exactViewRef(sourceV1), metadata: {} }];
    const sourceV2 = (await repository.commit({ draft: sourceV2Draft, expected_revision: 1 })).view;
    const labeled = await commit(repository, derivedDraft("view:derived:labeled", [], "labeled", normalPolicy(["forget-group"])));
    await commit(repository, derivedDraft("view:derived:other", [], "other", normalPolicy(["other"])));
    const service = forgetService(repository);

    const sourcePlan = await service.request({
      request_id: "forget:source-identity",
      actor: "user:test",
      requested_at: "2026-07-26T20:10:00.000Z",
      targets: [{
        kind: "source_identity",
        source: {
          connector: "browser",
          connection_id: "browser:default",
          source_id: "source:stable",
          source_kind: "page",
          identity: "stable_source",
        },
      }],
      mixed_source_rule: "purge",
    });
    assert.deepEqual(sourcePlan.plan.impact.map(item => item.ref), [exactViewRef(sourceV1), exactViewRef(sourceV2)]);

    const policyPlan = await service.request({
      request_id: "forget:policy-scope",
      actor: "user:test",
      requested_at: "2026-07-26T20:11:00.000Z",
      targets: [{ kind: "policy_scope", scope: { owner: "user:test", labels_any: ["forget-group"] } }],
      mixed_source_rule: "purge",
    });
    assert.ok(policyPlan.plan.impact.some(item => item.ref.view_id === labeled.id));
    assert.ok(policyPlan.plan.impact.some(item => item.ref.view_id === sourceV1.id));
    assert.ok(!policyPlan.plan.impact.some(item => item.ref.view_id === "view:derived:other"));

    const identityPlan = await service.request({
      request_id: "forget:view-identity",
      actor: "user:test",
      requested_at: "2026-07-26T20:12:00.000Z",
      targets: [{ kind: "view_identity", view_id: labeled.id }],
      mixed_source_rule: "purge",
    });
    assert.deepEqual(identityPlan.plan.impact.map(item => item.ref), [exactViewRef(labeled)]);
  });
});

test("forgetting one revision retires the complete View identity and forces recapture onto a new identity", async () => {
  await withRepository(async (repository, database) => {
    const originalDraft = rawDraft(
      "view:raw:retired-source",
      "source:retired",
      normalPolicy(),
      { text: "retired v1 payload", identity: "stable_source" },
    );
    const first = (await repository.commit({
      draft: originalDraft,
      expected_revision: 0,
      idempotency_key: "capture:retired:1",
    })).view;
    const secondDraft = rawDraft(
      first.id,
      "source:retired",
      normalPolicy(),
      { text: "retired v2 payload", identity: "stable_source" },
    );
    secondDraft.relations = [{ type: "supersedes", target: exactViewRef(first), metadata: {} }];
    const second = (await repository.commit({ draft: secondDraft, expected_revision: 1 })).view;
    const downstream = await commit(repository, derivedDraft(
      "view:derived:retired-source-summary",
      [first],
      "summary that depends on an older revision",
    ));

    const service = forgetService(repository);
    const preview = await service.request({
      request_id: "forget:retire-identity",
      actor: "user:test",
      requested_at: "2026-07-26T20:15:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(second) }],
      mixed_source_rule: "purge",
    });
    assert.deepEqual(
      preview.plan.impact
        .filter(item => item.ref.view_id === first.id)
        .map(item => ({ ref: item.ref, reason: item.reason })),
      [
        { ref: exactViewRef(first), reason: "target" },
        { ref: exactViewRef(second), reason: "target" },
      ],
    );
    assert.ok(preview.plan.impact.some(item => item.ref.view_id === downstream.id));

    const succeeded = await service.execute({
      request_id: preview.plan.request_id,
      authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
      actor: "user:test",
    });
    assert.equal(succeeded.status, "succeeded");
    assert.equal(await repository.get(exactViewRef(first)), undefined);
    assert.equal(await repository.get(exactViewRef(second)), undefined);
    assert.equal(await repository.resolveLatest(first.id), undefined);

    await assert.rejects(
      repository.commit({
        draft: originalDraft,
        expected_revision: 0,
        idempotency_key: "capture:retired:1",
      }),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "policy_violation"
        && error.details.phase === "reject_forgotten_identity",
    );

    const recaptured = await commit(repository, rawDraft(
      "view:raw:recaptured-source",
      "source:retired",
      normalPolicy(),
      { text: "new capture after privacy erasure", identity: "stable_source" },
    ));
    assert.notEqual(recaptured.id, first.id);
    assert.equal(await repository.get(exactViewRef(first)), undefined);
    assert.equal(await repository.get(exactViewRef(second)), undefined);
    assert.deepEqual(
      (await service.inspect(preview.plan.request_id, "user:test")).plan.impact
        .filter(item => item.ref.view_id === first.id)
        .map(item => item.ref),
      [exactViewRef(first), exactViewRef(second)],
    );

    const databaseCheck = new DatabaseSync(database);
    try {
      const retired = databaseCheck.prepare(`
        select request_id from privacy_forgotten_view_ids_v1 where view_id = ?
      `).get(first.id) as { request_id: string } | undefined;
      assert.equal(retired?.request_id, preview.plan.request_id);
    } finally {
      databaseCheck.close();
    }
  });
});

test("sensitive preauthorization performs an immediate cascade without a separate confirmation", async () => {
  await withRepository(async repository => {
    const sensitive = await commit(repository, rawDraft(
      "view:raw:sensitive",
      "source:sensitive",
      { ...normalPolicy(), privacy: "sensitive" },
      { text: "sensitive payload" },
    ));
    const derived = await commit(repository, derivedDraft(
      "view:derived:sensitive-summary",
      [sensitive],
      "sensitive summary",
      { ...normalPolicy(), privacy: "sensitive" },
    ));
    const service = forgetService(repository);
    const result = await service.request({
      request_id: "forget:sensitive:immediate",
      actor: "user:test",
      requested_at: "2026-07-26T20:20:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(sensitive) }],
      mixed_source_rule: "purge",
      preauthorization: { kind: "preauthorized_sensitive", policy_id: "policy:sensitive-cascade" },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.plan.mode, "sensitive_cascade");
    assert.equal(result.plan.preauthorization_policy_id, "policy:sensitive-cascade");
    assert.equal(await repository.get(exactViewRef(sensitive)), undefined);
    assert.equal(await repository.get(exactViewRef(derived)), undefined);
  });
});

test("an abandoned running request requires explicit restart recovery and resumes from durable receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-forget-abandoned-"));
  const database = join(directory, "views.sqlite");
  const first = new SqliteViewRepository(database);
  let source: View;
  let digest: string;
  try {
    source = await commit(first, rawDraft(
      "view:raw:abandoned",
      "source:abandoned",
      normalPolicy(),
      { text: "abandoned running payload" },
    ));
    const service = forgetService(first);
    const preview = await service.request({
      request_id: "forget:abandoned",
      actor: "user:test",
      requested_at: "2026-07-26T20:40:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(source) }],
      mixed_source_rule: "purge",
    });
    digest = preview.plan.plan_digest;
    await first.startForgetRequest(preview.plan.request_id, "2026-07-26T20:41:00.000Z");
  } finally {
    first.close();
  }

  const restarted = new SqliteViewRepository(database);
  try {
    const service = forgetService(restarted);
    await assert.rejects(service.execute({
      request_id: "forget:abandoned",
      authorization: { kind: "confirmed_preview", plan_digest: digest! },
      actor: "user:test",
    }));
    const recovered = await service.execute({
      request_id: "forget:abandoned",
      authorization: { kind: "confirmed_preview", plan_digest: digest! },
      actor: "user:test",
      recover_running: true,
    });
    assert.equal(recovered.status, "succeeded");
    assert.equal(await restarted.get(exactViewRef(source!)), undefined);
  } finally {
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial cleanup failure never purges core content and resumes durably after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-forget-restart-"));
  const database = join(directory, "views.sqlite");
  const repository = new SqliteViewRepository(database);
  const flaky = new MemoryCleanupStore("vector", [], true);
  let source: View;
  let digest: string;
  try {
    source = await commit(repository, rawDraft(
      "view:raw:restart",
      "source:restart",
      normalPolicy(),
      { text: "restart secret" },
    ));
    flaky.add(source);
    const service = forgetService(repository, { cleanup_stores: [flaky] });
    const preview = await service.request({
      request_id: "forget:restart",
      actor: "user:test",
      requested_at: "2026-07-26T20:30:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(source) }],
      mixed_source_rule: "purge",
    });
    digest = preview.plan.plan_digest;
    await assert.rejects(
      service.execute({
        request_id: preview.plan.request_id,
        authorization: { kind: "confirmed_preview", plan_digest: digest },
        actor: "user:test",
      }),
      (error: unknown) => error instanceof PrivacyForgetError && error.code === "forget_cleanup_failed",
    );
    assert.ok(await repository.get(exactViewRef(source)));
    const failed = await service.inspect(preview.plan.request_id, "user:test");
    assert.equal(failed.status, "failed");
    assert.equal(failed.receipts.find(item => item.store_id === "vector")?.status, "failed");
    assert.equal(failed.receipts.find(item => item.store_id === "view-store")?.status, "pending");
  } finally {
    repository.close();
  }

  const restarted = new SqliteViewRepository(database);
  try {
    const service = forgetService(restarted, { cleanup_stores: [flaky] });
    const recovered = await service.execute({
      request_id: "forget:restart",
      authorization: { kind: "confirmed_preview", plan_digest: digest! },
      actor: "user:test",
    });
    assert.equal(recovered.status, "succeeded");
    assert.equal(flaky.has(exactViewRef(source!)), false);
    assert.equal(await restarted.get(exactViewRef(source!)), undefined);
    assert.equal((await service.inspect("forget:restart", "user:test")).status, "succeeded");
  } finally {
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite Forget rolls back identity retirement and every core deletion when payload purge fails", async () => {
  await withRepository(async (repository, database) => {
    const draft = rawDraft(
      "view:raw:rollback-forget",
      "source:rollback-forget",
      normalPolicy(),
      { text: "payload must survive the failed transaction" },
    );
    const source = (await repository.commit({
      draft,
      expected_revision: 0,
      idempotency_key: "capture:rollback-forget",
    })).view;
    const service = forgetService(repository);
    const preview = await service.request({
      request_id: "forget:core-rollback",
      actor: "user:test",
      requested_at: "2026-07-26T20:50:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(source) }],
      mixed_source_rule: "purge",
    });

    const sabotage = new DatabaseSync(database);
    try {
      sabotage.exec(`
        create trigger fail_forget_payload_delete
        before delete on view_revisions_v1
        begin
          select raise(abort, 'injected Forget payload failure');
        end;
      `);
    } finally {
      sabotage.close();
    }

    await assert.rejects(
      service.execute({
        request_id: preview.plan.request_id,
        authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
        actor: "user:test",
      }),
      (error: unknown) => error instanceof PrivacyForgetError && error.code === "forget_commit_failed",
    );
    assert.ok(await repository.get(exactViewRef(source)));
    assert.deepEqual(await repository.resolveLatest(source.id), exactViewRef(source));

    const afterFailure = new DatabaseSync(database);
    try {
      const retired = afterFailure.prepare(`
        select count(*) as count from privacy_forgotten_view_ids_v1 where view_id = ?
      `).get(source.id) as { count: number };
      const idempotency = afterFailure.prepare(`
        select count(*) as count from view_idempotency_v1 where idempotency_key = ?
      `).get("capture:rollback-forget") as { count: number };
      assert.equal(Number(retired.count), 0);
      assert.equal(Number(idempotency.count), 1);
      afterFailure.exec("drop trigger fail_forget_payload_delete");
    } finally {
      afterFailure.close();
    }

    const recovered = await service.execute({
      request_id: preview.plan.request_id,
      authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
      actor: "user:test",
    });
    assert.equal(recovered.status, "succeeded");
    assert.equal(await repository.get(exactViewRef(source)), undefined);
  });
});

function forgetService(
  repository: SqliteViewRepository,
  options: { cleanup_stores?: ForgetCleanupStore[]; rebuilder?: ForgetRebuildPort } = {},
) {
  let tick = 0;
  return new PrivacyForgetService({
    views: repository,
    requests: repository,
    cleanup_stores: options.cleanup_stores,
    rebuilder: options.rebuilder,
    now: () => new Date(Date.parse("2026-07-26T21:00:00.000Z") + tick++ * 1_000).toISOString(),
  });
}

class MemoryCleanupStore implements ForgetCleanupStore {
  private readonly refs = new Set<string>();

  constructor(
    readonly id: string,
    initial: View[],
    private failAfterCleanup = false,
  ) {
    for (const view of initial) this.add(view);
  }

  add(view: View): void {
    this.refs.add(key(exactViewRef(view)));
  }

  has(ref: ExactViewRef): boolean {
    return this.refs.has(key(ref));
  }

  async purge(input: { request_id: string; plan: ForgetPlan }): Promise<void> {
    for (const impact of input.plan.impact) this.refs.delete(key(impact.ref));
    if (this.failAfterCleanup) {
      this.failAfterCleanup = false;
      throw new Error("injected vector acknowledgement failure");
    }
  }
}

class SafeRebuilder implements ForgetRebuildPort {
  async rebuild(input: Parameters<ForgetRebuildPort["rebuild"]>[0]): Promise<ViewDraft> {
    return parseViewDraft({
      id: `view:rebuilt:${input.affected.id}`,
      name: input.affected.name,
      purpose: input.affected.purpose,
      schema: input.affected.schema,
      role: "derived",
      time: { created_at: "2026-07-26T20:04:00.000Z" },
      representation: {
        form: "inline",
        kind: "rebuilt_summary",
        value: { summary: "rebuilt only from safe retained evidence" },
      },
      materialization: {
        primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      },
      relations: input.retained_inputs.map(view => ({ type: "derived_from", target: exactViewRef(view) })),
      provenance: {
        inputs: input.retained_inputs.map(exactViewRef),
        actor: "forget-rebuilder",
        trace_id: input.request_id,
      },
      policy: input.affected.policy,
    });
  }
}

async function withRepository(
  run: (repository: SqliteViewRepository, database: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-privacy-forget-"));
  const database = join(directory, "views.sqlite");
  const repository = new SqliteViewRepository(database);
  try {
    await run(repository, database);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function commit(repository: SqliteViewRepository, draft: ViewDraft): Promise<View> {
  return (await repository.commit({ draft, expected_revision: 0 })).view;
}

function rawDraft(
  id: string,
  sourceId: string,
  policy: ViewPolicy,
  options: { text: string; identity?: "stable_source" | "occurrence"; strict?: boolean },
): ViewDraft {
  const strictSchema = {
    name: "capture.privacy.page",
    version: 1,
    mode: "strict" as const,
    dialect: "https://json-schema.org/draft/2020-12/schema" as const,
    json_schema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    search_projection: {
      version: 1 as const,
      fields: [{ path: "/representation/value/text", category: "text" as const }],
    },
  };
  return parseViewDraft({
    id,
    name: id,
    purpose: "Preserve source evidence for privacy lifecycle tests",
    schema: options.strict ? strictSchema : {
      name: "capture.privacy.page",
      version: 1,
      mode: "freeform",
      search_projection: {
        version: 1,
        fields: [{ path: "/representation/value/text", category: "text" }],
      },
    },
    role: "raw",
    time: { observed_at: timestamp, created_at: timestamp },
    representation: { form: "inline", kind: "source_record", value: { text: options.text } },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "browser",
        connection_id: "browser:default",
        source_id: sourceId,
        source_kind: "page",
        identity: options.identity ?? "occurrence",
        assertion: "direct",
      },
    },
    policy,
  });
}

function derivedDraft(
  id: string,
  inputs: View[],
  text: string,
  policy: ViewPolicy = normalPolicy(),
): ViewDraft {
  return parseViewDraft({
    id,
    name: id,
    purpose: "Create a privacy lifecycle derived result",
    schema: {
      name: "analysis.privacy.summary",
      version: 1,
      mode: "freeform",
      search_projection: {
        version: 1,
        fields: [{ path: "/representation/value/text", category: "text" }],
      },
    },
    role: "derived",
    time: { created_at: timestamp },
    representation: { form: "inline", kind: "summary", value: { text } },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    relations: inputs.map(view => ({ type: "derived_from", target: exactViewRef(view) })),
    provenance: { inputs: inputs.map(exactViewRef), actor: "operator:test", operator_run_id: `run:${id}` },
    policy,
  });
}

function normalPolicy(labels: string[] = []): ViewPolicy {
  return {
    owner: "user:test",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: true,
    labels,
  };
}

function key(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

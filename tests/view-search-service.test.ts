import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  PrivacyForgetService,
  exactViewRef,
  parseViewDraft,
  type ExactViewRef,
  type View,
  type ViewDraft,
} from "@info/view";
import {
  SearchError,
  SearchRequestV1Schema,
  SearchService,
  fuseSearchCandidates,
  type SearchRequestV1,
  type SearchServiceDependencies,
  type SearchTraceEvent,
  type ViewReadAuthorizationPort,
} from "../packages/search/index.js";

const createdAt = "2026-07-27T01:00:00.000Z";

test("Search request contract rejects ambiguity, duplicate modes, semantic mismatch, and unbounded all-visible scope", () => {
  const valid = request({ scope: { kind: "all_visible", max_nodes: 10 }, modes: ["keyword"] });
  assert.equal(SearchRequestV1Schema.parse(valid).failure_mode, "require_all");
  assert.throws(() => SearchRequestV1Schema.parse({ ...valid, unknown: true }));
  assert.throws(() => SearchRequestV1Schema.parse({ ...valid, modes: ["keyword", "keyword"] }));
  assert.throws(() => SearchRequestV1Schema.parse({ ...valid, modes: ["semantic"] }));
  assert.throws(() => SearchRequestV1Schema.parse({ ...valid, scope: { kind: "all_visible" } }));
  assert.throws(() => SearchRequestV1Schema.parse({ ...valid, query: { text: "---" } }));
  assert.throws(() => SearchRequestV1Schema.parse({
    ...valid,
    scope: { kind: "exact_views", refs: [{ view_id: "view:x", revision: 1, latest: true }] },
  }));
});

test("rrf@1 fuses one-based ranks and weights with exact-ref tie breaking", () => {
  const candidate = (viewId: string) => ({
    ref: { view_id: viewId, revision: 1 },
    owner_ref: { view_id: viewId, revision: 1 },
    matched_schema: { name: "test.search.document", version: 1 },
    representation_kind: "search_document",
    matches: [{
      location: { kind: "envelope" as const, path: "/name" },
      value_digest: "0".repeat(64),
      modes: ["keyword" as const],
    }],
  });
  const equal = fuseSearchCandidates({
    modes: ["keyword", "relation"],
    candidates: { keyword: [candidate("view:a"), candidate("view:b")], relation: [candidate("view:b"), candidate("view:a")] },
    weights: {},
    k: 60,
  });
  assert.deepEqual(equal.map(hit => hit.ref.view_id), ["view:a", "view:b"]);
  assert.equal(equal[0]?.scores.fused, 1 / 61 + 1 / 62);
  const relationWeighted = fuseSearchCandidates({
    modes: ["keyword", "relation"],
    candidates: { keyword: [candidate("view:a"), candidate("view:b")], relation: [candidate("view:b"), candidate("view:a")] },
    weights: { relation: 2 },
    k: 60,
  });
  assert.deepEqual(relationWeighted.map(hit => hit.ref.view_id), ["view:b", "view:a"]);
});

test("authorized subgraph Search returns location evidence, relation rank, RRF, and stable cursor pages without denied leakage", async () => {
  await withRepository(async repository => {
    const root = await commit(repository, draft({ id: "view:space", name: "English Learning Space", owner: "user:reader" }));
    const lesson = await commit(repository, draft({
      id: "view:lesson",
      name: "Lesson notes",
      owner: "user:reader",
      segments: ["English pronunciation practice", "English listening practice"],
      relation: { type: "contains", target: exactViewRef(root) },
    }));
    const deniedBridge = await commit(repository, draft({
      id: "view:denied-bridge",
      name: "Denied bridge",
      owner: "user:other",
      segments: ["English private bridge"],
      relation: { type: "contains", target: exactViewRef(root) },
    }));
    await commit(repository, draft({
      id: "view:behind-denial",
      name: "Hidden descendant",
      owner: "user:reader",
      segments: ["English English English secret"],
      relation: { type: "contains", target: exactViewRef(deniedBridge) },
    }));
    await commit(repository, draft({
      id: "view:outside",
      name: "English English English outside",
      owner: "user:reader",
      segments: ["English English English outside scope"],
    }));

    const events: SearchTraceEvent[] = [];
    const service = searchService(repository, events);
    const base = request({
      scope: {
        kind: "subgraph",
        roots: [exactViewRef(root)],
        direction: "incoming",
        relation_types: ["contains"],
        max_depth: 4,
        max_nodes: 10,
      },
      modes: ["keyword", "relation"],
      limit: 1,
    });
    const first = await service.search({ request_id: "search:page:1", principal: { id: "user:reader" }, request: base });
    assert.equal(first.hits.length, 1);
    assert.ok(first.next_cursor);
    const second = await service.search({
      request_id: "search:page:2",
      principal: { id: "user:reader" },
      request: { ...base, page: { limit: 1, cursor: first.next_cursor } },
    });
    const hits = [...first.hits, ...second.hits];
    assert.deepEqual(hits.map(hit => hit.ref.view_id), [root.id, lesson.id]);
    assert.ok(hits.every(hit => hit.scores.keyword_rank && hit.scores.relation_rank && hit.scores.fused > 0));
    const lessonHit = hits.find(hit => hit.ref.view_id === lesson.id)!;
    assert.deepEqual(lessonHit.matches
      .filter(match => match.location.kind === "representation")
      .map(match => match.location.kind === "representation" ? match.location.path : ""), [
      "/representation/value/segments/0/text",
      "/representation/value/segments/1/text",
    ]);
    assert.equal(lessonHit.path?.length, 1);
    assert.equal(lessonHit.path?.[0]?.type, "contains");
    assert.ok(lessonHit.path?.[0]?.relation_id);
    assert.ok(!JSON.stringify({ hits, modes: first.modes }).includes("outside"));
    assert.ok(!JSON.stringify({ hits, modes: first.modes }).includes("behind-denial"));
    assert.ok(!JSON.stringify({ hits, modes: first.modes }).includes("denied-bridge"));

    await assert.rejects(
      service.search({
        request_id: "search:cursor:mismatch",
        principal: { id: "user:reader" },
        request: { ...base, query: { text: "changed" }, page: { limit: 1, cursor: first.next_cursor } },
      }),
      (error: unknown) => error instanceof SearchError && error.code === "cursor_request_mismatch",
    );
    assert.equal(events.filter(event => event.type === "search.started").length, 3);
    assert.equal(events.filter(event => event.type === "search.succeeded").length, 2);
    assert.equal(events.at(-1)?.type, "search.failed");
  });
});

test("all-visible bounds count only authorized Views and exact denied scope fails before retrieval", async () => {
  await withRepository(async repository => {
    const allowed = await commit(repository, draft({ id: "view:allowed", name: "English allowed", owner: "user:reader" }));
    const denied = await commit(repository, draft({ id: "view:denied", name: "English denied", owner: "user:other" }));
    const service = searchService(repository, []);
    const visible = await service.search({
      request_id: "search:visible",
      principal: { id: "user:reader" },
      request: request({ scope: { kind: "all_visible", max_nodes: 1 }, modes: ["keyword"] }),
    });
    assert.deepEqual(visible.hits.map(hit => hit.ref), [exactViewRef(allowed)]);
    await assert.rejects(
      service.search({
        request_id: "search:denied",
        principal: { id: "user:reader" },
        request: request({ scope: { kind: "exact_views", refs: [exactViewRef(denied)] }, modes: ["keyword"] }),
      }),
      (error: unknown) => error instanceof SearchError && error.code === "view_read_forbidden",
    );
  });
});

test("all-visible paging authorizes every batch so denied refs cannot exhaust max_nodes", async () => {
  const denied = Array.from({ length: 256 }, (_, index) => ({
    view_id: `view:denied:${String(index).padStart(3, "0")}`,
    revision: 1,
  }));
  const allowed = { view_id: "view:z-allowed", revision: 1 };
  const events: SearchTraceEvent[] = [];
  const service = new SearchService({
    authorization: {
      authorize: async input => input.refs.map(ref => ({
        ref,
        status: ref.view_id === allowed.view_id ? "allowed" as const : "denied" as const,
      })),
    },
    scope_source: {
      listLatestExactRefs: async input => input.after_view_id
        ? { refs: [allowed] }
        : { refs: denied, next_after_view_id: denied.at(-1)!.view_id },
      readRelations: async () => [],
    },
    descriptors: {
      describe: async refs => refs.map(ref => ({
        ref,
        schema: { name: "test.search.document", version: 1 },
        representation_kind: "search_document",
      })),
    },
    keyword: {
      retrieve: async input => input.refs.map(ref => ({
        ref,
        owner_ref: ref,
        matched_schema: { name: "test.search.document", version: 1 },
        representation_kind: "search_document",
        matches: [{
          location: { kind: "envelope", path: "/name" },
          snippet: "English",
          value_digest: "0".repeat(64),
          modes: ["keyword"],
        }],
      })),
    },
    observer: { record: async event => { events.push(event); } },
    now: () => "2026-07-27T04:00:00.000Z",
  });
  const result = await service.search({
    request_id: "search:visible:paged",
    principal: { id: "user:reader" },
    request: request({ scope: { kind: "all_visible", max_nodes: 1 }, modes: ["keyword"] }),
  });
  assert.deepEqual(result.hits.map(hit => hit.ref), [allowed]);
  assert.equal(events.find(event => event.type === "scope.resolved")?.count, 1);
});

test("semantic unavailability is explicit only when partial mode is requested", async () => {
  await withRepository(async repository => {
    const view = await commit(repository, draft({ id: "view:partial", name: "English partial", owner: "user:reader" }));
    const service = searchService(repository, []);
    const partialRequest = request({
      scope: { kind: "exact_views", refs: [exactViewRef(view)] },
      modes: ["keyword", "semantic"],
      failureMode: "allow_explicit_partial",
    });
    const partial = await service.search({ request_id: "search:partial", principal: { id: "user:reader" }, request: partialRequest });
    assert.deepEqual(partial.modes, [
      { mode: "keyword", status: "executed", candidate_count: 1 },
      { mode: "semantic", status: "unavailable", code: "semantic_not_configured" },
    ]);
    await assert.rejects(
      service.search({
        request_id: "search:required",
        principal: { id: "user:reader" },
        request: { ...partialRequest, failure_mode: "require_all" },
      }),
      (error: unknown) => error instanceof SearchError && error.code === "semantic_not_configured",
    );
  });
});

test("a requested reranker failure fails the Search instead of returning RRF output", async () => {
  await withRepository(async repository => {
    const view = await commit(repository, draft({ id: "view:rerank", name: "English rerank", owner: "user:reader" }));
    const service = searchService(repository, [], {
      reranker: { rerank: async () => { throw new Error("injected reranker failure"); } },
    });
    const base = request({ scope: { kind: "exact_views", refs: [exactViewRef(view)] }, modes: ["keyword"] });
    await assert.rejects(
      service.search({
        request_id: "search:rerank:failure",
        principal: { id: "user:reader" },
        request: SearchRequestV1Schema.parse({
          ...base,
          reranker: { descriptor: { id: "reranker:test", revision: 1 }, candidate_limit: 10 },
        }),
      }),
      (error: unknown) => error instanceof SearchError && error.code === "reranker_failed",
    );
  });
});

test("a retriever cannot return refs or paths outside the frozen authorized scope", async () => {
  await withRepository(async repository => {
    const allowed = await commit(repository, draft({ id: "view:retriever-allowed", name: "English allowed", owner: "user:reader" }));
    const outside = await commit(repository, draft({ id: "view:retriever-outside", name: "English outside", owner: "user:other" }));
    const service = searchService(repository, [], {
      keyword: {
        retrieve: async () => [{
          ref: exactViewRef(outside),
          owner_ref: exactViewRef(outside),
          matched_schema: { name: outside.schema.name, version: outside.schema.version },
          representation_kind: outside.representation.kind,
          matches: [{
            location: { kind: "envelope", path: "/name" },
            snippet: "English outside",
            value_digest: "0".repeat(64),
            modes: ["keyword"],
          }],
        }],
      },
    });
    await assert.rejects(
      service.search({
        request_id: "search:retriever:outside",
        principal: { id: "user:reader" },
        request: request({ scope: { kind: "exact_views", refs: [exactViewRef(allowed)] }, modes: ["keyword"] }),
      }),
      (error: unknown) => error instanceof SearchError && error.code === "retrieval_failed",
    );
  });
});

test("location FTS units survive reindex and reopen, and Privacy Forget removes content plus paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-search-vertical-"));
  const path = join(directory, "views.sqlite");
  let repository = new SqliteViewRepository(path);
  try {
    const root = await commit(repository, draft({ id: "view:durable-root", name: "English durable root", owner: "user:reader" }));
    const child = await commit(repository, draft({
      id: "view:durable-child",
      name: "Durable child",
      owner: "user:reader",
      segments: ["English durable first", "English durable second"],
      relation: { type: "contains", target: exactViewRef(root) },
    }));
    const before = await searchService(repository, []).search({
      request_id: "search:durable:before",
      principal: { id: "user:reader" },
      request: subgraphRequest(root),
    });
    assert.deepEqual(before.hits.map(hit => hit.ref.view_id), [root.id, child.id]);

    const database = new DatabaseSync(path);
    const unit = database.prepare(`
      select search_unit_id from view_search_units_v2
      where view_id = ? order by ordinal, expanded_path limit 1
    `).get(child.id) as { search_unit_id: number };
    database.prepare("delete from view_search_unit_fts_v2 where rowid = ?").run(Number(unit.search_unit_id));
    database.close();
    const report = await repository.reindexSearch({ run_id: "search:reindex:units", requested_at: "2026-07-27T02:00:00.000Z" });
    assert.equal(report.indexed, 1);
    repository.close();

    repository = new SqliteViewRepository(path);
    const reopened = await searchService(repository, []).search({
      request_id: "search:durable:reopen",
      principal: { id: "user:reader" },
      request: subgraphRequest(root),
    });
    assert.deepEqual(reopened.hits, before.hits);

    let tick = 0;
    const forget = new PrivacyForgetService({
      views: repository,
      requests: repository,
      now: () => new Date(Date.parse("2026-07-27T03:00:00.000Z") + tick++ * 1_000).toISOString(),
    });
    const preview = await forget.request({
      request_id: "forget:search-child",
      actor: "user:reader",
      requested_at: "2026-07-27T03:00:00.000Z",
      targets: [{ kind: "exact_view", ref: exactViewRef(child) }],
      mixed_source_rule: "purge",
    });
    await forget.execute({
      request_id: preview.plan.request_id,
      authorization: { kind: "confirmed_preview", plan_digest: preview.plan.plan_digest },
      actor: "user:reader",
    });
    const afterForget = await searchService(repository, []).search({
      request_id: "search:durable:forgotten",
      principal: { id: "user:reader" },
      request: subgraphRequest(root),
    });
    assert.deepEqual(afterForget.hits.map(hit => hit.ref.view_id), [root.id]);
    const audit = new DatabaseSync(path);
    assert.equal(Number((audit.prepare("select count(*) as count from view_search_units_v2 where view_id = ?").get(child.id) as { count: number }).count), 0);
    assert.equal(Number((audit.prepare("select count(*) as count from view_relations_v1 where source_view_id = ? or target_view_id = ?").get(child.id, child.id) as { count: number }).count), 0);
    audit.close();
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function searchService(
  repository: SqliteViewRepository,
  events: SearchTraceEvent[],
  overrides: Partial<SearchServiceDependencies> = {},
): SearchService {
  const authorization: ViewReadAuthorizationPort = {
    authorize: async input => Promise.all(input.refs.map(async ref => {
      const view = await repository.get(ref);
      return {
        ref,
        status: !view ? "missing" as const : view.policy.owner === input.principal.id ? "allowed" as const : "denied" as const,
        ...(!view || view.policy.owner === input.principal.id ? {} : { code: "owner_mismatch" }),
      };
    })),
  };
  return new SearchService({
    authorization,
    scope_source: repository.search,
    descriptors: repository.search,
    keyword: repository.search,
    observer: { record: async event => { events.push(event); } },
    now: () => "2026-07-27T04:00:00.000Z",
    ...overrides,
  });
}

function request(input: {
  scope: SearchRequestV1["scope"];
  modes: SearchRequestV1["modes"];
  limit?: number;
  failureMode?: SearchRequestV1["failure_mode"];
}): SearchRequestV1 {
  const semantic = input.modes.includes("semantic")
    ? { embedding_profile: { id: "embedding:test", revision: 1 } }
    : undefined;
  return SearchRequestV1Schema.parse({
    contract_version: 1,
    query: { text: "English" },
    scope: input.scope,
    target: { envelope: true, internal: true, related_views: input.modes.includes("relation") },
    modes: input.modes,
    ...(semantic ? { semantic } : {}),
    fusion: { strategy: "rrf@1", k: 60, weights: {} },
    failure_mode: input.failureMode ?? "require_all",
    page: { limit: input.limit ?? 100 },
  });
}

function subgraphRequest(root: View): SearchRequestV1 {
  return request({
    scope: {
      kind: "subgraph",
      roots: [exactViewRef(root)],
      direction: "incoming",
      relation_types: ["contains"],
      max_depth: 3,
      max_nodes: 10,
    },
    modes: ["keyword", "relation"],
  });
}

async function commit(repository: SqliteViewRepository, input: ViewDraft): Promise<View> {
  return (await repository.commit({ draft: input, expected_revision: 0 })).view;
}

function draft(input: {
  id: string;
  name: string;
  owner: string;
  segments?: string[];
  relation?: { type: string; target: ExactViewRef };
}): ViewDraft {
  return parseViewDraft({
    id: input.id,
    name: input.name,
    purpose: "Search authorization and location evidence fixture",
    aliases: [],
    schema: {
      name: "test.search.document",
      version: 1,
      mode: "freeform",
      search_projection: {
        version: 1,
        fields: [
          { path: "/name", category: "title" },
          { path: "/representation/value/segments/*/text", category: "text" },
        ],
      },
    },
    role: "raw",
    time: { observed_at: createdAt, created_at: createdAt },
    representation: {
      form: "inline",
      kind: "search_document",
      value: { segments: (input.segments ?? []).map(text => ({ text, hidden: "undeclared sibling" })) },
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    relations: input.relation ? [input.relation] : [],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test-search",
        connection_id: "test-search:default",
        source_id: input.id,
        source_kind: "document",
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: {
      owner: input.owner,
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      allow_local_search: true,
      labels: [],
    },
  });
}

async function withRepository(run: (repository: SqliteViewRepository) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-search-service-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  try {
    await run(repository);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepositoryViewReadAuthorizer,
  ViewGraphProjectionOperationError,
  projectAuthorizedViewGraph,
} from "@info/operations";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  VIEW_GRAPH_MAX_SCANNED_EDGES,
  ViewGraphProjectionRequestSchema,
  ViewGraphProjectionResultSchema,
  ViewRepositoryError,
  ViewValidationError,
  exactViewRef,
  parseViewDraft,
  type ExactViewRef,
  type ViewGraphProjectionSource,
  type ViewGraphSnapshotReader,
  type ViewDraft,
} from "@info/view";
import { ViewPackageError, runViewPackageConformance } from "@info/view-package";
import {
  APPLICATION_SPACE_COMPOSITION_RELATION,
  APPLICATION_SPACE_MEMBERSHIP_RELATION,
  APPLICATION_SPACE_REPRESENTATION_KIND,
  applicationSpaceFixtures,
  applicationSpaceRelations,
  applicationSpaceSchema,
  applicationSpaceViewPackage,
  normalizeApplicationSpaceEntries,
  type ApplicationSpaceEntry,
} from "../view-packages/application-space/index.ts";

const createdAt = "2026-07-27T08:00:00.000Z";
const reader = "user:reader";

test("Application Space View Package is strict and binds ordinary read Operations", () => {
  const report = runViewPackageConformance({
    package: applicationSpaceViewPackage,
    fixtures: applicationSpaceFixtures,
    operations: new Set(["view.get", "view.graph.project"]),
    renderers: new Set(["renderer.web.json@1@1"]),
    transformations: new Map(),
  });
  assert.deepEqual(report, {
    package_id: "view-package.application-space",
    package_version: 1,
    schemas: 1,
    fixtures: 1,
    methods: 2,
    renderers: 1,
    evolutions: 0,
  });
  assert.equal(applicationSpaceViewPackage.schema({ name: "application.space", version: 1 }).mode, "strict");
  assert.throws(() => normalizeApplicationSpaceEntries([{
    ref: { view_id: "view:entry", revision: 1 },
    semantics: "unknown",
  } as any]));
  assert.throws(() => parseViewDraft({
    ...applicationDraft("view:space:invalid", []),
    representation: {
      form: "inline",
      kind: APPLICATION_SPACE_REPRESENTATION_KIND,
      media_type: "application/json",
      value: { version: 1, entries: [], mutable_database_id: "forbidden" },
      metadata: {},
    },
  }));
  assert.throws(
    () => parseViewDraft({
      ...applicationDraft("view:space:whitespace-ref", []),
      representation: {
        form: "inline",
        kind: APPLICATION_SPACE_REPRESENTATION_KIND,
        media_type: "application/json",
        value: {
          version: 1,
          entries: [{ ref: { view_id: " \t ", revision: 1 }, semantics: "membership" }],
        },
        metadata: {},
      },
    }),
    (error: unknown) => error instanceof ViewValidationError && error.code === "representation_schema_mismatch",
  );
  assert.throws(
    () => runViewPackageConformance({
      package: applicationSpaceViewPackage,
      fixtures: [{ ...applicationSpaceFixtures[0], relations: [] }],
      operations: new Set(["view.get", "view.graph.project"]),
      renderers: new Set(["renderer.web.json@1@1"]),
      transformations: new Map(),
    }),
    (error: unknown) => error instanceof ViewPackageError && error.code === "invalid_fixture",
  );
});

test("Application Space commit admission rejects missing, extra, and mismatched managed relations", async () => {
  await withRepository(async views => {
    const member = await commit(views, memberDraft("view:member:relation-invariant", reader));
    const extra = await commit(views, memberDraft("view:member:relation-extra", reader));
    const entries: ApplicationSpaceEntry[] = [{ ref: exactViewRef(member), semantics: "membership" }];
    const valid = applicationDraft("view:space:relation-invariant", entries);
    const cases: ViewDraft[] = [
      { ...valid, id: "view:space:missing-relation", relations: [] },
      {
        ...valid,
        id: "view:space:extra-relation",
        relations: [
          ...valid.relations,
          {
            type: APPLICATION_SPACE_MEMBERSHIP_RELATION,
            target: exactViewRef(extra),
            metadata: { application_semantics: "membership" },
          },
        ],
      },
      {
        ...valid,
        id: "view:space:mismatched-relation",
        relations: [{
          type: APPLICATION_SPACE_COMPOSITION_RELATION,
          target: exactViewRef(member),
          metadata: { application_semantics: "composition" },
        }],
      },
    ];
    for (const draft of cases) {
      await assert.rejects(
        views.commit({ draft, expected_revision: 0 }),
        (error: unknown) => error instanceof ViewRepositoryError
          && error.code === "invalid_request"
          && error.cause instanceof ViewValidationError
          && error.cause.code === "relation_projection_mismatch",
      );
    }
  });
});

test("Application Space attach, detach, and multi-parent reuse are immutable ordinary View revisions", async () => {
  await withRepository(async views => {
    const member = await commit(views, memberDraft("view:member:shared", reader));
    const detached = await commit(views, memberDraft("view:member:detached", reader));
    const attached = await commit(views, memberDraft("view:member:attached", reader));
    const firstEntries: ApplicationSpaceEntry[] = [
      { ref: exactViewRef(member), semantics: "membership" },
      { ref: exactViewRef(detached), semantics: "composition" },
    ];
    const first = await commit(views, applicationDraft("view:space:one", firstEntries));
    const second = await commit(views, applicationDraft("view:space:two", [
      { ref: exactViewRef(member), semantics: "membership" },
    ]));
    const nextEntries: ApplicationSpaceEntry[] = [
      { ref: exactViewRef(member), semantics: "membership" },
      { ref: exactViewRef(attached), semantics: "composition" },
    ];
    const evolved = await commit(views, {
      ...applicationDraft(first.id, nextEntries),
      relations: [
        ...applicationSpaceRelations(nextEntries),
        { type: "supersedes", target: exactViewRef(first), metadata: {} },
      ],
    }, 1);

    assert.deepEqual(await views.get(exactViewRef(first)), first);
    assert.deepEqual(await views.get(exactViewRef(second)), second);
    assert.deepEqual(await views.get(exactViewRef(member)), member);
    const originalRelations = await views.traverseRelations({ ref: exactViewRef(first), direction: "outgoing", limit: 20 });
    const evolvedRelations = await views.traverseRelations({ ref: exactViewRef(evolved), direction: "outgoing", limit: 20 });
    assert.ok(originalRelations.some(relation => sameRef(relation.target, exactViewRef(detached))));
    assert.ok(!evolvedRelations.some(relation => sameRef(relation.target, exactViewRef(detached))));
    assert.ok(evolvedRelations.some(relation => sameRef(relation.target, exactViewRef(attached))));
    const parents = await views.traverseRelations({ ref: exactViewRef(member), direction: "incoming", limit: 20 });
    assert.deepEqual(new Set(parents
      .filter(relation => relation.type === APPLICATION_SPACE_MEMBERSHIP_RELATION)
      .map(relation => `${relation.source.view_id}@${relation.source.revision}`)), new Set([
      `${first.id}@${first.revision}`,
      `${second.id}@${second.revision}`,
      `${evolved.id}@${evolved.revision}`,
    ]));
  });
});

test("authorized SQLite graph projection handles exact cycles and redacts denied branches without leakage", async () => {
  await withRepository(async views => {
    const hidden = await commit(views, memberDraft("view:hidden:descendant", reader));
    const denied = await commit(views, {
      ...memberDraft("view:denied:bridge", "user:other"),
      name: "Private bridge label",
      relations: [{ type: APPLICATION_SPACE_MEMBERSHIP_RELATION, target: exactViewRef(hidden), metadata: {} }],
    });
    const rootRef = { view_id: "view:space:cycle", revision: 1 };
    const memberRef = { view_id: "view:member:cycle", revision: 1 };
    const entries: ApplicationSpaceEntry[] = [
      { ref: memberRef, semantics: "membership" },
      { ref: exactViewRef(denied), semantics: "membership" },
    ];
    const batch = await views.commitBatch([
      { draft: applicationDraft(rootRef.view_id, entries), expected_revision: 0 },
      {
        draft: {
          ...memberDraft(memberRef.view_id, reader),
          relations: [{ type: APPLICATION_SPACE_MEMBERSHIP_RELATION, target: rootRef, metadata: {} }],
        },
        expected_revision: 0,
      },
    ]);
    const root = batch.results.find(result => result.view.id === rootRef.view_id)!.view;
    const member = batch.results.find(result => result.view.id === memberRef.view_id)!.view;

    const result = await project(views, {
      roots: [exactViewRef(root)],
      direction: "outgoing",
      edge_types: [APPLICATION_SPACE_MEMBERSHIP_RELATION],
      max_depth: 5,
      max_nodes: 10,
      max_edges: 10,
    });
    assert.deepEqual(result.nodes.map(node => node.ref), [exactViewRef(root), exactViewRef(member)]);
    assert.deepEqual(result.nodes.map(node => node.depth), [0, 1]);
    assert.equal(result.edges.length, 2);
    assert.equal(result.redacted_boundary, true);
    assert.deepEqual(result.truncation, { truncated: false, reasons: [] });
    const serialized = JSON.stringify(result);
    for (const secret of [denied.id, hidden.id, denied.name, "Private bridge label"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(serialized.includes("representation.value"), false);
    assert.equal("value" in result.nodes[0]!.representation, false);
  });
});

test("authorized node and edge bounds truncate deterministically without counting denied discoveries", async () => {
  await withRepository(async views => {
    const allowedA = await commit(views, memberDraft("view:allowed:a", reader));
    const allowedB = await commit(views, memberDraft("view:allowed:b", reader));
    const denied = await commit(views, memberDraft("view:denied:does-not-count", "user:other"));
    const entries: ApplicationSpaceEntry[] = [allowedA, allowedB, denied].map(view => ({
      ref: exactViewRef(view),
      semantics: "membership" as const,
    }));
    const root = await commit(views, applicationDraft("view:space:bounds", entries));
    const base = {
      roots: [exactViewRef(root)],
      direction: "outgoing" as const,
      edge_types: [APPLICATION_SPACE_MEMBERSHIP_RELATION],
      max_depth: 2,
    };

    const nodeLimited = await project(views, { ...base, max_nodes: 1, max_edges: 10 });
    assert.deepEqual(nodeLimited.nodes.map(node => node.ref), [exactViewRef(root)]);
    assert.deepEqual(nodeLimited.truncation, { truncated: true, reasons: ["node_limit"] });
    assert.deepEqual(nodeLimited.frontier, [{ ref: exactViewRef(root), reason: "node_limit" }]);
    assert.equal(nodeLimited.redacted_boundary, true);

    const edgeLimitedA = await project(views, { ...base, max_nodes: 10, max_edges: 1 });
    const edgeLimitedB = await project(views, { ...base, max_nodes: 10, max_edges: 1 });
    assert.deepEqual(edgeLimitedB, edgeLimitedA);
    assert.equal(edgeLimitedA.edges.length, 1);
    assert.deepEqual(edgeLimitedA.truncation, { truncated: true, reasons: ["edge_limit"] });
    assert.deepEqual(edgeLimitedA.frontier, [{ ref: exactViewRef(root), reason: "edge_limit" }]);

    const depthLimited = await project(views, { ...base, max_depth: 0, max_nodes: 10, max_edges: 10 });
    assert.deepEqual(depthLimited.frontier, [{ ref: exactViewRef(root), reason: "depth_limit" }]);
    assert.deepEqual(depthLimited.truncation, { truncated: true, reasons: ["depth_limit"] });

    const rootLimited = await project(views, {
      ...base,
      roots: [exactViewRef(root), exactViewRef(allowedA)],
      max_nodes: 1,
      max_edges: 10,
    });
    assert.equal(rootLimited.nodes.length, 1);
    assert.deepEqual(rootLimited.frontier, [{ ref: exactViewRef(root), reason: "node_limit" }]);
    assert.deepEqual(rootLimited.truncation, { truncated: true, reasons: ["node_limit"] });
  });
});

test("paged SQLite traversal reaches an authorized edge after denied pages without consuming result bounds", async () => {
  await withRepository(async views => {
    const deniedDrafts = Array.from({ length: 270 }, (_, index) => memberDraft(
      `view:denied:paged:${String(index).padStart(3, "0")}`,
      "user:other",
    ));
    const deniedBatch = await views.commitBatch(deniedDrafts.map(draft => ({ draft, expected_revision: 0 })));
    const allowed = await commit(views, memberDraft("view:z-allowed-after-denials", reader));
    const entries: ApplicationSpaceEntry[] = [
      ...deniedBatch.results.map(result => ({
        ref: exactViewRef(result.view),
        semantics: "membership" as const,
      })),
      { ref: exactViewRef(allowed), semantics: "membership" },
    ];
    const root = await commit(views, applicationDraft("view:space:paged-redaction", entries));
    const result = await project(views, {
      roots: [exactViewRef(root)],
      direction: "outgoing",
      edge_types: [APPLICATION_SPACE_MEMBERSHIP_RELATION],
      max_depth: 2,
      max_nodes: 2,
      max_edges: 1,
    });
    assert.deepEqual(result.nodes.map(node => node.ref), [exactViewRef(root), exactViewRef(allowed)]);
    assert.equal(result.edges.length, 1);
    assert.deepEqual(result.truncation, { truncated: false, reasons: [] });
    assert.equal(result.redacted_boundary, true);
    assert.equal(JSON.stringify(result).includes("view:denied:paged"), false);
  });
});

test("SQLite graph projection freezes incoming relation pages across concurrent commits", async () => {
  await withRepository(async views => {
    const root = await commit(views, memberDraft("view:snapshot:root", reader));
    const parentDrafts = Array.from({ length: 270 }, (_, index) => ({
      ...memberDraft(`view:snapshot:parent:${String(index).padStart(3, "0")}`, reader),
      relations: [{ type: APPLICATION_SPACE_MEMBERSHIP_RELATION, target: exactViewRef(root), metadata: {} }],
    }));
    await views.commitBatch(parentDrafts.map(draft => ({ draft, expected_revision: 0 })));
    const concurrentId = "view:snapshot:zz-concurrent-parent";
    const repositoryAuthorizer = new RepositoryViewReadAuthorizer(views);
    let concurrentCommitted = false;
    const result = await projectAuthorizedViewGraph({
      request: ViewGraphProjectionRequestSchema.parse({
        roots: [exactViewRef(root)],
        direction: "incoming",
        edge_types: [APPLICATION_SPACE_MEMBERSHIP_RELATION],
        max_depth: 1,
        max_nodes: 2_000,
        max_edges: 10_000,
      }),
      principal: { id: reader },
      authorization: {
        async authorize(input) {
          if (!concurrentCommitted && input.refs.some(ref => ref.view_id.startsWith("view:snapshot:parent:"))) {
            concurrentCommitted = true;
            await commit(views, {
              ...memberDraft(concurrentId, reader),
              relations: [{ type: APPLICATION_SPACE_MEMBERSHIP_RELATION, target: exactViewRef(root), metadata: {} }],
            });
          }
          return repositoryAuthorizer.authorize(input);
        },
      },
      source: views.search,
    });
    assert.equal(concurrentCommitted, true);
    assert.equal(result.nodes.some(node => node.ref.view_id === concurrentId), false);
    assert.equal(result.edges.some(edge => edge.source.view_id === concurrentId), false);

    const afterCommit = await project(views, {
      roots: [exactViewRef(root)],
      direction: "incoming",
      edge_types: [APPLICATION_SPACE_MEMBERSHIP_RELATION],
      max_depth: 1,
      max_nodes: 2_000,
      max_edges: 10_000,
    });
    assert.equal(afterCommit.nodes.some(node => node.ref.view_id === concurrentId), true);
    assert.equal(afterCommit.edges.some(edge => edge.source.view_id === concurrentId), true);
  });
});

test("denied-only relation scans above the fixed cap stay redacted while authorized scans still fail closed", async () => {
  const root = { view_id: "view:scan-limit:root", revision: 1 };
  const request = ViewGraphProjectionRequestSchema.parse({
    roots: [root],
    direction: "outgoing",
    edge_types: [APPLICATION_SPACE_MEMBERSHIP_RELATION],
    max_depth: 1,
    max_nodes: 1,
    max_edges: 1,
  });
  const source = generatedLayerSource(root, VIEW_GRAPH_MAX_SCANNED_EDGES + 1);
  const denied = await projectAuthorizedViewGraph({
    request,
    principal: { id: reader },
    authorization: {
      async authorize(input) {
        return input.refs.map(ref => ({ ref, status: sameRef(ref, root) ? "allowed" as const : "denied" as const }));
      },
    },
    source,
  });
  assert.deepEqual(denied.nodes.map(node => node.ref), [root]);
  assert.deepEqual(denied.edges, []);
  assert.equal(denied.redacted_boundary, true);
  assert.deepEqual(denied.truncation, { truncated: false, reasons: [] });

  await assert.rejects(
    projectAuthorizedViewGraph({
      request,
      principal: { id: reader },
      authorization: {
        async authorize(input) { return input.refs.map(ref => ({ ref, status: "allowed" as const })); },
      },
      source,
    }),
    (error: unknown) => error instanceof ViewGraphProjectionOperationError
      && error.code === "view_graph_scan_limit_exceeded",
  );
});

test("graph projector rejects storage evidence outside the exact frontier before authorization or output", async () => {
  const root = { view_id: "view:root", revision: 1 };
  const privateRef = { view_id: "view:private:invented", revision: 1 };
  const authorized: ExactViewRef[] = [];
  await assert.rejects(
    projectAuthorizedViewGraph({
      request: ViewGraphProjectionRequestSchema.parse({
        roots: [root],
        direction: "outgoing",
        edge_types: ["allowed"],
        max_depth: 1,
        max_nodes: 10,
        max_edges: 10,
      }),
      principal: { id: reader },
      authorization: {
        async authorize(input) {
          authorized.push(...input.refs);
          return input.refs.map(ref => ({ ref, status: "allowed" as const }));
        },
      },
      source: graphSource({
        async readGraphRelationPage() {
          return {
            edges: [{ id: "relation:invented", type: "forbidden", source: root, target: privateRef }],
          };
        },
        async readGraphNodeSummaries() { return []; },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ViewGraphProjectionOperationError);
      assert.equal(error.code, "view_graph_source_invalid");
      assert.equal(error.message.includes(privateRef.view_id), false);
      return true;
    },
  );
  assert.deepEqual(authorized, [root]);
});

test("graph source and result ordering use SQLite-compatible UTF-8 binary order", async () => {
  const root = { view_id: "view:root:binary", revision: 1 };
  const upper = { view_id: "view:Z", revision: 1 };
  const lower = { view_id: "view:a", revision: 1 };
  const summaries = [root, upper, lower].map(ref => ({
    ref,
    name: ref.view_id,
    purpose: "Binary-order fixture",
    schema: { name: "fixture.binary", version: 1 },
    role: "derived" as const,
    time: { created_at: createdAt },
    representation: { kind: "fixture" },
  }));
  const result = await projectAuthorizedViewGraph({
    request: ViewGraphProjectionRequestSchema.parse({
      roots: [root],
      direction: "outgoing",
      edge_types: ["a", "Z"],
      max_depth: 1,
      max_nodes: 3,
      max_edges: 2,
    }),
    principal: { id: reader },
    authorization: {
      async authorize(input) { return input.refs.map(ref => ({ ref, status: "allowed" as const })); },
    },
    source: graphSource({
      async readGraphRelationPage() {
        return { edges: [
          { id: "relation:Z", type: "Z", source: root, target: upper },
          { id: "relation:a", type: "a", source: root, target: lower },
        ] };
      },
      async readGraphNodeSummaries(refs) {
        const keys = new Set(refs.map(ref => `${ref.view_id}@${ref.revision}`));
        return summaries.filter(summary => keys.has(`${summary.ref.view_id}@${summary.ref.revision}`));
      },
    }),
  });
  assert.deepEqual(result.edges.map(edge => edge.type), ["Z", "a"]);
});

test("graph request contract rejects moving roots, duplicate edges, and out-of-range bounds", () => {
  const valid = {
    roots: [{ view_id: "view:root", revision: 1 }],
    direction: "both",
    edge_types: ["application_member"],
    max_depth: 2,
    max_nodes: 10,
    max_edges: 20,
  };
  assert.deepEqual(ViewGraphProjectionRequestSchema.parse(valid), valid);
  assert.throws(() => ViewGraphProjectionRequestSchema.parse({ ...valid, roots: [{ ...valid.roots[0], latest: true }] }));
  assert.throws(() => ViewGraphProjectionRequestSchema.parse({ ...valid, edge_types: ["member", "member"] }));
  assert.throws(() => ViewGraphProjectionRequestSchema.parse({ ...valid, max_depth: 6 }));
  assert.throws(() => ViewGraphProjectionRequestSchema.parse({ ...valid, max_nodes: 0 }));
  assert.throws(() => ViewGraphProjectionRequestSchema.parse({ ...valid, max_edges: 10_001 }));
  assert.throws(() => ViewGraphProjectionResultSchema.parse({
    projection_version: 1,
    roots: valid.roots,
    nodes: [],
    edges: [],
    frontier: [],
    truncation: { truncated: true, reasons: [] },
    redacted_boundary: false,
  }));
});

async function project(views: SqliteViewRepository, request: unknown) {
  return projectAuthorizedViewGraph({
    request: ViewGraphProjectionRequestSchema.parse(request),
    principal: { id: reader },
    authorization: new RepositoryViewReadAuthorizer(views),
    source: views.search,
  });
}

function applicationDraft(id: string, entries: readonly ApplicationSpaceEntry[]): ViewDraft {
  const normalized = normalizeApplicationSpaceEntries(entries);
  return parseViewDraft({
    id,
    name: `Application Space ${id}`,
    purpose: "Compose exact reusable Views without creating another storage universe",
    aliases: [],
    schema: applicationSpaceSchema,
    role: "derived",
    time: { created_at: createdAt },
    representation: {
      form: "inline",
      kind: APPLICATION_SPACE_REPRESENTATION_KIND,
      media_type: "application/json",
      value: { version: 1, entries: normalized },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: applicationSpaceRelations(normalized),
    provenance: { inputs: normalized.map(entry => entry.ref), actor: reader },
    policy: policy(reader),
    metadata: {},
  });
}

function memberDraft(id: string, owner: string): ViewDraft {
  return parseViewDraft({
    id,
    name: `Member ${id}`,
    purpose: "Remain independently addressable and reusable across Application Spaces",
    aliases: [],
    schema: { name: "application.member.fixture", version: 1, mode: "freeform" },
    role: "derived",
    time: { created_at: createdAt },
    representation: { form: "inline", kind: "fixture", media_type: "application/json", value: { private_payload: id }, metadata: {} },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: { inputs: [], actor: owner },
    policy: policy(owner),
    metadata: {},
  });
}

function policy(owner: string) {
  return {
    owner,
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: false,
    labels: [],
  };
}

async function commit(views: SqliteViewRepository, draft: ViewDraft, expectedRevision = 0) {
  return (await views.commit({ draft, expected_revision: expectedRevision })).view;
}

function sameRef(left: ExactViewRef, right: ExactViewRef): boolean {
  return left.view_id === right.view_id && left.revision === right.revision;
}

function graphSource(reader: ViewGraphSnapshotReader): ViewGraphProjectionSource {
  return {
    async withGraphReadSnapshot(read) {
      return read(reader);
    },
  };
}

function generatedLayerSource(root: ExactViewRef, total: number): ViewGraphProjectionSource {
  const summary = {
    ref: root,
    name: "Scan limit root",
    purpose: "Prove authorization precedes the observable graph scan bound",
    schema: { name: "fixture.scan-limit", version: 1 },
    role: "derived" as const,
    time: { created_at: createdAt },
    representation: { kind: "fixture" },
  };
  return graphSource({
    async readGraphRelationPage(input) {
      const start = input.after === undefined
        ? 0
        : Number(input.after.relation_id.slice("relation:scan-limit:".length)) + 1;
      const end = Math.min(total, start + input.limit);
      const edges = Array.from({ length: end - start }, (_, offset) => {
        const sequence = String(start + offset).padStart(6, "0");
        return {
          id: `relation:scan-limit:${sequence}`,
          type: APPLICATION_SPACE_MEMBERSHIP_RELATION,
          source: root,
          target: { view_id: `view:scan-limit:target:${sequence}`, revision: 1 },
        };
      });
      const last = edges.at(-1);
      return {
        edges,
        ...(end < total && last ? {
          next: { type: last.type, source: last.source, target: last.target, relation_id: last.id },
        } : {}),
      };
    },
    async readGraphNodeSummaries(refs) {
      return refs.some(ref => sameRef(ref, root)) ? [summary] : [];
    },
  });
}

async function withRepository(run: (views: SqliteViewRepository) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-graph-project-"));
  const views = new SqliteViewRepository(join(directory, "metaflow.sqlite"));
  try {
    await run(views);
  } finally {
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

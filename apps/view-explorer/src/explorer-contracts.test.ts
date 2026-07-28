import test from "node:test";
import assert from "node:assert/strict";
import { EXPLORER_DEFAULT_EDGE_TYPES, EXPLORER_MAX_RESPONSE_BYTES, ViewGraphProjectionResultSchema, ViewRevisionSchema, refKey } from "./contracts.js";
import {
  createFixtureTransport,
  FIXTURE_SIZES,
  makeFixtureProjection,
  makePersonalizedProjection,
  parseFixtureId,
  PERSONALIZED_FIXTURE_ID,
  PERSONALIZED_VIEW_REFS,
  PRODUCT_VIEW_REFS,
  PRODUCT_VIEWS_FIXTURE_ID,
} from "./fixtures.js";
import { makeProductViewProjection } from "./product-view-fixture.js";
import { mergeProjection, ProjectionMergeError } from "./graph-projection.js";
import { LayoutProtocolError, validateLayoutResponse } from "./layout-protocol.js";
import { ExplorerClientError, ViewExplorerOperationClient, createHttpOperationTransport } from "./operation-client.js";
import { ExplorerRequestCoordinator } from "./request-coordinator.js";

test("all browser fixtures conform to the canonical graph contract", () => {
  for (const size of FIXTURE_SIZES) {
    const projection = ViewGraphProjectionResultSchema.parse(makeFixtureProjection(size));
    assert.equal(projection.nodes.length, size);
    assert.equal(new Set(projection.nodes.map(node => refKey(node.ref))).size, size);
    assert.equal(projection.truncation.truncated, size === 2_000);
  }
  assert.ok(makeFixtureProjection(10).edges.some(edge => edge.type === "application_composition"));

  const personalized = ViewGraphProjectionResultSchema.parse(makePersonalizedProjection());
  assert.equal(refKey(personalized.roots[0]!), refKey(PERSONALIZED_VIEW_REFS.application_space));
  assert.equal(personalized.nodes.length, Object.keys(PERSONALIZED_VIEW_REFS).length);
  assert.equal(new Set(personalized.nodes.map(node => refKey(node.ref))).size, personalized.nodes.length);
  assert.ok(personalized.nodes.every(node => node.ref.view_id.startsWith("view:fixture:view-explorer:personalized:")));
  assert.equal(personalized.nodes.some(node => node.ref.view_id === "view:personalized:working-state"), false);
  assert.equal(personalized.nodes.some(node => node.ref.view_id === "view:personalized:application-space"), false);
  assert.deepEqual(parseFixtureId(PERSONALIZED_FIXTURE_ID), PERSONALIZED_FIXTURE_ID);
  assert.equal(JSON.stringify(personalized).includes("/Users/"), false);

  const productViews = ViewGraphProjectionResultSchema.parse(makeProductViewProjection());
  assert.equal(refKey(productViews.roots[0]!), refKey(PRODUCT_VIEW_REFS.daily_summary));
  assert.equal(productViews.nodes.length, 4);
  assert.equal(productViews.edges.filter(edge => edge.type === "derived_from").length, 3);
  assert.deepEqual(parseFixtureId(PRODUCT_VIEWS_FIXTURE_ID), PRODUCT_VIEWS_FIXTURE_ID);

  const expected = { generation: 4, request_id: "layout-4", node_keys: new Set(["a", "b"]) };
  assert.deepEqual(validateLayoutResponse({
    protocol_version: 1,
    generation: 4,
    request_id: "layout-4",
    ok: true,
    positions: [{ key: "a", x: 1, y: 2 }, { key: "b", x: 3, y: 4 }],
  }, expected).status, "ready");
  assert.deepEqual(validateLayoutResponse({ generation: 3, request_id: "layout-3" }, expected), { status: "stale" });
  for (const positions of [
    [{ key: "a", x: 1, y: 2 }],
    [{ key: "a", x: 1, y: 2 }, { key: "a", x: 3, y: 4 }],
    [{ key: "a", x: 1, y: 2 }, { key: "extra", x: 3, y: 4 }],
    [{ key: "a", x: 1, y: 2 }, { key: "b", x: Number.NaN, y: 4 }],
  ]) {
    assert.throws(() => validateLayoutResponse({ protocol_version: 1, generation: 4, request_id: "layout-4", ok: true, positions }, expected), LayoutProtocolError);
  }
});

test("product fixture freezes the Audio to Timeline to Daily Summary provenance chain", async () => {
  const client = new ViewExplorerOperationClient(createFixtureTransport(PRODUCT_VIEWS_FIXTURE_ID));
  const signal = new AbortController().signal;
  const daily = ViewRevisionSchema.parse(await client.getView(PRODUCT_VIEW_REFS.daily_summary, signal));
  const timeline = ViewRevisionSchema.parse(await client.getView(PRODUCT_VIEW_REFS.timeline, signal));
  const audio = ViewRevisionSchema.parse(await client.getView(PRODUCT_VIEW_REFS.audio_design, signal));
  assert.equal(daily.schema.name, "personal.summary.daily");
  assert.deepEqual(daily.provenance.inputs, [PRODUCT_VIEW_REFS.timeline]);
  assert.equal(timeline.schema.name, "personal.timeline.activity");
  assert.deepEqual(timeline.provenance.inputs, [PRODUCT_VIEW_REFS.audio_design, PRODUCT_VIEW_REFS.audio_scope]);
  assert.equal(audio.schema.name, "personal.audio.semantic");
  assert.equal(audio.representation.kind, "personal_audio");
});

test("personalized fixture returns exact Application Space, working-state provenance, and synthetic Search evidence", async () => {
  const transport = createFixtureTransport(PERSONALIZED_FIXTURE_ID);
  const client = new ViewExplorerOperationClient(transport);
  const signal = new AbortController().signal;
  const projection = await client.project({
    roots: [PERSONALIZED_VIEW_REFS.application_space],
    direction: "both",
    edge_types: [...EXPLORER_DEFAULT_EDGE_TYPES],
    max_depth: 2,
    max_nodes: 2_000,
    max_edges: 10_000,
  }, signal);
  assert.equal(projection.nodes.length, 6);
  assert.ok(projection.edges.some(edge => edge.type === "derived_from"));
  assert.ok(projection.edges.some(edge => edge.type === "application_composition"));

  const workingState = ViewRevisionSchema.parse(await client.getView(PERSONALIZED_VIEW_REFS.working_state, signal));
  assert.deepEqual(workingState.provenance.inputs, [
    PERSONALIZED_VIEW_REFS.codex_history,
    PERSONALIZED_VIEW_REFS.obsidian_view_model,
    PERSONALIZED_VIEW_REFS.obsidian_search_graph,
    PERSONALIZED_VIEW_REFS.obsidian_connector_design,
  ]);
  assert.equal(workingState.provenance.actor, "operator:personalized-working-state");

  const search = await client.search({
    contract_version: 1,
    query: { text: "working state" },
    scope: { kind: "all_visible", max_nodes: 1_000, max_scan: 10_000 },
    target: { envelope: true, internal: false, related_views: false },
    modes: ["keyword"],
    fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
    failure_mode: "require_all",
    page: { limit: 20 },
  }, signal);
  assert.deepEqual(search.hits.map(hit => hit.ref), [PERSONALIZED_VIEW_REFS.working_state]);
});

test("fixture transport returns bounded graph, exact View, and Search envelopes", async () => {
  const transport = createFixtureTransport(10);
  const client = new ViewExplorerOperationClient(transport);
  const signal = new AbortController().signal;
  const projection = await client.project({
    roots: [{ view_id: "view:fixture:0000", revision: 1 }],
    direction: "both",
    edge_types: [...EXPLORER_DEFAULT_EDGE_TYPES],
    max_depth: 2,
    max_nodes: 2_000,
    max_edges: 10_000,
  }, signal);
  assert.equal(projection.nodes.length, 10);
  assert.equal(ViewRevisionSchema.parse(await client.getView(projection.nodes[1]!.ref, signal)).id, projection.nodes[1]!.ref.view_id);
  const search = await client.search({
    contract_version: 1,
    query: { text: "Research" },
    scope: { kind: "all_visible", max_nodes: 1_000, max_scan: 10_000 },
    target: { envelope: true, internal: false, related_views: false },
    modes: ["keyword"],
    fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
    failure_mode: "require_all",
    page: { limit: 20 },
  }, signal);
  assert.ok(search.hits.length > 0);
  assert.deepEqual(transport.calls.map(call => call.operation), ["view.graph.project", "view.get", "view.search"]);
});

test("client rejects projection requests above the canonical fixed limits before transport", async () => {
  let called = false;
  const client = new ViewExplorerOperationClient({ async call() { called = true; return {}; } });
  await assert.rejects(client.project({
    roots: [{ view_id: "view:fixture:0000", revision: 1 }],
    direction: "both",
    edge_types: ["derived_from"],
    max_depth: 2,
    max_nodes: 2_001,
    max_edges: 10_000,
  }, new AbortController().signal));
  assert.equal(called, false);

  const coordinator = new ExplorerRequestCoordinator();
  const search = coordinator.begin("search");
  const projection = coordinator.begin("projection");
  assert.equal(search.controller.signal.aborted, true);
  assert.equal(coordinator.isCurrent(search.token), false);
  assert.equal(coordinator.isCurrent(projection.token, projection.controller), true);
  const attached = coordinator.attach(projection.token, "expand");
  coordinator.dispose();
  assert.equal(projection.controller.signal.aborted, true);
  assert.equal(attached.signal.aborted, true);
});

test("one-hop merge is lossless and fails on conflicting exact evidence", () => {
  const current = makeFixtureProjection(10);
  const incoming = structuredClone(current);
  incoming.nodes = incoming.nodes.slice(0, 1);
  incoming.edges = [];
  const merged = mergeProjection(current, incoming);
  assert.equal(merged.nodes.length, 10);
  const conflict = structuredClone(incoming);
  conflict.nodes[0]!.name = "Conflicting summary";
  assert.throws(() => mergeProjection(current, conflict), (error: unknown) => error instanceof ProjectionMergeError && error.code === "node_conflict");
});

test("HTTP transport hard-stops an unknown-length response above the fixed host ceiling", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(EXPLORER_MAX_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      createHttpOperationTransport().call("view.get", { ref: { view_id: "view:test", revision: 1 } }, new AbortController().signal),
      (error: unknown) => error instanceof ExplorerClientError && error.code === "response_too_large",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

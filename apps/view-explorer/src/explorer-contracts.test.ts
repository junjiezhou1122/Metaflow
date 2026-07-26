import test from "node:test";
import assert from "node:assert/strict";
import { EXPLORER_MAX_RESPONSE_BYTES, ViewGraphProjectionResultSchema, ViewRevisionSchema, refKey } from "./contracts.js";
import { createFixtureTransport, FIXTURE_SIZES, makeFixtureProjection } from "./fixtures.js";
import { mergeProjection, ProjectionMergeError } from "./graph-projection.js";
import { ExplorerClientError, ViewExplorerOperationClient, createHttpOperationTransport } from "./operation-client.js";

test("all browser fixtures conform to the canonical graph contract", () => {
  for (const size of FIXTURE_SIZES) {
    const projection = ViewGraphProjectionResultSchema.parse(makeFixtureProjection(size));
    assert.equal(projection.nodes.length, size);
    assert.equal(new Set(projection.nodes.map(node => refKey(node.ref))).size, size);
    assert.equal(projection.truncation.truncated, size === 2_000);
  }
});

test("fixture transport returns bounded graph, exact View, and Search envelopes", async () => {
  const transport = createFixtureTransport(10);
  const client = new ViewExplorerOperationClient(transport);
  const signal = new AbortController().signal;
  const projection = await client.project({
    roots: [{ view_id: "view:fixture:0000", revision: 1 }],
    direction: "both",
    edge_types: ["derived_from", "member_of", "references", "application_member"],
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

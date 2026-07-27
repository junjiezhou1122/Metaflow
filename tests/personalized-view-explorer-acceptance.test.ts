import assert from "node:assert/strict";
import test from "node:test";
import {
  createFixtureTransport,
  PERSONALIZED_FIXTURE_ID,
  PERSONALIZED_VIEW_REFS,
} from "../apps/view-explorer/src/fixtures.js";
import type { ExplorerOperation } from "../apps/view-explorer/src/contracts.js";
import { runPersonalizedViewExplorerAcceptance } from "../apps/view-explorer/e2e/personalized-acceptance.js";

test("personalized pre-cleanup gate proves the real Vite, Sigma, and accessible DOM surface", async () => {
  const transport = createFixtureTransport(PERSONALIZED_FIXTURE_ID);
  const evidence = await runPersonalizedViewExplorerAcceptance({
    operations: {
      async execute(requestValue, contextValue) {
        const request = requestValue as { operation: ExplorerOperation; input: unknown };
        const context = contextValue as { principal?: { id?: string } };
        assert.equal(context.principal?.id, "user:local");
        if (request.operation === "view.graph.project") {
          assert.deepEqual(
            (request.input as { request?: { roots?: unknown[] } }).request?.roots?.[0],
            PERSONALIZED_VIEW_REFS.application_space,
          );
        }
        if (request.operation === "view.get") {
          assert.deepEqual(
            (request.input as { ref?: unknown }).ref,
            PERSONALIZED_VIEW_REFS.working_state,
          );
        }
        return transport.call(request.operation, request.input, new AbortController().signal);
      },
    },
    principal: { id: "user:local", grants: ["*"] },
    application_space: PERSONALIZED_VIEW_REFS.application_space,
    working_state: PERSONALIZED_VIEW_REFS.working_state,
  });

  assert.equal(evidence.contract_version, 1);
  assert.equal(evidence.graph_ready, true);
  assert.equal(evidence.exact_working_state_selected, true);
  assert.equal(evidence.accessible_dom_synchronized, true);
  assert.equal(evidence.node_count, 6);
  assert.equal(evidence.edge_count, 9);
  assert.ok(evidence.canvas_non_background_samples > 20);
  assert.ok(evidence.canvas_unique_colors > 4);
  assert.ok(evidence.operations.view_graph_project >= 1);
  assert.ok(evidence.operations.view_get >= 1);
  assert.equal(evidence.operations.view_search, 0);
  assert.equal(evidence.browser_console_errors, 0);
  assert.equal(evidence.browser_console_warnings, 0);
  assert.ok(evidence.chromium_webgl_driver_warnings >= 0);
  assert.equal(evidence.retained_artifacts, false);
  const operations = transport.calls.map(call => call.operation);
  assert.ok(operations.includes("view.graph.project"));
  assert.ok(operations.includes("view.get"));
  assert.ok(operations.every(operation => operation === "view.graph.project" || operation === "view.get"));
  assert.equal(evidence.operations.view_graph_project, operations.filter(operation => operation === "view.graph.project").length);
  assert.equal(evidence.operations.view_get, operations.filter(operation => operation === "view.get").length);
});

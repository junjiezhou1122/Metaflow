import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  createAmbientV1HttpHandler,
  type AmbientHttpEvent,
  type AmbientV1HttpHandlerOptions,
} from "../apps/ambient-daemon/http-handler.ts";
import { AmbientOperationAccess } from "../apps/ambient-daemon/operation-access.ts";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";
import { parseViewDraft } from "../packages/view/index.ts";

test("Browser Automation HTTP routes project one injected v1 controller", async () => {
  const calls: unknown[] = [];
  const handler = handlerWith({
    browser_automation: {
      async submit(input) {
        calls.push(input);
        return { status: "invoked", event_id: "event:1" };
      },
      listDeliveries(input) {
        return [{ delivery_id: "browser:1", query: input }];
      },
      async interact(input) {
        return { feedback_view: { view_id: "feedback:1", revision: 1 }, input };
      },
    },
  });
  const signal = await request(handler, "POST", "/automation/v1/browser-signals", { event_id: "event:1" });
  assert.equal(signal.status, 200);
  assert.deepEqual(signal.body, { ok: true, result: { status: "invoked", event_id: "event:1" } });
  assert.deepEqual(calls, [{ event_id: "event:1" }]);

  const deliveries = await request(handler, "GET", "/automation/v1/browser-deliveries?after=2026-07-26T10%3A00%3A00.000Z&limit=5");
  assert.equal(deliveries.status, 200);
  assert.deepEqual(deliveries.body.deliveries, [{
    delivery_id: "browser:1",
    query: { after: "2026-07-26T10:00:00.000Z", limit: 5 },
  }]);

  const interaction = await request(handler, "POST", "/automation/v1/browser-interactions", { action: "accept" });
  assert.equal(interaction.status, 200);
  assert.deepEqual(interaction.body.result.feedback_view, { view_id: "feedback:1", revision: 1 });
});

test("Ambient v1 HTTP composition fails before listening when a required port is absent", () => {
  const options = baseOptions() as any;
  delete options.browser_automation;
  assert.throws(
    () => createAmbientV1HttpHandler(options),
    /Browser Automation composition requires submit\(\)/,
  );
});

test("Browser Automation HTTP route preserves structured policy rejection and trace", async () => {
  const events: AmbientHttpEvent[] = [];
  const handler = handlerWith({
    browser_automation: {
      async submit() {
        throw Object.assign(new Error("exact evidence cannot be stored"), {
          code: "required_evidence_not_stored",
          details: { event_id: "event:private" },
        });
      },
      listDeliveries() { return []; },
      async interact() { return {}; },
    },
    observe(event) { events.push(event); },
  });
  const response = await request(handler, "POST", "/automation/v1/browser-signals", { event_id: "event:private" });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "required_evidence_not_stored");
  assert.deepEqual(response.body.details, { event_id: "event:private" });
  assert.deepEqual(events.map(event => [event.type, event.status, event.code]), [
    ["http.request_failed", 422, "required_evidence_not_stored"],
  ]);
});

test("Browser Capture HTTP route projects its port and preserves structured conflicts", async () => {
  const calls: unknown[] = [];
  const handler = handlerWith({
    browser_capture: {
      async submit(input) {
        calls.push(input);
        return {
          status: "stored",
          replayed: false,
          captured_views: [{ role: "page", created: true }],
        };
      },
    },
  });
  const stored = await request(handler, "POST", "/capture/v1/browser-events", { event_id: "browser:event:1" });
  assert.equal(stored.status, 201);
  assert.equal(stored.body.ok, true);
  assert.deepEqual(calls, [{ event_id: "browser:event:1" }]);

  const conflicts = handlerWith({
    browser_capture: {
      async submit() {
        throw Object.assign(new Error("event id reused with changed evidence"), {
          code: "idempotency_conflict",
          details: { event_id: "browser:event:1" },
        });
      },
    },
  });
  const conflict = await request(conflicts, "POST", "/capture/v1/browser-events", {});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
  assert.deepEqual(conflict.body.details, { event_id: "browser:event:1" });
});

test("v1 HTTP reads only an exact View revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-exact-view-http-"));
  const views = new SqliteViewRepository(join(directory, "views.sqlite"));
  try {
    const committed = await views.commit({
      draft: parseViewDraft({
        id: "view:summary:github",
        name: "GitHub summary",
        purpose: "Summarize the exact GitHub repository page for an Ambient delivery",
        schema: { name: "summary.github.repository", version: 1, mode: "freeform" },
        role: "derived",
        time: { created_at: "2026-07-26T10:00:00.000Z" },
        representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: "# Codex" },
        materialization: {
          primary: { id: "canonical", format: "markdown", media_type: "text/markdown", location: { kind: "inline" } },
        },
        provenance: { inputs: [], actor: "test" },
        policy: {
          owner: "user:local",
          visibility: "private",
          privacy: "private",
          retention: "normal",
          allow_external_model: false,
          allow_embedding: false,
          labels: [],
        },
      }),
      expected_revision: 0,
    });
    const operationCalls: unknown[] = [];
    const handler = handlerWith({
      operations: {
        async handle(input) {
          operationCalls.push(input);
          const ref = (input.body as { ref: { view_id: string; revision: number } }).ref;
          const view = await views.get(ref);
          return view ? {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: { ok: true, request_id: "request:view", operation: "view.get", data: view },
          } : {
            status: 404,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: {
              ok: false,
              request_id: "request:view",
              operation: "view.get",
              error: { code: "view_not_found", message: "Exact View revision does not exist", category: "not_found", details: { ref } },
            },
          };
        },
      },
    });
    const exact = await request(handler, "GET", `/context/v1/views/${encodeURIComponent(committed.view.id)}?revision=1`);
    assert.equal(exact.status, 200);
    assert.equal(exact.body.view.id, committed.view.id);
    assert.equal(exact.body.view.revision, 1);
    assert.deepEqual(operationCalls[0], {
      method: "POST",
      path: "/metaflow/v1/operations/view.get",
      body: { ref: { view_id: committed.view.id, revision: 1 } },
    });

    const latest = await request(handler, "GET", `/context/v1/views/${encodeURIComponent(committed.view.id)}`);
    assert.equal(latest.status, 400);
    assert.equal(latest.body.code, "exact_view_revision_required");

    const missing = await request(handler, "GET", `/context/v1/views/${encodeURIComponent(committed.view.id)}?revision=2`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "exact_view_not_found");
  } finally {
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical Operation HTTP route is projected by the Ambient daemon", async () => {
  const calls: unknown[] = [];
  const handler = handlerWith({
    operations: {
      async handle(input) {
        calls.push(input);
        return {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: {
            ok: true,
            request_id: "request:test",
            operation: "catalog.list",
            data: [],
          },
        };
      },
    },
  });
  const response = await request(handler, "POST", "/metaflow/v1/operations/catalog.list", {});
  assert.equal(response.status, 200);
  assert.equal(response.body.operation, "catalog.list");
  assert.deepEqual(calls, [{ method: "POST", path: "/metaflow/v1/operations/catalog.list", body: {} }]);
});

function handlerWith(overrides: Partial<AmbientV1HttpHandlerOptions> = {}) {
  return createAmbientV1HttpHandler({ ...baseOptions(), ...overrides });
}

function baseOptions(): AmbientV1HttpHandlerOptions {
  const automation = {
    async submit() { return {}; },
    listDeliveries() { return []; },
    async interact() { return {}; },
  };
  return {
    browser_capture: { async submit() { return {}; } },
    browser_automation: automation,
    mac_automation: {
      ...automation,
      listBrowserContextRequests() { return []; },
      async respondBrowserContext() { return {}; },
    },
    inbox_automation: {
      listDeliveries() { return []; },
      async interact() { return {}; },
    },
    operations: {
      async handle() {
        return {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: {
            ok: false,
            request_id: "request:test",
            error: { code: "not_used", message: "not used", category: "not_found", details: {} },
          },
        };
      },
    },
    operation_access: new AmbientOperationAccess("test-operation-auth-token-32-bytes"),
    observe() {},
  };
}

async function request(
  handler: ReturnType<typeof createAmbientV1HttpHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    authorization: "Bearer test-operation-auth-token-32-bytes",
  };
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { raw = value; },
  } as any;
  await handler(req, res);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

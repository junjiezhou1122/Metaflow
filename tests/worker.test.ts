import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { registerContextWorkerFunctions } from "../src/server/worker.js";

type RegisteredFunction = (input: unknown) => Promise<{ status_code: number; body: any }>;

class FakeIiiWorker {
  functions = new Map<string, RegisteredFunction>();
  triggers: unknown[] = [];

  async registerFunction(id: string, handler: RegisteredFunction) {
    this.functions.set(id, handler);
  }

  async registerTrigger(trigger: unknown) {
    this.triggers.push(trigger);
  }
}

async function withWorker(fn: (worker: FakeIiiWorker, store: ContextStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "info-worker-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  const worker = new FakeIiiWorker();
  try {
    await registerContextWorkerFunctions(worker, store);
    await fn(worker, store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("iii worker reuses policy-aware HTTP routes for unknown plugin context reads", async () => withWorker(async (worker, store) => {
  store.insertRecord({
    id: "record:worker-hidden-recent",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Hidden source", text: "UNKNOWN WORKER PLUGIN SHOULD NOT SEE THIS RECORD" },
    privacy: { level: "private", retention: "normal" },
  });

  const recent = await worker.functions.get("context::recent")?.({ query: { plugin_id: "missing-plugin", limit: 10 } });
  const search = await worker.functions.get("context::search")?.({ query: { plugin_id: "missing-plugin" }, body: { query: "UNKNOWN WORKER", limit: 10 } });

  assert.equal(recent?.status_code, 404);
  assert.equal(recent?.body.plugin_loaded, false);
  assert.match(recent?.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(recent?.body), /UNKNOWN WORKER PLUGIN SHOULD NOT SEE/);

  assert.equal(search?.status_code, 404);
  assert.equal(search?.body.plugin_loaded, false);
  assert.match(search?.body.error, /plugin not found/);
  assert.doesNotMatch(JSON.stringify(search?.body), /UNKNOWN WORKER PLUGIN SHOULD NOT SEE/);
}));

test("iii worker view writes use the same plugin write policy as HTTP", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "info-worker-plugin-test-"));
  process.chdir(dir);
  try {
    mkdirSync(join(dir, "plugins", "reader"), { recursive: true });
    writeFileSync(join(dir, "plugins", "reader", "plugin.json"), JSON.stringify({
      id: "reader",
      name: "Reader",
      view_types_produced: ["analysis.browser_page"],
      permissions: {
        allow_write_views: false,
        max_privacy_level: "private",
      },
    }));

    const store = new ContextStore(join(dir, "context.sqlite"));
    const worker = new FakeIiiWorker();
    await registerContextWorkerFunctions(worker, store);

    const denied = await worker.functions.get("context::view_upsert")?.({
      body: {
        id: "analysis:worker-denied-view-write",
        view_type: "analysis.browser_page",
        scope: { plugin_id: "reader" },
        content: { analysis: "DENIED WORKER VIEW WRITE SHOULD NOT PERSIST" },
      },
    });

    assert.equal(denied?.status_code, 403);
    assert.equal(denied?.body.error, "plugin cannot write views");
    assert.equal(denied?.body.plugin_loaded, true);
    assert.equal(store.getView("analysis:worker-denied-view-write"), undefined);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

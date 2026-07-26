import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { buildEvidenceView, compileEvidenceViews } from "@info/views/evidence/index.js";
import type { RuntimeTickRequest, RuntimeTickResult } from "@info/runtime/runtime.js";
import { III_RUNTIME_FUNCTIONS, InProcessIiiRuntimeClient, registerInfoIiiRuntime } from "@info/iii-runtime";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-evidence-view-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function runtimeTickViaIii(req: RuntimeTickRequest, store: ContextStore): Promise<RuntimeTickResult> {
  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-evidence-runtime-test" });
  const response = await iii.trigger({ function_id: III_RUNTIME_FUNCTIONS.tick, payload: req }) as { result?: RuntimeTickResult };
  return (response.result ?? response) as RuntimeTickResult;
}

test("Evidence View compiler normalizes raw browser and Screenpipe observations", () => withStore((store) => {
  const now = Date.now();
  store.insertRecord({
    id: "record:evidence-browser",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "docs.screenpi.pe" },
    time: { observed_at: new Date(now - 60_000).toISOString() },
    content: {
      title: "Screenpipe Docs",
      url: "https://docs.screenpi.pe/recording",
      text: "Screenpipe permissions and browser URL capture.",
    },
    payload: { dwell_seconds: 120 },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:evidence-frame",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Warp" },
    time: { observed_at: new Date(now).toISOString() },
    content: { title: "Warp - OCR", text: "sqlite3 ~/.screenpipe/db.sqlite select browser_url" },
    payload: { app_name: "Warp", content_type: "OCR", frame_id: 9466 },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = compileEvidenceViews({ write: true, limit: 10, minutes: 10_000 }, store);
  const views = store.listViews({ view_types: ["evidence"], limit: 10 });

  assert.equal(result.records_used, 2);
  assert.equal(views.length, 2);
  assert.ok(views.every(view => view.view_type === "evidence"));
  assert.ok(views.some(view => view.content?.kind === "page"));
  assert.ok(views.some(view => view.content?.kind === "screen"));

  const browser = views.find(view => view.content?.kind === "page");
  assert.ok(browser);
  assert.deepEqual(browser.source_records, ["record:evidence-browser"]);
  assert.equal((browser.content?.subject as Record<string, unknown>).url, "https://docs.screenpi.pe/recording");
  assert.equal((browser.content?.origin as Record<string, unknown>).schema, "observation.browser_page_heartbeat");
  assert.equal((browser.content?.signals as Record<string, unknown>).duration_seconds, 120);
  assert.equal((browser.content?.claims as string[]).includes("url_seen"), true);
  assert.equal((browser.content?.quality as Record<string, unknown>).confidence, 0.9);

  const frame = views.find(view => view.content?.kind === "screen");
  assert.ok(frame);
  assert.deepEqual((frame.content?.signals as Record<string, unknown>).frame_ids, [9466]);
  assert.equal((frame.content?.subject as Record<string, unknown>).app, "Warp");
}));

test("Evidence View can be used as a graph node with stable provenance", () => withStore((store) => {
  const record = store.insertRecord({
    id: "record:evidence-node",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { title: "Local project snapshot: info", path: "/Users/junjie/info", text: "packages/views/evidence/evidence-view.ts changed" },
    payload: { root: "/Users/junjie/info", files_touched: ["packages/views/evidence/evidence-view.ts"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const first = buildEvidenceView(record);
  const second = buildEvidenceView(record);

  assert.equal(first.id, second.id);
  assert.equal(first.view_type, "evidence");
  assert.equal(first.content?.kind, "project");
  assert.deepEqual(first.source_records, [record.id]);
  assert.equal(first.compiler?.id, "builtin.evidence-view");
  assert.equal(first.lossiness, "low");
}));

test("runtimeTick compiles Evidence Views before higher-level runtime Views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:evidence-runtime-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "info", project_path: "/Users/junjie/info", domain: "github.com", app: "Chrome" },
    content: {
      title: "Info Runtime",
      url: "https://github.com/example/info",
      text: "Context runtime docs mention evidence views and activity timeline.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runtimeTickViaIii({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    force: true,
    window_minutes: 60,
    min_score: 0.1,
  }, store);

  assert.equal(result.ok, true);
  assert.ok(result.compiled_views.some(view => view.view_type === "evidence"));
  assert.ok(store.listViews({ view_types: ["evidence"], limit: 10 }).some(view => view.source_records?.includes("record:evidence-runtime-source")));
}));

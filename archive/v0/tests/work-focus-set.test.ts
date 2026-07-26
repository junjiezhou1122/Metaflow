import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore, type StoredContextRecord } from "@info/core";
import { buildRouteCandidateRecord, buildCandidateRoutes, extractRouteFeatures } from "@info/processor-runtime";
import { WORK_FOCUS_SET_VIEW_TYPE, compileWorkFocusSet } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-work-focus-set-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("compileWorkFocusSet groups multiple simultaneous project lanes", () => withStore((store) => {
  const records = [
    sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
      scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
      content: { title: "Codex info work", text: "packages/view-system/spec.ts" },
      payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["packages/view-system/spec.ts"] },
    }),
    sourceRecord("obs:ai:paperclip", "observation.ai_session_locator_result", {
      scope: { project: "paperclip", project_path: "/Users/junjie/paperclip", session: "codex-paperclip" },
      content: { title: "Codex paperclip work", text: "src/tasks.ts" },
      payload: { cwd: "/Users/junjie/paperclip", session_id: "codex-paperclip", files_touched: ["src/tasks.ts"] },
    }),
  ];
  const routeCandidates = records.map(record => store.insertRecord(routeCandidateFor(record)));

  const result = compileWorkFocusSet({ records: [...records, ...routeCandidates], write: false, now: new Date("2026-06-16T10:05:00.000Z") }, store);

  assert.equal(result.view.view_type, WORK_FOCUS_SET_VIEW_TYPE);
  assert.equal(result.active_lanes.filter(lane => lane.lane_kind === "project").length, 2);
  assert.equal(result.active_lanes.some(lane => lane.lane_key === "project:/Users/junjie/info"), true);
  assert.equal(result.active_lanes.some(lane => lane.lane_key === "project:/Users/junjie/paperclip"), true);
  assert.ok(Math.abs(result.active_lanes.reduce((sum, lane) => sum + lane.attention_share, 0) - 1) < 0.01);
}));

test("compileWorkFocusSet attaches related docs topic while keeping communication low attention", () => withStore((store) => {
  const source = sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: { title: "Current page automation with midscene", text: "Need current page automation for Chrome ACP." },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["apps/chrome-acp/packages/chrome-extension/src/tools/browser.ts"] },
  });
  const routeInfo = store.insertRecord(routeCandidateFor(source));
  const docs = sourceRecord("obs:browser:midscene", "observation.browser_page_snapshot", {
    scope: { app: "chrome", domain: "midscenejs.com" },
    content: { title: "Midscene Introduction", url: "https://midscenejs.com/introduction.html", text: "current page automation docs" },
  });
  const routeDocs = store.insertRecord(routeCandidateFor(docs, [routeInfo]));
  const msg = sourceRecord("obs:wechat", "observation.screenpipe_activity", {
    scope: { app: "WeChat" },
    content: { title: "WeChat", text: "short personal reply" },
    payload: { app_name: "WeChat" },
  });
  const routeMsg = store.insertRecord(routeCandidateFor(msg));

  const result = compileWorkFocusSet({
    records: [source, docs, msg, routeInfo, routeDocs, routeMsg],
    write: false,
    now: new Date("2026-06-16T10:10:00.000Z"),
  }, store);

  const project = result.active_lanes.find(lane => lane.lane_key === "project:/Users/junjie/info");
  const topic = result.active_lanes.find(lane => lane.lane_key === "topic:midscene");
  const communication = result.active_lanes.find(lane => lane.lane_key === "communication:messages");

  assert.ok(project);
  assert.ok(topic);
  assert.ok(communication);
  assert.ok((project?.attention_share ?? 0) > (communication?.attention_share ?? 1));
  assert.equal(topic?.lane_kind, "topic");
  assert.equal(communication?.lane_kind, "communication");
}));

test("compileWorkFocusSet writes a view and tolerates empty inputs", () => withStore((store) => {
  const empty = compileWorkFocusSet({ records: [], write: false, now: new Date("2026-06-16T10:00:00.000Z") }, store);
  assert.equal(empty.active_lanes.length, 0);
  assert.equal(empty.view.status, "archived");

  const source = sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info" },
    payload: { cwd: "/Users/junjie/info" },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  const written = compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:00:00.000Z") }, store);
  assert.ok("id" in written.view);
  assert.equal(store.getView((written.view as any).id)?.view_type, WORK_FOCUS_SET_VIEW_TYPE);
}));

function routeCandidateFor(source: StoredContextRecord, recent: StoredContextRecord[] = []) {
  const features = extractRouteFeatures(source);
  return buildRouteCandidateRecord(source, features, buildCandidateRoutes(features, recent), new Date("2026-06-16T10:00:00.000Z"));
}

function sourceRecord(id: string, schemaName: string, overrides: Partial<StoredContextRecord>): StoredContextRecord {
  const now = "2026-06-16T10:00:00.000Z";
  return {
    id,
    schema: { name: schemaName, version: 1 },
    source: { type: schemaName.includes("browser") ? "browser" : schemaName.includes("screenpipe") ? "screenpipe" : "ai_session" },
    scope: {},
    time: { observed_at: now, captured_at: now },
    content: {},
    payload: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

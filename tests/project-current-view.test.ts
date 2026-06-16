import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore, type StoredContextRecord } from "@info/core";
import { buildCandidateRoutes, buildRouteCandidateRecord, extractRouteFeatures } from "@info/processor-runtime";
import { compileProjectCurrent, compileWorkFocusSet, PROJECT_CURRENT_VIEW_TYPE } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-project-current-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("compileProjectCurrent generates project.current from high-confidence focus lane", () => withStore((store) => {
  const source = sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: {
      title: "Design hybrid work router",
      text: "Decision: use rule hits for realtime routing.\nHow often should the batch router run?",
    },
    payload: {
      cwd: "/Users/junjie/info",
      session_id: "codex-info",
      files_touched: ["packages/processor-runtime/builtins/route-candidate.ts", "packages/views/work-router/focus-set.ts"],
      commands_run: ["pnpm typecheck"],
    },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  const focus = compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:05:00.000Z") }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [source], write: false, now: new Date("2026-06-16T10:06:00.000Z") }, store);

  assert.equal(result.views.length, 1);
  const view = result.views[0];
  assert.equal(view.view_type, PROJECT_CURRENT_VIEW_TYPE);
  assert.equal(view.scope?.project, "info");
  assert.equal(view.scope?.project_path, "/Users/junjie/info");
  assert.deepEqual(view.content?.active_sessions, ["codex-info"]);
  assert.ok((view.content?.active_files as string[]).includes("packages/processor-runtime/builtins/route-candidate.ts"));
  assert.ok((view.content?.decisions as string[])[0]?.includes("Decision"));
  assert.ok((view.content?.open_questions as string[])[0]?.includes("How often"));
  assert.deepEqual(view.source_records, ["obs:ai:info"]);
}));

test("compileProjectCurrent supports multiple active projects", () => withStore((store) => {
  const info = sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["packages/view-system/spec.ts"] },
  });
  const paperclip = sourceRecord("obs:ai:paperclip", "observation.ai_session_locator_result", {
    scope: { project: "paperclip", project_path: "/Users/junjie/paperclip", session: "codex-paperclip" },
    payload: { cwd: "/Users/junjie/paperclip", session_id: "codex-paperclip", files_touched: ["src/tasks.ts"] },
  });
  const routes = [store.insertRecord(routeCandidateFor(info)), store.insertRecord(routeCandidateFor(paperclip))];
  const focus = compileWorkFocusSet({ records: [info, paperclip, ...routes], write: true, now: new Date("2026-06-16T10:05:00.000Z") }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [info, paperclip], write: false }, store);

  assert.equal(result.views.length, 2);
  assert.deepEqual(result.views.map(view => view.scope?.project_path).sort(), ["/Users/junjie/info", "/Users/junjie/paperclip"]);
}));

test("compileProjectCurrent excludes unrelated browser and communication records not in project lane", () => withStore((store) => {
  const project = sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: { title: "Info work", text: "Need project.current compiler." },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["packages/views/project/current.ts"] },
  });
  const weather = sourceRecord("obs:weather", "observation.browser_page_snapshot", {
    scope: { app: "chrome", domain: "weather.com" },
    content: { title: "Weather forecast", url: "https://weather.com/today", text: "weather" },
  });
  const message = sourceRecord("obs:wechat", "observation.screenpipe_activity", {
    scope: { app: "WeChat" },
    content: { title: "WeChat", text: "short reply" },
    payload: { app_name: "WeChat" },
  });
  const routeProject = store.insertRecord(routeCandidateFor(project));
  const routeWeather = store.insertRecord(routeCandidateFor(weather));
  const routeMessage = store.insertRecord(routeCandidateFor(message));
  const focus = compileWorkFocusSet({
    records: [project, weather, message, routeProject, routeWeather, routeMessage],
    write: true,
    now: new Date("2026-06-16T10:05:00.000Z"),
  }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [project, weather, message], write: false }, store);
  const view = result.views[0];

  assert.deepEqual(view.source_records, ["obs:ai:info"]);
  assert.equal(JSON.stringify(view.content).includes("Weather forecast"), false);
  assert.equal(JSON.stringify(view.content).includes("WeChat"), false);
}));

test("compileProjectCurrent does not promote secret or do-not-store project evidence", () => withStore((store) => {
  const secret = sourceRecord("obs:secret:project", "observation.ai_session_locator_result", {
    scope: { project: "secret", project_path: "/Users/junjie/secret", session: "codex-secret" },
    content: { title: "Secret work", text: "private secret task" },
    payload: { cwd: "/Users/junjie/secret", session_id: "codex-secret" },
    privacy: { level: "secret", retention: "do_not_store" },
  });
  const focus = store.upsertView({
    id: "view:focus:secret",
    view_type: "work.focus_set",
    status: "candidate",
    source_records: [secret.id],
    content: {
      active_lanes: [{
        lane_key: "project:/Users/junjie/secret",
        lane_kind: "project",
        label: "secret",
        confidence: 0.95,
        attention_share: 1,
        source_records: [secret.id],
        candidate_route_ids: [],
        evidence: { project: "secret", project_path: "/Users/junjie/secret" },
      }],
    },
  });

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [secret], write: false }, store);
  assert.equal(result.views.length, 0);
}));

function routeCandidateFor(source: StoredContextRecord) {
  const features = extractRouteFeatures(source);
  return buildRouteCandidateRecord(source, features, buildCandidateRoutes(features), new Date("2026-06-16T10:00:00.000Z"));
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

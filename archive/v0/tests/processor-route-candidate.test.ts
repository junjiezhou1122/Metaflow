import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore, type ContextRecord } from "@info/core";
import {
  ProcessorRuntime,
  ROUTE_CANDIDATE_SCHEMA,
  buildCandidateRoutes,
  createRouteCandidateProcessor,
  extractRouteFeatures,
} from "@info/processor-runtime";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-route-candidate-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("route candidate processor writes observation.route_candidate records for AI sessions", async () => withStore(async (store) => {
  const observation = store.insertRecord({
    id: "obs:ai-session:info",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", connector: "codex-locator" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "session-1" },
    content: {
      title: "Codex session for info",
      text: "files touched:\npackages/view-system/spec.ts\npackages/processor-runtime/runtime.ts",
      path: "/Users/junjie/.codex/sessions/rollout.jsonl",
    },
    payload: {
      tool: "codex",
      cwd: "/Users/junjie/info",
      session_id: "session-1",
      files_touched: ["packages/view-system/spec.ts", "packages/processor-runtime/runtime.ts"],
      commands_run: ["pnpm typecheck"],
    },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createRouteCandidateProcessor({ now: new Date("2026-06-16T10:00:00.000Z") })] });
  const result = await runtime.processObservation(observation);

  assert.equal(result.observations_written?.length, 1);
  const route = store.getRecord(result.observations_written?.[0] ?? "");
  assert.equal(route?.schema.name, ROUTE_CANDIDATE_SCHEMA);
  assert.deepEqual(route?.relations?.derived_from, ["obs:ai-session:info"]);

  const routes = route?.payload?.candidate_routes as Array<Record<string, unknown>>;
  assert.equal(routes.some(candidate => candidate.route_key === "project:/Users/junjie/info"), true);
  const project = routes.find(candidate => candidate.route_key === "project:/Users/junjie/info")!;
  assert.ok(Number(project.score) >= 0.9);
  assert.deepEqual(
    (project.rule_hits as string[]).filter(hit => hit.includes("ai_session") || hit.includes("project_path")).sort(),
    ["ai_session.project_path", "project_path.present"].sort(),
  );
  assert.equal(Object.prototype.hasOwnProperty.call(project, "reason"), false);
}));

test("route candidates classify docs browser pages without natural-language reasons", () => {
  const observation = storedRecord({
    id: "obs:browser:midscene",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "midscenejs.com" },
    content: {
      title: "Midscene.js Introduction",
      url: "https://midscenejs.com/introduction.html",
      text: "Midscene current page automation documentation.",
    },
    payload: { scroll_depth: 0.2 },
  });

  const features = extractRouteFeatures(observation);
  const routes = buildCandidateRoutes(features);

  assert.equal(features.domain, "midscenejs.com");
  assert.equal(features.url_class, "docs");
  assert.equal(routes.some(route => route.route_key === "topic:midscene"), true);
  assert.equal(routes.every(route => !("reason" in route)), true);
  assert.ok(routes.find(route => route.route_key === "topic:midscene")?.rule_hits.includes("domain.docs"));
});

test("route candidates demote unrelated browser pages and communication interruptions", () => {
  const weather = buildCandidateRoutes(extractRouteFeatures(storedRecord({
    id: "obs:weather",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "weather.com" },
    content: { title: "Weather forecast", url: "https://weather.com/today", text: "Weather forecast" },
  })));
  const message = buildCandidateRoutes(extractRouteFeatures(storedRecord({
    id: "obs:message",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe" },
    scope: { app: "WeChat" },
    content: { title: "WeChat", text: "short personal reply" },
    payload: { app_name: "WeChat" },
  })));

  assert.equal(weather.some(route => route.route_key.startsWith("project:")), false);
  assert.equal(message.some(route => route.route_key === "communication:messages"), true);
  assert.equal(message.find(route => route.route_key === "communication:messages")?.lane_kind, "communication");
});

function storedRecord(record: ContextRecord & { id: string }) {
  const now = "2026-06-16T10:00:00.000Z";
  return {
    ...record,
    time: { observed_at: record.time?.observed_at ?? now, captured_at: record.time?.captured_at ?? now },
    payload: record.payload ?? {},
    created_at: now,
    updated_at: now,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import {
  ProcessorRuntime,
  buildSurfaceStateView,
  createProcessorRegistry,
  createSurfaceStateProcessor,
  createViewPromotionEngineProcessor,
  createWorkRouterBatchProcessor,
  matchesPattern,
  type ProcessorDefinition,
} from "@info/processor-runtime";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-processor-runtime-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("local processor consumes an Observation and writes a ViewDraft as a View", async () => withStore(async (store) => {
  const processor: ProcessorDefinition = {
    id: "processor.writing_assist",
    version: "0.0.1",
    consumes: { observations: ["observation.editor.text_changed"] },
    produces: { views: ["advice.writing_assist"] },
    runtime: { kind: "local" },
    handler: ({ observation }) => ({
      views: [{
        type: "advice.writing_assist",
        title: "Writing suggestion",
        summary: "Tighten the sentence.",
        content: {
          original_text: observation?.content?.text,
          suggestion: "Make the sentence shorter and more direct.",
        },
        confidence: 0.82,
      }],
    }),
  };
  const observation = store.insertRecord({
    id: "obs:editor:1",
    schema: { name: "observation.editor.text_changed", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    content: { text: "I think that maybe this sentence could possibly be shorter." },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [processor] });
  const result = await runtime.processObservation(observation);

  assert.equal(result.ok, true);
  assert.deepEqual(result.processors_matched, ["processor.writing_assist"]);
  assert.equal(result.views_written.length, 1);

  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, "advice.writing_assist");
  assert.deepEqual(view?.source_records, ["obs:editor:1"]);
  assert.equal(view?.compiler?.id, "processor.writing_assist");
  assert.equal(view?.compiler?.mode, "deterministic");
  assert.equal(view?.metadata?.processor_runtime, "local");
  assert.equal(view?.content?.suggestion, "Make the sentence shorter and more direct.");
  assert.ok(store.listRuntimeEvents({ event_type: "processor.view_written", plugin_id: "processor.writing_assist", limit: 1 })[0]);
}));

test("a processor can consume a View produced by another processor", async () => withStore(async (store) => {
  const advice = store.upsertView({
    id: "advice:writing:1",
    view_type: "advice.writing_assist",
    source_records: ["obs:editor:1"],
    content: {
      suggestion: "Use simpler wording.",
    },
  });
  const processor: ProcessorDefinition = {
    id: "processor.writing_preference",
    consumes: { views: ["advice.writing_assist"] },
    produces: { views: ["memory.preference"] },
    runtime: { kind: "local" },
    handler: ({ view }) => ({
      views: [{
        type: "memory.preference",
        title: "Writing preference",
        content: {
          preference: "User benefits from direct, simple wording suggestions.",
          source_suggestion: view?.content?.suggestion,
        },
      }],
    }),
  };

  const runtime = new ProcessorRuntime({ store, processors: [processor] });
  const result = await runtime.processView(advice);

  assert.deepEqual(result.processors_matched, ["processor.writing_preference"]);
  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, "memory.preference");
  assert.deepEqual(view?.source_views, ["advice:writing:1"]);
  assert.equal(view?.content?.source_suggestion, "Use simpler wording.");
}));

test("view promotion engine produces adaptive ViewGraph evolution candidates", async () => withStore(async (store) => {
  const now = new Date(Date.now() + 60_000);
  for (let index = 0; index < 3; index += 1) {
    store.insertRecord({
      id: `route:promotion:${index}`,
      schema: { name: "observation.route_candidate", version: 1 },
      source: { type: "runtime", connector: "processor.route_candidate" },
      time: { observed_at: new Date(now.getTime() - index * 60_000).toISOString() },
      payload: {
        candidate_routes: [{
          route_key: "project:/Users/junjie/info",
          lane_kind: "project",
          score: 0.8,
          rule_hits: ["project_path.present"],
        }],
      },
      privacy: { level: "private", retention: "normal" },
    });
  }
  store.appendRuntimeEvent({
    id: "event:promotion:failed:1",
    event_type: "agent_task.failed",
    actor: "system",
    status: "failed",
    subject_type: "view",
    subject_id: "task:browser:failed",
  });
  store.appendRuntimeEvent({
    id: "event:promotion:failed:2",
    event_type: "processor.run.failed",
    actor: "system",
    status: "failed",
    subject_type: "runtime",
    subject_id: "processor.browser",
  });
  const seed = store.insertRecord({
    id: "obs:promotion:seed",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    time: { observed_at: now.toISOString() },
    content: { title: "Info" },
  });

  const runtime = new ProcessorRuntime({
    store,
    processors: [createViewPromotionEngineProcessor({ now, windowMinutes: 60 })],
  });
  const result = await runtime.processObservation(seed);

  assert.deepEqual(result.processors_matched, ["processor.view_promotion_engine"]);
  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, "view.promotion_candidates");
  const candidates = view?.content?.candidates as Array<Record<string, unknown>>;
  assert.ok(candidates.some(candidate => candidate.action === "create_view" && candidate.target_view_type === "project.current"));
  assert.ok(candidates.some(candidate => candidate.action === "create_processor" && candidate.target_processor_id === "processor.failure_miner"));
  assert.equal(view?.metadata?.view_promotion_engine, true);
}));

test("registry supports exact, prefix wildcard, and global wildcard routing", () => {
  assert.equal(matchesPattern("observation.editor.text_changed", "observation.editor.text_changed"), true);
  assert.equal(matchesPattern("observation.editor.*", "observation.editor.text_changed"), true);
  assert.equal(matchesPattern("observation.screenpipe_*", "observation.screenpipe_activity"), true);
  assert.equal(matchesPattern("*", "analysis.browser_page"), true);
  assert.equal(matchesPattern("observation.browser.*", "observation.editor.text_changed"), false);

  const registry = createProcessorRegistry([
    {
      id: "processor.editor",
      consumes: { observations: ["observation.editor.*"] },
      produces: { views: ["advice.*"] },
      runtime: { kind: "local" },
      handler: () => ({ views: [] }),
    },
    {
      id: "processor.any_view",
      consumes: { views: ["*"] },
      produces: { views: ["analysis.any"] },
      runtime: { kind: "local" },
      handler: () => ({ views: [] }),
    },
  ]);

  assert.deepEqual(
    registry.matchingObservation("observation.editor.text_changed").map(processor => processor.id),
    ["processor.editor"],
  );
  assert.deepEqual(
    registry.matchingView("advice.writing_assist").map(processor => processor.id),
    ["processor.any_view"],
  );
});

test("runtime records unsupported runtimes as failed processor runs", async () => withStore(async (store) => {
  const observation = store.insertRecord({
    id: "obs:browser:1",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser" },
    content: { title: "Example", url: "https://example.com", text: "Example page" },
  });
  const processor: ProcessorDefinition = {
    id: "processor.remote_llm_placeholder",
    consumes: { observations: ["observation.browser_page_snapshot"] },
    produces: { views: ["analysis.browser_page"] },
    runtime: { kind: "llm", model: "future-model" },
  };

  const runtime = new ProcessorRuntime({ store, processors: [processor] });
  const result = await runtime.processObservation(observation);

  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].error ?? "", /requires a handler or configured provider bridge/);
  assert.ok(store.listRuntimeEvents({ event_type: "processor.run.failed", plugin_id: "processor.remote_llm_placeholder", limit: 1 })[0]);
}));

test("cli processor runtime executes a JSON worker and writes returned drafts", async () => withStore(async (store) => {
  const dir = mkdtempSync(join(tmpdir(), "info-processor-cli-"));
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, `
const payload = JSON.parse(process.env.INFO_PROCESSOR_INPUT);
process.stdout.write(JSON.stringify({
  views: [{
    type: "analysis.cli_worker",
    title: "CLI worker output",
    content: { source_id: payload.input.observation.id, processor_id: process.env.INFO_PROCESSOR_ID }
  }],
  diagnostics: { runtime: process.env.INFO_PROCESSOR_RUNTIME }
}));
`);
  const observation = store.insertRecord({
    id: "obs:cli-runtime",
    schema: { name: "observation.cli_runtime", version: 1 },
    source: { type: "test" },
    content: { title: "CLI source" },
  });
  const processor: ProcessorDefinition = {
    id: "processor.cli_worker",
    consumes: { observations: ["observation.cli_runtime"] },
    produces: { views: ["analysis.cli_worker"] },
    runtime: { kind: "cli", command: process.execPath, args: [worker] },
  };

  const result = await new ProcessorRuntime({ store, processors: [processor] }).processObservation(observation);

  assert.equal(result.runs[0]?.ok, true);
  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, "analysis.cli_worker");
  assert.equal(view?.content?.source_id, "obs:cli-runtime");
  assert.equal(view?.metadata?.processor_runtime, "cli");
  assert.equal(result.runs[0]?.diagnostics.runtime, "cli");
}));

test("http processor runtime posts processor payload and writes returned drafts", async () => withStore(async (store) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      const payload = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        views: [{
          type: "analysis.http_worker",
          title: "HTTP worker output",
          content: { source_id: payload.input.observation.id, processor_id: payload.processor.id },
        }],
        diagnostics: { method: req.method },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const observation = store.insertRecord({
      id: "obs:http-runtime",
      schema: { name: "observation.http_runtime", version: 1 },
      source: { type: "test" },
      content: { title: "HTTP source" },
    });
    const processor: ProcessorDefinition = {
      id: "processor.http_worker",
      consumes: { observations: ["observation.http_runtime"] },
      produces: { views: ["analysis.http_worker"] },
      runtime: { kind: "http", url: `http://127.0.0.1:${address.port}/processor` },
    };

    const result = await new ProcessorRuntime({ store, processors: [processor] }).processObservation(observation);

    assert.equal(result.runs[0]?.ok, true);
    const view = store.getView(result.views_written[0]);
    assert.equal(view?.view_type, "analysis.http_worker");
    assert.equal(view?.content?.source_id, "obs:http-runtime");
    assert.equal(view?.metadata?.processor_runtime, "http");
    assert.equal(result.runs[0]?.diagnostics.method, "POST");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));

test("surface state prefers Chrome ACP context for browser/editor surfaces", async () => withStore(async (store) => {
  const page = store.insertRecord({
    id: "obs:browser:surface",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "example.com" },
    time: { observed_at: "2026-06-11T10:00:00.000Z" },
    content: {
      title: "Example article",
      url: "https://example.com/article",
      text: "This is the article text that should be used as browser page context.",
    },
    payload: { scroll_depth: 0.4, selected_text_length: 0 },
  });
  store.insertRecord({
    id: "obs:screen:surface",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Google Chrome", domain: "example.com" },
    time: { observed_at: "2026-06-11T10:00:01.000Z" },
    content: { title: "Google Chrome - Example article", text: "Noisy OCR around the same page." },
    payload: {
      app_name: "Google Chrome",
      window_name: "Example article - Google Chrome",
      browser_url: "https://example.com/article",
      frame_id: 123,
      raw_result: { content: { file_path: "/tmp/frame.jpg", text_source: "accessibility" } },
    },
  });
  const editor = store.insertRecord({
    id: "obs:editor:surface",
    schema: { name: "observation.editor.text_changed", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "example.com" },
    time: { observed_at: "2026-06-11T10:00:02.000Z" },
    content: {
      title: "Example article",
      url: "https://example.com/article",
      text: "Please rewrite this sentence in a clearer way.",
    },
    payload: { text_length: 47, writing_surface: "browser_inline", element_kind: "textarea" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createSurfaceStateProcessor({ windowMinutes: 1440, now: new Date("2026-06-11T10:00:03.000Z") })] });
  const result = await runtime.processObservation(editor);
  const surface = store.getView(result.views_written[0]);

  assert.equal(surface?.view_type, "state.surface");
  assert.equal(surface?.content?.surface_kind, "editor");
  assert.equal(surface?.content?.source_priority, "browser_acp");
  assert.equal(surface?.content?.active_url, "https://example.com/article");
  assert.equal((surface?.content?.focused_element as any)?.text_preview, "Please rewrite this sentence in a clearer way.");
  assert.equal((surface?.content?.page as any)?.text_preview, page.content?.text);
  assert.ok(surface?.source_records?.includes("obs:editor:surface"));
  assert.ok(surface?.source_records?.includes("obs:screen:surface"));
}));

test("surface state uses Screenpipe OCR/screenshot for non-browser surfaces", async () => withStore(async (store) => {
  const screen = store.insertRecord({
    id: "obs:screen:terminal",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Warp" },
    time: { observed_at: "2026-06-11T10:00:00.000Z" },
    content: {
      title: "Warp - info",
      text: "pnpm typecheck && node --experimental-sqlite --import tsx --test tests/processor-runtime.test.ts",
    },
    payload: {
      app_name: "Warp",
      window_name: "info",
      frame_id: 39408,
      frame_ids: [39408],
      raw_result: {
        content: {
          file_path: "/Users/junjie/.screenpipe/data/frame.jpg",
          text_source: "accessibility",
        },
      },
    },
  });
  store.insertRecord({
    id: "obs:screen:input",
    schema: { name: "observation.screenpipe_input_event", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Warp" },
    time: { observed_at: "2026-06-11T10:00:02.000Z" },
    content: { title: "input - Warp", text: "key" },
    payload: { app_name: "Warp", content_type: "input" },
  });
  store.insertRecord({
    id: "obs:screen:audio",
    schema: { name: "observation.screenpipe_audio", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    time: { observed_at: "2026-06-11T10:00:01.000Z" },
    content: { title: "Audio", text: "现在总结一下当前界面" },
    payload: { audio_chunk_id: 1, device_name: "EarPods Microphone" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createSurfaceStateProcessor({ windowMinutes: 1440, now: new Date("2026-06-11T10:00:04.000Z") })] });
  const result = await runtime.processObservation(screen);
  const surface = store.getView(result.views_written[0]);

  assert.equal(surface?.content?.surface_kind, "terminal");
  assert.equal(surface?.content?.source_priority, "screenpipe");
  assert.equal(surface?.content?.active_app, "Warp");
  assert.equal((surface?.content?.screen as any)?.frame_id, "39408");
  assert.equal((surface?.content?.screen as any)?.screenshot_path, "/Users/junjie/.screenpipe/data/frame.jpg");
  assert.match((surface?.content?.screen as any)?.visible_text_preview, /pnpm typecheck/);
  assert.equal((surface?.content?.input_state as any)?.typing_active, true);
  assert.match((surface?.content?.audio as any)?.transcript_preview, /当前界面/);
}));

test("surface view builder can summarize raw records without a runtime", () => {
  const view = buildSurfaceStateView({
    now: new Date("2026-06-11T10:00:05.000Z"),
    records: [{
      id: "obs:screen:standalone",
      schema: { name: "observation.screenpipe_activity", version: 1 },
      source: { type: "screenpipe", connector: "screenpipe-local-api" },
      scope: { app: "Code" },
      time: { observed_at: "2026-06-11T10:00:00.000Z" },
      content: { title: "Code - surface-state.ts", text: "export function buildSurfaceStateView" },
      payload: { app_name: "Code", window_name: "surface-state.ts", frame_id: 7 },
      created_at: "2026-06-11T10:00:00.000Z",
      updated_at: "2026-06-11T10:00:00.000Z",
    }],
  });

  assert.equal(view.type, "state.surface");
  assert.equal(view.content?.surface_kind, "ide");
  assert.equal((view.content?.screen as any)?.frame_id, "7");
});

test("work_router_batch processor is registered with correct id and metadata", () => {
  const processor = createWorkRouterBatchProcessor();
  assert.equal(processor.id, "processor.work_router_batch");
  assert.deepEqual(processor.produces.views, ["work.focus_set"]);
  assert.ok(processor.consumes.observations?.includes("observation.route_candidate"));
  assert.equal(processor.runtime.kind, "local");
});

test("work_router_batch processor writes a work.focus_set view from route candidates", async () => withStore(async (store) => {
  const now = new Date("2026-06-18T10:00:00.000Z");
  for (let i = 0; i < 3; i++) {
    store.insertRecord({
      id: `route:batch:${i}`,
      schema: { name: "observation.route_candidate", version: 1 },
      source: { type: "runtime", connector: "processor.route_candidate" },
      time: { observed_at: new Date(now.getTime() - i * 60_000).toISOString() },
      payload: {
        candidate_routes: [{
          route_key: "project:/Users/junjie/info",
          lane_kind: "project",
          score: 0.85,
          rule_hits: ["project_path.present"],
        }],
      },
      privacy: { level: "private", retention: "normal" },
    });
  }
  const seed = store.insertRecord({
    id: "obs:batch:seed",
    schema: { name: "observation.route_candidate", version: 1 },
    source: { type: "runtime" },
    time: { observed_at: now.toISOString() },
    payload: { candidate_routes: [{ route_key: "project:/Users/junjie/info", lane_kind: "project", score: 0.9, rule_hits: [] }] },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createWorkRouterBatchProcessor({ now })] });
  const result = await runtime.processObservation(seed);

  assert.deepEqual(result.processors_matched, ["processor.work_router_batch"]);
  assert.equal(result.views_written.length, 1);
  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, "work.focus_set");
  assert.equal(view?.compiler?.id, "processor.work_router_batch");
  const lanes = (view?.content?.active_lanes as Array<{ lane_key: string }>) ?? [];
  assert.ok(lanes.some(lane => lane.lane_key === "project:/Users/junjie/info"));
}));

test("work_router_batch processor writes empty focus set when no route candidates present", async () => withStore(async (store) => {
  const now = new Date("2026-06-18T10:00:00.000Z");
  const seed = store.insertRecord({
    id: "obs:batch:empty",
    schema: { name: "observation.route_candidate", version: 1 },
    source: { type: "runtime" },
    time: { observed_at: now.toISOString() },
    payload: { candidate_routes: [] },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createWorkRouterBatchProcessor({ now })] });
  const result = await runtime.processObservation(seed);

  assert.equal(result.views_written.length, 1);
  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, "work.focus_set");
  assert.deepEqual((view?.content?.active_lanes as unknown[]) ?? [], []);
}));

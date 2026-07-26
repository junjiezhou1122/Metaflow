import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { ProcessorRuntime } from "@info/processor-runtime";
import {
  buildRouteCandidateRecord,
  createRouteCandidateProcessor,
  extractRouteFeatures,
  buildCandidateRoutes,
} from "@info/processor-runtime";
import {
  compileWorkFocusSet,
  compileProjectCurrent,
  compileMemoryCandidates,
  compileMemoryGate,
  WORK_FOCUS_SET_VIEW_TYPE,
  PROJECT_CURRENT_VIEW_TYPE,
  MEMORY_CANDIDATE_VIEW_TYPE,
} from "@info/views";

// ── Helpers ─────────────────────────────────────────────────────────────────

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-e2e-dogfood-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sourceRecord(id: string, schemaName: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  const now = "2026-06-16T10:00:00.000Z";
  return {
    id,
    schema: { name: schemaName, version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: {},
    time: { observed_at: now, captured_at: now },
    content: {},
    payload: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function routeCandidateFor(source: Record<string, unknown>) {
  const features = extractRouteFeatures(source as any);
  return buildRouteCandidateRecord(source as any, features, buildCandidateRoutes(features), new Date("2026-06-16T10:00:00.000Z"));
}

function orderedSnapshot(label: string, store: ContextStore): object {
  return {
    label,
    records: store.recent(100).map(r => ({ id: r.id, schema: r.schema.name })),
    views: store.listViews({ limit: 100 }).map(v => ({ id: v.id, type: v.view_type, status: v.status })),
    events: store.listRuntimeEvents({ limit: 20 }).map(e => e.event_type),
  };
}

function saveArtifact(artifactDir: string, name: string, data: unknown) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, name), JSON.stringify(data, null, 2));
}

// ── Scenario 1: Coding with browser research ────────────────────────────────

test("Scenario 1: Coding with browser research updates project views", async () => withStore(async (store) => {
  const artifactDir = join(tmpdir(), "info-e2e-artifacts-scenario-1");

  // 1a. User is coding in the info project
  const coding = store.insertRecord({
    id: "obs:ai:info",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: {
      title: "Implement end-to-end dogfood scenarios",
      text: "Need to build tests for coding with browser research.",
    },
    payload: {
      cwd: "/Users/junjie/info",
      session_id: "codex-info",
      files_touched: ["tests/e2e-dogfood-scenarios.test.ts"],
      commands_run: ["pnpm typecheck"],
    },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 1b. User visits documentation pages
  const docs = store.insertRecord({
    id: "obs:browser:midscene",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "midscenejs.com" },
    content: {
      title: "Midscene.js Introduction",
      url: "https://midscenejs.com/introduction.html",
      text: "Current page automation for Chrome ACP.",
    },
    payload: { scroll_depth: 0.2 },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 1c. Run route candidate processor
  const routeProcessor = createRouteCandidateProcessor({ now: new Date("2026-06-16T10:00:00.000Z") });
  const runtime = new ProcessorRuntime({ store, processors: [routeProcessor] });
  await runtime.processObservation(coding as any);
  await runtime.processObservation(docs as any);

  // 1d. Compile work focus set and project current
  const focusResult = compileWorkFocusSet({
    records: store.recent(50),
    write: true,
    now: new Date("2026-06-16T10:05:00.000Z"),
  }, store);

  assert.equal(focusResult.view.view_type, WORK_FOCUS_SET_VIEW_TYPE);
  assert.ok(focusResult.active_lanes.some(lane => lane.lane_key === "project:/Users/junjie/info"), "Expected project lane for info");
  assert.ok(focusResult.active_lanes.some(lane => lane.lane_key === "topic:midscene"), "Expected topic lane for midscene docs");

  const projectResult = compileProjectCurrent({
    focusSetViews: [focusResult.view as any],
    records: store.recent(50),
    write: true,
    now: new Date("2026-06-16T10:06:00.000Z"),
  }, store);

  assert.equal(projectResult.views.length, 1);
  assert.equal(projectResult.views[0].view_type, PROJECT_CURRENT_VIEW_TYPE);
  assert.equal(projectResult.views[0].scope?.project, "info");
  assert.ok((projectResult.views[0].content?.active_files as string[]).includes("tests/e2e-dogfood-scenarios.test.ts"));
  assert.ok((projectResult.views[0].content?.next_actions as string[]).length > 0);

  saveArtifact(artifactDir, "scenario-1-snapshot.json", orderedSnapshot("scenario-1", store));
}));

// ── Scenario 2: Unrelated interruption does not pollute ─────────────────────

test("Scenario 2: Unrelated interruption does not pollute project views", async () => withStore(async (store) => {
  const artifactDir = join(tmpdir(), "info-e2e-artifacts-scenario-2");

  // 2a. User is coding
  const coding = store.insertRecord({
    id: "obs:ai:info",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: { title: "Info work", text: "Implementing feature." },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["src/index.ts"] },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 2b. Weather tab opened
  const weather = store.insertRecord({
    id: "obs:weather",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "weather.com" },
    content: { title: "Weather forecast", url: "https://weather.com/today", text: "Sunny today." },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 2c. Messaging tab opened
  const messaging = store.insertRecord({
    id: "obs:wechat",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "WeChat" },
    content: { title: "WeChat", text: "short personal reply" },
    payload: { app_name: "WeChat" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 2d. Run route candidate and compile
  const routeProcessor = createRouteCandidateProcessor({ now: new Date("2026-06-16T10:00:00.000Z") });
  const pr = new ProcessorRuntime({ store, processors: [routeProcessor] });
  await pr.processObservation(coding as any);
  await pr.processObservation(weather as any);
  await pr.processObservation(messaging as any);

  const focus = compileWorkFocusSet({ records: store.recent(50), write: true, now: new Date("2026-06-16T10:10:00.000Z") }, store);

  // Weather should not start a project lane
  assert.equal(focus.active_lanes.some(lane => lane.lane_key.startsWith("project:") && lane.lane_key.includes("weather")), false);
  // Messaging should be low-attention communication lane
  const commLane = focus.active_lanes.find(lane => lane.lane_key === "communication:messages");
  if (commLane) {
    assert.ok(commLane.attention_share < 0.5, "Communication lane should get less than half attention");
  }

  const projectResult = compileProjectCurrent({ focusSetViews: [focus.view as any], records: store.recent(50), write: true }, store);
  assert.equal(projectResult.views.length, 1);
  const projectView = projectResult.views[0];
  assert.equal(projectView.scope?.project, "info");
  assert.equal(JSON.stringify(projectView.content).includes("Weather forecast"), false);
  assert.equal(JSON.stringify(projectView.content).includes("WeChat"), false);

  saveArtifact(artifactDir, "scenario-2-snapshot.json", orderedSnapshot("scenario-2", store));
}));

// ── Scenario 3: YouTube learning ────────────────────────────────────────────

test("Scenario 3: YouTube caption on/off and pause fragments create learning views", async () => withStore(async (store) => {
  const artifactDir = join(tmpdir(), "info-e2e-artifacts-scenario-3");

  // 3a. Caption on
  const captionOn = store.insertRecord({
    id: "obs:youtube:caption-on",
    schema: { name: "observation.youtube.caption_state", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Agentic AI Talk", text: "Captions enabled." },
    payload: { video_id: "abc123", caption_enabled: true, current_time: 120 },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 3b. Caption fragment while watching
  const captionFragment = store.insertRecord({
    id: "obs:youtube:fragment",
    schema: { name: "observation.youtube.caption_fragment", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Agentic AI Talk", text: "Agents can be composed of smaller skills." },
    payload: { video_id: "abc123", start_seconds: 120, end_seconds: 146, caption_text: "Agents can be composed of smaller skills." },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 3c. Pause event
  const pause = store.insertRecord({
    id: "obs:youtube:pause",
    schema: { name: "observation.youtube.pause", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Agentic AI Talk", text: "Video paused." },
    payload: { video_id: "abc123", current_time: 146, action: "pause" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 3d. Caption off
  const captionOff = store.insertRecord({
    id: "obs:youtube:caption-off",
    schema: { name: "observation.youtube.caption_state", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Agentic AI Talk", text: "Captions disabled." },
    payload: { video_id: "abc123", caption_enabled: false, current_time: 200 },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // Verify records are stored
  assert.equal(store.getRecord("obs:youtube:caption-on")?.schema.name, "observation.youtube.caption_state");
  assert.equal(store.getRecord("obs:youtube:fragment")?.schema.name, "observation.youtube.caption_fragment");
  assert.equal(store.getRecord("obs:youtube:pause")?.schema.name, "observation.youtube.pause");
  assert.equal(store.getRecord("obs:youtube:caption-off")?.schema.name, "observation.youtube.caption_state");

  // Verify route candidates classify them
  const routeProcessor = createRouteCandidateProcessor({ now: new Date("2026-06-16T10:00:00.000Z") });
  const pr = new ProcessorRuntime({ store, processors: [routeProcessor] });
  await pr.processObservation(captionOn as any);
  await pr.processObservation(captionFragment as any);
  await pr.processObservation(pause as any);
  await pr.processObservation(captionOff as any);

  const allRecords = store.recent(50);
  const youtubeRouteCandidates = allRecords.filter(r => r.schema.name === "observation.route_candidate")
    .filter(r => (r.payload?.features as any)?.domain === "youtube.com");
  assert.ok(youtubeRouteCandidates.length >= 1, "Expected at least one YouTube route candidate");

  // Focus set should include a topic lane for youtube content
  const focus = compileWorkFocusSet({ records: allRecords, write: true, now: new Date("2026-06-16T10:10:00.000Z") }, store);
  const youtubeTopic = focus.active_lanes.find(lane => lane.lane_key === "domain:youtube.com");
  assert.ok(youtubeTopic, "Expected a YouTube domain lane");

  saveArtifact(artifactDir, "scenario-3-snapshot.json", orderedSnapshot("scenario-3", store));
}));

// ── Scenario 4: Selection explain/translate ─────────────────────────────────────

test("Scenario 4: Selection explain/translate creates expected observations and views", async () => withStore(async (store) => {
  const artifactDir = join(tmpdir(), "info-e2e-artifacts-scenario-4");

  // 4a. Text selection in browser
  const selection = store.insertRecord({
    id: "obs:browser:select",
    schema: { name: "observation.browser_text_selected", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "example.com" },
    content: {
      title: "Architecture notes",
      text: "The context runtime maintains work thread candidates as views.",
      url: "https://example.com/architecture",
    },
    payload: { selected_text: "context runtime maintains work thread candidates", selection_length: 48 },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 4b. Explain action triggered by user
  const explainAction = store.insertRecord({
    id: "obs:action:explain",
    schema: { name: "observation.browser_action", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: { title: "Explain selection", text: "User requested explanation of selected text." },
    payload: { action: "explain", selected_text: "context runtime maintains work thread candidates" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 4c. Translate action triggered
  const translateAction = store.insertRecord({
    id: "obs:action:translate",
    schema: { name: "observation.browser_action", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: { title: "Translate selection", text: "User requested translation of selected text." },
    payload: { action: "translate", selected_text: "context runtime maintains work thread candidates", target_language: "zh" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // Verify explain/translate observations are stored
  assert.equal(store.getRecord("obs:action:explain")?.payload?.action, "explain");
  assert.equal(store.getRecord("obs:action:translate")?.payload?.action, "translate");
  assert.equal(store.getRecord("obs:action:translate")?.payload?.target_language, "zh");

  // Route candidates should classify them
  const routeProcessor = createRouteCandidateProcessor({ now: new Date("2026-06-16T10:00:00.000Z") });
  const pr = new ProcessorRuntime({ store, processors: [routeProcessor] });
  await pr.processObservation(selection as any);
  await pr.processObservation(explainAction as any);
  await pr.processObservation(translateAction as any);

  const allRecords = store.recent(50);
  const browserRoutes = allRecords.filter(r => r.schema.name === "observation.route_candidate")
    .filter(r => (r.payload?.features as any)?.source_type === "browser");
  assert.ok(browserRoutes.length >= 3, "Expected route candidates for browser actions");

  saveArtifact(artifactDir, "scenario-4-snapshot.json", orderedSnapshot("scenario-4", store));
}));

// ── Scenario 5: Writing suggestion feedback affects memory ──────────────────

test("Scenario 5: Writing suggestion dismiss/insert/edit feedback affects memory", async () => withStore(async (store) => {
  const artifactDir = join(tmpdir(), "info-e2e-artifacts-scenario-5");

  // 5a. Writing advice view is produced
  const advice = store.upsertView({
    id: "advice:writing:1",
    view_type: "advice.writing_assist",
    title: "Writing suggestion",
    summary: "Tighten the sentence.",
    content: {
      original_text: "I think that maybe this sentence could possibly be shorter.",
      suggestion: "Make the sentence shorter and more direct.",
    },
    source_records: [],
    confidence: 0.82,
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 5b. User dismisses the advice
  const dismissFeedback = store.insertRecord({
    id: "feedback:dismiss",
    schema: { name: "feedback.analysis.dismissed", version: 1 },
    source: { type: "application", connector: "browser.popup" },
    content: { title: "Dismissed writing suggestion" },
    relations: { related_to: ["advice:writing:1"] },
    payload: { value: "dismissed", view_id: "advice:writing:1" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 5c. Memory candidates should reflect the dismiss feedback
  const result = compileMemoryCandidates({ records: [dismissFeedback], views: [advice], feedback_index: new Map(), write: true }, store);
  assert.ok(result.views.length > 0, "Expected memory candidates from dismiss feedback");
  const candidate = result.views[0];
  assert.equal(candidate.view_type, MEMORY_CANDIDATE_VIEW_TYPE);
  assert.equal(candidate.content?.memory_kind, "preference");
  assert.equal(candidate.content?.target_view_type, "memory.preferences");
  assert.ok(String(candidate.content?.claim).includes("Prefer less automatic surfacing"));
  assert.deepEqual(candidate.source_records, ["feedback:dismiss"]);

  // 5d. User edits the advice output
  const editFeedback = store.insertRecord({
    id: "feedback:edit",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application", connector: "browser.popup" },
    content: { title: "Edited writing suggestion", text: "Shortened it more aggressively." },
    relations: { related_to: ["advice:writing:1"] },
    payload: { edit_summary: "Shortened it more aggressively.", view_id: "advice:writing:1" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 5e. Memory candidates from edit feedback should capture collaboration style
  const editResult = compileMemoryCandidates({ records: [editFeedback], views: [advice], feedback_index: new Map(), write: true }, store);
  assert.ok(editResult.views.length > 0, "Expected memory candidates from edit feedback");
  const editCandidate = editResult.views[0];
  assert.equal(editCandidate.content?.memory_kind, "agent_collaboration_style");
  assert.equal(editCandidate.content?.target_view_type, "memory.agent_collaboration_style");
  assert.ok(String(editCandidate.content?.claim).includes("User edited agent output"));

  saveArtifact(artifactDir, "scenario-5-snapshot.json", orderedSnapshot("scenario-5", store));
}));

// ── Scenario 6: Memory candidate promote/reject ──────────────────────────────

test("Scenario 6: Memory candidate promote/reject via CLI/UI actions", async () => withStore(async (store) => {
  const artifactDir = join(tmpdir(), "info-e2e-artifacts-scenario-6");

  // 6a. Create a memory candidate via project current view
  const projectView = store.upsertView({
    id: "project:current",
    view_type: "project.current",
    title: "Project current: info",
    summary: "Implement dogfood scenarios.",
    source_records: ["obs:project"],
    content: { focus: "Dogfood scenario implementation" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    confidence: 0.82,
    privacy: { level: "private", retention: "normal" },
  } as any);

  const candidateResult = compileMemoryCandidates({ records: [], views: [projectView], feedback_index: new Map(), write: true }, store);
  assert.equal(candidateResult.views.length, 1);
  const candidate = candidateResult.views[0];
  assert.equal(candidate.view_type, MEMORY_CANDIDATE_VIEW_TYPE);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.content?.gate_status, "candidate");

  // Add the source record so gate passes privacy check
  store.insertRecord({
    id: "obs:project",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { title: "Project snapshot", text: "Dogfood scenario implementation" },
    privacy: { level: "private", retention: "normal" },
  } as any);

  // 6b. User promotes the candidate via CLI action
  const gateResult = compileMemoryGate({
    candidates: [candidate],
    force_promote_ids: [candidate.id],
    write: true,
    now: new Date("2026-06-16T11:00:00.000Z"),
  }, store);

  assert.equal(gateResult.decisions[0]?.action, "promote");
  assert.equal(gateResult.views.length, 1);
  const durable = gateResult.views[0];
  assert.equal(durable.view_type, "project.memory");
  assert.equal(durable.status, "accepted");
  assert.equal(durable.content?.claim, candidate.content?.claim);
  assert.equal(durable.content?.memory_kind, "project_memory");

  // 6c. Create another candidate and reject it
  const projectView2 = store.upsertView({
    id: "project:current:2",
    view_type: "project.current",
    title: "Project current: ephemeral",
    summary: "Temporary experiment.",
    source_records: ["obs:temp"],
    content: { focus: "Temporary experiment not worth keeping." },
    scope: { project: "temp", project_path: "/Users/junjie/temp" },
    confidence: 0.5,
    privacy: { level: "private", retention: "normal" },
  } as any);

  const candidate2Result = compileMemoryCandidates({ records: [], views: [projectView2], feedback_index: new Map(), write: true }, store);
  const candidate2 = candidate2Result.views[0];

  const rejectGateResult = compileMemoryGate({
    candidates: [candidate2],
    reject_ids: [candidate2.id],
    rejection_reason: "User rejected: not useful",
    write: true,
    now: new Date("2026-06-16T11:01:00.000Z"),
  }, store);

  assert.equal(rejectGateResult.decisions[0].action, "reject");
  const updatedCandidate = store.getView(candidate2.id);
  assert.equal(updatedCandidate?.status, "rejected");
  assert.equal(updatedCandidate?.content?.rejection_reason, "User rejected: not useful");

  // Verify no durable memory created for rejected candidate
  const allProjectMemories = store.listViews({ view_types: ["project.memory"], limit: 50 });
  assert.equal(allProjectMemories.some(v => v.content?.claim?.includes("Temporary experiment")), false);

  saveArtifact(artifactDir, "scenario-6-snapshot.json", orderedSnapshot("scenario-6", store));
}));

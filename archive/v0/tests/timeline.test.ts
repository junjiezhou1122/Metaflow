import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { compileObservationTimeline } from "@info/views/timeline/timeline.js";
import { compileActivityTimeline } from "@info/views/timeline/activity-timeline.js";
import { compileProjectTimeline } from "@info/views/timeline/project-timeline.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-timeline-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const FIXTURE_BASE_MS = Math.floor((Date.now() - 12 * 60 * 60_000) / (5 * 60_000)) * 5 * 60_000;

function fixtureTime(offsetSeconds = 0): string {
  return new Date(FIXTURE_BASE_MS + offsetSeconds * 1000).toISOString();
}

function seedLegacyRecords(store: ContextStore) {
  store.insertRecord({
    id: "record:timeline-raw-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "info", project_path: "/Users/junjie/info", domain: "github.com", app: "chrome" },
    content: {
      title: "Raw Info project page",
      url: "https://github.com/example/info",
      text: "Raw observation about context runtime timelines and work_thread views.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:timeline-derived-legacy",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy-compiler" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: {
      title: "Legacy derived timeline memory",
      text: "LEGACY DERIVED TIMELINE RECORD SHOULD NOT BECOME TIMELINE EVIDENCE.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:timeline-episode-legacy",
    schema: { name: "episode.project_work", version: 1 },
    source: { type: "plugin", connector: "legacy-episode" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: {
      title: "Legacy timeline episode",
      text: "LEGACY EPISODE TIMELINE RECORD SHOULD NOT BECOME TIMELINE EVIDENCE.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
}

test("compileObservationTimeline ignores legacy derived and episode Records", () => withStore((store) => {
  seedLegacyRecords(store);

  const result = compileObservationTimeline({ write: false, limit: 20 }, store);

  assert.equal(result.records_used, 1);
  assert.deepEqual(result.view.source_records, ["record:timeline-raw-source"]);
  assert.doesNotMatch(JSON.stringify(result.view.content), /LEGACY DERIVED TIMELINE RECORD/);
  assert.doesNotMatch(JSON.stringify(result.view.content), /LEGACY EPISODE TIMELINE RECORD/);
}));

test("compileActivityTimeline ignores legacy derived and episode Records", () => withStore((store) => {
  seedLegacyRecords(store);

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);

  assert.equal(result.records_used, 1);
  assert.deepEqual(result.view.source_records, ["record:timeline-raw-source"]);
  assert.doesNotMatch(JSON.stringify(result.view.content), /LEGACY DERIVED TIMELINE RECORD/);
  assert.doesNotMatch(JSON.stringify(result.view.content), /LEGACY EPISODE TIMELINE RECORD/);
}));

test("compileActivityTimeline renders AI session records as structured timeline metadata", () => withStore((store) => {
  store.insertRecord({
    id: "record:ai-session-codex",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", connector: "codex-locator" },
    scope: { project: "info", session: "session-1" },
    time: { observed_at: fixtureTime() },
    content: {
      title: "codex session session-1",
      path: "/Users/junjie/.codex/sessions/2026/06/19/rollout-session-1.jsonl",
      text: "codex session session-1 cwd: /Users/junjie/info time: 2026-06-19T05:53:38.326Z -> 2026-06-19T05:54:59.482Z messages: 57, tool calls: 22 files touched: /very/long/path/that/should/not/become/the/main/timeline/body.ts",
    },
    payload: {
      tool: "codex",
      session_id: "session-1",
      cwd: "/Users/junjie/info",
      source_path: "/Users/junjie/.codex/sessions/2026/06/19/rollout-session-1.jsonl",
      message_count: 57,
      tool_call_count: 22,
      files_touched: ["/Users/junjie/info/apps/ui/src/main.tsx", "/Users/junjie/info/packages/views/timeline/activity-timeline.ts"],
    },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);
  const item = result.buckets.flatMap(bucket => bucket.items)[0];

  assert.equal(result.records_used, 1);
  assert.equal(item.text, "codex session metadata · 57 messages · 22 tool calls · 2 files touched");
  assert.equal(item.stats?.message_count, 57);
  assert.equal(item.stats?.tool_call_count, 22);
  assert.equal(item.stats?.files_touched_count, 2);
  assert.deepEqual(item.stats?.files_touched, ["/Users/junjie/info/apps/ui/src/main.tsx", "/Users/junjie/info/packages/views/timeline/activity-timeline.ts"]);
  assert.doesNotMatch(item.text ?? "", /very\/long\/path/);
}));

test("compileActivityTimeline keeps low-level Screenpipe workspace signals out of the default UI timeline", () => withStore((store) => {
  store.insertRecord({
    id: "record:screenpipe-window",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Warp" },
    content: { title: "Warp - ⠇ info", text: "app: Warp\nwindow: ⠇ info\nminutes: 3.5" },
    payload: { app_name: "Warp", window_name: "⠇ info", minutes: 3.5 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:screenpipe-element",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-elements" },
    content: { title: "block: git", text: "git" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:screenpipe-input",
    schema: { name: "observation.screenpipe_input_event", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Tailscale" },
    content: { title: "Tailscale - Input", text: "input" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 1);
  assert.deepEqual(result.view.source_records, ["record:screenpipe-window"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Warp - info");
  assert.equal(items[0].subtitle, "Warp · 4m");
  assert.doesNotMatch(JSON.stringify(result.view.content), /block: git/);
  assert.doesNotMatch(JSON.stringify(result.view.content), /Tailscale - Input/);
}));

test("compileActivityTimeline keeps ordinary Screenpipe OCR/search results in the default expanded timeline", () => withStore((store) => {
  store.insertRecord({
    id: "record:screenpipe-window",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Warp" },
    time: { observed_at: fixtureTime() },
    content: { title: "Warp - info", text: "app: Warp\nwindow: info\nminutes: 3" },
    payload: { app_name: "Warp", window_name: "info", minutes: 3 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:screenpipe-raw-search",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Warp" },
    time: { observed_at: fixtureTime(10) },
    content: { title: "Warp - OCR", text: "RAW OCR SHOULD NOT BE MAIN ACTIVITY" },
    payload: { app_name: "Warp", content_type: "OCR" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 2);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.kind === "activity"));
  assert.ok(items.some(item => item.title === "Warp - info"));
  assert.match(JSON.stringify(result.view.content), /RAW OCR SHOULD NOT BE MAIN ACTIVITY/);
}));

test("compileActivityTimeline hides Screenpipe recorder and Info Timeline self-observation by default", () => withStore((store) => {
  store.insertRecord({
    id: "record:real-work",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Warp" },
    time: { observed_at: fixtureTime() },
    content: { title: "Warp - info", text: "app: Warp\nwindow: info\nminutes: 3" },
    payload: { app_name: "Warp", window_name: "info", minutes: 3 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:screenpipe-recorder",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Terminal" },
    time: { observed_at: fixtureTime(10) },
    content: { title: "Terminal - screenpipe record", text: "npm exec screenpipe@latest record" },
    payload: { app_name: "Terminal", window_name: "junjie - screenpipe ◂ npm exec screenpipe@latest record", minutes: 0.1 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:info-self",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "localhost" },
    time: { observed_at: fixtureTime(20) },
    content: { title: "Info Runtime · Timeline", text: "Timeline Live sync", url: "http://localhost:5177/" },
    payload: { browser_url: "http://localhost:5177/" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 1);
  assert.deepEqual(result.view.source_records, ["record:real-work"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Warp - info");
  assert.doesNotMatch(JSON.stringify(result.view.content), /screenpipe@latest record/);
  assert.doesNotMatch(JSON.stringify(result.view.content), /Info Runtime/);
}));

test("compileActivityTimeline keeps recorder and self-observation available in low-level debug mode", () => withStore((store) => {
  store.insertRecord({
    id: "record:screenpipe-recorder",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Terminal" },
    time: { observed_at: fixtureTime(10) },
    content: { title: "Terminal - screenpipe record", text: "npm exec screenpipe@latest record" },
    payload: { app_name: "Terminal", window_name: "junjie - screenpipe ◂ npm exec screenpipe@latest record", minutes: 0.1 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:info-self",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "localhost" },
    time: { observed_at: fixtureTime(20) },
    content: { title: "Info Runtime · Timeline", text: "Timeline Live sync", url: "http://localhost:5177/" },
    payload: { browser_url: "http://localhost:5177/" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false, includeLowLevelScreenpipe: true }, store);

  assert.equal(result.records_used, 2);
  assert.match(JSON.stringify(result.view.content), /screenpipe@latest record/);
  assert.match(JSON.stringify(result.view.content), /Info Runtime/);
}));

test("compileActivityTimeline applies source filter before limiting candidates", () => withStore((store) => {
  for (let index = 0; index < 4; index += 1) {
    store.insertRecord({
      id: `record:browser-heartbeat-${index}`,
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "youtube.com" },
      content: { title: `Browser page ${index}`, url: `https://www.youtube.com/watch?v=${index}` },
      privacy: { level: "private", retention: "normal" },
    });
  }
  for (let index = 0; index < 80; index += 1) {
    store.insertRecord({
      id: `record:screenpipe-noise-${index}`,
      schema: { name: "observation.screenpipe_activity", version: 1 },
      source: { type: "screenpipe", connector: "screenpipe-local-api" },
      scope: { app: "Warp" },
      content: { title: `Screenpipe OCR ${index}`, text: "terminal noise" },
      payload: { app_name: "Warp", content_type: "OCR" },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const result = compileActivityTimeline({ write: false, limit: 3, includeRuntimeEvents: false, sourceFilter: "browser", summarizeHeartbeats: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 3);
  assert.equal(items.length, 3);
  assert.ok(items.every(item => item.source === "browser/chrome-extension"));
}));

test("compileActivityTimeline can merge continuous browser page samples", () => withStore((store) => {
  for (const [index, observed] of [
    [0, fixtureTime()],
    [1, fixtureTime(60)],
    [2, fixtureTime(150)],
  ] as const) {
    store.insertRecord({
      id: `record:browser-youtube-${index}`,
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "youtube.com" },
      time: { observed_at: observed },
      content: { title: "(119) Lecture 1 - YouTube", url: "https://www.youtube.com/watch?v=lecture" },
      payload: { dwell_seconds: 60 + index },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const result = compileActivityTimeline({
    write: false,
    limit: 20,
    includeRuntimeEvents: false,
    dedupe: false,
    summarizeHeartbeats: false,
    mergeContinuous: true,
    mergeGapMinutes: 3,
  }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 3);
  assert.equal(items.length, 1);
  assert.equal(items[0].stats?.merged_continuous, true);
  assert.equal(items[0].stats?.samples, 3);
  assert.deepEqual(items[0].record_ids, ["record:browser-youtube-0", "record:browser-youtube-1", "record:browser-youtube-2"]);
}));

test("compileActivityTimeline projects continuous activity into every covered bucket", () => withStore((store) => {
  for (const [index, observed] of [
    [0, fixtureTime()],
    [1, fixtureTime(5 * 60)],
    [2, fixtureTime(11 * 60)],
  ] as const) {
    store.insertRecord({
      id: `record:browser-long-session-${index}`,
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      time: { observed_at: observed },
      content: { title: "GitHub work session", url: "https://github.com/example/repo" },
      payload: { dwell_seconds: 300 + index },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const result = compileActivityTimeline({
    write: false,
    limit: 20,
    bucketMinutes: 5,
    includeRuntimeEvents: false,
    dedupe: false,
    summarizeHeartbeats: false,
    mergeContinuous: true,
    mergeGapMinutes: 6,
  }, store);

  assert.equal(result.records_used, 3);
  assert.equal(result.buckets.length, 3);
  assert.deepEqual(result.buckets.map(bucket => bucket.count), [1, 1, 1]);
  assert.ok(result.buckets.every(bucket => bucket.items[0].stats?.merged_continuous === true));
  assert.equal(new Set(result.buckets.map(bucket => bucket.items[0].id)).size, 3);
  assert.match(result.buckets[1].items[0].title, /continued/);
}));

test("compileActivityTimeline supports fixed day ranges independent of sliding minutes", () => withStore((store) => {
  const startTime = fixtureTime(-120 * 60);
  const endTime = fixtureTime(60 * 60);
  store.insertRecord({
    id: "record:fixed-range-early",
    schema: { name: "observation.browser_page_visit", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    time: { observed_at: fixtureTime(-90 * 60) },
    content: { title: "Early page in fixed day range", url: "https://example.com/early" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:fixed-range-late",
    schema: { name: "observation.browser_page_visit", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    time: { observed_at: fixtureTime(-5 * 60) },
    content: { title: "Late page in fixed day range", url: "https://example.com/late" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({
    minutes: 15,
    startTime,
    endTime,
    write: false,
    limit: 20,
    bucketMinutes: 30,
    includeRuntimeEvents: false,
  }, store);
  const titles = result.buckets.flatMap(bucket => bucket.items.map(item => item.title));

  assert.equal(result.records_used, 2);
  assert.ok(titles.includes("Early page in fixed day range"));
  assert.ok(titles.includes("Late page in fixed day range"));
  assert.deepEqual(result.view.scope?.time_range, { start: startTime, end: endTime });
}));

test("compileActivityTimeline writes a stable day View for fixed day ranges", () => withStore((store) => {
  const startTime = fixtureTime(-10 * 60 * 60);
  const endTime = fixtureTime(2 * 60 * 60);
  store.insertRecord({
    id: "record:stable-day-view-first",
    schema: { name: "observation.browser_page_visit", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    time: { observed_at: fixtureTime(-9 * 60 * 60) },
    content: { title: "Stable day view first", url: "https://example.com/first" },
    privacy: { level: "private", retention: "normal" },
  });

  const first = compileActivityTimeline({
    minutes: 60,
    startTime,
    endTime,
    write: true,
    limit: 20,
    includeRuntimeEvents: false,
  }, store);
  store.insertRecord({
    id: "record:stable-day-view-second",
    schema: { name: "observation.browser_page_visit", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    time: { observed_at: fixtureTime(-30 * 60) },
    content: { title: "Stable day view second", url: "https://example.com/second" },
    privacy: { level: "private", retention: "normal" },
  });
  const second = compileActivityTimeline({
    minutes: 60,
    startTime,
    endTime,
    write: true,
    limit: 20,
    includeRuntimeEvents: false,
  }, store);

  assert.equal(first.view.id, second.view.id);
  assert.match(first.view.id, /^view:timeline:activity:day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.listViews({ view_types: ["timeline.activity"], limit: 10 }).filter(view => view.id === first.view.id).length, 1);
  assert.equal(second.records_used, 2);
  assert.equal(second.view.stability, "project");
}));

test("compileActivityTimeline does not split continuous browser duration on selected text evidence", () => withStore((store) => {
  for (const [index, observed] of [
    [0, fixtureTime()],
    [1, fixtureTime(60)],
    [2, fixtureTime(120)],
  ] as const) {
    store.insertRecord({
      id: `record:browser-video-heartbeat-${index}`,
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "www.youtube.com" },
      time: { observed_at: observed },
      content: { title: "(119) Lecture 1 - YouTube", url: "https://www.youtube.com/watch?v=lecture" },
      privacy: { level: "private", retention: "normal" },
    });
  }
  store.insertRecord({
    id: "record:browser-video-selection",
    schema: { name: "observation.browser_text_selected", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "www.youtube.com" },
    time: { observed_at: fixtureTime(90) },
    content: { title: "(119) Lecture 1 - YouTube", text: "115K", url: "https://www.youtube.com/watch?v=lecture" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({
    write: false,
    limit: 20,
    includeRuntimeEvents: false,
    dedupe: false,
    summarizeHeartbeats: false,
    mergeContinuous: true,
    mergeGapMinutes: 3,
  }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);
  const merged = items.find(item => item.stats?.merged_continuous);

  assert.equal(result.records_used, 4);
  assert.equal(items.length, 2);
  assert.ok(merged);
  assert.equal(merged.stats?.samples, 3);
  assert.match(merged.subtitle ?? "", /2m/);
  assert.deepEqual(merged.record_ids, [
    "record:browser-video-heartbeat-0",
    "record:browser-video-heartbeat-1",
    "record:browser-video-heartbeat-2",
  ]);
}));

test("compileActivityTimeline dedupes repeated Screenpipe activity summaries to the latest expanded row", () => withStore((store) => {
  for (const [id, observed, minutes] of [
    ["one", fixtureTime(), 14],
    ["two", fixtureTime(60), 3],
  ] as const) {
    store.insertRecord({
      id: `record:screenpipe-window-${id}`,
      schema: { name: "observation.screenpipe_activity_summary", version: 1 },
      source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
      scope: { app: "Warp" },
      time: { observed_at: observed },
      content: { title: "Warp - info", text: "app: Warp\nwindow: info" },
      payload: { app_name: "Warp", window_name: "info", minutes },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "activity");
  assert.equal(items[0].subtitle, "Warp · 3m");
  assert.deepEqual(items[0].record_ids, ["record:screenpipe-window-two"]);
}));

test("compileActivityTimeline can disable dedupe for evidence inspection", () => withStore((store) => {
  for (const [id, observed, minutes] of [
    ["one", fixtureTime(), 14],
    ["two", fixtureTime(60), 3],
  ] as const) {
    store.insertRecord({
      id: `record:screenpipe-window-${id}`,
      schema: { name: "observation.screenpipe_activity_summary", version: 1 },
      source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
      scope: { app: "Warp" },
      time: { observed_at: observed },
      content: { title: "Warp - info", text: "app: Warp\nwindow: info" },
      payload: { app_name: "Warp", window_name: "info", minutes },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false, dedupe: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 2);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.record_ids?.[0]), ["record:screenpipe-window-two", "record:screenpipe-window-one"]);
}));

test("compileActivityTimeline can include complete low-level Screenpipe details for source inspection", () => withStore((store) => {
  store.insertRecord({
    id: "record:screenpipe-frame-context-complete",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-frame-context" },
    content: { title: "Screenpipe frame context 9480", text: "~/info.main apps/ui/src/main.tsx /Users/junjie/info" },
    payload: { content_type: "frame_context", frame_id: 9480, text_source: "ocr", node_count: 42 },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false, includeLowLevelScreenpipe: true }, store);
  const item = result.buckets.flatMap(bucket => bucket.items)[0];

  assert.equal(result.records_used, 1);
  assert.equal(item.schema, "observation.screenpipe_workspace_signal");
  assert.ok((item.text ?? "").includes("/Users/junjie/info"));
  assert.equal(item.stats?.frame_id, 9480);
  assert.equal(item.stats?.content_type, "frame_context");
}));

test("compileActivityTimeline drops Screenpipe Timeline self-observation echoes", () => withStore((store) => {
  store.insertRecord({
    id: "record:screenpipe-frame-context-real",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-frame-context" },
    content: { title: "Screenpipe frame context 9480", text: "~/info.main apps/ui/src/main.tsx /Users/junjie/info" },
    payload: { content_type: "frame_context", frame_id: 9480, text_source: "ocr", node_count: 42 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:screenpipe-frame-context-echo",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-frame-context" },
    content: {
      title: "Screenpipe frame context 9913",
      text: "Timeline Live sync Screenpipe frame context 9903 observation.screenpipe_workspace content_type: frame_context frame_id: 9903 text_source: accessibility",
    },
    payload: { content_type: "frame_context", frame_id: 9913, text_source: "ocr", node_count: 0 },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false, includeLowLevelScreenpipe: true }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 1);
  assert.deepEqual(result.view.source_records, ["record:screenpipe-frame-context-real"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].stats?.frame_id, 9480);
  assert.doesNotMatch(JSON.stringify(result.view.content), /frame_id: 9903/);
}));

test("compileActivityTimeline promotes Screenpipe frame URLs and labels UI blocks clearly", () => withStore((store) => {
  store.insertRecord({
    id: "record:screenpipe-frame-url",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-frame-context" },
    scope: { domain: "tech.genius.com" },
    content: { title: "Screenpipe frame context 9508", text: "Sam Altman lecture", url: "http://tech.genius.com/Sam-altman-lecture" },
    payload: { content_type: "frame_context", frame_id: 9508, browser_url: "http://tech.genius.com/Sam-altman-lecture" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:screenpipe-block-label",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-elements" },
    content: { title: "block: /Users/junjie/info", text: "/Users/junjie/info" },
    payload: { content_type: "element", role: "block", frame_id: 9508 },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false, includeLowLevelScreenpipe: true }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.ok(items.some(item => item.title === "Web frame: tech.genius.com/Sam-altman-lecture" && item.domain === "tech.genius.com"));
  assert.ok(items.some(item => item.title === "UI block: /Users/junjie/info"));
}));

test("compileActivityTimeline dedupes Screenpipe terminal spinner window titles", () => withStore((store) => {
  for (const [id, spinner] of [["one", "⠇"], ["two", "⠏"]] as const) {
    store.insertRecord({
      id: `record:screenpipe-spinner-${id}`,
      schema: { name: "observation.screenpipe_activity_summary", version: 1 },
      source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
      scope: { app: "Warp" },
      time: { observed_at: fixtureTime() },
      content: { title: `Warp - ${spinner} info` },
      payload: { app_name: "Warp", window_name: `${spinner} info`, minutes: 1 },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const result = compileActivityTimeline({ write: false, limit: 20, includeRuntimeEvents: false }, store);
  const items = result.buckets.flatMap(bucket => bucket.items);

  assert.equal(result.records_used, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Warp - info");
}));

test("compileProjectTimeline ignores legacy derived and episode Records", () => withStore((store) => {
  seedLegacyRecords(store);

  const result = compileProjectTimeline({ write: false, project: "info", limit: 20, includeStoredWorkThreads: false }, store);

  assert.equal(result.records_used, 1);
  assert.deepEqual(result.view.source_records, ["record:timeline-raw-source"]);
  assert.doesNotMatch(JSON.stringify(result.view.content), /LEGACY DERIVED TIMELINE RECORD/);
  assert.doesNotMatch(JSON.stringify(result.view.content), /LEGACY EPISODE TIMELINE RECORD/);
}));

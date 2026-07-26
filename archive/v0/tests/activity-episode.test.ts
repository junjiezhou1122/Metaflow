import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore, type ContextRecord } from "@info/core";
import { compileActivityEpisodes, segmentRecords, type ActivityEpisodeSummarizer } from "@info/views/activity-episode/index.js";
import { compileActivityTimeline } from "@info/views/timeline/activity-timeline.js";
import { createViewProcessorDefinitions, VIEW_PROCESSOR_FUNCTIONS } from "@info/views/processors.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-activity-episode-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const FIXTURE_BASE_MS = Math.floor((Date.now() - 12 * 60 * 60_000) / (5 * 60_000)) * 5 * 60_000;

function fixtureTime(offsetSeconds = 0): string {
  return new Date(FIXTURE_BASE_MS + offsetSeconds * 1000).toISOString();
}

const FIXTURE_WINDOW = {
  startTime: fixtureTime(-60),
  endTime: fixtureTime(60 * 60),
};

function insert(store: ContextStore, record: ContextRecord) {
  return store.insertRecord({
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    ...record,
  });
}

test("segmentRecords groups browser observations by normalized page URL and splits on page path change", () => withStore((store) => {
  const records = [
    insert(store, {
      id: "record:browser-docs-a",
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "Chrome", domain: "docs.example.com" },
      time: { observed_at: fixtureTime(0) },
      content: { title: "Docs A", url: "https://docs.example.com/guide#intro" },
      payload: { browser_url: "https://docs.example.com/guide#intro" },
    }),
    insert(store, {
      id: "record:browser-docs-a-utm",
      schema: { name: "observation.browser_page_snapshot", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "Chrome", domain: "docs.example.com" },
      time: { observed_at: fixtureTime(60) },
      content: { title: "Docs A scrolled", url: "https://docs.example.com/guide?utm_source=feed#api" },
      payload: { browser_url: "https://docs.example.com/guide?utm_source=feed#api" },
    }),
    insert(store, {
      id: "record:browser-docs-b",
      schema: { name: "observation.browser_page_snapshot", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "Chrome", domain: "docs.example.com" },
      time: { observed_at: fixtureTime(120) },
      content: { title: "Docs B", url: "https://docs.example.com/reference" },
      payload: { browser_url: "https://docs.example.com/reference" },
    }),
  ];

  const episodes = segmentRecords(records, { gapMinutes: 5 });

  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].identity_kind, "browser_url");
  assert.deepEqual(episodes[0].records.map(record => record.id), ["record:browser-docs-a", "record:browser-docs-a-utm"]);
  assert.deepEqual(episodes[1].records.map(record => record.id), ["record:browser-docs-b"]);
}));

test("segmentRecords keeps ordinary app window/title changes as evidence in the same episode", () => withStore((store) => {
  const records = ["Info agent task 架构", "Info agent task 架构重构", "Settings modal"].map((windowTitle, index) => insert(store, {
    id: `record:codex-${index}`,
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Codex" },
    time: { observed_at: fixtureTime(index * 60) },
    content: { title: `Codex - ${windowTitle}`, text: `Working in ${windowTitle}` },
    payload: { app_name: "Codex", window_name: windowTitle, minutes: 1 },
  }));

  const episodes = segmentRecords(records, { gapMinutes: 5 });

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].identity_kind, "application");
  assert.equal(episodes[0].app, "Codex");
  assert.deepEqual(episodes[0].window_titles, ["Info agent task 架构", "Info agent task 架构重构", "Settings modal"]);
  assert.deepEqual(episodes[0].records.map(record => record.id), ["record:codex-0", "record:codex-1", "record:codex-2"]);
}));

test("segmentRecords merges returning app and page identities even when interleaved", () => withStore((store) => {
  const records = [
    insert(store, {
      id: "record:localhost-a",
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "Chrome", domain: "localhost" },
      time: { observed_at: fixtureTime(0) },
      content: { title: "MetaFlow", url: "http://localhost:5177/" },
      payload: { browser_url: "http://localhost:5177/" },
    }),
    insert(store, {
      id: "record:terminal-a",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local", connector: "local-project" },
      scope: { app: "terminal", project: "info" },
      time: { observed_at: fixtureTime(60) },
      content: { title: "Local project snapshot: info", text: "status" },
      payload: { app_name: "terminal", window_name: "Local project snapshot: info" },
    }),
    insert(store, {
      id: "record:localhost-b",
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "Chrome", domain: "localhost" },
      time: { observed_at: fixtureTime(120) },
      content: { title: "MetaFlow", url: "http://localhost:5177/" },
      payload: { browser_url: "http://localhost:5177/" },
    }),
    insert(store, {
      id: "record:terminal-b",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local", connector: "local-project" },
      scope: { app: "terminal", project: "info" },
      time: { observed_at: fixtureTime(180) },
      content: { title: "Local project snapshot: info", text: "status" },
      payload: { app_name: "terminal", window_name: "Local project snapshot: info" },
    }),
  ];

  const episodes = segmentRecords(records, { gapMinutes: 5 });

  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes[0].records.map(record => record.id), ["record:localhost-a", "record:localhost-b"]);
  assert.deepEqual(episodes[1].records.map(record => record.id), ["record:terminal-a", "record:terminal-b"]);
}));

test("compileActivityEpisodes passes memory/project context into summarizer and stores ambient help", () => withStore(async (store) => {
  store.upsertView({
    id: "memory:daily:auto-research",
    view_type: "memory.daily",
    status: "accepted",
    title: "Recent learning",
    summary: "最近正在学习 auto research，并希望 ambient agent 主动帮忙整理。",
    content: { summary: "auto research learning loop" },
  });
  insert(store, {
    id: "record:auto-research-episode",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Codex", project: "info", project_path: "/Users/junjie/info" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "Codex - auto research episode design", text: "Designing ambient activity episodes for auto research memory." },
    payload: { app_name: "Codex", window_name: "auto research episode design" },
  });
  let sawMemory = false;
  const summarizer: ActivityEpisodeSummarizer = async ({ episode, contextViews }) => {
    sawMemory = contextViews.some(view => view.id === "memory:daily:auto-research");
    assert.match(episode.summary, /Codex/i);
    return {
      ok: true,
      model: "test-model",
      base_url: "mock://activity-episode",
      content: {
        title: "Auto research episode design",
        summary: "用户在 Codex 中设计 activity episode，用于把 auto research 与 memory context 连接起来。",
        keywords: ["auto research", "activity episode", "memory"],
        next_steps: ["Draft an ambient analysis task from this episode"],
        memory_signals: ["User wants proactive auto research support"],
        ambient_help: {
          should_help: true,
          kind: "background_research",
          rationale: "Episode overlaps with memory.daily auto research focus.",
          suggested_action: "Prepare a compact auto research design brief.",
          confidence: 0.91,
        },
      },
    };
  };

  const result = await compileActivityEpisodes({ write: true, summarizeWithLlm: true, summarizer, llmEpisodeLimit: 2, ...FIXTURE_WINDOW }, store);
  const view = result.views[0];

  assert.equal(sawMemory, true);
  assert.equal(result.diagnostics.llm_attempted, true);
  assert.equal(view.view_type, "activity.episode");
  assert.equal(view.summary, "用户在 Codex 中设计 activity episode，用于把 auto research 与 memory context 连接起来。");
  assert.deepEqual(view.source_records, ["record:auto-research-episode"]);
  assert.deepEqual(view.source_views, ["memory:daily:auto-research"]);
  assert.equal((view.content?.ambient_help as Record<string, unknown>)?.should_help, true);
  assert.equal((view.content?.llm_summary as Record<string, unknown>)?.model, "test-model");
}));

test("compileActivityEpisodes filters browser embed/ad noise before creating page episodes", () => withStore(async (store) => {
  insert(store, {
    id: "record:browser-youtube-watch",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "youtube.com" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "Lecture - YouTube", url: "https://www.youtube.com/watch?v=lecture&pp=tracking" },
    payload: { browser_url: "https://www.youtube.com/watch?v=lecture&pp=tracking" },
  });
  insert(store, {
    id: "record:browser-ad-frame",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "tpc.googlesyndication.com" },
    time: { observed_at: fixtureTime(30) },
    content: { title: "Ad frame", url: "https://tpc.googlesyndication.com/sodar/5k7CCto5.html" },
    payload: { browser_url: "https://tpc.googlesyndication.com/sodar/5k7CCto5.html" },
  });

  const result = await compileActivityEpisodes({ write: false, summarizeWithLlm: false, ...FIXTURE_WINDOW }, store);

  assert.equal(result.views.length, 1);
  assert.equal(result.views[0].content?.identity_kind, "browser_url");
  assert.deepEqual(result.views[0].source_records, ["record:browser-youtube-watch"]);
  assert.deepEqual(result.views[0].content?.urls, ["https://www.youtube.com/watch?v=lecture&pp=tracking"]);
  assert.equal((result.views[0].content?.ambient_help as Record<string, unknown>)?.should_help, false);
}));

test("compileActivityEpisodes attaches nearby screenpipe frame ids to the episode", () => withStore(async (store) => {
  insert(store, {
    id: "record:browser-doc",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "docs.example.com" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "Docs", url: "https://docs.example.com/guide" },
    payload: { browser_url: "https://docs.example.com/guide" },
  });
  insert(store, {
    id: "record:frame-doc",
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-frame-context" },
    scope: { app: "Chrome", domain: "docs.example.com" },
    time: { observed_at: fixtureTime(20) },
    content: { title: "Docs frame", text: "Visible docs page" },
    payload: { content_type: "frame_context", app_name: "Chrome", browser_url: "https://docs.example.com/guide#intro", frame_id: 9480 },
  });

  const result = await compileActivityEpisodes({ write: false, summarizeWithLlm: false, ...FIXTURE_WINDOW }, store);

  assert.equal(result.views.length, 1);
  assert.deepEqual(result.views[0].content?.frame_ids, [9480]);
}));

test("compileActivityEpisodes uses overlapping visual_frame views as episode visual evidence", () => withStore(async (store) => {
  insert(store, {
    id: "record:browser-localhost",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "localhost" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "MetaFlow", url: "http://localhost:5177/" },
    payload: { browser_url: "http://localhost:5177/" },
  });
  store.upsertView({
    id: "visual_frame:meta-flow",
    view_type: "visual_frame",
    status: "candidate",
    title: "MetaFlow episode card layout",
    scope: { time_range: { start: fixtureTime(-10), end: fixtureTime(10) } },
    content: {
      kind: "screen_semantics",
      frame_id: "vf-1",
      app: "Chrome",
      topic: "MetaFlow localhost UI",
      visible_text_lines: ["localhost:5177", "MetaFlow"],
    },
  });

  const result = await compileActivityEpisodes({ write: true, summarizeWithLlm: false, ...FIXTURE_WINDOW }, store);
  const view = result.views[0];

  assert.deepEqual(view.content?.frame_ids, ["vf-1"]);
  assert.deepEqual(view.content?.visual_frames, [{ id: "visual_frame:meta-flow", frame_id: "vf-1", title: "MetaFlow episode card layout" }]);
  assert.deepEqual(view.metadata?.visual_frame_ids, ["visual_frame:meta-flow"]);
}));

test("compileActivityEpisodes archives stale active episode views in the recompiled window", () => withStore(async (store) => {
  const stale = store.upsertView({
    id: "activity:episode:stale-ad",
    view_type: "activity.episode",
    title: "Browsing: tpc.googlesyndication.com/sodar/5k7CCto5.html",
    status: "candidate",
    source_records: ["record:old-ad-frame"],
    scope: { time_range: { start: fixtureTime(0), end: fixtureTime(30) } },
    content: { kind: "activity_episode", start_time: fixtureTime(0), end_time: fixtureTime(30), urls: ["https://tpc.googlesyndication.com/sodar/5k7CCto5.html"] },
  });
  insert(store, {
    id: "record:fresh-work",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Codex" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "Codex - activity episode", text: "Real work should remain active." },
    payload: { app_name: "Codex", window_name: "activity episode" },
  });

  const result = await compileActivityEpisodes({ write: true, summarizeWithLlm: false, ...FIXTURE_WINDOW }, store);

  assert.equal(result.views.length, 1);
  assert.equal(store.getView(stale.id)?.status, "archived");
  assert.equal(store.getView(result.views[0].id)?.status, "candidate");
}));

test("compileActivityTimeline renders stored activity episodes and hides covered raw records", () => withStore(async (store) => {
  insert(store, {
    id: "record:browser-covered-a",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "example.com" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "Example Guide", url: "https://example.com/guide" },
    payload: { browser_url: "https://example.com/guide" },
  });
  insert(store, {
    id: "record:browser-covered-b",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "Chrome", domain: "example.com" },
    time: { observed_at: fixtureTime(60) },
    content: { title: "Example Guide", url: "https://example.com/guide#part2" },
    payload: { browser_url: "https://example.com/guide#part2" },
  });

  await compileActivityEpisodes({ write: true, summarizeWithLlm: false, ...FIXTURE_WINDOW }, store);
  const timeline = compileActivityTimeline({
    write: false,
    ...FIXTURE_WINDOW,
    includeRuntimeEvents: false,
    summarizeHeartbeats: false,
    dedupe: false,
  }, store);
  const items = timeline.buckets.flatMap(bucket => bucket.items);

  assert.equal(timeline.view.metadata?.episode_count, 1);
  assert.deepEqual(timeline.view.source_records, ["record:browser-covered-b", "record:browser-covered-a"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "activity_episode");
  assert.deepEqual(items[0].record_ids, ["record:browser-covered-a", "record:browser-covered-b"]);
  assert.match(items[0].title, /example\.com\/guide/);
}));

test("activity episode processor is registered and compiles activity.episode Views", () => withStore(async (store) => {
  insert(store, {
    id: "record:processor-episode",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Codex" },
    time: { observed_at: fixtureTime(0) },
    content: { title: "Codex - episode processor", text: "Processor registration test." },
    payload: { app_name: "Codex", window_name: "episode processor" },
  });
  const processor = createViewProcessorDefinitions().find(item => item.function_id === VIEW_PROCESSOR_FUNCTIONS.activityEpisode);

  assert.ok(processor);
  const result = await processor.process({ write: true, summarize_with_llm: false, start_time: FIXTURE_WINDOW.startTime, end_time: FIXTURE_WINDOW.endTime }, { store });

  assert.equal(result.ok, true);
  assert.equal(result.view_type, "activity.episode");
  assert.equal(result.views.length, 1);
  assert.equal(result.diagnostics.episodes, 1);
  assert.ok(store.getView(result.views[0].id));
}));

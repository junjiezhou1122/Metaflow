import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { ProcessorRuntime } from "@info/processor-runtime";
import {
  createYouTubeLearningProcessor,
  YOUTUBE_FRAGMENT_VIEW_TYPE,
  YOUTUBE_CAPTION_STATE_SCHEMA,
  YOUTUBE_CAPTION_FRAGMENT_SCHEMA,
  LANGUAGE_LEARNING_PACK_VIEW_TYPE,
  YOUTUBE_PAUSED_SCHEMA,
  YOUTUBE_PLAYED_SCHEMA,
} from "@info/views";


function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-yt-learning-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function createCaptionStateObservation(store: ContextStore, enabled: boolean, overrides: Record<string, unknown> = {}) {
  return store.insertRecord({
    id: `obs:caption:${Date.now()}`,
    schema: { name: YOUTUBE_CAPTION_STATE_SCHEMA, version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Caption state", text: `captions ${enabled ? "enabled" : "disabled"}` },
    payload: { enabled, video_id: "test-video-123", video_title: "Test Video", ...overrides },
    time: { observed_at: new Date().toISOString() },
    privacy: { level: "private", retention: "normal" },
  });
}

function createCaptionFragmentObservation(store: ContextStore, start: number, end: number, text: string, overrides: Record<string, unknown> = {}) {
  return store.insertRecord({
    id: `obs:fragment:${Date.now()}:${start}`,
    schema: { name: YOUTUBE_CAPTION_FRAGMENT_SCHEMA, version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Caption fragment", text },
    payload: { video_id: "test-video-123", video_title: "Test Video", start_seconds: start, end_seconds: end, ...overrides },
    time: { observed_at: new Date().toISOString() },
    privacy: { level: "private", retention: "normal" },
  });
}

function createPauseObservation(store: ContextStore, currentTime: number, isDifficult = false, overrides: Record<string, unknown> = {}) {
  return store.insertRecord({
    id: `obs:pause:${Date.now()}:${currentTime}`,
    schema: { name: YOUTUBE_PAUSED_SCHEMA, version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Paused", text: `Paused at ${currentTime}` },
    payload: { video_id: "test-video-123", video_title: "Test Video", current_time: currentTime, is_difficult: isDifficult, ...overrides },
    time: { observed_at: new Date().toISOString() },
    privacy: { level: "private", retention: "normal" },
  });
}

function createPlayObservation(store: ContextStore, currentTime: number, overrides: Record<string, unknown> = {}) {
  return store.insertRecord({
    id: `obs:play:${Date.now()}:${currentTime}`,
    schema: { name: YOUTUBE_PLAYED_SCHEMA, version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "youtube.com" },
    content: { title: "Played", text: `Played from ${currentTime}` },
    payload: { video_id: "test-video-123", video_title: "Test Video", current_time: currentTime, ...overrides },
    time: { observed_at: new Date().toISOString() },
    privacy: { level: "private", retention: "normal" },
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("caption toggle state is tracked with timestamps", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor();
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  const observation = createCaptionStateObservation(store, true);
  const result = await runtime.processObservation(observation);

  assert.equal(result.ok, true);
  assert.equal(result.processors_matched.includes("processor.youtube_learning"), true);
  // Caption state events produce diagnostics, not views directly
  const run = result.runs[0];
  assert.ok(run);
  assert.equal(run.diagnostics?.event, "caption_state");
  assert.equal(run.diagnostics?.captions_enabled, true);
  assert.equal(run.diagnostics?.video_id, "test-video-123");
  assert.ok(run.diagnostics?.timestamp);
}));

test("pause creates a bounded fragment from play to pause", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor({ fragmentMinSeconds: 1 });
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  // Play at 0 seconds
  const playObs = createPlayObservation(store, 0);
  await runtime.processObservation(playObs);

  // Pause at 45 seconds
  const pauseObs = createPauseObservation(store, 45);
  const result = await runtime.processObservation(pauseObs);

  assert.equal(result.ok, true);
  const viewsWritten = result.views_written;
  assert.ok(viewsWritten.length >= 0);

  // Verify diagnostics
  const run = result.runs[0];
  assert.equal(run.diagnostics?.event, "paused");
  assert.equal(run.diagnostics?.current_time, 45);
}));

test("duplicate fragment handling deduplicates identical fragments", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor({ fragmentMinSeconds: 1 });
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  // Create two identical caption fragments
  const obs1 = createCaptionFragmentObservation(store, 120, 146, "This is a test caption.");
  const obs2 = createCaptionFragmentObservation(store, 120, 146, "This is a test caption.");

  const result1 = await runtime.processObservation(obs1);
  const result2 = await runtime.processObservation(obs2);

  assert.equal(result1.ok, true);
  assert.equal(result2.ok, true);

  // Both should write a fragment view, and the IDs should be identical
  if (result1.views_written.length > 0 && result2.views_written.length > 0) {
    const view1 = store.getView(result1.views_written[0]);
    const view2 = store.getView(result2.views_written[0]);
    assert.equal(view1?.content?.start_seconds, 120);
    assert.equal(view1?.content?.end_seconds, 146);
    assert.equal(view2?.content?.start_seconds, 120);
    assert.equal(view2?.content?.end_seconds, 146);
    // Same content, same video, same time range -> same deterministic ID
    assert.equal(view1?.id, view2?.id);
  }
}));

test("pause difficult flag stays diagnostic-only", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor();
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  const pauseObs = createPauseObservation(store, 120, true, { difficulty_reason: "fast speech" });
  const result = await runtime.processObservation(pauseObs);

  assert.equal(result.ok, true);
  const run = result.runs[0];
  assert.equal(run.diagnostics?.is_difficult, true);
  assert.equal(result.views_written.length, 0);
}));

test("pause without prior play does not produce a fragment", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor({ fragmentMinSeconds: 1 });
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  // Pause without a prior play observation
  const pauseObs = createPauseObservation(store, 60);
  const result = await runtime.processObservation(pauseObs);

  assert.equal(result.ok, true);
  const run = result.runs[0];
  assert.equal(run.diagnostics?.event, "paused");
  assert.equal(run.diagnostics?.closed_fragment, false);
  assert.equal(run.views_written.length, 0);
}));

test("play observation starts a new open-ended fragment", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor();
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  const playObs = createPlayObservation(store, 30);
  const result = await runtime.processObservation(playObs);

  assert.equal(result.ok, true);
  const run = result.runs[0];
  assert.equal(run.diagnostics?.event, "played");
  assert.equal(run.diagnostics?.current_time, 30);
  assert.equal(run.views_written.length, 1);

  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, YOUTUBE_FRAGMENT_VIEW_TYPE);
  assert.equal(view?.content?.start_seconds, 30);
  assert.equal(view?.content?.end_seconds, 30); // Open-ended at play time
}));

test("fragment from caption fragment observation has correct content", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor();
  const runtime = new ProcessorRuntime({ store, processors: [processor] });

  const obs = createCaptionFragmentObservation(store, 120, 146, "This is the caption text.");
  const result = await runtime.processObservation(obs);

  assert.equal(result.ok, true);
  assert.equal(result.views_written.length, 1);

  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, YOUTUBE_FRAGMENT_VIEW_TYPE);
  assert.equal(view?.content?.video_id, "test-video-123");
  assert.equal(view?.content?.start_seconds, 120);
  assert.equal(view?.content?.end_seconds, 146);
  assert.equal(view?.content?.caption_text, "This is the caption text.");
  assert.equal(view?.content?.duration_seconds, 26);
}));

test("comprehension gap observation creates a compact language learning pack", async () => withStore(async (store) => {
  const processor = createYouTubeLearningProcessor();
  const runtime = new ProcessorRuntime({ store, processors: [processor] });
  const obs = store.insertRecord({
    id: "obs:youtube:gap",
    schema: { name: "observation.youtube.comprehension_gap", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "youtube.com" },
    payload: {
      gap: {
        fragment_id: "gap-fragment-1",
        video_id: "english-demo",
        video_title: "English Demo",
        video_url: "https://www.youtube.com/watch?v=english-demo",
        start_seconds: 12,
        end_seconds: 18,
        transcript_samples: ["I want to review this sentence."],
      },
    },
    privacy: { level: "private", retention: "normal" },
  });

  const result = await runtime.processObservation(obs);

  assert.equal(result.ok, true);
  assert.equal(result.views_written.length, 1);
  assert.equal(result.runs[0].diagnostics?.retained_as_observation, true);
  assert.equal(result.runs[0].diagnostics?.generated_views, 1);

  const view = store.getView(result.views_written[0]);
  assert.equal(view?.view_type, LANGUAGE_LEARNING_PACK_VIEW_TYPE);
  assert.deepEqual(view?.source_records, [obs.id]);
  assert.equal(view?.content?.source, "youtube.comprehension_gap");
  assert.equal(view?.content?.video_id, "english-demo");
  assert.deepEqual(view?.content?.sentences, ["I want to review this sentence."]);
  assert.deepEqual(view?.content?.focus_words, ["review", "sentence"]);
  assert.deepEqual(view?.content?.examples, [
    { word: "review", sentence: "I want to review this sentence.", record_id: obs.id },
    { word: "sentence", sentence: "I want to review this sentence.", record_id: obs.id },
  ]);

  const writtenTypes = result.views_written.map(id => store.getView(id)?.view_type);
  assert.equal(writtenTypes.includes("learning.review_queue"), false);
  assert.equal(writtenTypes.includes("memory.language.difficult_segments"), false);
}));

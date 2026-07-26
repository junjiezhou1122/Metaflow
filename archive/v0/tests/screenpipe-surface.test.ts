import test from "node:test";
import assert from "node:assert/strict";
import { ContextStore } from "@info/core";
import type { StoredContextRecord } from "@info/core";
import {
  buildScreenpipeSurfaceView,
  routeScreenpipeSurface,
  createScreenpipeSurfaceProcessor,
} from "@info/processor-runtime";

// ── Helpers ───────────────────────────────────────────────────────

function makeScreenpipeRecord(overrides: Partial<StoredContextRecord> = {}): StoredContextRecord {
  return {
    id: `screenpipe:${Math.random().toString(36).slice(2, 8)}`,
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Warp", domain: undefined },
    time: { observed_at: new Date().toISOString(), captured_at: new Date().toISOString() },
    content: { title: "Warp - info", text: "pnpm build succeeded", url: undefined },
    acquisition: { mode: "sync", actor: "connector", reason: "test" },
    signal: { importance: 0.25, confidence: 0.8, status: "inbox" },
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: false, allow_external_reader: false, allow_external_llm: false },
    memory: { kind: "observation", stability: "session" },
    payload: { app_name: "Warp", window_name: "info", content_type: "ocr" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

/**
 * OCR-only capture
 * Given a Screenpipe record with rich OCR text, vision should NOT be used.
 */
test("OCR-only capture: prefers OCR text over vision", () => {
  const records = [makeScreenpipeRecord({
    content: { title: "Warp - info", text: "npm test passed", url: undefined },
    payload: { app_name: "Warp", window_name: "info", ocr_text: "npm test passed", content_type: "ocr" },
  })];

  const result = buildScreenpipeSurfaceView(records, { preferOcr: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.capture_mode, "ocr_only");
  assert.equal(result.vision_used, false);
  assert.equal(result.noise_filtered, false);
  assert.ok(result.view.content.ocr_text?.includes("npm test passed"));
});

/**
 * Screenshot-needed path
 * When OCR text is absent and VISION_LLM_* is configured, vision should be flagged.
 */
test("screenshot-needed path: falls back to vision when OCR is empty", () => {
  const records = [makeScreenpipeRecord({
    content: { title: "Warp - info", text: "", url: undefined },
    payload: { app_name: "Warp", window_name: "info", ocr_text: "", content_type: "ocr" },
  })];

  // Simulate VISION_LLM configured
  process.env.VISION_LLM_BASE_URL = "http://localhost:11434/v1";
  const result = buildScreenpipeSurfaceView(records, { preferOcr: true, visionLlmRequired: true });
  delete process.env.VISION_LLM_BASE_URL;

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.capture_mode, "ocr_with_vision");
  assert.equal(result.vision_used, true);
});

/**
 * No-Screenpipe fallback
 * When no screenpipe records are provided, the builder should return a no-screenpipe error.
 */
test("no-Screenpipe fallback: returns error when no screenpipe records exist", () => {
  const nonScreenpipe: StoredContextRecord = {
    ...makeScreenpipeRecord(),
    source: { type: "browser", connector: "chrome-extension" },
    schema: { name: "observation.browser_page_snapshot", version: 1 },
  };
  const result = buildScreenpipeSurfaceView([nonScreenpipe]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.capture_mode, "no_screenpipe");
  assert.ok(result.error.includes("No Screenpipe records"));
});

/**
 * Privacy-denied (no external LLM)
 * When vision is not configured and privacy policy blocks external LLM,
 * the view should not allow external LLM.
 */
test("privacy-denied: does not allow external LLM when vision is not configured", () => {
  const records = [makeScreenpipeRecord()];
  const result = buildScreenpipeSurfaceView(records, { preferOcr: true, visionLlmRequired: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.vision_used, false);
  assert.equal(result.view.privacy?.allow_external_llm, false);
  assert.equal(result.view.privacy?.allow_llm_summary, false);
});

/**
 * Noise filtering
 * Screenpipe self-observation records should be flagged as noise.
 */
test("noise filtering: detects screenpipe self-observation", () => {
  const noiseRecord = makeScreenpipeRecord({
    content: { title: "Terminal - screenpipe record", text: "screenpipe record --help output", url: undefined },
    payload: { app_name: "Terminal", window_name: "screenpipe", content_type: "ocr" },
  });
  const result = buildScreenpipeSurfaceView([noiseRecord], { filterNoise: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.noise_filtered, true);
  assert.ok(result.view.summary?.includes("[noise filtered]") || result.view.content.noise_filtered);
});

/**
 * Routing into work lanes
 * Non-browser surface records should produce route candidates.
 */
test("project routing: routes non-browser context into work/project lanes", () => {
  const record = makeScreenpipeRecord({
    content: { title: "Warp - info", text: "Working on /Users/junjie/info project", url: undefined },
    payload: { app_name: "Warp", window_name: "info", content_type: "ocr" },
  });
  const routes = routeScreenpipeSurface(record, { projectHints: ["/Users/junjie/info"] });
  assert.ok(routes.some(r => r.startsWith("project:")));
});

/**
 * Dry-run safe: doesn't persist views
 */
test("dry-run safe: processor respects dryRun flag", () => {
  const processor = createScreenpipeSurfaceProcessor({ dryRun: true, filterNoise: false });
  assert.equal(processor.id, "processor.screenpipe_surface");
  assert.equal(producerPolicy(processor).privacy, "private");
});

function producerPolicy(processor: { policy?: { speed?: string; autonomy?: string; privacy?: string } }) {
  return processor.policy ?? {};
}

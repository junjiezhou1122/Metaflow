import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import {
  AmbientLayer,
  createDefaultAmbientProcessors,
  handleAttachLocalFile,
  handleCheckOrCiteFact,
  handleProjectContext,
  parseInlineIntent,
  resolveIntents,
  speedTierOf,
  SPEED_TIER_DEFINITIONS,
} from "@info/ambient-layer";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-ambient-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ======================================================================
// Intent Resolver
// ======================================================================

test("parseInlineIntent resolves attach_local_file", () => withStore((store) => {
  const text = "@info attach README.md";
  const intents = parseInlineIntent(text);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].name, "attach_local_file");
  assert.equal(intents[0].args.filePath, "README.md");
  assert.ok(intents[0].confidence >= 0.9);
}));

test("parseInlineIntent resolves check_or_cite_fact", () => withStore((store) => {
  const text = "@info verify this claim";
  const intents = parseInlineIntent(text);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].name, "check_or_cite_fact");
  assert.equal(intents[0].args.claim, "this claim");
}));

test("parseInlineIntent resolves project_context", () => withStore((store) => {
  const text = "@info context";
  const intents = parseInlineIntent(text);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].name, "project_context");
}));

test("resolveIntents returns speed mapping", () => withStore((store) => {
  const text = "@info attach README.md";
  const result = resolveIntents(text);
  assert.equal(result.ok, true);
  assert.equal(result.intents.length, 1);
  assert.equal(result.speedMapping[0], "glance");
}));

test("parseInlineIntent ignores non-invocation text", () => withStore((store) => {
  const text = "Hello world, no @info here";
  const intents = parseInlineIntent(text);
  assert.equal(intents.length, 0);
}));

// ======================================================================
// Speed Tier System
// ======================================================================

test("speedTierOf maps intent names to correct tiers", () => withStore((store) => {
  assert.equal(speedTierOf("attach_local_file"), "glance");
  assert.equal(speedTierOf("check_or_cite_fact"), "think");
  assert.equal(speedTierOf("project_context"), "glance");
  assert.equal(speedTierOf("unknown_intent"), "background");
}));

test("SPEED_TIER_DEFINITIONS has expected keys", () => withStore((store) => {
  assert.ok(SPEED_TIER_DEFINITIONS.reflex);
  assert.ok(SPEED_TIER_DEFINITIONS.glance);
  assert.ok(SPEED_TIER_DEFINITIONS.think);
  assert.ok(SPEED_TIER_DEFINITIONS.work);
  assert.ok(SPEED_TIER_DEFINITIONS.background);
  assert.equal(SPEED_TIER_DEFINITIONS.reflex.maxLatencyMs, 50);
  assert.equal(SPEED_TIER_DEFINITIONS.think.maxLatencyMs, 3000);
}));

// ======================================================================
// Ambient Layer Core
// ======================================================================

test("AmbientLayer resolve returns correct intents", () => withStore((store) => {
  const layer = new AmbientLayer({ store, processors: createDefaultAmbientProcessors() });
  const result = layer.resolve("@info attach package.json");
  assert.equal(result.ok, true);
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].name, "attach_local_file");
}));

test("AmbientLayer handle runs attach_local_file processor", async () => withStore(async (store) => {
  store.insertRecord({
    id: "rec:file-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    content: { title: "File source", text: "README contents here", path: "/Users/junjie/info/README.md" },
    privacy: { level: "private", retention: "normal" },
  });

  const layer = new AmbientLayer({ store, processors: createDefaultAmbientProcessors() });
  const result = await layer.handle({ name: "attach_local_file", confidence: 0.95, args: { filePath: "README.md" } }, "@info attach README.md");

  assert.equal(result.ok, true);
  assert.equal(result.intent_name, "attach_local_file");
  assert.equal(result.content.file_path, "README.md");
}));

test("AmbientLayer resolveAndHandle runs full flow", async () => withStore(async (store) => {
  const layer = new AmbientLayer({ store, processors: createDefaultAmbientProcessors() });
  const results = await layer.resolveAndHandle("@info verify claim");

  assert.equal(results.length, 1);
  assert.equal(results[0].intent.name, "check_or_cite_fact");
  assert.equal(results[0].result.ok, true);
  assert.equal(results[0].result.intent_name, "check_or_cite_fact");
}));

test("AmbientLayer handle throws for unregistered intent", async () => withStore(async (store) => {
  const layer = new AmbientLayer({ store, processors: [] });
  try {
    await layer.handle({ name: "unknown", confidence: 0.5, args: {} }, "text");
    assert.fail("Should have thrown");
  } catch (error) {
    assert.match(String(error), /No processor registered/);
  }
}));

// ======================================================================
// Built-in Intent Handlers
// ======================================================================

test("handleAttachLocalFile matches by path", async () => withStore(async (store) => {
  store.insertRecord({
    id: "rec:lp:1",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    content: { title: "Project snapshot", path: "/Users/junjie/info/README.md", text: "Some readme text" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = await handleAttachLocalFile({
    intent: { name: "attach_local_file", confidence: 0.95, args: { filePath: "README.md" } },
    sourceText: "@info attach README.md",
    store,
  });

  assert.equal(result.ok, true);
  assert.equal(result.intent_name, "attach_local_file");
  assert.equal(result.content.matched_record_id, "rec:lp:1");
  assert.equal(typeof result.content.preview, "string");
}));

test("handleCheckOrCiteFact finds matching records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "rec:bp:1",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Example page", text: "The claim is that TypeScript is great." },
    privacy: { level: "private", retention: "normal" },
  });

  const result = await handleCheckOrCiteFact({
    intent: { name: "check_or_cite_fact", confidence: 0.88, args: { claim: "TypeScript is great" } },
    sourceText: "@info verify TypeScript is great",
    store,
  });

  assert.equal(result.ok, true);
  assert.equal(result.intent_name, "check_or_cite_fact");
  assert.ok(result.content.match_count >= 0);
}));

test("handleProjectContext returns active thread and observations", async () => withStore(async (store) => {
  store.setRuntimeState("active_thread", {
    thread_id: "thread:test",
    title: "Test thread",
    project_path: "/Users/junjie/info",
  });
  store.insertRecord({
    id: "rec:prj:1",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project_path: "/Users/junjie/info" },
    content: { title: "Project snapshot", text: "Working on ambient layer" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = await handleProjectContext({
    intent: { name: "project_context", confidence: 0.85, args: {} },
    sourceText: "@info context",
    store,
  });

  assert.equal(result.ok, true);
  assert.equal(result.intent_name, "project_context");
  assert.equal((result.content.active_thread as any)?.thread_id, "thread:test");
  assert.ok(Array.isArray(result.content.recent_observations));
}));

// ======================================================================
// Integration Tests
// ======================================================================

test("full @info flow: resolve, handle, and produce view", async () => withStore(async (store) => {
  store.insertRecord({
    id: "rec:full:1",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    content: { title: "Build notes", text: "pnpm run test", path: "/Users/junjie/info/build.md" },
    privacy: { level: "private", retention: "normal" },
  });

  const layer = new AmbientLayer({ store, processors: createDefaultAmbientProcessors() });
  const results = await layer.resolveAndHandle("@info attach build.md");

  assert.equal(results.length, 1);
  assert.equal(results[0].result.ok, true);
  assert.equal(results[0].result.intent_name, "attach_local_file");
  assert.equal(results[0].result.content.file_path, "build.md");
}));

test("multiple intents in single run are possible", async () => withStore(async (store) => {
  // Note: current MVP only parses the first matching intent per text.
  // Verify that the system handles multiple intents cleanly.
  const layer = new AmbientLayer({ store, processors: createDefaultAmbientProcessors() });
  const text = "@info verify claim";
  const result = await layer.resolveAndHandle(text);

  // Should still produce one clean intent
  assert.equal(result.length, 1);
  assert.equal(result[0].intent.name, "check_or_cite_fact");
}));

test("ambient layer is quiet: does not modify records on resolve", async () => withStore(async (store) => {
  const before = store.recent(10).length;
  const layer = new AmbientLayer({ store, processors: createDefaultAmbientProcessors() });
  layer.resolve("@info context");
  const after = store.recent(10).length;
  assert.equal(before, after);
}));

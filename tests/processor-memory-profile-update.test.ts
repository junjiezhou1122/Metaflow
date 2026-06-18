import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import {
  createMemoryProfileUpdateProcessor,
  MEMORY_PROFILE_UPDATE_PROCESSOR_ID,
  MEMORY_PROFILE_VIEW_TYPE,
  MEMORY_PREFERENCES_VIEW_TYPE,
  ProcessorRuntime,
} from "@info/processor-runtime";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-proc-mem-profile-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("createMemoryProfileUpdateProcessor has correct id and produces memory.profile and memory.preferences", () => {
  const processor = createMemoryProfileUpdateProcessor();
  assert.equal(processor.id, MEMORY_PROFILE_UPDATE_PROCESSOR_ID);
  assert.equal(processor.id, "processor.memory_profile_update");
  assert.ok(processor.produces.views?.includes(MEMORY_PROFILE_VIEW_TYPE));
  assert.ok(processor.produces.views?.includes(MEMORY_PREFERENCES_VIEW_TYPE));
  assert.equal(processor.runtime.kind, "local");
  assert.ok(processor.consumes.observations?.some(p => p === "feedback.*" || p.startsWith("feedback")));
  assert.ok(processor.consumes.views?.includes("memory.daily"));
});

test("memory_profile_update processor writes memory.profile and memory.preferences views", async () => withStore(async (store) => {
  store.upsertView({
    id: "view:memory_daily:2026-06-17",
    view_type: "memory.daily",
    title: "Daily Memory 2026-06-17",
    summary: "Worked on processor builtins and view system.",
    content: { date: "2026-06-17", summary: "Worked on processor builtins and view system." },
    source_records: [],
  });
  const feedback = store.insertRecord({
    id: "obs:feedback:1",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "user", connector: "ui" },
    content: { title: "Edited processor output" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createMemoryProfileUpdateProcessor({ now: new Date("2026-06-17T20:00:00.000Z") })] });
  const result = await runtime.processObservation(feedback);

  assert.equal(result.ok, true);
  assert.ok(result.processors_matched.includes("processor.memory_profile_update"));

  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  const profile = written.find(v => v?.view_type === MEMORY_PROFILE_VIEW_TYPE);
  const prefs = written.find(v => v?.view_type === MEMORY_PREFERENCES_VIEW_TYPE);
  assert.ok(profile, "memory.profile view should be written");
  assert.ok(prefs, "memory.preferences view should be written");
  assert.equal(profile?.compiler?.id, "processor.memory_profile_update");
  assert.equal(prefs?.compiler?.id, "processor.memory_profile_update");
  assert.equal((profile?.content?.daily_count as number), 1);
  assert.equal((prefs?.content?.edit_count as number), 1);
}));

test("memory_profile_update processor produces views even with no feedback or daily views", async () => withStore(async (store) => {
  const obs = store.insertRecord({
    id: "obs:feedback:empty",
    schema: { name: "feedback.view.dismissed", version: 1 },
    source: { type: "user", connector: "ui" },
    content: { title: "Dismissed view" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createMemoryProfileUpdateProcessor({ now: new Date("2026-06-17T20:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);

  assert.equal(result.ok, true);
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  assert.ok(written.some(v => v?.view_type === MEMORY_PROFILE_VIEW_TYPE));
  assert.ok(written.some(v => v?.view_type === MEMORY_PREFERENCES_VIEW_TYPE));
}));

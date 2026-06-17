import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { runScheduledBatch, deterministicScheduledBatch } from "@info/scheduled-batch";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-scheduled-batch-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("dry-run mode returns ok without writing views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs:test-project",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { title: "Local project snapshot: info", text: "TypeScript project" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runScheduledBatch(store, { write: false, windowMinutes: 60 });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "scheduled_ai_batch");
  assert.equal(result.privacyBlocked, true);
  const views = store.listViews({ view_types: ["work.synthesis"], limit: 10 });
  assert.equal(views.length, 0);
}));

test("write mode persists a synthesis view", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs:test-browser",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { app: "chrome", domain: "github.com" },
    content: { title: "github.com", text: "PR review" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const result = await runScheduledBatch(store, { write: true, windowMinutes: 60 });

  assert.equal(result.ok, true);
  const views = store.listViews({ view_types: ["work.synthesis"], limit: 10 });
  assert.equal(views.length, 1);
  assert.equal(views[0].content?.interruptions.length, 0);
}));

test("privacy-denied path skips LLM and returns fallback", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs:private",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application" },
    content: { title: "Private feedback", text: "Feedback" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runScheduledBatch(store, { windowMinutes: 60 });

  assert.equal(result.privacyBlocked, true);
  assert.equal(result.llmEnabled, false);
  assert.equal(result.fallback, true);
  assert.equal(result.decisions.length, 0);
  assert.equal(result.openQuestions.length, 0);
  assert.equal(result.nextActions.length, 0);
  assert.equal(result.candidateMemories.length, 0);
}));

test("work vs interruption classification distinguishes main work from interruptions", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs:work-coding",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", app: "vscode" },
    content: { title: "Coding work", text: "Implementing a feature" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });
  store.insertRecord({
    id: "obs:interruption-wechat",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe" },
    scope: { app: "WeChat" },
    content: { title: "WeChat", text: "short personal reply" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });

  const result = await runScheduledBatch(store, { write: true, windowMinutes: 60 });

  assert.equal(result.ok, true);
  // One interruption input should be identified
  const synth = store.listViews({ view_types: ["work.synthesis"], limit: 1 })[0];
  assert.ok(synth);
  assert.ok(Array.isArray(synth.content?.interruptions));
  assert.ok(Array.isArray(synth.content?.mainActivities));
  // mainActivities should include the coding observation
  const mainIds: string[] = synth.content?.mainActivities ?? [];
  assert.ok(mainIds.some(id => id === "obs:work-coding"));
  // interruptions should include the WeChat observation
  const interIds: string[] = synth.content?.interruptions ?? [];
  assert.ok(interIds.some(id => id === "obs:interruption-wechat"));
}));

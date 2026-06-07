import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { runPipelineTick } from "../src/pipeline/runner.js";
import type { ContextRecord } from "@info/core";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-pipeline-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function browserRepoSnapshot(): ContextRecord {
  return {
    id: "record:pipeline-browser-repo",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "github.com" },
    content: {
      title: "example/info",
      url: "https://github.com/example/info",
      text: "A TypeScript local-first ambient context runtime repository.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  };
}

test("Pipeline classifier writes inferred context as a reusable View with provenance", () => withStore((store) => {
  const record = store.insertRecord(browserRepoSnapshot());

  const result = runPipelineTick({ limit: 5 }, store);
  const outputId = result.outputs[0]?.output_id;
  const view = outputId ? store.getView(outputId) : undefined;

  assert.equal(result.ok, true);
  assert.equal(result.produced, 1);
  assert.equal(result.skipped_existing, 0);
  assert.ok(view);
  assert.equal(view.view_type, "analysis.content_classification");
  assert.equal(view.compiler?.id, "builtin.content-classifier");
  assert.deepEqual(view.source_records, [record.id]);
  assert.equal(view.content?.content_kind, "code_repo");
  assert.equal(view.content?.domain_area, "coding");
  assert.equal(view.privacy?.level, "private");
  assert.equal(store.recent(10).filter(item => item.schema.name === "derived.content_classification").length, 0);

  const completed = store.listRuntimeEvents({ event_type: "plugin_run_completed", plugin_id: "builtin.content-classifier", limit: 1 })[0];
  assert.ok(completed);
  assert.deepEqual(completed.related_records, [record.id]);
  assert.deepEqual(completed.related_views, [view.id]);
}));

test("Pipeline classifier dedupes existing classification Views", () => withStore((store) => {
  store.insertRecord(browserRepoSnapshot());

  const first = runPipelineTick({ limit: 5 }, store);
  const second = runPipelineTick({ limit: 5 }, store);

  assert.equal(first.produced, 1);
  assert.equal(second.produced, 0);
  assert.equal(second.skipped_existing, 1);
  assert.equal(store.listViews({ view_types: ["analysis.content_classification"], limit: 10 }).length, 1);
}));

test("Pipeline classifier dry run does not write Views or Events", () => withStore((store) => {
  store.insertRecord(browserRepoSnapshot());

  const result = runPipelineTick({ limit: 5, dryRun: true }, store);

  assert.equal(result.produced, 1);
  assert.equal(result.dry_run, true);
  assert.equal(store.listViews({ view_types: ["analysis.content_classification"], limit: 10 }).length, 0);
  assert.equal(store.listRuntimeEvents({ plugin_id: "builtin.content-classifier", limit: 10 }).length, 0);
}));

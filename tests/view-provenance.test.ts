import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { collectViewProvenance } from "@info/runtime/view-provenance.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-view-provenance-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("View provenance exposes nested source Views and records for Applications", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-browser-provenance",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "example/repo", url: "https://github.com/example/repo", text: "Repo page text" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:browser-page:provenance",
    view_type: "analysis.browser_page",
    title: "Browser analysis",
    source_records: ["obs-browser-provenance"],
    content: { analysis: "Browser page analysis." },
  });
  store.upsertView({
    id: "project:current-context:provenance",
    view_type: "project.current_context",
    title: "Project context",
    source_views: ["analysis:browser-page:provenance"],
    content: { analysis: "Project context over browser analysis." },
  });

  const result = collectViewProvenance(store, "project:current-context:provenance");

  assert.equal(result.ok, true);
  assert.deepEqual(result.views.map(view => view.id), [
    "project:current-context:provenance",
    "analysis:browser-page:provenance",
  ]);
  assert.deepEqual(result.records.map(record => record.id), ["obs-browser-provenance"]);
  assert.deepEqual(result.diagnostics.missing_view_ids, []);
  assert.deepEqual(result.diagnostics.missing_record_ids, []);
}));

test("View provenance does not expand inactive source Views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "obs-behind-inactive-provenance",
    schema: { name: "observation.secret", version: 1 },
    source: { type: "test" },
    content: { text: "Inactive source view record should not leak." },
    privacy: { level: "secret", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:inactive-provenance",
    view_type: "analysis.secret",
    status: "archived",
    source_records: ["obs-behind-inactive-provenance"],
    content: { analysis: "Archived analysis." },
  });
  store.upsertView({
    id: "project:active-over-inactive",
    view_type: "project.current_context",
    title: "Active project context",
    source_views: ["analysis:inactive-provenance"],
    content: { analysis: "Active context references an inactive source view." },
  });

  const result = collectViewProvenance(store, "project:active-over-inactive");

  assert.equal(result.ok, true);
  assert.deepEqual(result.views.map(view => view.id), ["project:active-over-inactive"]);
  assert.deepEqual(result.records.map(record => record.id), []);
  assert.deepEqual(result.diagnostics.inactive_view_ids, ["analysis:inactive-provenance"]);
}));

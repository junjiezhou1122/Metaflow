import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-views-query-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("ContextStore.listViews can return only active Views for Applications", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:active-query",
    view_type: "analysis.browser_page",
    title: "Active browser analysis",
    content: { analysis: "active" },
  });
  store.upsertView({
    id: "analysis:archived-query",
    view_type: "analysis.browser_page",
    title: "Archived browser analysis",
    status: "archived",
    content: { analysis: "archived" },
  });
  store.upsertView({
    id: "analysis:expired-query",
    view_type: "analysis.browser_page",
    title: "Expired browser analysis",
    validity: { valid_until: "2026-01-01T00:00:00.000Z" },
    content: { analysis: "expired" },
  });
  store.upsertView({
    id: "analysis:stale-query",
    view_type: "analysis.browser_page",
    title: "Stale browser analysis",
    validity: { stale_after: "2026-01-01T00:00:00.000Z" },
    content: { analysis: "stale" },
  });

  const views = store.listViews({ view_types: ["analysis.browser_page"], active_only: true });

  assert.deepEqual(views.map(view => view.id), ["analysis:active-query"]);
}));

test("ContextStore.listViews filters by status, compiler, and provenance source", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:browser-for-source",
    view_type: "analysis.browser_page",
    status: "accepted",
    source_records: ["record:browser-source"],
    compiler: { id: "program.browser_ambient", mode: "deterministic" },
    content: { analysis: "browser" },
  });
  store.upsertView({
    id: "project:context-for-source",
    view_type: "project.current_context",
    status: "accepted",
    source_views: ["analysis:browser-for-source"],
    compiler: { id: "program.project_ambient", mode: "deterministic" },
    content: { analysis: "project" },
  });
  store.upsertView({
    id: "project:other-source",
    view_type: "project.current_context",
    status: "candidate",
    source_views: ["analysis:other"],
    compiler: { id: "program.project_ambient", mode: "deterministic" },
    content: { analysis: "other" },
  });

  assert.deepEqual(
    store.listViews({ status: "accepted", compiler_id: "program.project_ambient" }).map(view => view.id),
    ["project:context-for-source"],
  );
  assert.deepEqual(
    store.listViews({ source_record_id: "record:browser-source" }).map(view => view.id),
    ["analysis:browser-for-source"],
  );
  assert.deepEqual(
    store.listViews({ source_view_id: "analysis:browser-for-source" }).map(view => view.id),
    ["project:context-for-source"],
  );
}));

test("ContextStore.listViews filters by View type prefix", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:browser-prefix",
    view_type: "analysis.browser_page",
    content: { analysis: "browser" },
  });
  store.upsertView({
    id: "analysis:repo-prefix",
    view_type: "analysis.repo",
    content: { analysis: "repo" },
  });
  store.upsertView({
    id: "project:context-prefix",
    view_type: "project.current_context",
    content: { analysis: "project" },
  });

  assert.deepEqual(
    new Set(store.listViews({ view_type_prefix: "analysis." }).map(view => view.id)),
    new Set(["analysis:browser-prefix", "analysis:repo-prefix"]),
  );
}));

test("ContextStore.listViews supports updated_after for Application polling", async () => withStore(async (store) => {
  const oldView = store.upsertView({
    id: "analysis:poll-old",
    view_type: "analysis.browser_page",
    content: { analysis: "old" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "analysis:poll-new",
    view_type: "analysis.browser_page",
    content: { analysis: "new" },
  });

  const views = store.listViews({ view_type_prefix: "analysis.", updated_after: oldView.updated_at });

  assert.deepEqual(views.map(view => view.id), ["analysis:poll-new"]);
}));

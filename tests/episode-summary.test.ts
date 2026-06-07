import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { compileProjectWorkEpisode } from "@info/views/timeline/episode-summary.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-episode-summary-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Project work episode compiles thread summary as a View with provenance", () => withStore((store) => {
  const record = store.insertRecord({
    id: "record:episode-summary-evidence",
    schema: { name: "observation.terminal.command", version: 1 },
    source: { type: "terminal", connector: "shell" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
    time: { observed_at: "2026-05-25T01:00:00.000Z" },
    content: { title: "pnpm test", text: "226 tests passed", path: "/Users/junjie/info/package.json" },
    payload: { commands_run: ["pnpm test"], files_touched: ["src/runtime/episode-summary.ts"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const thread = store.upsertWorkThread({
    id: "thread:episode-summary",
    title: "Info Runtime Test Loop",
    status: "candidate",
    confidence: 0.78,
    evidence_records: [record.id],
    projects: ["info"],
    apps: ["terminal"],
    reasons: ["terminal command evidence"],
  });

  const result = compileProjectWorkEpisode(thread, [record]);

  assert.equal(result.view.view_type, "summary.project_work_episode");
  assert.equal(result.view.compiler?.id, "episode-summary");
  assert.deepEqual(result.view.source_records, [record.id]);
  assert.equal(result.view.scope?.project, "info");
  assert.equal(result.view.scope?.time_range?.start, "2026-05-25T01:00:00.000Z");
  assert.equal(result.view.content?.thread_id, thread.id);
  assert.match(String(result.view.content?.markdown), /pnpm test/);
  assert.equal(result.view.privacy?.level, "private");
}));

test("Project work episode can be persisted without writing an episode Record", () => withStore((store) => {
  const record = store.insertRecord({
    id: "record:episode-summary-write-evidence",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info" },
    content: { title: "Info project", text: "Compile episode summary as View." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const thread = store.upsertWorkThread({
    id: "thread:episode-summary-write",
    title: "Info Runtime Episode",
    status: "candidate",
    confidence: 0.7,
    evidence_records: [record.id],
    projects: ["info"],
  });

  const result = compileProjectWorkEpisode(thread, [record], { write: true, store });
  const view = result.written ? store.getView(result.written) : undefined;

  assert.equal(result.written, "summary:project-work-episode:thread:episode-summary-write");
  assert.ok(view);
  assert.equal(view.view_type, "summary.project_work_episode");
  assert.equal(store.recent(10).filter(item => item.schema.name === "episode.project_work").length, 0);
}));

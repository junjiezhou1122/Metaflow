import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";

test("correlate-recent --write persists WorkThreads and work_thread Views without candidate episode Records", () => {
  const dir = mkdtempSync(join(tmpdir(), "info-correlate-script-test-"));
  const dbPath = join(dir, "context.sqlite");
  try {
    const store = new ContextStore(dbPath);
    store.insertRecord({
      id: "record:correlate-local-project",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local_project", connector: "runtime-snapshot" },
      scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
      content: {
        title: "Local project snapshot: info",
        path: "/Users/junjie/info",
        text: "Context runtime TypeScript project with work_thread views.",
      },
      payload: { root: "/Users/junjie/info", files_touched: ["scripts/correlate-recent.ts"] },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.insertRecord({
      id: "record:correlate-browser",
      schema: { name: "observation.browser_page_snapshot", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { project: "info", project_path: "/Users/junjie/info", domain: "github.com", app: "chrome" },
      content: {
        title: "Info runtime repository",
        url: "https://github.com/example/info",
        text: "WorkThread candidate routing and context graph implementation notes.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const stdout = execFileSync(process.execPath, [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "scripts/correlate-recent.ts",
      "--write",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CONTEXT_DB_PATH: dbPath, CORRELATE_MIN_SCORE: "0.2", CORRELATE_INCLUDE_SOCIAL: "0" },
      encoding: "utf8",
    });
    const output = JSON.parse(stdout) as { ok?: boolean; written?: string[]; written_views?: string[] };

    assert.equal(output.ok, true);
    assert.ok((output.written ?? []).length >= 1);
    assert.ok((output.written_views ?? []).length >= 1);
    assert.equal(store.recent(20).filter(record => record.schema.name === "episode.candidate_thread").length, 0);
    assert.ok(store.listWorkThreads("candidate").length >= 1);
    assert.ok(store.listViews({ view_types: ["work_thread"], limit: 5 }).length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

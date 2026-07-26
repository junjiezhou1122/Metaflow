import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";

function withDb(fn: (dbPath: string, store: ContextStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "info-mf-memory-cli-test-"));
  const dbPath = join(dir, "context.sqlite");
  const store = new ContextStore(dbPath);
  try {
    fn(dbPath, store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mf(dbPath: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync("node", ["--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
}

test("mf memory candidates, list, and trace inspect memory views", () => withDb((dbPath, store) => {
  const source = store.insertRecord({
    id: "obs:memory-cli",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application", connector: "test" },
    content: { title: "Useful" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:candidate:cli",
    view_type: "memory.candidate",
    title: "Candidate",
    status: "candidate",
    source_records: [source.id],
    content: {
      memory_kind: "preference",
      target_view_type: "memory.preferences",
      claim: "Prefer concise memory CLI output.",
      confidence: 0.9,
      evidence_count: 2,
      promotion_policy: { min_confidence: 0.7, min_evidence_count: 1, allow_manual_promote: true, require_privacy_check: true },
      gate_status: "candidate",
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:durable:cli",
    view_type: "memory.preferences",
    title: "Durable Memory",
    status: "accepted",
    source_records: [source.id],
    content: { memory_kind: "preference", claim: "Prefer concise memory CLI output.", source_candidate_ids: ["memory:candidate:cli"] },
    confidence: 0.91,
    privacy: { level: "private", retention: "normal" },
  });

  const candidates = mf(dbPath, ["memory", "candidates"]);
  assert.match(candidates, /memory:candidate:cli/);
  assert.match(candidates, /memory\.preferences/);

  const list = mf(dbPath, ["memory", "list"]);
  assert.match(list, /memory:durable:cli/);
  assert.match(list, /Prefer concise memory CLI output/);

  const trace = mf(dbPath, ["memory", "trace", "memory:candidate:cli"]);
  assert.match(trace, /gate_status: candidate/);
  assert.match(trace, /target_view_type: memory\.preferences/);
  assert.match(trace, /record obs:memory-cli/);
}));

test("mf memory daily writes markdown-backed editable View", () => withDb((dbPath, store) => {
  const memoryRoot = mkdtempSync(join(tmpdir(), "info-mf-memory-root-"));
  const source = join(tmpdir(), `info-mf-daily-${Date.now()}.md`);
  writeFileSync(source, "# 2026-06-17\n\nWorked on Agent Surface CLI contracts.\n");

  const result = JSON.parse(mf(dbPath, ["--json", "memory", "daily", "write", "--date", "2026-06-17", "--from", source], { INFO_MEMORY_ROOT: memoryRoot })) as {
    ok: boolean;
    data: { relative_path: string; view: { id: string; view_type: string; content: Record<string, unknown> } };
  };

  assert.equal(result.ok, true);
  assert.equal(result.data.relative_path, join("memory", "daily", "2026-06-17.md"));
  assert.equal(result.data.view.id, "memory:daily:2026-06-17");
  assert.equal(result.data.view.view_type, "memory.daily");
  assert.match(String(result.data.view.content.markdown), /Agent Surface CLI/);
  assert.equal(store.getView("memory:daily:2026-06-17")?.metadata?.markdown_backed, true);
  assert.ok(store.listRuntimeEvents({ event_types: ["agent_surface.memory_markdown_synced"], limit: 10 }).some(event => event.subject_id === "memory:daily:2026-06-17"));

  const show = JSON.parse(mf(dbPath, ["--json", "memory", "daily", "show", "--date", "2026-06-17"], { INFO_MEMORY_ROOT: memoryRoot })) as {
    ok: boolean;
    data: { exists: boolean; markdown: string; view: { id: string } | null };
  };
  assert.equal(show.ok, true);
  assert.equal(show.data.exists, true);
  assert.match(show.data.markdown, /Worked on Agent Surface/);
  assert.equal(show.data.view?.id, "memory:daily:2026-06-17");
}));

test("mf memory reject records feedback and marks candidate rejected", () => withDb((dbPath, store) => {
  store.insertRecord({
    id: "obs:reject-cli",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application" },
    content: { title: "source" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:candidate:reject-cli",
    view_type: "memory.candidate",
    title: "Reject candidate",
    status: "candidate",
    source_records: ["obs:reject-cli"],
    content: {
      memory_kind: "preference",
      target_view_type: "memory.preferences",
      claim: "Bad candidate.",
      confidence: 0.9,
      evidence_count: 2,
      promotion_policy: { min_confidence: 0.7, min_evidence_count: 1, allow_manual_promote: true, require_privacy_check: true },
      gate_status: "candidate",
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });

  const output = mf(dbPath, ["memory", "reject", "memory:candidate:reject-cli", "wrong"]);

  assert.match(output, /rejected memory:candidate:reject-cli/);
  assert.equal(store.getView("memory:candidate:reject-cli")?.status, "rejected");
  assert.ok(store.recent(10).some(record => record.schema.name === "feedback.memory.rejected"));
}));

test("mf memory promote promotes a candidate when policy allows", () => withDb((dbPath, store) => {
  store.insertRecord({
    id: "obs:promote-cli",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application" },
    content: { title: "source" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:candidate:promote-cli",
    view_type: "memory.candidate",
    title: "Promote candidate",
    status: "candidate",
    source_records: ["obs:promote-cli"],
    content: {
      memory_kind: "preference",
      target_view_type: "memory.preferences",
      claim: "Prefer explicit memory promotion.",
      confidence: 0.4,
      evidence_count: 1,
      promotion_policy: { min_confidence: 0.9, min_evidence_count: 3, allow_manual_promote: true, require_privacy_check: true },
      gate_status: "candidate",
    },
    confidence: 0.4,
    privacy: { level: "private", retention: "normal" },
  });

  const output = mf(dbPath, ["memory", "promote", "memory:candidate:promote-cli"]);

  assert.match(output, /promote memory:candidate:promote-cli/);
  assert.equal(store.listViews({ view_types: ["memory.preferences"], limit: 10 }).length, 1);
}));

test("mf memory commands return non-zero for missing or unknown ids", () => withDb((dbPath) => {
  const missingArg = spawnSync("node", ["--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", "memory", "trace"], {
    cwd: process.cwd(),
    env: { ...process.env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.notEqual(missingArg.status, 0);
  assert.match(missingArg.stderr, /memory_id is required/);

  const unknown = spawnSync("node", ["--experimental-sqlite", "--import", "tsx", "scripts/mf.ts", "memory", "reject", "missing"], {
    cwd: process.cwd(),
    env: { ...process.env, CONTEXT_DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Memory candidate not found/);
}));

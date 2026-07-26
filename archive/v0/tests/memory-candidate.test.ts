import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { compileMemoryCandidates, MEMORY_CANDIDATE_VIEW_TYPE } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-memory-candidate-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("feedback observations produce memory candidates with provenance", () => withStore((store) => {
  const target = store.upsertView({
    id: "analysis:useful",
    view_type: "analysis.browser_agent_task",
    title: "Useful browser analysis",
    scope: { domain: "github.com", project: "info" },
    content: { summary: "Useful analysis" },
    privacy: { level: "private", retention: "normal" },
  });
  const feedback = store.insertRecord({
    id: "feedback:useful",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application", connector: "browser.popup" },
    content: { title: "Useful", text: "this helped" },
    relations: { related_to: [target.id] },
    payload: { value: "useful", view_id: target.id },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [feedback], views: [target], write: false, now: new Date("2026-06-16T10:00:00.000Z") }, store);

  assert.equal(result.views.length, 1);
  const candidate = result.views[0];
  assert.equal(candidate.view_type, MEMORY_CANDIDATE_VIEW_TYPE);
  assert.equal(candidate.content?.memory_kind, "preference");
  assert.equal(candidate.content?.target_view_type, "memory.preferences");
  assert.equal(candidate.content?.gate_status, "candidate");
  assert.deepEqual(candidate.source_records, ["feedback:useful"]);
  assert.deepEqual(candidate.source_views, ["analysis:useful"]);
  assert.equal(candidate.content?.claim, "Prefer more surfacing for useful analysis.browser_agent_task results.");
}));

test("project.current produces project memory candidates without copying secret source text", () => withStore((store) => {
  const project = store.upsertView({
    id: "project:current",
    view_type: "project.current",
    title: "Project current: info",
    summary: "Implement memory framework",
    source_records: ["obs:project"],
    content: {
      focus: "Memory framework design",
      recent_context: [{ text: "SECRET_TOKEN_SHOULD_NOT_COPY" }],
    },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    confidence: 0.82,
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [], views: [project], write: false, now: new Date("2026-06-16T10:00:00.000Z") }, store);
  const candidate = result.views[0];

  assert.equal(candidate.content?.memory_kind, "project_memory");
  assert.equal(candidate.content?.target_view_type, "project.memory");
  assert.equal(JSON.stringify(candidate.content).includes("SECRET_TOKEN_SHOULD_NOT_COPY"), false);
  assert.deepEqual(candidate.source_views, ["project:current"]);
  assert.deepEqual(candidate.source_records, ["obs:project"]);
}));

test("agent session observations can produce collaboration and workflow candidates", () => withStore((store) => {
  const record = store.insertRecord({
    id: "obs:agent:session",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "s1" },
    content: { title: "Codex", text: "用户说：不要只讲架构，直接实现。 " },
    payload: { commands_run: ["pnpm typecheck"], files_touched: ["packages/views/memory/candidate.ts"] },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [record], views: [], write: false }, store);
  const kinds = result.views.map(view => view.content?.memory_kind).sort();

  assert.deepEqual(kinds, ["agent_collaboration_style", "workflow_pattern"]);
  assert.ok(result.views.every(view => view.source_records?.includes("obs:agent:session")));
}));

test("secret, do-not-store, and noisy inputs do not produce candidates", () => withStore((store) => {
  const secret = store.insertRecord({
    id: "obs:secret",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application" },
    content: { text: "make this shorter" },
    payload: { original_text: "secret", edited_text: "short" },
    privacy: { level: "secret", retention: "do_not_store" },
  });
  const noisy = store.insertRecord({
    id: "obs:noisy",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser" },
    content: { title: "Weather" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [secret, noisy], views: [], write: false }, store);

  assert.equal(result.views.length, 0);
}));

test("compileMemoryCandidates writes candidate views when requested", () => withStore((store) => {
  const feedback = store.insertRecord({
    id: "feedback:dismissed",
    schema: { name: "feedback.analysis.dismissed", version: 1 },
    source: { type: "application", connector: "browser.popup" },
    content: { text: "not useful" },
    payload: { target_view_type: "analysis.browser_page" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [feedback], views: [], write: true }, store);
  const stored = store.getView(result.views[0].id);

  assert.equal(stored?.view_type, MEMORY_CANDIDATE_VIEW_TYPE);
  assert.equal(stored?.content?.target_view_type, "memory.preferences");
}));

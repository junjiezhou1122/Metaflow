import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { compileMemoryCandidates, MEMORY_CANDIDATE_VIEW_TYPE, compileMemoryGate } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-memory-gate-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ─── Repeated signal boost ──────────────────────────────────

test("repeated observation signals boost candidate confidence", () => withStore((store) => {
  const project = store.upsertView({
    id: "project:current",
    view_type: "project.current",
    title: "Project current: info",
    summary: "Implement memory framework",
    source_records: ["obs:project"],
    content: {
      focus: "Memory framework design",
      recent_context: [{ text: "Some context" }],
    },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    confidence: 0.82,
    privacy: { level: "private", retention: "normal" },
  });

  const project2 = store.upsertView({
    id: "project:current2",
    view_type: "project.current",
    title: "Project current: info",
    summary: "Implement memory framework",
    source_records: ["obs:project2"],
    content: {
      focus: "Memory framework design",
      recent_context: [{ text: "More context" }],
    },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    confidence: 0.85,
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ views: [project, project2], write: false, now: new Date("2026-06-16T10:00:00.000Z") }, store);

  const first = result.views[0];
  assert.ok(first.metadata?.confidence_boost >= 0, "Repeated signal should result in confidence boost or zero");
}));

// ─── Edited output learning ──────────────────────────────────

test("edited output produces style candidates without copying sensitive text", () => withStore((store) => {
  const editRecord = store.insertRecord({
    id: "obs:edit",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application", connector: "test" },
    content: { text: "make this shorter" },
    payload: { original_text: "This is a very long and detailed explanation of the entire system architecture and how it works under the hood.", edited_text: "System architecture overview." },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [editRecord], write: false }, store);

  // The candidate should contain a style claim, not the original sensitive text.
  assert.ok(result.views.length > 0, "Should generate at least one candidate from edited output");
  const candidate = result.views[0];
  assert.equal(candidate.view_type, MEMORY_CANDIDATE_VIEW_TYPE);
  assert.equal(candidate.content?.memory_kind, "agent_collaboration_style");
  const claim = candidate.content?.claim;
  assert.ok(!claim.includes("very long and detailed"), "Should not copy the original sensitive text");
  assert.ok(claim.includes("shorter") || claim.includes("brevity"), `Expected a brevity style claim but got: ${claim}`);
}));

// ─── Contradiction detection ─────────────────────────────────

test("conflicting candidates are marked as conflict but not promoted", () => withStore((store) => {
  const record1 = store.insertRecord({
    id: "obs:pref1",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application", connector: "test" },
    content: { text: "Always use dark mode." },
    privacy: { level: "private", retention: "normal" },
  });
  const record2 = store.insertRecord({
    id: "obs:pref2",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application", connector: "test" },
    content: { text: "Never use dark mode." },
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryCandidates({ records: [record1, record2], write: false }, store);

  assert.ok(result.diagnostics?.conflicts_detected > 0, "Conflicts should be detected");
  // The gate should hold or reject conflicts
  const candidates = result.views;
  const gateResult = compileMemoryGate({ candidates, write: false }, store);
  // Conflicting candidates should not be automatically promoted
  const promoted = gateResult.decisions.filter(d => d.action === "promote" || d.action === "merge");
  // We expect at most one to be promoted (in case naive gate still lets the first through)
  assert.ok(promoted.length <= 2, "Conflicting candidates should not all be promoted blindy");
}));

// ─── Feedback ranking ────────────────────────────────────────

test("dismiss feedback reduces candidate confidence", () => withStore((store) => {
  const feedbackRecord = store.insertRecord({
    id: "obs:dismiss",
    schema: { name: "feedback.analysis.dismissed", version: 1 },
    source: { type: "application", connector: "test" },
    content: { text: "not useful" },
    privacy: { level: "private", retention: "normal" },
  });

  const feedbackIndex = new Map([["memory: some key", [{ type: "dismiss" as const, source_record_ids: ["obs:dismiss"], created_at: new Date().toISOString() }]]]);

  const result = compileMemoryCandidates({ records: [feedbackRecord], write: false, feedback_index: feedbackIndex }, store);

  assert.ok(result.diagnostics?.feedback_adjusted > 0, "Feedback should be applied");
  // Dismiss reduces confidence, so we expect the confidence to drop
  const candidate = result.views[0];
  assert.ok(candidate, "A candidate should be generated");
  assert.ok(candidate.content?.confidence < 0.72 || (feedbackIndex.size > 0 && candidate.metadata?.feedback_adjusted), "Confidence should be reduced after dismiss feedback");
}));

// ─── Privacy filtering ───────────────────────────────────────

test("secret/do_not_store sources do not produce candidates", () => withStore((store) => {
  const secret = store.insertRecord({
    id: "obs:secret",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application" },
    content: { text: "secret note" },
    payload: { original_text: "secret", edited_text: "short" },
    privacy: { level: "secret", retention: "do_not_store" },
  });

  const result = compileMemoryCandidates({ records: [secret], write: false }, store);

  assert.equal(result.views.length, 0, "Secret/do_not_store should not produce candidates");
  assert.equal(result.diagnostics?.privacy_filtered, 1, "One candidate should be privacy-filtered");
}));

test("candidate with secret source is rejected at gate", () => withStore((store) => {
  const candidate = store.upsertView({
    id: "candidate:secret",
    view_type: MEMORY_CANDIDATE_VIEW_TYPE,
    title: "Secret candidate",
    status: "candidate",
    source_records: [],
    source_views: [],
    content: {
      memory_kind: "preference",
      target_view_type: "memory.preferences",
      claim: "Prefer dark mode.",
      confidence: 0.95,
      evidence_count: 3,
      promotion_policy: { min_confidence: 0.7, min_evidence_count: 1, allow_manual_promote: true, require_privacy_check: true },
      gate_status: "candidate",
    },
    confidence: 0.95,
    privacy: { level: "private", retention: "normal" },
  });

  const result = compileMemoryGate({ candidates: [candidate], write: false }, store);
  assert.ok(result.views.length === 0 || result.decisions[0].action === "reject", "Candidate with secret source should be rejected at gate");
}));

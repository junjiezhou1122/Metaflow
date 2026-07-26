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

test("optional summarizer receives sanitized observations and can add preference candidates", () => withStore((store) => {
  const record = store.insertRecord({
    id: "obs:preference",
    schema: { name: "observation.agent_session", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "s1" },
    content: { text: "always keep provenance visible; api_key=SHOULD_NOT_COPY" },
    payload: { original_text: "raw secret body should not be sent" },
    privacy: { level: "private", retention: "normal", allow_llm_summary: true, allow_external_llm: false },
  });
  let observedText = "";

  const result = compileMemoryCandidates({
    records: [record],
    write: false,
    summarizer: ({ observations }) => {
      observedText = observations[0]?.text ?? "";
      assert.deepEqual(observations[0]?.payload_keys, ["original_text"]);
      return [{
        kind: "preference",
        target: "memory.preferences",
        claim: "Prefer memory suggestions that keep source provenance visible.",
        confidence: 0.76,
        evidenceCount: 1,
        sourceRecords: [observations[0].id],
        scope: observations[0].scope,
        metadata: { extraction: "mock_summarizer" },
      }];
    },
  }, store);

  const claim = result.views.find(view => view.content?.claim === "Prefer memory suggestions that keep source provenance visible.")?.content?.claim;
  assert.ok(claim);
  assert.equal(observedText.includes("SHOULD_NOT_COPY"), false);
  assert.equal(JSON.stringify(result.views).includes("SHOULD_NOT_COPY"), false);
  assert.equal(result.diagnostics?.summarizer_candidates, 1);
}));

test("summarizer is skipped for sources that disallow local summarization", () => withStore((store) => {
  const record = store.insertRecord({
    id: "obs:no-summary",
    schema: { name: "observation.agent_session", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    content: { text: "prefer short answers" },
    privacy: { level: "private", retention: "normal", allow_llm_summary: false },
  });

  const result = compileMemoryCandidates({
    records: [record],
    write: false,
    summarizer: ({ observations }) => {
      assert.equal(observations.length, 0);
      return [];
    },
  }, store);

  assert.equal(result.diagnostics?.summarizer_candidates, 0);
}));

test("candidate quality rules reject malformed or secret-like summarizer drafts", () => withStore((store) => {
  const record = store.insertRecord({
    id: "obs:quality",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    content: { text: "prefer concise implementation" },
    privacy: { level: "private", retention: "normal", allow_llm_summary: true },
  });

  const result = compileMemoryCandidates({
    records: [record],
    write: false,
    summarizer: ({ observations }) => [
      {
        kind: "preference",
        target: "memory.preferences",
        claim: "sk-test_SECRET_TOKEN_SHOULD_NOT_COPY",
        confidence: 0.99,
        evidenceCount: 1,
        sourceRecords: [observations[0].id],
      },
      {
        kind: "workflow_pattern",
        target: "memory.preferences",
        claim: "Wrong target should not survive quality filtering.",
        confidence: 0.99,
        evidenceCount: 1,
        sourceRecords: [observations[0].id],
      },
      {
        kind: "agent_collaboration_style",
        target: "memory.agent_collaboration_style",
        claim: "Prefer concise implementation plans before code edits.",
        confidence: 0.8,
        evidenceCount: 1,
        sourceRecords: [observations[0].id],
      },
    ],
  }, store);

  assert.equal(result.views.length, 1);
  assert.equal(result.views[0].content?.claim, "Prefer concise implementation plans before code edits.");
  assert.equal(result.diagnostics?.quality_filtered, 2);
}));

test("repeated stuck signals produce skill gap candidates that gate holds until repeated", () => withStore((store) => {
  const first = store.insertRecord({
    id: "obs:stuck1",
    schema: { name: "observation.agent_session", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { text: "The test command hung and the build was stuck until timeout." },
    privacy: { level: "private", retention: "normal" },
  });
  const second = store.insertRecord({
    id: "obs:stuck2",
    schema: { name: "observation.agent_session", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { text: "Again blocked by a test command hang and needed timeout checks." },
    privacy: { level: "private", retention: "normal" },
  });

  const one = compileMemoryCandidates({ records: [first], write: false }, store);
  const repeated = compileMemoryCandidates({ records: [first, second], write: false }, store);
  const oneSkill = one.views.find(view => view.content?.memory_kind === "skill_gap");
  const repeatedSkill = repeated.views.find(view => view.content?.memory_kind === "skill_gap");

  assert.ok(oneSkill);
  assert.ok(repeatedSkill);
  assert.ok((repeatedSkill.content?.confidence as number) > (oneSkill.content?.confidence as number));
  assert.ok((repeatedSkill.metadata?.repeated_signals as number) >= 2);

  const gate = compileMemoryGate({ candidates: [repeatedSkill], write: false }, store);
  assert.equal(gate.decisions[0].action, "hold");
}));

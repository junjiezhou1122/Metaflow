import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore, type StoredContextView } from "@info/core";
import { compileMemoryGate, MEMORY_CANDIDATE_VIEW_TYPE } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-memory-gate-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("memory gate promotes high-confidence candidates into durable memory", () => withStore((store) => {
  const source = sourceRecord(store, "obs:preference");
  const candidate = store.upsertView(candidateView("candidate:preference", {
    source_records: [source.id],
    content: {
      memory_kind: "preference",
      target_view_type: "memory.preferences",
      claim: "Prefer side-panel inbox over intrusive popups.",
      confidence: 0.86,
      evidence_count: 2,
      promotion_policy: { min_confidence: 0.7, min_evidence_count: 1, allow_manual_promote: true, require_privacy_check: true },
      gate_status: "candidate",
    },
  }));

  const result = compileMemoryGate({ candidates: [candidate], write: true, now: new Date("2026-06-16T10:00:00.000Z") }, store);
  const durable = result.views[0];
  const updatedCandidate = store.getView(candidate.id);

  assert.equal(result.decisions[0].action, "promote");
  assert.equal(durable.view_type, "memory.preferences");
  assert.equal(durable.content?.claim, "Prefer side-panel inbox over intrusive popups.");
  assert.deepEqual(durable.source_records, ["obs:preference"]);
  assert.deepEqual(durable.source_views, ["candidate:preference"]);
  assert.equal(updatedCandidate?.content?.gate_status, "promoted");
  assert.equal(updatedCandidate?.content?.durable_view_id, durable.id);
}));

test("memory gate holds low-confidence candidates", () => withStore((store) => {
  const source = sourceRecord(store, "obs:weak");
  const candidate = store.upsertView(candidateView("candidate:weak", {
    source_records: [source.id],
    content: {
      memory_kind: "workflow_pattern",
      target_view_type: "memory.workflow_patterns",
      claim: "Maybe sometimes checks docs.",
      confidence: 0.3,
      evidence_count: 1,
      promotion_policy: { min_confidence: 0.7, min_evidence_count: 2, allow_manual_promote: true, require_privacy_check: true },
      gate_status: "candidate",
    },
  }));

  const result = compileMemoryGate({ candidates: [candidate], write: true }, store);

  assert.equal(result.views.length, 0);
  assert.equal(result.decisions[0].action, "hold");
  assert.equal(store.getView(candidate.id)?.content?.gate_status, "held");
}));

test("memory gate merges compatible repeated candidates instead of duplicating", () => withStore((store) => {
  const firstSource = sourceRecord(store, "obs:first");
  const secondSource = sourceRecord(store, "obs:second");
  const first = store.upsertView(candidateView("candidate:first", {
    source_records: [firstSource.id],
    scope: { project: "info" },
    content: candidateContent("project.memory", "Project principle: memory is a View subsystem.", 0.82),
  }));
  const second = store.upsertView(candidateView("candidate:second", {
    source_records: [secondSource.id],
    scope: { project: "info" },
    content: candidateContent("project.memory", "Project principle: memory is a View subsystem.", 0.84),
  }));

  const firstResult = compileMemoryGate({ candidates: [first], write: true }, store);
  const secondResult = compileMemoryGate({ candidates: [second], write: true }, store);
  const durable = store.getView(firstResult.views[0].id);

  assert.equal(secondResult.decisions[0].action, "merge");
  assert.equal(store.listViews({ view_types: ["project.memory"], limit: 10 }).length, 1);
  assert.deepEqual(durable?.source_records?.sort(), ["obs:first", "obs:second"]);
  assert.deepEqual((durable?.content?.source_candidate_ids as string[]).sort(), ["candidate:first", "candidate:second"]);
}));

test("memory gate rejects candidates by explicit review", () => withStore((store) => {
  const source = sourceRecord(store, "obs:reject");
  const candidate = store.upsertView(candidateView("candidate:reject", {
    source_records: [source.id],
    content: candidateContent("memory.agent_collaboration_style", "Always do an unsafe thing.", 0.91),
  }));

  const result = compileMemoryGate({ candidates: [candidate], reject_ids: [candidate.id], rejection_reason: "user rejected", write: true }, store);

  assert.equal(result.decisions[0].action, "reject");
  assert.equal(store.getView(candidate.id)?.status, "rejected");
  assert.equal(store.getView(candidate.id)?.content?.rejection_reason, "user rejected");
}));

test("memory gate refuses promotion when source privacy disallows it", () => withStore((store) => {
  const secret = store.insertRecord({
    id: "obs:secret",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application" },
    content: { text: "secret" },
    privacy: { level: "secret", retention: "do_not_store" },
  });
  const candidate = store.upsertView(candidateView("candidate:secret", {
    source_records: [secret.id],
    content: candidateContent("memory.preferences", "Remember secret thing.", 0.95),
  }));

  const result = compileMemoryGate({ candidates: [candidate], write: true }, store);

  assert.equal(result.views.length, 0);
  assert.equal(result.decisions[0].action, "reject");
  assert.match((result.decisions[0] as any).reason, /privacy/);
}));

function sourceRecord(store: ContextStore, id: string) {
  return store.insertRecord({
    id,
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application", connector: "test" },
    content: { title: id },
    privacy: { level: "private", retention: "normal" },
  });
}

function candidateContent(target: string, claim: string, confidence: number) {
  return {
    memory_kind: target === "project.memory" ? "project_memory" : "agent_collaboration_style",
    target_view_type: target,
    claim,
    confidence,
    evidence_count: 2,
    promotion_policy: { min_confidence: 0.7, min_evidence_count: 1, allow_manual_promote: true, require_privacy_check: true },
    gate_status: "candidate",
  };
}

function candidateView(id: string, overrides: Partial<StoredContextView>): StoredContextView {
  const now = "2026-06-16T10:00:00.000Z";
  return {
    id,
    view_type: MEMORY_CANDIDATE_VIEW_TYPE,
    title: id,
    status: "candidate",
    source_records: [],
    source_views: [],
    content: {},
    confidence: 0.8,
    privacy: { level: "private", retention: "normal" },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

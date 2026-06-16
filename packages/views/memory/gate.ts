import { createHash } from "node:crypto";
import { ContextStore, type ContextView, type StoredContextView } from "@info/core";
import {
  MEMORY_CANDIDATE_VIEW_TYPE,
  MEMORY_GATE_COMPILER_ID,
  type DurableMemoryViewType,
  type MemoryCandidateContent,
  type MemoryGateDecision,
} from "./framework.js";

export type CompileMemoryGateOptions = {
  candidates?: StoredContextView[];
  write?: boolean;
  limit?: number;
  now?: Date;
  force_promote_ids?: string[];
  reject_ids?: string[];
  rejection_reason?: string;
};

export type CompileMemoryGateResult = {
  ok: true;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  decisions: MemoryGateDecision[];
  diagnostics: Record<string, unknown>;
};

export function compileMemoryGate(options: CompileMemoryGateOptions = {}, store = new ContextStore()): CompileMemoryGateResult {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const forcePromote = new Set(options.force_promote_ids ?? []);
  const reject = new Set(options.reject_ids ?? []);
  const candidates = (options.candidates ?? store.listViews({
    view_types: [MEMORY_CANDIDATE_VIEW_TYPE],
    active_only: true,
    limit: options.limit ?? 100,
  })).filter(view => view.view_type === MEMORY_CANDIDATE_VIEW_TYPE);
  const durable: Array<ContextView | StoredContextView> = [];
  const decisions: MemoryGateDecision[] = [];

  for (const candidate of candidates) {
    const content = candidate.content as Partial<MemoryCandidateContent>;
    const target = durableTarget(content.target_view_type);
    if (!target || !content.claim || !content.memory_kind) {
      decisions.push({ action: "hold", candidate_id: candidate.id, reason: "malformed candidate" });
      continue;
    }
    if (reject.has(candidate.id)) {
      decisions.push({ action: "reject", candidate_id: candidate.id, reason: options.rejection_reason ?? "manual rejection" });
      if (options.write ?? true) store.upsertView(markCandidate(candidate, "rejected", generatedAt, { rejection_reason: options.rejection_reason ?? "manual rejection" }));
      continue;
    }
    if (candidate.metadata?.conflict_status === "conflict") {
      decisions.push({ action: "hold", candidate_id: candidate.id, reason: "candidate conflicts with another memory candidate" });
      if (options.write ?? true) store.upsertView(markCandidate(candidate, "held", generatedAt));
      continue;
    }
    const privacy = sourcePrivacyAllowed(candidate, store);
    if (!privacy.ok) {
      decisions.push({ action: "reject", candidate_id: candidate.id, reason: privacy.reason });
      if (options.write ?? true) store.upsertView(markCandidate(candidate, "rejected", generatedAt, { rejection_reason: privacy.reason }));
      continue;
    }

    const confidence = numberValue(content.confidence) ?? candidate.confidence ?? 0;
    const evidenceCount = numberValue(content.evidence_count) ?? (candidate.source_records?.length ?? 0) + (candidate.source_views?.length ?? 0);
    const policy = content.promotion_policy;
    const forced = forcePromote.has(candidate.id) && policy?.allow_manual_promote !== false;
    const eligible = forced || (confidence >= (policy?.min_confidence ?? 0.7) && evidenceCount >= (policy?.min_evidence_count ?? 1));
    if (!eligible) {
      decisions.push({ action: "hold", candidate_id: candidate.id, reason: "below promotion threshold" });
      if (options.write ?? true) store.upsertView(markCandidate(candidate, "held", generatedAt));
      continue;
    }

    const existing = findCompatibleMemory(store, target, String(content.claim), candidate.scope);
    const view = existing
      ? mergeDurableMemory(existing, candidate, generatedAt, confidence, evidenceCount)
      : buildDurableMemory(candidate, target, generatedAt, confidence, evidenceCount);
    const stored = options.write ?? true ? store.upsertView(view) : view;
    durable.push(stored);
    if (options.write ?? true) {
      store.upsertView(markCandidate(candidate, "promoted", generatedAt, { durable_view_id: stored.id }));
      store.appendRuntimeEvent({
        event_type: "view_compiled",
        actor: "system",
        status: "completed",
        subject_type: "view",
        subject_id: stored.id,
        plugin_id: MEMORY_GATE_COMPILER_ID,
        related_views: [candidate.id, ...(candidate.source_views ?? [])],
        related_records: candidate.source_records,
        payload: { view_type: target, candidate_id: candidate.id, action: existing ? "merge" : "promote" },
      });
    }
    const storedId = stored.id ?? view.id ?? durableMemoryId(target, String(content.claim), candidate.scope);
    decisions.push(existing
      ? { action: "merge", candidate_id: candidate.id, target_view_id: storedId, confidence }
      : { action: "promote", candidate_id: candidate.id, target_view_type: target, confidence });
  }

  return {
    ok: true,
    generated_at: generatedAt,
    views: durable,
    decisions,
    diagnostics: {
      candidates_scanned: candidates.length,
      promoted: decisions.filter(decision => decision.action === "promote").length,
      merged: decisions.filter(decision => decision.action === "merge").length,
      held: decisions.filter(decision => decision.action === "hold").length,
      rejected: decisions.filter(decision => decision.action === "reject").length,
    },
  };
}

function buildDurableMemory(candidate: StoredContextView, target: DurableMemoryViewType, generatedAt: string, confidence: number, evidenceCount: number): ContextView {
  const content = candidate.content as MemoryCandidateContent;
  return {
    id: durableMemoryId(target, content.claim, candidate.scope),
    view_type: target,
    title: durableTitle(target, content.claim),
    summary: content.claim,
    status: "accepted",
    source_records: candidate.source_records ?? [],
    source_views: [candidate.id, ...(candidate.source_views ?? [])],
    compiler: { id: MEMORY_GATE_COMPILER_ID, version: "0.0.1", mode: "deterministic" },
    purpose: `Durable memory promoted from ${MEMORY_CANDIDATE_VIEW_TYPE}.`,
    scope: candidate.scope,
    content: {
      memory_kind: content.memory_kind,
      claim: content.claim,
      evidence_count: evidenceCount,
      confidence,
      last_confirmed_at: generatedAt,
      source_candidate_ids: [candidate.id],
      user_rejected: false,
    },
    confidence,
    stability: target.startsWith("project.") ? "project" : "long_term",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    validity: { valid_from: generatedAt },
    metadata: { promoted_at: generatedAt, memory_gate_version: 1 },
  };
}

function mergeDurableMemory(existing: StoredContextView, candidate: StoredContextView, generatedAt: string, confidence: number, evidenceCount: number): ContextView {
  const currentEvidence = numberValue(existing.content?.evidence_count) ?? 0;
  const candidates = unique([
    ...arrayStrings(existing.content?.source_candidate_ids),
    candidate.id,
  ]);
  return {
    ...existing,
    status: "accepted",
    source_records: unique([...(existing.source_records ?? []), ...(candidate.source_records ?? [])]),
    source_views: unique([...(existing.source_views ?? []), candidate.id, ...(candidate.source_views ?? [])]),
    confidence: Math.max(existing.confidence ?? 0, confidence),
    content: {
      ...(existing.content ?? {}),
      evidence_count: Math.max(currentEvidence, evidenceCount, candidates.length),
      confidence: Math.max(numberValue(existing.content?.confidence) ?? 0, confidence),
      last_confirmed_at: generatedAt,
      source_candidate_ids: candidates,
      user_rejected: false,
    },
    metadata: { ...(existing.metadata ?? {}), last_merged_at: generatedAt, memory_gate_version: 1 },
  };
}

function markCandidate(candidate: StoredContextView, status: MemoryCandidateContent["gate_status"], generatedAt: string, patch: Partial<MemoryCandidateContent> = {}): ContextView {
  return {
    ...candidate,
    status: status === "promoted" ? "accepted" : status === "rejected" ? "rejected" : "candidate",
    content: { ...(candidate.content ?? {}), gate_status: status, ...patch },
    metadata: { ...(candidate.metadata ?? {}), gate_checked_at: generatedAt },
  };
}

function findCompatibleMemory(store: ContextStore, target: DurableMemoryViewType, claim: string, scope?: Record<string, unknown>): StoredContextView | undefined {
  return store.listViews({ view_types: [target], active_only: true, limit: 100 })
    .find(view => normalize(view.content?.claim ?? view.summary ?? "") === normalize(claim) && sameScope(view.scope, scope));
}

function sourcePrivacyAllowed(candidate: StoredContextView, store: ContextStore): { ok: true } | { ok: false; reason: string } {
  if (!(candidate.source_records?.length || candidate.source_views?.length)) {
    return { ok: false, reason: "candidate has no source provenance" };
  }
  for (const id of candidate.source_records ?? []) {
    const record = store.getRecord(id);
    if (!record) return { ok: false, reason: `missing source record: ${id}` };
    if (record.privacy?.retention === "do_not_store" || record.privacy?.level === "secret") return { ok: false, reason: `source record privacy disallows promotion: ${id}` };
  }
  for (const id of candidate.source_views ?? []) {
    const view = store.getView(id);
    if (!view) continue;
    if (view.privacy?.retention === "do_not_store" || view.privacy?.level === "secret") return { ok: false, reason: `source view privacy disallows promotion: ${id}` };
  }
  return { ok: true };
}

function durableTarget(value: unknown): DurableMemoryViewType | undefined {
  const text = typeof value === "string" ? value : "";
  if (["memory.preferences", "memory.workflow_patterns", "memory.skill_gaps", "memory.agent_collaboration_style", "project.memory", "agent.case_memory"].includes(text)) return text as DurableMemoryViewType;
  return undefined;
}

function durableMemoryId(target: DurableMemoryViewType, claim: string, scope?: Record<string, unknown>): string {
  return `memory:durable:${target.replace(/\./g, "-")}:${stableKey(JSON.stringify({ claim: normalize(claim), scope: scopeKey(scope) }))}`;
}

function durableTitle(target: DurableMemoryViewType, claim: string): string {
  return `${target}: ${claim.slice(0, 80)}`;
}

function sameScope(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  return scopeKey(a) === scopeKey(b);
}

function scopeKey(scope?: Record<string, unknown>): string {
  if (!scope) return "";
  return JSON.stringify({
    project: scope.project,
    project_path: scope.project_path,
    domain: scope.domain,
    app: scope.app,
  });
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function stableKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

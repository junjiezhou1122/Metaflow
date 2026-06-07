import type { ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";

export const routingLearningProgram: Program = {
  id: "program.routing_learning",
  title: "Routing Learning",
  purpose: "Turn explicit routing feedback into reusable routing.shortcut Views.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "suggest",
  produces: ["routing.shortcut"],
  learns_from: ["feedback.routing.confirmed", "feedback.routing.rejected"],

  attention(signal: ContextSignal): AttentionDecision {
    if (signal.object_kind !== "observation") return { action: "ignore", reason: "routing learning starts from feedback observations", confidence: 0.9 };
    if (signal.object_type !== "feedback.routing.confirmed" && signal.object_type !== "feedback.routing.rejected") return { action: "ignore", reason: "not routing feedback", confidence: 0.9 };
    return { action: "run", reason: "routing feedback can update a shortcut", confidence: 0.95, speed: "background" };
  },

  run({ signal, store }): ProgramRunResult {
    const feedback = store.getRecord(signal.object_id);
    if (!feedback) return { ok: false, reason: `feedback record not found: ${signal.object_id}` };
    const programId = stringValue(feedback.payload?.program_id);
    const match = objectValue(feedback.payload?.match);
    if (!programId || !match) return { ok: false, reason: "routing feedback missing program_id or match" };
    if (!hasMeaningfulMatch(match)) return { ok: false, reason: "routing feedback match must include at least one condition" };

    const evidence = relatedEvidence(feedback, store);
    const rejected = feedback.schema.name === "feedback.routing.rejected";
    const shortcutId = routingShortcutId(programId, match);
    const existing = store.getView(shortcutId);
    const shortcut = buildRoutingShortcut(feedback, evidence, programId, match, rejected, existing);
    return {
      ok: true,
      reason: rejected ? `rejected routing shortcut for ${programId}` : `learned routing shortcut for ${programId}`,
      views: [shortcut],
      diagnostics: { program_id: programId, evidence_records: shortcut.source_records?.length ?? 0, rejected },
    };
  },
};

function relatedEvidence(feedback: StoredContextRecord, store: { getRecord(id: string): StoredContextRecord | undefined }): StoredContextRecord[] {
  return (feedback.relations?.related_to ?? [])
    .map(id => store.getRecord(id))
    .filter((record): record is StoredContextRecord => Boolean(record));
}

function buildRoutingShortcut(feedback: StoredContextRecord, evidence: StoredContextRecord[], programId: string, match: Record<string, unknown>, rejected = false, existing?: StoredContextView): ContextView {
  const id = routingShortcutId(programId, match);
  const sourceRecords = [...new Set([...(existing?.source_records ?? []), feedback.id, ...evidence.map(record => record.id)])];
  const confidence = rejected
    ? 0.2
    : Math.min(0.98, Math.max(existing?.confidence ?? 0.76, 0.76) + 0.06);
  return {
    id,
    view_type: "routing.shortcut",
    title: `Routing shortcut: ${programId}`,
    summary: stringValue(feedback.payload?.reason) ?? feedback.content?.text ?? (rejected ? `Do not route matching signals to ${programId}.` : `Route matching signals to ${programId}.`),
    status: rejected ? "rejected" : "candidate",
    source_records: sourceRecords,
    compiler: { id: "program.routing_learning", version: "0.1.0", mode: "deterministic" },
    purpose: "Learned routing shortcut compiled from explicit user feedback.",
    scope: { ...feedback.scope, plugin_id: programId },
    content: {
      program_id: programId,
      match,
      reason: stringValue(feedback.payload?.reason) ?? feedback.content?.text,
      rejected,
      evidence_count: sourceRecords.length,
    },
    confidence,
    stability: "long_term",
    lossiness: "low",
    privacy: feedback.privacy,
    metadata: { source_feedback_schema: feedback.schema.name },
  };
}

function routingShortcutId(programId: string, match: Record<string, unknown>): string {
  return `routing:shortcut:${stableKey(`${programId}:${JSON.stringify(match)}`)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasMeaningfulMatch(match: Record<string, unknown>): boolean {
  return Object.values(match).some(value => {
    if (typeof value === "string") return Boolean(value.trim());
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.some(item => typeof item === "string" ? Boolean(item.trim()) : item !== undefined && item !== null);
    return false;
  });
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

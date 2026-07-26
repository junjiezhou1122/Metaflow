import { createHash } from "node:crypto";
import { ContextStore, type ContextView, type StoredContextRecord, type StoredContextView } from "@info/core";
import {
  type MemoryCandidateContent,
  type DurableMemoryViewType,
  type MemoryCandidateKind,
  type MemoryPromotionPolicy,
  MEMORY_CANDIDATE_VIEW_TYPE,
  MEMORY_CANDIDATE_COMPILER_ID,
} from "./framework.js";
import {
  computeRepeatedSignalBoost,
  detectConflicts,
  filterPrivacyViolatingCandidates,
  applyFeedbackToCandidates,
  extractStyleFromEdit,
  type CandidateDraft,
  type FeedbackIndex,
  type CandidateConflict,
  type MemoryCandidateSummarizer,
  type SanitizedMemoryObservation,
} from "./learning.js";

export type CompileMemoryCandidatesOptions = {
  records?: StoredContextRecord[];
  views?: StoredContextView[];
  write?: boolean;
  limit?: number;
  now?: Date;
  feedback_index?: FeedbackIndex;
  summarizer?: MemoryCandidateSummarizer;
};

export type CompileMemoryCandidatesResult = {
  ok: true;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  candidates: MemoryCandidateContent[];
  diagnostics: Record<string, unknown>;
};

type _CandidateDraft = CandidateDraft;

export function compileMemoryCandidates(options: CompileMemoryCandidatesOptions = {}, store = new ContextStore()): CompileMemoryCandidatesResult {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();

  const blockedRecordDrafts = (options.records ?? []).filter(record => !isAllowedRecord(record)).flatMap(record => toCandidateDrafts(record, store, { includeBlocked: true }));
  const blockedViewDrafts = (options.views ?? []).filter(view => !isAllowedView(view)).flatMap(view => candidatesFromView(view, { includeBlocked: true }));
  const recordDrafts = (options.records ?? []).filter(isAllowedRecord).flatMap(record => toCandidateDrafts(record, store));
  const viewDrafts = (options.views ?? []).filter(isAllowedView).flatMap(view => candidatesFromView(view));
  const summarizerDrafts = options.summarizer
    ? options.summarizer({ observations: sanitizedObservations(options.records ?? [], options.views ?? []), now: generatedAt })
    : [];
  const allDrafts = dedupeDrafts([...recordDrafts, ...viewDrafts, ...summarizerDrafts]);
  const feedbackIndex = options.feedback_index ?? collectFeedbackIndex(store);
  const withFeedback = applyFeedbackToCandidates(allDrafts, feedbackIndex);
  const boosted = withFeedback.adjustedDrafts.map(draft => {
    const boost = computeRepeatedSignalBoost(draft, withFeedback.adjustedDrafts);
    return {
      ...draft,
      confidence: Math.min(1, draft.confidence + boost.boost),
      metadata: {
        ...(draft.metadata ?? {}),
        confidence_boost: boost.boost,
        repeated_signals: boost.signals,
        confidence_boost_reason: boost.reason,
      },
    };
  });
  const blockedDrafts = dedupeDrafts([...blockedRecordDrafts, ...blockedViewDrafts]);
  const privacyFilteredDrafts = filterPrivacyViolatingCandidates(boosted, store);
  const filtered = privacyFilteredDrafts.filter(isHighQualityDraft);
  const privacyFiltered = boosted.length - privacyFilteredDrafts.length + blockedDrafts.length;
  const conflicts = detectConflicts(filtered);
  const candidateViews = filtered.map(draft => buildCandidateView(markDraftConflict(draft, conflicts), generatedAt));
  const stored = (options.write ?? true) ? candidateViews.map(view => store.upsertView(view)) : candidateViews;

  if (options.write ?? true) {
    for (const view of stored) {
      store.appendRuntimeEvent({
        event_type: "view_compiled",
        actor: "system",
        status: "completed",
        subject_type: "view",
        subject_id: view.id ?? "",
        plugin_id: MEMORY_CANDIDATE_COMPILER_ID ?? "processor.memory_candidate",
        related_views: [view.id ?? ""],
        payload: { view_type: MEMORY_CANDIDATE_VIEW_TYPE, memory_candidates: stored.length, conflicts: conflicts.length },
      });
    }
  }

  return {
    ok: true,
    generated_at: generatedAt,
    views: stored,
    candidates: stored.map(view => view.content as MemoryCandidateContent),
    diagnostics: {
      draft_count: allDrafts.length,
      view_count: stored.length,
      conflict_count: conflicts.length,
      conflicts_detected: conflicts.length,
      feedback_applied: withFeedback.applied.size > 0,
      feedback_adjusted: withFeedback.applied.size,
      privacy_filtered: privacyFiltered,
      quality_filtered: privacyFilteredDrafts.length - filtered.length,
      summarizer_candidates: summarizerDrafts.length,
    },
  };
}

function collectFeedbackIndex(store: ContextStore): FeedbackIndex {
  return new Map();
}

function toCandidateDrafts(record: StoredContextRecord, store: ContextStore, options: { includeBlocked?: boolean } = {}): CandidateDraft[] {
  if (!options.includeBlocked && !isAllowedRecord(record)) return [];
  if (record.schema.name.startsWith("feedback.")) {
    return candidatesFromFeedback(record, store);
  }
  if (record.schema.name.startsWith("observation.agent_")) {
    return candidatesFromAgentSignal(record);
  }
  if (record.schema.name === "observation.ai_session_locator_result") {
    return candidatesFromAgentSignal(record);
  }
  if (record.schema.name === "observation.local_project") {
    return candidatesFromProjectRecord(record);
  }
  return [];
}

function candidatesFromFeedback(record: StoredContextRecord, store: ContextStore): CandidateDraft[] {
  const target = relatedView(record, undefined, store);
  const targetType = target?.view_type ?? "unknown";
  const scope = compactRecord({ project: record.scope?.project, project_path: record.scope?.project_path });
  if (record.schema.name === "feedback.analysis.dismissed") {
    return [{
      kind: "preference",
      target: "memory.preferences",
      claim: `Prefer less automatic surfacing for ${targetType}.`,
      confidence: 0.72,
      evidenceCount: 1,
      sourceRecords: [record.id],
      sourceViews: target ? [target.id] : [],
      scope,
      metadata: { feedback_schema: record.schema.name, feedback_value: record.payload?.value },
    }];
  }
  if (record.schema.name === "feedback.analysis.useful") {
    const explicitPreference = explicitPreferenceFromText(record.content?.text);
    if (explicitPreference) {
      return [{
        kind: "preference",
        target: "memory.preferences",
        claim: explicitPreference,
        confidence: 0.74,
        evidenceCount: 1,
        sourceRecords: [record.id],
        sourceViews: target ? [target.id] : [],
        scope,
        metadata: { feedback_schema: record.schema.name, feedback_value: record.payload?.value },
      }];
    }
    return [{
      kind: "preference",
      target: "memory.preferences",
      claim: `Prefer more surfacing for useful ${targetType} results.`,
      confidence: 0.74,
      evidenceCount: 1,
      sourceRecords: [record.id],
      sourceViews: target ? [target.id] : [],
      scope,
      metadata: { feedback_schema: record.schema.name, feedback_value: record.payload?.value },
    }];
  }
  if (record.schema.name === "feedback.output.edited") {
    const note = firstString(record.content?.text as string, stringValue(record.payload?.edit_summary), stringValue(record.payload?.value));
    const originalText = stringValue(record.payload?.original_text) ?? "";
    if (note) {
      const styleClaim = extractStyleFromEdit(originalText, note);
      return [{
        kind: "agent_collaboration_style",
        target: "memory.agent_collaboration_style",
        claim: styleClaim ?? `User edited agent output: ${truncate(note, 180)}`,
        confidence: 0.78,
        evidenceCount: 1,
        sourceRecords: [record.id],
        sourceViews: target ? [target.id] : [],
        scope,
        metadata: { feedback_schema: record.schema.name, target_view_type: targetType, style_extracted: Boolean(styleClaim) },
      }];
    }
  }
  return [];
}

function candidatesFromAgentSignal(record: StoredContextRecord): CandidateDraft[] {
  const text = [record.content?.title, record.content?.text, safeJson(record.payload)].filter(Boolean).join("");
  const explicitPreference = text.match(/(不要|需要|我觉得|prefer|always|never|不喜欢|喜欢|应该|别用|直接实现)[^\n。.!?]{0,160}/i)?.[0];
  const drafts: CandidateDraft[] = [];
  if (explicitPreference) {
    drafts.push({
      kind: "agent_collaboration_style",
      target: "memory.agent_collaboration_style",
      claim: truncate(explicitPreference, 200),
      confidence: 0.66,
      evidenceCount: 1,
      sourceRecords: [record.id],
      scope: compactRecord({ project: record.scope?.project, project_path: record.scope?.project_path, session: record.scope?.session }),
      metadata: { source_schema: record.schema.name },
      policy: { min_evidence_count: 2, allow_manual_promote: true },
    });
  }
  const stuckPoint = repeatedStuckPointFromText(text);
  if (stuckPoint) {
    drafts.push({
      kind: "skill_gap",
      target: "memory.skill_gaps",
      claim: stuckPoint,
      confidence: 0.6,
      evidenceCount: 1,
      sourceRecords: [record.id],
      scope: compactRecord({ project: record.scope?.project, project_path: record.scope?.project_path }),
      metadata: { source_schema: record.schema.name, signal_type: "repeated_stuck_point" },
      policy: { min_evidence_count: 2, allow_manual_promote: true },
    });
  }
  const commands = arrayStrings(record.payload?.commands_run);
  const files = arrayStrings(record.payload?.files_touched);
  if (commands.length || files.length) {
    drafts.push({
      kind: "workflow_pattern",
      target: "memory.workflow_patterns",
      claim: commands.length
        ? `Coding workflow includes commands such as ${commands.slice(0, 3).join(", ")}.`
        : `Coding workflow touched files such as ${files.slice(0, 3).join(", ")}.`,
      confidence: 0.58,
      evidenceCount: 1,
      sourceRecords: [record.id],
      scope: compactRecord({ project: record.scope?.project, project_path: record.scope?.project_path }),
      metadata: { source_schema: record.schema.name },
      policy: { min_evidence_count: 2, allow_manual_promote: true },
    });
  }
  return drafts;
}

function candidatesFromProjectRecord(record: StoredContextRecord): CandidateDraft[] {
  const scope = compactRecord({ project: record.scope?.project, project_path: record.scope?.project_path });
  return [{
    kind: "project_memory",
    target: "project.memory",
    claim: `Project work tracked: ${record.content?.title ?? "unknown"}`,
    confidence: 0.65,
    evidenceCount: 1,
    sourceRecords: [record.id],
    scope,
    metadata: { source_schema: record.schema.name },
    policy: { min_confidence: 0.7, min_evidence_count: 2, allow_manual_promote: true },
  }];
}

function candidatesFromView(view: StoredContextView, options: { includeBlocked?: boolean } = {}): CandidateDraft[] {
  if (!options.includeBlocked && !isAllowedView(view)) return [];
  if (view.view_type === "project.current") {
    const focus = firstString(stringValue(view.content?.focus as string), view.summary, view.title);
    if (!focus) return [];
    return [{
      kind: "project_memory",
      target: "project.memory",
      claim: `Project context to remember: ${truncate(focus, 180)}`,
      confidence: Math.max(0.64, Math.min(0.86, view.confidence ?? 0.7)),
      evidenceCount: Math.max(1, (view.source_records ?? []).length + (view.source_views ?? []).length),
      sourceRecords: view.source_records,
      sourceViews: [view.id, ...(view.source_views ?? [])],
      scope: compactRecord({ project: view.scope?.project, project_path: view.scope?.project_path, repo: view.scope?.repo }),
      metadata: { source_view_type: view.view_type },
    }];
  }
  if (view.view_type === "work.focus_set") {
    const lanes = Array.isArray(view.content?.active_lanes) ? view.content.active_lanes : [];
    const topLane = lanes.find((lane) => Boolean(recordValue(lane as Record<string, unknown>)));
    if (!topLane) return [];
    return [{
      kind: "workflow_pattern",
      target: "memory.workflow_patterns",
      claim: `Recent work often centers on ${stringValue((topLane as Record<string, unknown>).label) ?? stringValue((topLane as Record<string, unknown>).lane_key) ?? "an active lane"}.`,
      confidence: 0.55,
      evidenceCount: Math.max(1, (view.source_records ?? []).length),
      sourceRecords: view.source_records,
      sourceViews: [view.id],
      scope: compactRecord({ project: view.scope?.project, project_path: view.scope?.project_path }),
      metadata: { source_view_type: view.view_type },
      policy: { min_evidence_count: 2, allow_manual_promote: true },
    }];
  }
  return [];
}

function buildCandidateView(draft: CandidateDraft, generatedAt: string): ContextView {
  const policy: MemoryPromotionPolicy = {
    min_confidence: draft.policy?.min_confidence ?? 0.7,
    min_evidence_count: draft.policy?.min_evidence_count ?? 1,
    allow_manual_promote: draft.policy?.allow_manual_promote ?? true,
    require_privacy_check: draft.policy?.require_privacy_check ?? true,
  };
  const content: MemoryCandidateContent = {
    memory_kind: draft.kind,
    target_view_type: draft.target,
    claim: draft.claim,
    confidence: draft.confidence,
    evidence_count: draft.evidenceCount,
    proposed_scope: draft.scope,
    promotion_policy: policy,
    gate_status: "candidate",
  };
  const id = `memory:candidate:${stableKey(JSON.stringify({
    kind: draft.kind,
    target: draft.target,
    claim: draft.claim,
    sourceRecords: draft.sourceRecords,
    sourceViews: draft.sourceViews,
  }))}`;
  return {
    id,
    view_type: MEMORY_CANDIDATE_VIEW_TYPE,
    title: `Memory candidate: ${draft.kind}`,
    summary: draft.claim,
    status: "candidate",
    source_records: unique(draft.sourceRecords ?? []),
    source_views: unique(draft.sourceViews ?? []),
    compiler: { id: MEMORY_CANDIDATE_COMPILER_ID, version: "0.0.1", mode: "deterministic" },
    purpose: "Reviewable memory proposal that must pass the memory gate before durable promotion.",
    scope: draft.scope,
    content,
    confidence: draft.confidence,
    stability: "session",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    validity: { valid_from: generatedAt, stale_after: new Date(Date.parse(generatedAt) + 7 * 24 * 60 * 60_000).toISOString() },
    metadata: { ...draft.metadata, generated_at: generatedAt, memory_candidate_version: 1 },
  };
}

function sanitizedObservations(records: StoredContextRecord[], views: StoredContextView[]): SanitizedMemoryObservation[] {
  const recordObservations = records
    .filter(isAllowedRecord)
    .filter(allowsLocalSummary)
    .map((record): SanitizedMemoryObservation => ({
      id: record.id,
      source_type: "record",
      signal_type: record.schema.name,
      title: sanitizeObservationText(record.content?.title),
      text: sanitizeObservationText(record.content?.text),
      payload_keys: objectKeys(record.payload),
      source_records: [record.id],
      source_views: [],
      scope: safeScope(record.scope),
      privacy: {
        level: record.privacy?.level,
        retention: record.privacy?.retention,
        allow_llm_summary: record.privacy?.allow_llm_summary,
        allow_external_llm: record.privacy?.allow_external_llm,
      },
    }));
  const viewObservations = views
    .filter(isAllowedView)
    .filter(allowsLocalSummary)
    .map((view): SanitizedMemoryObservation => ({
      id: view.id,
      source_type: "view",
      signal_type: view.view_type,
      title: sanitizeObservationText(view.title),
      text: sanitizeObservationText(firstString(view.summary, stringValue(view.content?.focus as string))),
      payload_keys: objectKeys(view.content),
      source_records: view.source_records ?? [],
      source_views: [view.id, ...(view.source_views ?? [])],
      scope: safeScope(view.scope),
      privacy: {
        level: view.privacy?.level,
        retention: view.privacy?.retention,
        allow_llm_summary: view.privacy?.allow_llm_summary,
        allow_external_llm: view.privacy?.allow_external_llm,
      },
    }));
  return [...recordObservations, ...viewObservations];
}

function allowsLocalSummary(source: StoredContextRecord | StoredContextView): boolean {
  return source.privacy?.allow_llm_summary !== false && source.privacy?.allow_external_llm !== true;
}

function sanitizeObservationText(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  return redactSensitiveText(truncate(text, 240));
}

function isHighQualityDraft(draft: CandidateDraft): boolean {
  if (!isAllowedTarget(draft.kind, draft.target)) return false;
  const claim = draft.claim.trim();
  const minLength = /[\u3400-\u9fff]/.test(claim) ? 6 : 12;
  if (claim.length < minLength || claim.length > 260) return false;
  if (containsSecretLikeText(claim)) return false;
  if (!((draft.sourceRecords?.length ?? 0) + (draft.sourceViews?.length ?? 0))) return false;
  return true;
}

function isAllowedTarget(kind: MemoryCandidateKind, target: DurableMemoryViewType): boolean {
  return (
    (kind === "preference" && target === "memory.preferences") ||
    (kind === "workflow_pattern" && target === "memory.workflow_patterns") ||
    (kind === "skill_gap" && target === "memory.skill_gaps") ||
    (kind === "agent_collaboration_style" && target === "memory.agent_collaboration_style") ||
    (kind === "project_memory" && target === "project.memory") ||
    (kind === "agent_case" && target === "agent.case_memory")
  );
}

function markDraftConflict(draft: CandidateDraft, conflicts: CandidateConflict[]): CandidateDraft {
  const sourceRecordSet = new Set(draft.sourceRecords ?? []);
  const sourceViewSet = new Set(draft.sourceViews ?? []);
  const draftConflicts = conflicts.filter(conflict =>
    sourceRecordSet.has(conflict.candidate_id_a) ||
    sourceRecordSet.has(conflict.candidate_id_b) ||
    sourceViewSet.has(conflict.candidate_id_a) ||
    sourceViewSet.has(conflict.candidate_id_b)
  );
  if (!draftConflicts.length) return draft;
  return {
    ...draft,
    metadata: {
      ...(draft.metadata ?? {}),
      conflict_status: "conflict",
      conflicts: draftConflicts.map(conflict => ({
        kind: conflict.kind,
        severity: conflict.severity,
        description: conflict.description,
      })),
    },
    policy: {
      ...(draft.policy ?? {}),
      min_confidence: 1.01,
      min_evidence_count: Number.MAX_SAFE_INTEGER,
    },
  };
}

function relatedView(record: StoredContextRecord, _viewsById: unknown, store: ContextStore): StoredContextView | undefined {
  const related = record.relations?.related_to ?? [];
  for (const id of related) {
    const view = store.getView(id);
    if (view && isAllowedView(view)) return view;
  }
  const payloadId = stringValue(record.payload?.view_id as string);
  if (payloadId) {
    const view = store.getView(payloadId);
    if (view && isAllowedView(view)) return view;
  }
  return undefined;
}

function dedupeDrafts(drafts: CandidateDraft[]): CandidateDraft[] {
  const byKey = new Map<string, CandidateDraft>();
  for (const draft of drafts) {
    const key = `${draft.kind}:${draft.target}:${draft.claim}:${(draft.sourceRecords ?? []).join(",")}:${(draft.sourceViews ?? []).join(",")}`;
    if (!byKey.has(key)) byKey.set(key, draft);
  }
  return [...byKey.values()];
}

function isAllowedRecord(record: StoredContextRecord): boolean {
  return record.privacy?.retention !== "do_not_store" && record.privacy?.level !== "secret";
}

function isAllowedView(view: StoredContextView | ContextView): boolean {
  return view.privacy?.retention !== "do_not_store" && view.privacy?.level !== "secret";
}

function explicitPreferenceFromText(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  if (/^(always|never|prefer|avoid|不要|需要|我喜欢|我不喜欢)\b/i.test(text) || /(dark mode|light mode|popup|side-panel|inline)/i.test(text)) {
    return text.replace(/\s+/g, " ").trim().slice(0, 220);
  }
  return undefined;
}

function repeatedStuckPointFromText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!/(stuck|blocked|failed|error|hang|超时|卡住|失败|报错)/i.test(normalized)) return undefined;
  if (/test|typecheck|build|command|terminal|compile|测试|构建/i.test(normalized)) {
    return "Repeated stuck point: commands, tests, or builds need bounded verification and follow-up checks.";
  }
  return "Repeated stuck point: work is blocked often enough to remember the failure pattern.";
}

function safeScope(scope?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!scope) return undefined;
  return compactRecord({
    project: scope.project,
    project_path: scope.project_path,
    repo: scope.repo,
    domain: scope.domain,
    app: scope.app,
    session: scope.session,
  });
}

function containsSecretLikeText(value: string): boolean {
  return /(secret|token|api[_-]?key|password|passwd|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]{12,})/i.test(value);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-[a-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b(?:secret|token|api[_-]?key|password|passwd)\b\s*[:=]\s*\S+/gi, "[redacted]");
}

function stableKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find(value => Boolean(value?.trim()));
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function objectKeys(value: unknown): string[] {
  const record = recordValue(value);
  return record ? Object.keys(record).sort() : [];
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

function truncate(value: string, length: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

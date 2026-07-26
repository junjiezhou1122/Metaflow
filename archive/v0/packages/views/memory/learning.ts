import type { StoredContextView, ContextView, ContextStore } from "@info/core";
import {
  type MemoryCandidateContent,
  type DurableMemoryViewType,
  type MemoryCandidateKind,
  type MemoryPromotionPolicy,
  type MemoryGateDecision,
  MEMORY_CANDIDATE_VIEW_TYPE,
  MEMORY_GATE_COMPILER_ID,
} from "./framework.js";

/**
 * Legacy repetition tracking helpers for memory candidate quality.
 * These are used within compileMemoryGate to boost confidence when
 * semantically similar candidates appear repeatedly.
 */
export type RepetitionSignal = {
  candidate_id: string;
  claim: string;
  kind: MemoryCandidateKind;
  target_view_type: DurableMemoryViewType;
  scope?: Record<string, unknown>;
  confidence: number;
  confidence_boost: number;
  evidence_count: number;
  source_records: string[];
  source_views: string[];
  created_at: string;
};

export type ConfidenceBoost = {
  signals: number;
  boost: number;
  reason: string;
};

/** Types of user feedback that can affect memory ranking. */
export type FeedbackType = "dismiss" | "insert" | "useful" | "reject";

export type FeedbackIndex = Map<string, FeedbackRecord[]>;

export type FeedbackRecord = {
  type: FeedbackType;
  source_record_ids: string[];
  created_at: string;
  metadata?: Record<string, unknown>;
};

export type CandidateExplanation = {
  candidate_id: string;
  action: "promote" | "merge" | "hold" | "reject" | "conflict";
  reason: string;
  confidence_before?: number;
  confidence_after?: number;
  evidence_count?: number;
  conflicts?: string[];
  feedback_applied?: string[];
  privacy_reason?: string;
};

/** Contradiction between two candidates. */
export type CandidateConflict = {
  candidate_id_a: string;
  candidate_id_b: string;
  kind: "direct_contradiction" | "scope_mismatch" | "confidence_inversion";
  severity: "critical" | "warning" | "info";
  description: string;
};

/** Options for quality-enhanced candidate compilation. */
export type CompileCandidatesWithQualityOptions = {
  records?: import("@info/core").StoredContextRecord[];
  views?: import("@info/core").StoredContextView[];
  write?: boolean;
  limit?: number;
  now?: Date;
  store?: ContextStore;
};

export type CandidateDraft = {
  kind: MemoryCandidateKind;
  target: DurableMemoryViewType;
  claim: string;
  confidence: number;
  evidenceCount: number;
  sourceRecords?: string[];
  sourceViews?: string[];
  scope?: Record<string, unknown>;
  policy?: Partial<MemoryPromotionPolicy>;
  metadata?: Record<string, unknown>;
};

export type SanitizedMemoryObservation = {
  id: string;
  source_type: "record" | "view";
  signal_type: string;
  title?: string;
  text?: string;
  payload_keys?: string[];
  source_records: string[];
  source_views: string[];
  scope?: Record<string, unknown>;
  privacy: {
    level?: string;
    retention?: string;
    allow_llm_summary?: boolean;
    allow_external_llm?: boolean;
  };
};

export type MemoryCandidateSummarizerInput = {
  observations: SanitizedMemoryObservation[];
  now: string;
};

export type MemoryCandidateSummarizer = (input: MemoryCandidateSummarizerInput) => CandidateDraft[];

/**
 * Extract an edited snippet without including sensitive text.
 */
export function extractStyleFromEdit(original?: string, edited?: string): string | undefined {
  if (!original || !edited) return undefined;
  // Compare lengths to decide what was changed in general terms.
  const originalLen = original.length;
  const editedLen = edited.length;
  const delta = originalLen - editedLen;

  if (delta > 20) {
    return "User significantly shortened agent output, preferring brevity.";
  }
  if (delta < -20) {
    return "User significantly expanded agent output, preferring detail.";
  }

  return "User refined agent output with edits.";
}

/**
 * Compute confidence boost from repeated signals.
 */
export function computeRepeatedSignalBoost(
  draft: CandidateDraft,
  allDrafts: CandidateDraft[],
): ConfidenceBoost {
  const similar = allDrafts.filter(
    (d) =>
      d.kind === draft.kind &&
      d.target === draft.target &&
      similarClaim(d.claim, draft.claim) &&
      sameScopeKey(d.scope, draft.scope),
  );

  if (similar.length < 2) {
    return { signals: 1, boost: 0, reason: "no repetition detected" };
  }

  const boost = Math.min(0.06 + (similar.length - 2) * 0.03, 0.18);
  return {
    signals: similar.length,
    boost,
    reason: `repeated signal: ${similar.length} similar candidate(s)`,
  };
}

/**
 * Detect contradictions between candidate drafts.
 */
export function detectConflicts(drafts: CandidateDraft[]): CandidateConflict[] {
  const conflicts: CandidateConflict[] = [];
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      const a = drafts[i];
      const b = drafts[j];
      if (a.kind !== b.kind || a.target !== b.target) continue;

      if (isDirectContradiction(a.claim, b.claim)) {
        conflicts.push({
          candidate_id_a: firstEvidenceId(a),
          candidate_id_b: firstEvidenceId(b),
          kind: "direct_contradiction",
          severity: "critical",
          description: `Conflicting claims: "${truncate(a.claim, 40)}" vs "${truncate(b.claim, 40)}"`,
        });
      } else if (
        a.confidence < 0.5 &&
        b.confidence > 0.85 &&
        similarClaim(a.claim, b.claim)
      ) {
        conflicts.push({
          candidate_id_a: firstEvidenceId(a),
          candidate_id_b: firstEvidenceId(b),
          kind: "confidence_inversion",
          severity: "warning",
          description: "Confidence inversion between similar claims.",
        });
      }
    }
  }
  return conflicts;
}

/**
 * Filter candidates to exclude those with secret/do_not_store sources.
 */
export function filterPrivacyViolatingCandidates(
  drafts: CandidateDraft[],
  _store?: ContextStore,
): CandidateDraft[] {
  return drafts.filter((draft) => {
    const meta = draft.metadata ?? {};
    if (meta.privacy_level === "secret" || meta.privacy_retention === "do_not_store") {
      return false;
    }
    return true;
  });
}

/**
 * Apply feedback adjustments to candidate confidence.
 */
export function applyFeedbackToCandidates(
  drafts: CandidateDraft[],
  feedbackIndex: FeedbackIndex,
): { adjustedDrafts: CandidateDraft[]; applied: Map<string, string[]> } {
  const applied = new Map<string, string[]>();
  const adjustedDrafts = drafts.map((draft) => {
    const feedbacks = feedbackForDraft(draft, feedbackIndex);
    let confidence = draft.confidence;
    let evidenceCount = draft.evidenceCount;
    const appliedReasons: string[] = [];

    for (const fb of feedbacks) {
      switch (fb.type) {
        case "dismiss":
          confidence = Math.max(0, confidence - 0.30);
          appliedReasons.push("feedback: dismissed by user");
          break;
        case "reject":
          confidence = Math.max(0, confidence - 0.50);
          appliedReasons.push("feedback: explicitly rejected by user");
          break;
        case "useful":
          confidence = Math.min(1, confidence + 0.10);
          evidenceCount += 1;
          appliedReasons.push("feedback: marked useful by user");
          break;
        case "insert":
          confidence = Math.min(1, confidence + 0.20);
          evidenceCount += 1;
          appliedReasons.push("feedback: inserted by user");
          break;
      }
    }

    if (appliedReasons.length) {
      applied.set(draft.sourceRecords?.[0] ?? draft.claim, appliedReasons);
    }

    return {
      ...draft,
      confidence,
      evidenceCount,
      metadata: {
        ...(draft.metadata ?? {}),
        feedback_adjusted: appliedReasons.length > 0,
        feedback_adjustments: appliedReasons,
      },
    };
  });

  return { adjustedDrafts, applied };
}

function feedbackForDraft(
  draft: CandidateDraft,
  feedbackIndex: FeedbackIndex,
): FeedbackRecord[] {
  const results: FeedbackRecord[] = [];
  const claimKey = `${draft.kind}:${draft.target}:${draft.claim}`;
  const fb = feedbackIndex.get(claimKey);
  if (fb) results.push(...fb);
  for (const sr of draft.sourceRecords ?? []) {
    const bySource = feedbackIndex.get(sr);
    if (bySource) results.push(...bySource);
  }
  for (const feedbacks of feedbackIndex.values()) {
    for (const feedback of feedbacks) {
      if (feedback.source_record_ids.some(id => (draft.sourceRecords ?? []).includes(id))) {
        results.push(feedback);
      }
    }
  }
  return results;
}

/* --- helpers --- */

function firstEvidenceId(draft: CandidateDraft): string {
  return draft.sourceRecords?.[0] ?? draft.sourceViews?.[0] ?? draft.claim;
}

function similarClaim(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  return shared / Math.max(wordsA.size, wordsB.size) > 0.6;
}

function sameScopeKey(a?: Record<string, unknown>, b?: Record<string, unknown>): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify([a.project, a.project_path, a.domain]) === JSON.stringify([b.project, b.project_path, b.domain]);
}

function isDirectContradiction(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  // Simple heuristic: claims are short and share same topic but differ heavily.
  if (na === nb) return false;
  if ((na.includes("always ") && nb.includes("never ")) || (na.includes("never ") && nb.includes("always "))) {
    const shared = [...new Set(na.split(/\s+/))]
      .filter((w) => !["always", "never"].includes(w))
      .filter((w) => nb.split(/\s+/).includes(w)).length;
    if (shared >= 2) return true;
  }
  const negationPatterns = ["not ", "no ", "less ", "more ", "don't ", "never ", "always "];
  const aHasNeg = negationPatterns.some((p) => na.includes(p));
  const bHasNeg = negationPatterns.some((p) => nb.includes(p));
  if (aHasNeg !== bHasNeg) {
    const shared = [...new Set(na.split(/\s+/))].filter((w) => nb.split(/\s+/).includes(w)).length;
    if (shared >= 2) return true;
  }
  return false;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

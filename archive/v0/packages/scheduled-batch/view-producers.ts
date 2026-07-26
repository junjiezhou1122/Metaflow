import { ContextStore } from "@info/core";
import type { ContextView } from "@info/core";
import type { ContextWindowSnapshot } from "./context-window.js";
import type { ClassifyResult } from "./classifier.js";
import type { DecisionView, QuestionView, ActionView, MemoryCandidateView } from "./types.js";

export type SynthesisOutput = {
  decisions: DecisionView[];
  openQuestions: QuestionView[];
  nextActions: ActionView[];
  memoryCandidates: MemoryCandidateView[];
  synthesisViews: ContextView[];
  synthesisView?: ContextView;
};

/**
 * Deterministically generate synthesis views and structured updates
 * from the classified context window.
 */
export function generateSynthesisAndViews(
  window: ContextWindowSnapshot,
  classification: ClassifyResult
): SynthesisOutput {
  const generatedAt = new Date().toISOString();
  const decisions: DecisionView[] = [];
  const openQuestions: QuestionView[] = [];
  const nextActions: ActionView[] = [];
  const memoryCandidates: MemoryCandidateView[] = [];
  const synthesisViews: ContextView[] = [];

  const mainActivityIds = classification.mainActivities.map((a) => a.id);
  const interruptionIds = classification.interruptions.map((i) => i.id);

  // Simple deterministic extracts
  for (const record of window.records) {
    const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}`;
    const lower = text.toLowerCase();

    if (lower.includes("decided")) {
      decisions.push({
        id: `view:decision:${record.id}`,
        observedAt: record.time?.observed_at ?? record.created_at,
        title: `Decision from ${record.schema.name}`,
        rationale: text.slice(0, 200),
      });
    }
    if (lower.includes("?")) {
      openQuestions.push({
        id: `view:question:${record.id}`,
        observedAt: record.time?.observed_at ?? record.created_at,
        question: text.slice(0, 200),
      });
    }
    if (lower.includes("todo") || lower.includes("should")) {
      nextActions.push({
        id: `view:action:${record.id}`,
        observedAt: record.time?.observed_at ?? record.created_at,
        title: `Next action from ${record.schema.name}`,
        quickCommand: "echo Review context",
        effort: "low",
      });
    }
    // memory candidate from any non-interruption
    if (!interruptionIds.includes(record.id)) {
      memoryCandidates.push({
        id: `view:memory-candidate:${record.id}`,
        observedAt: record.time?.observed_at ?? record.created_at,
        category: "user_goal",
        description: text.slice(0, 200),
      });
    }
  }

  const synthesisView: ContextView = {
    id: `view:synthesis:${generatedAt}`,
    view_type: "work.synthesis",
    title: "ScheduledCB: Deterministic Synthesis",
    status: "candidate",
    source_records: window.records.map((r) => r.id),
    source_views: window.views.map((v) => v.id),
    content: {
      mainActivities: mainActivityIds,
      interruptions: interruptionIds,
      contextUsed: window.records.length,
      contextUsedViews: window.views.length,
      decisions: decisions.length,
      openQuestions: openQuestions.length,
      nextActions: nextActions.length,
      memoryCandidates: memoryCandidates.length,
      llmEnabled: false,
      privacyBlocked: false,
    },
    confidence: 0.8,
  };

  synthesisViews.push(synthesisView);

  return {
    decisions,
    openQuestions,
    nextActions,
    memoryCandidates,
    synthesisViews,
    synthesisView,
  };
}

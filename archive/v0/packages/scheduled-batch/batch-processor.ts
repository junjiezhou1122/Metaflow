import { ContextStore } from "@info/core";
import type {
  StoredContextRecord,
  StoredContextView,
} from "@info/core";
import { buildContextWindow } from "./context-window.js";
import { classifyWorkAndInterruptions } from "./classifier.js";
import { generateSynthesisAndViews } from "./view-producers.js";
import type { ScheduledBatchOptions, ScheduledBatchResult } from "./types.js";

export async function runScheduledBatch(
  store: ContextStore,
  options: ScheduledBatchOptions = {}
): Promise<ScheduledBatchResult> {
  const start = performance.now();
  const generatedAt = new Date().toISOString();
  const write = options.write ?? true;

  const window = buildContextWindow(store, {
    windowMinutes: options.windowMinutes ?? 60,
  });

  const privacyDenied = privacyDisallowed(window.records, window.views);
  if (privacyDenied) {
    return createPrivacyDeniedResult(window, generatedAt);
  }

  const classification = classifyWorkAndInterruptions(window);
  const synthesis = generateSynthesisAndViews(window, classification);

  if (write) {
    if (synthesis.synthesisView) store.upsertView(synthesis.synthesisView);
    for (const view of synthesis.synthesisViews) store.upsertView(view);
    for (const candidate of synthesis.memoryCandidates) {
      if ("view_type" in candidate) store.upsertView(candidate as import("@info/core").ContextView);
    }
  }

  return {
    ok: true,
    mode: "scheduled_ai_batch",
    generatedAt,
    sourcesUsed: window.sources.map(s => s.id).filter((id): id is string => Boolean(id)),
    decisions: synthesis.decisions,
    openQuestions: synthesis.openQuestions,
    nextActions: synthesis.nextActions,
    candidateMemories: synthesis.memoryCandidates,
    privacyBlocked: false,
    llmEnabled: false,
    fallback: true,
    durationMs: Math.round(performance.now() - start),
    diagnostics: {
      contextWindow: window.diagnostics,
      classification: classification.diagnostics,
    },
  };
}

export async function deterministicScheduledBatch(
  store: ContextStore,
  options: ScheduledBatchOptions = {}
): Promise<ScheduledBatchResult> {
  const generatedAt = new Date().toISOString();
  const window = buildContextWindow(store, { windowMinutes: options.windowMinutes ?? 60 });
  return createPrivacyDeniedResult(window, generatedAt);
}

function createPrivacyDeniedResult(
  window: ReturnType<typeof buildContextWindow>,
  generatedAt: string
): ScheduledBatchResult {
  return {
    ok: true,
    mode: "scheduled_ai_batch",
    generatedAt,
    sourcesUsed: (window.sources ?? []).map(s => s.id).filter((id): id is string => Boolean(id)),
    decisions: [],
    openQuestions: [],
    nextActions: [],
    candidateMemories: [],
    privacyBlocked: true,
    llmEnabled: false,
    fallback: true,
    durationMs: 0,
    diagnostics: {
      contextWindow: window.diagnostics,
      classification: { totalActivities: 0, totalInterruptions: 0, classificationReasons: ["privacy_denied: source disallows external LLM"] },
    },
  };
}

function privacyDisallowed(
  records: StoredContextRecord[],
  views: StoredContextView[]
): boolean {
  return records.some(r => r.privacy?.allow_external_llm === false)
    || views.some(v => v.privacy?.allow_external_llm === false);
}

/**
 * Types for the Scheduled AI Batch layer.
 */

export type ContextSourceReference = {
  kind: "record" | "view";
  id: string;
  type: string;
  sourceType: string;
  observedAt: string;
  title?: string;
};

export type WorkActivity = {
  id: string;
  type: string;
  sourceType: string;
  title?: string;
  description?: string;
  durationMinutes?: number;
  interruptionRisk?: "low" | "medium" | "high";
};

export type Interruption = {
  id: string;
  type: string;
  sourceType: string;
  title?: string;
  description?: string;
  durationMinutes?: number;
  severity?: "low" | "normal" | "high";
};

export type DecisionView = {
  id: string;
  observedAt: string;
  title: string;
  rationale: string;
};

export type QuestionView = {
  id: string;
  observedAt: string;
  question: string;
  contextIds?: string[];
};

export type ActionView = {
  id: string;
  observedAt: string;
  title: string;
  quickCommand?: string;
  effort?: "low" | "medium" | "high";
};

export type MemoryCandidateView = {
  id: string;
  observedAt: string;
  category: string;
  description: string;
};

export type SynthesisView = {
  id: string;
  startTime: string;
  endTime: string;
  mainActivities: string[];
  interruptions: string[];
  contextUsed: number;
  contextUsedViews: number;
  viewsProduced: string[];
  llmEnabled: boolean;
  privacyBlocked: boolean;
};

export type ScheduledBatchOptions = {
  // Minutes to look back (default: 60)
  windowMinutes?: number;
  // If false, do not write any Views to the store
  write?: boolean;
  // If provided, use external LLM (subject to privacy rules)
  llm?: import("@info/core").LlmOptions;
};

export type ScheduledBatchResult = {
  ok: true;
  mode: "scheduled_ai_batch";
  generatedAt: string;
  sourcesUsed: string[];
  decisions: DecisionView[];
  openQuestions: QuestionView[];
  nextActions: ActionView[];
  candidateMemories: MemoryCandidateView[];
  privacyBlocked: boolean;
  llmEnabled: boolean;
  fallback: boolean;
  durationMs: number;
  diagnostics: {
    contextWindow: any;
    classification?: any;
  };
};

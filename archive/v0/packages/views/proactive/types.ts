import type { ContextRecord, ContextView, StoredContextView } from "@info/core";

// ─── Autonomy Level ───────────────────────────────────────────────────────────
export type AutonomyLevel = "manual" | "suggest" | "draft" | "sandbox_auto" | "full_auto";

export function autonomous(autonomy: AutonomyLevel): (req: ActionRequest) => boolean {
  return (req) => req.autonomy_level === autonomy;
}

// ─── Action Risk Level ────────────────────────────────────────────────────────
export type ActionRiskLevel = "none" | "read_only" | "write_safe" | "write_destructive" | "irreversible";

export const RISK_ORDER: ActionRiskLevel[] = [
  "none",
  "read_only",
  "write_safe",
  "write_destructive",
  "irreversible",
];

export function riskOrder(risk: ActionRiskLevel): number {
  return RISK_ORDER.indexOf(risk);
}

export function riskCompare(a: ActionRiskLevel, b: ActionRiskLevel): number {
  return riskOrder(a) - riskOrder(b);
}

export function riskAllowed(risk: ActionRiskLevel, maxRisk: ActionRiskLevel): boolean {
  return riskOrder(risk) <= riskOrder(maxRisk);
}

// ─── Confirmation Policy ──────────────────────────────────────────────────────
export type ConfirmationPolicy =
  | "silent"
  | "notify"
  | "confirm"
  | "block";

export interface ActionPolicy {
  autonomy_level: AutonomyLevel;
  risk_level: ActionRiskLevel;
  max_risk: ActionRiskLevel;
  allowed_actions: string[];
  blocked_actions: string[];
  requires_confirmation: boolean;
  confirmation_policy: ConfirmationPolicy;
  sources: string[];
  owner: string;
  project: string;
}

// ─── Action Request ──────────────────────────────────────────────────────────
export interface ActionRequest {
  id: string;
  goal: string;
  action_type: string;
  payload: Record<string, unknown>;
  autonomy_level: AutonomyLevel;
  risk_level: ActionRiskLevel;
  sources: string[];
  policy: ActionPolicy;
  view_id?: string;
  task_id?: string;
  created_at: string;
}

// ─── Action Outcome ────────────────────────────────────────────────────────────
export interface ActionOutcome {
  ok: boolean;
  request_id: string;
  action_type: string;
  status: "completed" | "failed" | "denied" | "skipped";
  error?: string;
  reason?: string;
  output_views?: string[];
  output_records?: string[];
  diagnostics?: Record<string, unknown>;
  started_at: string;
  finished_at: string;
}

// ─── Learnable Failure ─────────────────────────────────────────────────────────
export interface LearnableFailure {
  ok: false;
  request_id: string;
  action_type: string;
  error: string;
  recovery_pattern?: string;
  prevention_tag?: string;
  created_at: string;
}

// ─── Proactive Task ───────────────────────────────────────────────────────────
export interface ProactiveTask {
  id: string;
  goal: string;
  source_view_id: string;
  autonomy_level: AutonomyLevel;
  risk_level: ActionRiskLevel;
  confirmation_policy: ConfirmationPolicy;
  allowed_actions: string[];
  status: "candidate" | "confirmed" | "running" | "completed" | "failed" | "denied";
  outcome_view_id?: string;
  created_at: string;
  updated_at: string;
}

// ─── View Content Helpers ─────────────────────────────────────────────────────
export type ActionOutcomeViewContent = {
  request_id: string;
  action_type: string;
  goal: string;
  status: ActionOutcome["status"];
  outcome: ActionOutcome;
  sources: string[];
  policy: ActionPolicy;
  created_at: string;
};

export type LearnableFailureViewContent = {
  request_id: string;
  action_type: string;
  error: string;
  recovery_pattern?: string;
  prevention_tag?: string;
  sources: string[];
  created_at: string;
};

export type ProactiveTaskViewContent = {
  task: ProactiveTask;
  goal: string;
  autonomy_level: AutonomyLevel;
  risk_level: ActionRiskLevel;
  confirmation_policy: ConfirmationPolicy;
  status: ProactiveTask["status"];
  outcome_summary?: string;
  outcome_view_id?: string;
  created_at: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────
export const PROACTIVE_TASK_VIEW_TYPE = "proactive.task";
export const ACTION_OUTCOME_VIEW_TYPE = "action.outcome";
export const LEARNABLE_FAILURE_VIEW_TYPE = "failure.learnable";

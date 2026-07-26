import type { StoredContextView } from "./types.js";

export type AgentOutputContent = {
  summary?: string;
  analysis?: unknown;
  key_points?: unknown;
  confidence?: number;
};

export function isGenericAgentAnalysisView(view: StoredContextView): boolean {
  return view.view_type.startsWith("analysis.") && (
    view.compiler?.id === "capability.agent_task.submit" ||
    Boolean(view.content?.agent_task) ||
    typeof view.metadata?.agent_runtime === "string"
  );
}

export function analysisTextFromView(view: StoredContextView): string | undefined {
  const output = agentOutputContent(view);
  if (typeof output?.analysis === "string" && output.analysis.trim()) return output.analysis.trim();
  if (typeof view.content?.analysis === "string" && view.content.analysis.trim()) return view.content.analysis.trim();
  if (typeof view.content?.text === "string" && view.content.text.trim()) return view.content.text.trim().slice(0, 1200);
  return view.summary;
}

export function keyPointsFromView(view: StoredContextView, limit = 8): string[] {
  const output = agentOutputContent(view);
  return arrayOfStrings(output?.key_points).concat(arrayOfStrings(view.content?.key_points)).slice(0, limit);
}

export function agentOutputFromDiagnostics(diagnostics?: Record<string, unknown>): AgentOutputContent | undefined {
  const output = diagnostics?.agent_output;
  return output && typeof output === "object" ? output as AgentOutputContent : undefined;
}

function agentOutputContent(view: StoredContextView): AgentOutputContent | undefined {
  return view.content?.agent_output && typeof view.content.agent_output === "object" ? view.content.agent_output as AgentOutputContent : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

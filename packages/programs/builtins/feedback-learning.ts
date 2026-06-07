import type { ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";

export const feedbackLearningProgram: Program = {
  id: "program.feedback_learning",
  title: "Feedback Learning",
  purpose: "Compile application feedback into reusable Memory Views that change future surfacing behavior.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "suggest",
  produces: ["memory.surfacing_preference", "memory.output_edit_pattern"],
  learns_from: ["feedback.analysis.dismissed", "feedback.analysis.useful", "feedback.output.edited"],

  attention(signal: ContextSignal): AttentionDecision {
    if (signal.object_kind !== "observation") return { action: "ignore", reason: "feedback learning starts from feedback observations", confidence: 0.9 };
    if (signal.object_type === "feedback.analysis.dismissed") return { action: "run", reason: "dismissed analysis can update surfacing memory", confidence: 0.9, speed: "background" };
    if (signal.object_type === "feedback.analysis.useful") return { action: "run", reason: "useful analysis can update surfacing memory", confidence: 0.9, speed: "background" };
    if (signal.object_type === "feedback.output.edited") return { action: "run", reason: "edited output can update taste memory", confidence: 0.9, speed: "background" };
    return { action: "ignore", reason: "not feedback learning input", confidence: 0.85 };
  },

  run({ signal, store }): ProgramRunResult {
    const feedback = store.getRecord(signal.object_id);
    if (!feedback) return { ok: false, reason: `feedback record not found: ${signal.object_id}` };
    const target = relatedViews(feedback, store)[0];
    if (!target) return { ok: false, reason: "feedback has no related View to learn from" };

    const memory = feedback.schema.name === "feedback.output.edited"
      ? buildOutputEditMemory(feedback, target)
      : buildSurfacingMemory(feedback, target);
    if (!memory) return { ok: false, reason: "feedback.output.edited requires non-empty original_text and edited_text" };
    return {
      ok: true,
      reason: `learned ${memory.view_type} for ${target.view_type}`,
      views: [memory],
      diagnostics: { target_view_id: target.id, target_view_type: target.view_type, preference: memory.content?.preference },
    };
  },
};

function relatedViews(feedback: StoredContextRecord, store: { getView(id: string): StoredContextView | undefined }): StoredContextView[] {
  return (feedback.relations?.related_to ?? [])
    .map(id => store.getView(id))
    .filter((view): view is StoredContextView => Boolean(view));
}

function buildSurfacingMemory(feedback: StoredContextRecord, target: StoredContextView): ContextView {
  const preference = feedback.schema.name === "feedback.analysis.useful" ? "show_more" : "show_less";
  const id = `memory:surfacing:${stableKey(`${target.view_type}:${target.scope?.domain ?? ""}:${feedback.source.connector ?? ""}:${preference}`)}`;
  const label = preference === "show_more" ? "Show more" : "Show less";
  return {
    id,
    view_type: "memory.surfacing_preference",
    title: `${label}: ${target.view_type}`,
    summary: feedback.content?.text ?? surfacingSummary(preference, target.view_type),
    status: "candidate",
    source_records: [feedback.id],
    source_views: [target.id],
    compiler: { id: "program.feedback_learning", version: "0.1.0", mode: "deterministic" },
    purpose: "Memory View compiled from dismissal feedback so future Programs can adjust attention.",
    scope: {
      domain: target.scope?.domain,
      app: target.scope?.app,
      project: target.scope?.project,
      project_path: target.scope?.project_path,
      plugin_id: "program.feedback_learning",
    },
    content: {
      preference,
      target_view_type: target.view_type,
      target_view_id: target.id,
      feedback_type: feedback.schema.name,
      feedback_value: feedback.payload?.value,
      application_id: feedback.payload?.application_id ?? feedback.source.connector,
      reason: feedback.content?.text,
    },
    confidence: preference === "show_more" ? 0.7 : 0.72,
    stability: "long_term",
    lossiness: "low",
    privacy: feedback.privacy,
    metadata: { source_feedback_schema: feedback.schema.name },
  };
}

function surfacingSummary(preference: string, viewType: string): string {
  if (preference === "show_more") return `User marked ${viewType} useful; raise similar context surfacing.`;
  return `User dismissed ${viewType}; reduce similar automatic surfacing.`;
}

function buildOutputEditMemory(feedback: StoredContextRecord, target: StoredContextView): ContextView | undefined {
  const originalText = stringValue(feedback.payload?.original_text)?.trim();
  const editedText = stringValue(feedback.payload?.edited_text)?.trim();
  if (!originalText || !editedText) return undefined;
  const id = `memory:output-edit:${stableKey(`${target.view_type}:${feedback.source.connector ?? ""}:${editedText}`)}`;
  return {
    id,
    view_type: "memory.output_edit_pattern",
    title: `Output edit pattern: ${target.view_type}`,
    summary: feedback.content?.text ?? `User edited output from ${target.view_type}.`,
    status: "candidate",
    source_records: [feedback.id],
    source_views: [target.id],
    compiler: { id: "program.feedback_learning", version: "0.1.0", mode: "deterministic" },
    purpose: "Memory View compiled from edited output feedback so future Programs can adapt taste and output style.",
    scope: {
      domain: target.scope?.domain,
      app: target.scope?.app,
      project: target.scope?.project,
      project_path: target.scope?.project_path,
      plugin_id: "program.feedback_learning",
    },
    content: {
      preference: "edited_output",
      target_view_type: target.view_type,
      target_view_id: target.id,
      feedback_type: feedback.schema.name,
      feedback_value: feedback.payload?.value,
      application_id: feedback.payload?.application_id ?? feedback.source.connector,
      original_text: originalText,
      edited_text: editedText,
      reason: feedback.content?.text,
    },
    confidence: 0.78,
    stability: "long_term",
    lossiness: "low",
    privacy: feedback.privacy,
    metadata: { source_feedback_schema: feedback.schema.name },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

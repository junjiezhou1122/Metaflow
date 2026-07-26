import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const PROJECT_DECISION_EXTRACTOR_PROCESSOR_ID = "processor.project_decision_extractor";
export const PROJECT_DECISIONS_VIEW_TYPE = "project.decisions";

export type ProjectDecisionExtractorOptions = {
  limit?: number;
  now?: Date;
};

export function createProjectDecisionExtractorProcessor(options: ProjectDecisionExtractorOptions = {}): ProcessorDefinition {
  return {
    id: PROJECT_DECISION_EXTRACTOR_PROCESSOR_ID,
    title: "Project Decision Extractor",
    version: "0.0.1",
    description: "Extracts project decisions with rationale from conversation observations and project context.",
    consumes: {
      observations: ["observation.codex.message", "observation.claude.message"],
      views: ["project.current"],
    },
    produces: { views: [PROJECT_DECISIONS_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
    handler: projectDecisionExtractorHandler(options),
  };
}

export function projectDecisionExtractorHandler(options: ProjectDecisionExtractorOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 20;
    const currentViews = context.store.listViews({ view_types: ["project.current"], active_only: true, limit: 5 });
    const msgRecords = context.store.recent(limit, undefined, undefined)
      .filter((record: StoredContextRecord) =>
        record.schema.name === "observation.codex.message" ||
        record.schema.name === "observation.claude.message"
      )
      .slice(0, limit);

    const decisions = msgRecords
      .filter((record: StoredContextRecord) => {
        const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}`.toLowerCase();
        return text.includes("decision") || text.includes("decided");
      })
      .map((record: StoredContextRecord) => ({
        id: record.id,
        title: record.content?.title ?? "Decision",
        source_count: 1,
        observed_at: record.created_at,
      }));
    const generatedAt = now.toISOString();

    const view: ViewDraft = {
      id: "view:project_decisions:current",
      type: PROJECT_DECISIONS_VIEW_TYPE,
      title: "Project Decisions",
      summary: `${decisions.length} decision(s) extracted from project conversations.`,
      status: "candidate",
      source_records: msgRecords.map((record: StoredContextRecord) => record.id),
      source_views: currentViews.map((view: StoredContextView) => view.id),
      compiler: { id: PROJECT_DECISION_EXTRACTOR_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Project decisions with rationale, source context, and open consequences.",
      content: { decisions, decision_count: decisions.length, generated_at: generatedAt },
      confidence: 0.65,
      stability: "project",
      lossiness: "low",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: generatedAt },
    };
    return { views: [view] };
  };
}

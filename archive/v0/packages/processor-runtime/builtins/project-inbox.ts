import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const PROJECT_INBOX_PROCESSOR_ID = "processor.project_inbox";
export const PROJECT_INBOX_VIEW_TYPE = "project.inbox";

export type ProjectInboxProcessorOptions = {
  limit?: number;
  now?: Date;
};

export function createProjectInboxProcessor(options: ProjectInboxProcessorOptions = {}): ProcessorDefinition {
  return {
    id: PROJECT_INBOX_PROCESSOR_ID,
    title: "Project Inbox",
    version: "0.0.1",
    description: "Collects project-relevant unresolved observations and resources awaiting triage.",
    consumes: {
      observations: ["observation.browser_page_snapshot", "observation.codex.message"],
      views: ["brief.research", "advice.writing_assist", "research.brief", "writing.advice"],
    },
    produces: { views: [PROJECT_INBOX_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
    handler: projectInboxHandler(options),
  };
}

export function projectInboxHandler(options: ProjectInboxProcessorOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 20;
    const recentRecords = context.store.recent(limit * 2, undefined, undefined)
      .filter((record: StoredContextRecord) =>
        record.schema.name === "observation.browser_page_snapshot" ||
        record.schema.name === "observation.codex.message"
      )
      .slice(0, limit);
    const briefViews = context.store.listViews({ view_types: ["brief.research", "advice.writing_assist", "research.brief", "writing.advice"], active_only: true, limit });

    const items = [
      ...recentRecords.map((record: StoredContextRecord) => ({
        id: record.id,
        title: record.content?.title ?? record.schema.name,
        source: record.schema.name,
        observed_at: record.created_at,
      })),
      ...briefViews.map((view: StoredContextView) => ({
        id: view.id,
        title: view.title ?? view.view_type,
        source: view.view_type,
        observed_at: view.created_at,
      })),
    ];
    const generatedAt = now.toISOString();

    const view: ViewDraft = {
      id: "view:project_inbox:current",
      type: PROJECT_INBOX_VIEW_TYPE,
      title: "Project Inbox",
      summary: `${items.length} item(s) awaiting triage.`,
      status: "candidate",
      source_records: recentRecords.map((record: StoredContextRecord) => record.id),
      source_views: briefViews.map((view: StoredContextView) => view.id),
      compiler: { id: PROJECT_INBOX_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Project-relevant unresolved observations and resources awaiting triage.",
      content: { items, item_count: items.length, generated_at: generatedAt },
      confidence: 0.7,
      stability: "session",
      lossiness: "low",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: generatedAt },
    };
    return { views: [view] };
  };
}

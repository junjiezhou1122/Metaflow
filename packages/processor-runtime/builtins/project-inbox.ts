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
      views: ["research.brief", "writing.advice"],
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
      .filter((r: StoredContextRecord) =>
        r.schema.name === "observation.browser_page_snapshot" ||
        r.schema.name === "observation.codex.message"
      )
      .slice(0, limit);

    const briefViews = context.store.listViews({ view_types: ["research.brief", "writing.advice"], active_only: true, limit });

    const items = [
      ...recentRecords.map((r: StoredContextRecord) => ({
        id: r.id,
        title: (r.content as Record<string, unknown>)?.title as string ?? r.schema.name,
        source: r.schema.name,
        observed_at: r.created_at,
      })),
      ...briefViews.map((v: StoredContextView) => ({
        id: v.id,
        title: v.title ?? v.view_type,
        source: v.view_type,
        observed_at: v.created_at,
      })),
    ];

    const view: ViewDraft = {
      id: "view:project_inbox:current",
      type: PROJECT_INBOX_VIEW_TYPE,
      title: "Project Inbox",
      summary: `${items.length} item(s) awaiting triage.`,
      status: "candidate",
      source_records: recentRecords.map((r: StoredContextRecord) => r.id),
      source_views: briefViews.map((v: StoredContextView) => v.id),
      compiler: { id: PROJECT_INBOX_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Project-relevant unresolved observations and resources awaiting triage.",
      content: { items, item_count: items.length, generated_at: now.toISOString() },
      confidence: 0.7,
      stability: "session",
      lossiness: "low",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: now.toISOString() },
    };
    return { views: [view] };
  };
}

import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const PROJECT_TASKS_PROCESSOR_ID = "processor.project_tasks";
export const PROJECT_TASKS_VIEW_TYPE = "project.tasks";

export type ProjectTasksProcessorOptions = {
  limit?: number;
  now?: Date;
};

export function createProjectTasksProcessor(options: ProjectTasksProcessorOptions = {}): ProcessorDefinition {
  return {
    id: PROJECT_TASKS_PROCESSOR_ID,
    title: "Project Tasks",
    version: "0.0.1",
    description: "Derives actionable project work items from conversations, inbox, and project context.",
    consumes: {
      views: ["project.current", "project.inbox"],
      observations: ["observation.codex.message"],
    },
    produces: { views: [PROJECT_TASKS_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
    handler: projectTasksHandler(options),
  };
}

export function projectTasksHandler(options: ProjectTasksProcessorOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 20;

    const currentViews = context.store.listViews({ view_types: ["project.current"], active_only: true, limit: 5 });
    const inboxViews = context.store.listViews({ view_types: ["project.inbox"], active_only: true, limit: 5 });
    const codexRecords = context.store.recent(limit, undefined, undefined)
      .filter((r: StoredContextRecord) => r.schema.name === "observation.codex.message")
      .slice(0, limit);

    const sourceViewIds = [...currentViews, ...inboxViews].map((v: StoredContextView) => v.id);
    const sourceRecordIds = codexRecords.map((r: StoredContextRecord) => r.id);

    const tasks = codexRecords.map((r: StoredContextRecord) => ({
      id: r.id,
      title: (r.content as Record<string, unknown>)?.title as string ?? "Codex task",
      status: "open",
      source: r.schema.name,
      observed_at: r.created_at,
    }));

    const view: ViewDraft = {
      id: "view:project_tasks:current",
      type: PROJECT_TASKS_VIEW_TYPE,
      title: "Project Tasks",
      summary: `${tasks.length} task(s) derived from project context.`,
      status: "candidate",
      source_records: sourceRecordIds,
      source_views: sourceViewIds,
      compiler: { id: PROJECT_TASKS_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Actionable project work items derived from conversations and project context.",
      content: { tasks, task_count: tasks.length, generated_at: now.toISOString() },
      confidence: 0.7,
      stability: "session",
      lossiness: "low",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: now.toISOString() },
    };
    return { views: [view] };
  };
}

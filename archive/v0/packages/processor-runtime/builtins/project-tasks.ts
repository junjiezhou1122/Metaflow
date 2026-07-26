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
      .filter((record: StoredContextRecord) => record.schema.name === "observation.codex.message")
      .slice(0, limit);

    const tasks = codexRecords.map((record: StoredContextRecord) => ({
      id: record.id,
      title: record.content?.title ?? "Codex task",
      status: "open",
      source: record.schema.name,
      observed_at: record.created_at,
    }));
    const generatedAt = now.toISOString();

    const view: ViewDraft = {
      id: "view:project_tasks:current",
      type: PROJECT_TASKS_VIEW_TYPE,
      title: "Project Tasks",
      summary: `${tasks.length} task(s) derived from project context.`,
      status: "candidate",
      source_records: codexRecords.map((record: StoredContextRecord) => record.id),
      source_views: [...currentViews, ...inboxViews].map((view: StoredContextView) => view.id),
      compiler: { id: PROJECT_TASKS_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Actionable project work items derived from conversations and project context.",
      content: { tasks, task_count: tasks.length, generated_at: generatedAt },
      confidence: 0.7,
      stability: "session",
      lossiness: "low",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: generatedAt },
    };
    return { views: [view] };
  };
}

import { ContextStore, type ContextView, type StoredContextView } from "@info/core";
import { processAmbientBackgroundTasks, type AmbientBackgroundTaskMode, type AmbientBackgroundTaskResult, type BackgroundTaskIiiClient } from "./background-tasks.js";
import type { AutonomyProfile } from "@info/programs/types.js";

export const AGENT_TASK_LIST_VIEW_TYPE = "agent.task_list";
export const AGENT_TASK_SOURCE_VIEW_TYPES = ["task.background_research"] as const;

export type AgentTaskListStatus = "queued" | "completed" | "failed" | "skipped" | "candidate" | "cancelled";

export type AgentTaskListItem = {
  id: string;
  view_type: string;
  title?: string;
  summary?: string;
  status: AgentTaskListStatus;
  speed?: string;
  autonomy?: string;
  runtime?: string;
  output_view_type?: string;
  source_records: string[];
  source_views: string[];
  updated_at?: string;
  reason?: string;
};

export type AgentTaskList = {
  ok: true;
  generated_at: string;
  items: AgentTaskListItem[];
  counts: Record<AgentTaskListStatus, number>;
  latest_view?: StoredContextView;
};

export type AgentTaskQueueOptions = {
  limit?: number;
  write?: boolean;
  iii?: BackgroundTaskIiiClient;
  mode?: AmbientBackgroundTaskMode;
  runtime?: string;
  dry_run?: boolean;
  autonomy?: AutonomyProfile;
};

export type AgentTaskLifecycleAction = "cancel" | "retry";

export type AgentTaskLifecycleResult = {
  ok: boolean;
  action: AgentTaskLifecycleAction;
  task_id: string;
  view?: StoredContextView;
  task_list?: AgentTaskList;
  error?: string;
};

type RuntimeActor = "agent" | "user" | "connector" | "system" | "plugin";

export async function queueOrProcessAgentTasks(options: AgentTaskQueueOptions = {}, store = new ContextStore()): Promise<AmbientBackgroundTaskResult & { task_list: AgentTaskList }> {
  const result = await processAmbientBackgroundTasks(options, store);
  const taskList = buildAgentTaskList({ write: options.write ?? true }, store);
  return { ...result, task_list: taskList };
}

export function buildAgentTaskList(options: { limit?: number; write?: boolean } = {}, store = new ContextStore()): AgentTaskList {
  const generatedAt = new Date().toISOString();
  const items = store.listViews({ view_types: [...AGENT_TASK_SOURCE_VIEW_TYPES], active_only: true, limit: options.limit ?? 100 })
    .map(viewToTaskItem)
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""));
  const counts = countItems(items);
  let latest: StoredContextView | undefined;
  if (options.write ?? true) {
    latest = store.upsertView(taskListView(generatedAt, items, counts));
  } else {
    latest = store.listViews({ view_types: [AGENT_TASK_LIST_VIEW_TYPE], active_only: true, limit: 1 })[0];
  }
  return { ok: true, generated_at: generatedAt, items, counts, latest_view: latest };
}

export function updateAgentTaskLifecycle(taskId: string, action: AgentTaskLifecycleAction, options: { reason?: string; actor?: RuntimeActor; write?: boolean } = {}, store = new ContextStore()): AgentTaskLifecycleResult {
  const view = store.getView(taskId);
  if (!view || !AGENT_TASK_SOURCE_VIEW_TYPES.includes(view.view_type as (typeof AGENT_TASK_SOURCE_VIEW_TYPES)[number])) {
    return { ok: false, action, task_id: taskId, error: "agent task view not found" };
  }
  const now = new Date().toISOString();
  const background = isRecord(view.content?.background_task) ? view.content.background_task : {};
  const nextBackground = action === "cancel"
    ? {
        ...background,
        status: "cancelled",
        cancelled_at: now,
        reason: options.reason ?? "cancelled by agent task lifecycle action",
      }
    : {
        ...background,
        status: "queued",
        retried_at: now,
        reason: options.reason ?? "requeued by agent task lifecycle action",
        written_views: [],
      };
  const updated = store.upsertView({
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    status: "candidate",
    source_records: view.source_records,
    source_views: view.source_views,
    compiler: view.compiler,
    purpose: view.purpose,
    scope: view.scope,
    content: { ...(view.content ?? {}), background_task: nextBackground },
    confidence: view.confidence,
    stability: view.stability,
    lossiness: view.lossiness,
    privacy: view.privacy,
    validity: view.validity,
    metadata: {
      ...(view.metadata ?? {}),
      last_agent_task_lifecycle_action: action,
      last_agent_task_lifecycle_at: now,
    },
  });
  store.appendRuntimeEvent({
    event_type: `agent_task.${action === "cancel" ? "cancelled" : "retried"}`,
    actor: options.actor ?? "agent",
    status: "completed",
    subject_type: "view",
    subject_id: updated.id,
    plugin_id: "runtime.agent_tasks",
    related_views: [updated.id],
    related_records: updated.source_records,
    payload: { action, task_id: updated.id, reason: options.reason, at: now },
  });
  const taskList = buildAgentTaskList({ write: options.write ?? true }, store);
  return { ok: true, action, task_id: updated.id, view: updated, task_list: taskList };
}

function taskListView(generatedAt: string, items: AgentTaskListItem[], counts: Record<AgentTaskListStatus, number>): ContextView {
  const open = counts.queued + counts.candidate + counts.skipped;
  return {
    id: "agent:task_list:current",
    view_type: AGENT_TASK_LIST_VIEW_TYPE,
    title: "Agent task list",
    summary: `${open} open agent task${open === 1 ? "" : "s"}; ${counts.completed} completed; ${counts.failed} failed.`,
    status: open > 0 ? "candidate" : "accepted",
    source_views: items.map(item => item.id),
    compiler: { id: "runtime.agent_task_list", version: "0.1.0", mode: "deterministic" },
    purpose: "Unified queue surface for slow AgentTask work handled by Claude Code, Codex, ACP, or local adapters.",
    content: {
      generated_at: generatedAt,
      item_count: items.length,
      counts,
      items,
      realtime_policy: {
        immediate: ["reflex", "glance", "think"],
        queued: ["work", "background"],
      },
    },
    stability: "session",
    lossiness: "low",
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    metadata: { generated_by: "runtime.agent_task_list" },
  };
}

function viewToTaskItem(view: StoredContextView): AgentTaskListItem {
  const background = isRecord(view.content?.background_task) ? view.content.background_task : undefined;
  return {
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    status: taskStatus(view, background),
    speed: stringValue(view.content?.speed),
    autonomy: stringValue(view.content?.autonomy),
    runtime: stringValue(background?.runtime) ?? stringValue(view.content?.runtime),
    output_view_type: stringValue(background?.output_view_type) ?? stringValue(view.metadata?.output_view_type),
    source_records: view.source_records ?? [],
    source_views: view.source_views ?? [],
    updated_at: view.updated_at,
    reason: stringValue(background?.reason),
  };
}

function taskStatus(view: StoredContextView, background?: Record<string, unknown>): AgentTaskListStatus {
  const status = stringValue(background?.status) ?? view.status;
  if (status === "completed" || status === "failed" || status === "skipped" || status === "queued" || status === "candidate" || status === "cancelled") return status;
  return "candidate";
}

function countItems(items: AgentTaskListItem[]): Record<AgentTaskListStatus, number> {
  return {
    queued: items.filter(item => item.status === "queued").length,
    completed: items.filter(item => item.status === "completed").length,
    failed: items.filter(item => item.status === "failed").length,
    skipped: items.filter(item => item.status === "skipped").length,
    candidate: items.filter(item => item.status === "candidate").length,
    cancelled: items.filter(item => item.status === "cancelled").length,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ContextStore } from "@info/core";
import { filterViewsForPlugin } from "@info/core";
import type { ContextView, StoredContextRecord, StoredContextView, StoredRuntimeEvent } from "@info/core";
import { compileActivityTimeline, type ActivityTimelineBucket, type ActivityTimelineItem } from "./activity-timeline.js";
import { extractFeatures } from "./correlation.js";

export const PROJECT_TIMELINE_COMPILER_ID = "builtin.project-timeline";

export type CompileProjectTimelineOptions = {
  projectPath?: string;
  project?: string;
  minutes?: number;
  limit?: number;
  eventLimit?: number;
  bucketMinutes?: number;
  write?: boolean;
  title?: string;
  records?: StoredContextRecord[];
  runtimeEvents?: StoredRuntimeEvent[];
  workThreadViews?: StoredContextView[];
  includeStoredWorkThreads?: boolean;
  pluginId?: string;
};

export type ProjectTimelineEvidence = {
  id: string;
  schema: string;
  source: string;
  title?: string;
  url?: string;
  path?: string;
  observed_at?: string;
  excerpt?: string;
};

export type ProjectTimelineWorkThread = {
  id: string;
  title?: string;
  confidence?: number;
  view_id?: string;
  thread_id?: string;
  updated_at: string;
  source_records: string[];
  evidence: ProjectTimelineEvidence[];
  next_actions: string[];
};

export type CompileProjectTimelineResult = {
  ok: true;
  compiler_id: string;
  project: string;
  project_path?: string;
  view: ContextView | StoredContextView;
  records_used: number;
  work_threads: ProjectTimelineWorkThread[];
  buckets: ActivityTimelineBucket[];
};

export function compileProjectTimeline(options: CompileProjectTimelineOptions = {}, store = new ContextStore()): CompileProjectTimelineResult {
  const generatedAt = new Date().toISOString();
  const projectPath = normalizeProjectPath(options.projectPath);
  const project = options.project ?? (projectPath ? basename(projectPath) : inferActiveProject(store));
  const minutes = options.minutes ?? 24 * 60;
  const limit = options.limit ?? 300;
  const activity = compileActivityTimeline({
    minutes,
    limit: Math.max(limit * 2, limit),
    eventLimit: options.eventLimit ?? 80,
    bucketMinutes: options.bucketMinutes,
    write: false,
    records: options.records,
    runtimeEvents: options.runtimeEvents,
    pluginId: options.pluginId,
  }, store);
  const activityView = activity.view;
  const allItems = ((activityView.content?.items ?? []) as ActivityTimelineItem[]);
  const recordLimit = Math.max(limit * 2, limit);
  const candidateRecordLimit = options.records ? recordLimit : Math.max(recordLimit * 3, recordLimit + 50);
  const records = (options.records ?? store.recent(candidateRecordLimit, undefined, { minutes })).filter(isRawProjectRecord).slice(0, recordLimit);
  const relevantRecords = selectProjectRecords(records, { project, projectPath }).slice(0, limit);
  const relevantRecordIds = new Set(relevantRecords.map(record => record.id));
  const relevantItems = allItems.filter(item => isItemRelevantToProject(item, relevantRecordIds, { project, projectPath }));
  const representedRecordIds = new Set(relevantItems.flatMap(item => item.record_ids ?? []));
  const fallbackItems = relevantRecords
    .filter(record => !representedRecordIds.has(record.id))
    .map(projectRecordToItem);
  const workThreads = selectProjectWorkThreads(store, {
    project,
    projectPath,
    recordIds: relevantRecordIds,
    minutes,
    views: options.workThreadViews,
    includeStoredWorkThreads: options.includeStoredWorkThreads,
  });
  const projectItems = [...relevantItems, ...fallbackItems, ...workThreads.map(workThreadToItem)]
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  const buckets = bucketProjectItems(projectItems, options.bucketMinutes ?? chooseBucketMinutes(minutes));
  const range = { start: new Date(Date.parse(generatedAt) - minutes * 60_000).toISOString(), end: generatedAt };
  const view: ContextView = {
    id: `view:project_timeline:${slug(projectPath ?? project ?? "unknown")}:${minutes}m`,
    view_type: "project_timeline",
    title: options.title ?? `Project timeline: ${project ?? projectPath ?? "unknown"}`,
    summary: `${buckets.reduce((sum, bucket) => sum + bucket.count, 0)} activity items and ${workThreads.length} work threads for ${projectPath ?? project ?? "project"}.`,
    status: "candidate",
    source_records: relevantRecords.map(record => record.id),
    source_views: [activityView.id, ...workThreads.map(thread => thread.view_id).filter((id): id is string => Boolean(id))].filter((id): id is string => Boolean(id)),
    compiler: { id: PROJECT_TIMELINE_COMPILER_ID, version: "1", mode: "deterministic" },
    purpose: "Project-scoped timeline that groups all-sensor activity and related WorkThreads for a single project.",
    scope: { project, project_path: projectPath, time_range: range, plugin_id: options.pluginId ?? PROJECT_TIMELINE_COMPILER_ID },
    content: {
      project,
      project_path: projectPath,
      minutes,
      buckets,
      work_threads: workThreads,
      activity_item_count: projectItems.filter(item => item.kind !== "runtime_event" || item.source !== "work_thread").length,
      work_thread_item_count: workThreads.length,
      signals: summarizeProjectTimeline(projectItems, workThreads),
    },
    confidence: relevantRecords.length || workThreads.length ? 0.85 : 0.25,
    stability: minutes <= 24 * 60 ? "session" : "project",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    metadata: { generated_at: generatedAt, record_count: relevantRecords.length, work_thread_count: workThreads.length, activity_source_view_id: activityView.id },
  };
  const shouldWrite = options.write ?? true;
  const stored = shouldWrite ? store.upsertView(view) : view;
  if (shouldWrite) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: stored.id,
      plugin_id: options.pluginId ?? PROJECT_TIMELINE_COMPILER_ID,
      related_records: stored.source_records,
      related_views: stored.source_views,
      payload: { view_type: stored.view_type, project, project_path: projectPath, records_used: relevantRecords.length, bucket_count: buckets.length, work_thread_count: workThreads.length },
    });
  }
  return { ok: true, compiler_id: PROJECT_TIMELINE_COMPILER_ID, project: project ?? "unknown", project_path: projectPath, view: stored, records_used: relevantRecords.length, work_threads: workThreads, buckets };
}

function isRawProjectRecord(record: StoredContextRecord): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (record.privacy?.retention === "do_not_store") return false;
  return true;
}

function selectProjectRecords(records: StoredContextRecord[], scope: { project?: string; projectPath?: string }): StoredContextRecord[] {
  return records.filter(record => isRecordRelevantToProject(record, scope));
}

function isRecordRelevantToProject(record: StoredContextRecord, scope: { project?: string; projectPath?: string }): boolean {
  const feature = extractFeatures(record);
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${record.content?.url ?? ""}\n${record.content?.path ?? ""}\n${JSON.stringify(record.payload ?? {})}`;
  if (scope.projectPath && normalizeProjectPath(feature.path) === scope.projectPath) return true;
  if (scope.projectPath && text.includes(scope.projectPath)) return true;
  if (scope.project && feature.project === scope.project) return true;
  if (scope.project && record.scope?.project === scope.project) return true;
  if (scope.project && scope.project.length >= 5 && new RegExp(`\\b${escapeRegExp(scope.project.toLowerCase())}\\b`).test(text.toLowerCase())) return true;
  return false;
}

function isItemRelevantToProject(item: ActivityTimelineItem, recordIds: Set<string>, scope: { project?: string; projectPath?: string }): boolean {
  if (item.record_ids?.some(id => recordIds.has(id))) return true;
  if (scope.project && item.project === scope.project) return true;
  if (scope.projectPath && item.path?.includes(scope.projectPath)) return true;
  return false;
}

function selectProjectWorkThreads(store: ContextStore, input: {
  project?: string;
  projectPath?: string;
  recordIds: Set<string>;
  minutes: number;
  views?: StoredContextView[];
  includeStoredWorkThreads?: boolean;
}): ProjectTimelineWorkThread[] {
  const rawViews = input.views ?? store.listViews({ view_types: ["work_thread"], limit: 80, timeWindow: { minutes: input.minutes } });
  const views = filterViewsForPlugin(rawViews, store);
  const threads: ProjectTimelineWorkThread[] = [];
  for (const view of views) {
    const sourceRecords = view.source_records ?? [];
    const status = view.content?.current_status as Record<string, unknown> | undefined;
    const activeThread = view.content?.active_thread as Record<string, unknown> | undefined;
    const nextActions = Array.isArray(view.content?.next_actions) ? view.content.next_actions.map(String) : [];
    const viewProject = stringValue(view.scope?.project) ?? stringValue(status?.project);
    const viewProjectPath = stringValue(view.scope?.project_path) ?? stringValue(status?.project_path);
    const matches =
      sourceRecords.some(id => input.recordIds.has(id)) ||
      (input.project && viewProject === input.project) ||
      (input.projectPath && normalizeProjectPath(viewProjectPath) === input.projectPath);
    if (!matches) continue;
    threads.push({
      id: view.id,
      view_id: view.id,
      thread_id: stringValue(activeThread?.thread_id),
      title: view.title,
      confidence: view.confidence,
      updated_at: view.updated_at,
      source_records: sourceRecords,
      evidence: compactEvidenceForIds(store, sourceRecords),
      next_actions: nextActions.slice(0, 6),
    });
  }
  if (input.includeStoredWorkThreads === false) return threads.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 20);

  for (const thread of store.listWorkThreads("candidate").slice(0, 80)) {
    const matches =
      thread.evidence_records?.some(id => input.recordIds.has(id)) ||
      (input.project ? thread.projects?.includes(input.project) : false) ||
      (input.project ? JSON.stringify(thread.metadata ?? {}).toLowerCase().includes(input.project.toLowerCase()) : false) ||
      (input.projectPath ? JSON.stringify(thread.metadata ?? {}).includes(input.projectPath) : false);
    if (!matches || threads.some(existing => existing.id === thread.id)) continue;
    threads.push({
      id: thread.id,
      thread_id: thread.id,
      title: thread.title,
      confidence: thread.confidence,
      updated_at: thread.updated_at,
      source_records: thread.evidence_records ?? [],
      evidence: compactEvidenceForIds(store, thread.evidence_records ?? []),
      next_actions: [],
    });
  }
  return threads.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 20);
}

function workThreadToItem(thread: ProjectTimelineWorkThread): ActivityTimelineItem {
  return {
    id: `work-thread:${thread.id}`,
    kind: "runtime_event",
    source: "work_thread",
    event_type: "work_thread",
    title: thread.title ?? thread.thread_id ?? "WorkThread",
    subtitle: `confidence ${thread.confidence ?? "unknown"}${thread.source_records.length ? ` · ${thread.source_records.length} evidence records` : ""}`,
    observed_at: thread.updated_at,
    importance: Math.max(0.6, Math.min(1, thread.confidence ?? 0.65)),
    event_ids: thread.view_id ? [thread.view_id] : undefined,
    record_ids: thread.source_records,
    stats: {
      thread_id: thread.thread_id,
      view_id: thread.view_id,
      next_actions: thread.next_actions,
      source_record_count: thread.source_records.length,
      evidence: thread.evidence,
    },
  };
}

function compactEvidenceForIds(store: ContextStore, ids: string[]): ProjectTimelineEvidence[] {
  const evidence: ProjectTimelineEvidence[] = [];
  for (const id of [...new Set(ids)].slice(0, 12)) {
    const record = store.getRecord(id);
    if (!record) {
      evidence.push(externalEvidenceForId(id));
      continue;
    }
    evidence.push({
      id: record.id,
      schema: record.schema.name,
      source: `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
      title: record.content?.title,
      url: record.content?.url,
      path: record.content?.path,
      observed_at: record.time?.observed_at ?? record.created_at,
      excerpt: excerpt(record.content?.text, 220),
    });
  }
  return evidence;
}

function projectRecordToItem(record: StoredContextRecord): ActivityTimelineItem {
  const feature = extractFeatures(record);
  return {
    id: `project-record:${record.id}`,
    kind: "activity",
    source: `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
    schema: record.schema.name,
    title: record.content?.title ?? record.content?.url ?? record.content?.path ?? record.schema.name,
    subtitle: feature.project ? `project: ${feature.project}` : feature.domain,
    url: record.content?.url,
    path: record.content?.path,
    app: feature.app,
    domain: feature.domain,
    project: feature.project,
    observed_at: record.time?.observed_at ?? record.created_at,
    importance: typeof record.signal?.importance === "number" ? record.signal.importance : 0.55,
    record_ids: [record.id],
  };
}

function bucketProjectItems(items: ActivityTimelineItem[], bucketMinutes: number): ActivityTimelineBucket[] {
  const byBucket = new Map<string, ActivityTimelineItem[]>();
  for (const item of items) {
    const label = bucketLabel(item.observed_at, bucketMinutes);
    byBucket.set(label, [...(byBucket.get(label) ?? []), item]);
  }
  return [...byBucket.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([label, bucketItems]) => {
    const startMs = Date.parse(label);
    const start = Number.isNaN(startMs) ? label : new Date(startMs).toISOString();
    const end = Number.isNaN(startMs) ? label : new Date(startMs + bucketMinutes * 60_000).toISOString();
    const sorted = bucketItems.sort((a, b) => b.importance - a.importance || Date.parse(b.observed_at) - Date.parse(a.observed_at));
    return {
      label,
      start,
      end,
      count: sorted.length,
      top_sources: top(sorted.map(item => item.source), 5),
      top_apps: top(sorted.map(item => item.app).filter(Boolean) as string[], 5),
      top_domains: top(sorted.map(item => item.domain).filter(Boolean) as string[], 5),
      top_projects: top(sorted.map(item => item.project).filter(Boolean) as string[], 5),
      summary: summarizeBucket(sorted),
      items: sorted.slice(0, 30),
    };
  });
}

function bucketLabel(iso: string, minutes: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const size = minutes * 60_000;
  return new Date(Math.floor(t / size) * size).toISOString();
}

function chooseBucketMinutes(minutes: number): number {
  if (minutes <= 120) return 10;
  if (minutes <= 8 * 60) return 30;
  return 60;
}

function summarizeProjectTimeline(items: ActivityTimelineItem[], workThreads: ProjectTimelineWorkThread[]) {
  return {
    top_sources: top(items.map(item => item.source), 8),
    top_apps: top(items.map(item => item.app).filter(Boolean) as string[], 8),
    top_domains: top(items.map(item => item.domain).filter(Boolean) as string[], 8),
    evidence_sources: top(workThreads.flatMap(thread => thread.evidence.map(item => item.source)), 8),
    top_work_threads: workThreads.slice(0, 8).map(thread => ({
      title: thread.title,
      confidence: thread.confidence,
      updated_at: thread.updated_at,
      evidence_count: thread.evidence.length,
      evidence_sources: top(thread.evidence.map(item => item.source), 4),
    })),
  };
}

function summarizeBucket(items: ActivityTimelineItem[]): string {
  const focus = top(items.map(item => item.project ?? item.domain ?? item.app ?? item.source).filter(Boolean) as string[], 1)[0] ?? "project activity";
  const titles = items.slice(0, 3).map(item => item.title);
  return `${items.length} project items around ${focus}${titles.length ? `: ${titles.join("; ")}` : ""}`;
}

function inferActiveProject(store: ContextStore): string | undefined {
  const state = store.getRuntimeState("active_work_thread_view")?.value;
  const viewId = typeof state?.view_id === "string" ? state.view_id : undefined;
  const view = viewId ? store.getView(viewId) : undefined;
  return view?.scope?.project ?? stringValue((view?.content?.current_status as Record<string, unknown> | undefined)?.project) ?? basename(process.cwd());
}

function normalizeProjectPath(path?: string): string | undefined {
  if (!path) return undefined;
  const expanded = path.startsWith("~/") ? `${process.env.HOME}/${path.slice(2)}` : path;
  if (!expanded.startsWith("/")) return undefined;
  const resolved = resolve(expanded.replace(/^file:\/\//, "").replace(/\/$/, ""));
  return existsSync(resolved) ? resolved : expanded.replace(/\/$/, "");
}

function top(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function externalEvidenceForId(id: string): ProjectTimelineEvidence {
  if (id.startsWith("screenpipe:")) return parseScreenpipeEvidence(id);
  if (id.startsWith("ai-session:")) {
    return { id, schema: "external.ai_session_ref", source: "external/ai_session", title: id };
  }
  return { id, schema: "external.ref", source: "external/missing", title: id };
}

function parseScreenpipeEvidence(id: string): ProjectTimelineEvidence {
  const withoutPrefix = id.replace(/^screenpipe:/, "");
  const timestampMatch = withoutPrefix.match(/(\d{4}-\d{2}-\d{2}T.+)$/);
  const timestamp = timestampMatch?.[1];
  const body = timestamp ? withoutPrefix.slice(0, -timestamp.length).replace(/:$/, "") : withoutPrefix;
  const title = body.startsWith("activity-window-")
    ? parseScreenpipeWindowTitle(body)
    : body.startsWith("activity-")
      ? body.replace(/^activity-/, "Screenpipe activity ")
      : `Screenpipe evidence: ${body}`;
  return {
    id,
    schema: body.startsWith("activity-window-") ? "external.screenpipe_activity_window" : "external.screenpipe_ref",
    source: "external/screenpipe",
    title,
    observed_at: timestamp && timestamp.includes("T") ? timestamp : undefined,
    excerpt: id,
  };
}

function parseScreenpipeWindowTitle(body: string): string {
  const cleaned = body.replace(/^activity-window-/, "");
  const parts = cleaned.split("-");
  const app = parts[1];
  const window = parts.slice(2).join("-").replace(/_/g, " ");
  if (app && window) return `Screenpipe window: ${app} — ${window}`;
  return `Screenpipe window: ${cleaned}`;
}

function excerpt(text: string | undefined, max: number): string | undefined {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "project";
}

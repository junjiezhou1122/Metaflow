import type { ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";

const TIMELINE_VIEW_TYPES = new Set(["timeline.activity", "timeline.observations"]);

export const dailySummaryProgram: Program = {
  id: "program.daily_summary",
  title: "Daily Summary",
  purpose: "Compress recent timeline Views and reusable project context into a daily summary View.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "suggest",
  capabilities: ["context.timeline.compress"],
  applications: ["daily.briefing", "agent.context_pack"],
  produces: ["summary.daily", "brief.tomorrow", "memory.routine_patterns"],
  learns_from: ["feedback.summary.useful", "feedback.summary.dismissed"],

  attention(signal: ContextSignal): AttentionDecision {
    if (signal.object_kind !== "view") return { action: "ignore", reason: "daily summary starts from timeline Views", confidence: 0.9 };
    if (!TIMELINE_VIEW_TYPES.has(signal.object_type)) return { action: "ignore", reason: "not a timeline View", confidence: 0.85 };
    return { action: "run", reason: `compress ${signal.object_type} into daily summary`, confidence: 0.9, speed: "background" };
  },

  run({ signal, store, buildContextPack }): ProgramRunResult {
    const timeline = store.getView(signal.object_id);
    if (!timeline) return { ok: false, reason: `timeline view not found: ${signal.object_id}` };

    const pack = buildContextPack({
      mode: "timeline",
      include_views: true,
      include_records: false,
      view_type_prefix: "project.",
      limit: 6,
    });
    const projectViews = pack.views.filter(view => view.view_type.startsWith("project."));
    const sourceRecords = sourceRecordsForViews(store, [timeline, ...projectViews]);
    const summary = buildDailySummaryView(timeline, projectViews, sourceRecords);
    const tomorrow = buildTomorrowBriefView(timeline, projectViews, summary, sourceRecords);
    const routineMemory = buildRoutinePatternsMemoryView(timeline, summary, sourceRecords);

    return {
      ok: true,
      reason: `compiled daily summary from ${timeline.view_type}`,
      views: [summary, tomorrow, routineMemory],
      diagnostics: {
        timeline_view_id: timeline.id,
        project_view_count: projectViews.length,
        source_record_count: sourceRecords.length,
        tomorrow_brief_view_id: tomorrow.id,
        routine_patterns_memory_view_id: routineMemory.id,
      },
    };
  },
};

function buildDailySummaryView(timeline: StoredContextView, projectViews: StoredContextView[], sourceRecords: StoredContextRecord[]): ContextView {
  const now = new Date().toISOString();
  const bucketCount = arrayValue(timeline.content?.buckets).length;
  const projectTitles = projectViews.map(view => view.title ?? view.id).slice(0, 5);
  const id = `summary:daily:${stableKey(`${timeline.id}:${now.slice(0, 10)}`)}`;
  return {
    id,
    view_type: "summary.daily",
    title: `Daily summary: ${now.slice(0, 10)}`,
    summary: `${bucketCount} timeline buckets compressed with ${projectViews.length} project context Views.`,
    status: "candidate",
    source_records: sourceRecords.map(record => record.id),
    source_views: [timeline.id, ...projectViews.map(view => view.id)],
    compiler: { id: "program.daily_summary", version: "0.1.0", mode: "deterministic" },
    purpose: "Reusable daily activity compression for applications and later Programs.",
    scope: {
      time_range: timeline.scope?.time_range ?? { end: now },
      plugin_id: "program.daily_summary",
    },
    content: {
      date: now.slice(0, 10),
      timeline_view_id: timeline.id,
      timeline_view_type: timeline.view_type,
      project_view_ids: projectViews.map(view => view.id),
      project_titles: projectTitles,
      timeline_signals: timeline.content?.signals,
      timeline_buckets: arrayValue(timeline.content?.buckets).slice(0, 12),
      project_contexts: projectViews.map(view => ({
        id: view.id,
        view_type: view.view_type,
        title: view.title,
        summary: view.summary,
      })),
    },
    confidence: Math.max(0.45, Math.min(0.9, timeline.confidence ?? 0.65)),
    stability: "session",
    lossiness: "medium",
    privacy: timeline.privacy,
    validity: { stale_after: new Date(Date.parse(now) + 36 * 60 * 60_000).toISOString() },
    metadata: { timeline_view_id: timeline.id, project_view_count: projectViews.length },
  };
}

function buildTomorrowBriefView(timeline: StoredContextView, projectViews: StoredContextView[], summary: ContextView, sourceRecords: StoredContextRecord[]): ContextView {
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const id = `brief:tomorrow:${stableKey(`${timeline.id}:${tomorrow}`)}`;
  return {
    id,
    view_type: "brief.tomorrow",
    title: `Tomorrow brief: ${tomorrow}`,
    summary: `Continuity brief for tomorrow from ${timeline.view_type}.`,
    status: "candidate",
    source_records: sourceRecords.map(record => record.id),
    source_views: [timeline.id, ...projectViews.map(view => view.id), summary.id!],
    compiler: { id: "program.daily_summary", version: "0.1.0", mode: "deterministic" },
    purpose: "Reusable tomorrow continuity brief derived from today's timeline and project context.",
    scope: {
      time_range: { start: now, end: new Date(Date.parse(now) + 36 * 60 * 60_000).toISOString() },
      plugin_id: "program.daily_summary",
    },
    content: {
      date: tomorrow,
      daily_summary_view_id: summary.id,
      timeline_view_id: timeline.id,
      project_view_ids: projectViews.map(view => view.id),
      continuity_contexts: projectViews.map(view => ({
        id: view.id,
        view_type: view.view_type,
        title: view.title,
        summary: view.summary,
      })),
      timeline_buckets: arrayValue(timeline.content?.buckets).slice(0, 6),
    },
    confidence: Math.max(0.4, Math.min(0.86, summary.confidence ?? timeline.confidence ?? 0.6)),
    stability: "session",
    lossiness: "medium",
    privacy: timeline.privacy,
    validity: { stale_after: new Date(Date.parse(now) + 36 * 60 * 60_000).toISOString() },
    metadata: { timeline_view_id: timeline.id, daily_summary_view_id: summary.id },
  };
}

function buildRoutinePatternsMemoryView(timeline: StoredContextView, summary: ContextView, sourceRecords: StoredContextRecord[]): ContextView {
  const now = new Date().toISOString();
  const signals = objectValue(timeline.content?.signals);
  const id = `memory:routine-patterns:${stableKey(`${timeline.id}:${now.slice(0, 10)}`)}`;
  return {
    id,
    view_type: "memory.routine_patterns",
    title: `Routine patterns: ${now.slice(0, 10)}`,
    summary: "Reusable routine pattern memory derived from daily timeline signals.",
    status: "candidate",
    source_records: sourceRecords.map(record => record.id),
    source_views: [timeline.id, summary.id!],
    compiler: { id: "program.daily_summary", version: "0.1.0", mode: "deterministic" },
    purpose: "Memory View that helps future summaries and ambient Programs understand recurring daily patterns.",
    scope: {
      time_range: timeline.scope?.time_range ?? { end: now },
      plugin_id: "program.daily_summary",
    },
    content: {
      date: now.slice(0, 10),
      daily_summary_view_id: summary.id,
      timeline_view_id: timeline.id,
      top_sources: arrayOfStrings(signals?.top_sources),
      top_projects: arrayOfStrings(signals?.top_projects),
      bucket_count: arrayValue(timeline.content?.buckets).length,
    },
    confidence: Math.max(0.35, Math.min(0.8, summary.confidence ?? timeline.confidence ?? 0.55)),
    stability: "long_term",
    lossiness: "high",
    privacy: timeline.privacy,
    metadata: { timeline_view_id: timeline.id, daily_summary_view_id: summary.id },
  };
}

function sourceRecordsForViews(store: { getRecord(id: string): StoredContextRecord | undefined }, views: StoredContextView[]): StoredContextRecord[] {
  const records = new Map<string, StoredContextRecord>();
  for (const view of views) {
    for (const id of view.source_records ?? []) {
      const record = store.getRecord(id);
      if (record) records.set(record.id, record);
    }
  }
  return [...records.values()];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

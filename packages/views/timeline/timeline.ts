import { ContextStore } from "@info/core";
import type { ContextView, StoredContextRecord, StoredContextView } from "@info/core";

export type CompileObservationTimelineOptions = {
  minutes?: number;
  limit?: number;
  write?: boolean;
  title?: string;
  records?: StoredContextRecord[];
  pluginId?: string;
};

export type CompileObservationTimelineResult = {
  ok: boolean;
  view: StoredContextView | ContextView;
  records_used: number;
  buckets: Array<{ label: string; count: number; top_sources: string[]; top_schemas: string[]; sample_titles: string[] }>;
};

export function compileObservationTimeline(options: CompileObservationTimelineOptions = {}, store = new ContextStore()): CompileObservationTimelineResult {
  const minutes = options.minutes ?? 24 * 60;
  const limit = options.limit ?? 200;
  const generatedAt = new Date().toISOString();
  const candidateLimit = options.records ? limit : Math.max(limit * 3, limit + 50);
  const records = (options.records ?? store.recent(candidateLimit, undefined, { minutes })).filter(isRawObservationRecord).slice(0, limit);
  const buckets = bucketRecords(records);
  const view: ContextView = {
    id: `view:timeline:observations:${timelineKey(generatedAt, minutes)}`,
    view_type: "timeline.observations",
    title: options.title ?? `Observation timeline (${minutes}m)`,
    summary: `${records.length} observations across ${buckets.length} time buckets.`,
    status: "candidate",
    source_records: records.map(r => r.id),
    compiler: { id: "observation-timeline", version: "1", mode: "deterministic" },
    purpose: "Navigable timeline view over raw ContextRecord observations.",
    scope: { time_range: { start: new Date(Date.now() - minutes * 60_000).toISOString(), end: generatedAt }, plugin_id: options.pluginId },
    content: { minutes, buckets, records: records.map(compactRecord) },
    confidence: 0.95,
    stability: minutes <= 180 ? "session" : "project",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: false, allow_external_llm: false, allow_external_reader: false },
    metadata: { generated_at: generatedAt, record_count: records.length },
  };
  const shouldWrite = options.write ?? true;
  const stored = shouldWrite ? store.upsertView(view) : view;
  if (shouldWrite) {
    store.appendRuntimeEvent({
      event_type: "timeline_view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: stored.id,
      plugin_id: options.pluginId,
      related_records: records.map(r => r.id),
      payload: { minutes, records_used: records.length, bucket_count: buckets.length },
    });
  }
  return { ok: true, view: stored, records_used: records.length, buckets };
}

function isRawObservationRecord(record: StoredContextRecord): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (record.privacy?.retention === "do_not_store") return false;
  return true;
}

function bucketRecords(records: StoredContextRecord[]) {
  const byHour = new Map<string, StoredContextRecord[]>();
  for (const record of records) {
    const date = new Date(record.time?.observed_at ?? record.created_at);
    const label = Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 13) + ":00";
    byHour.set(label, [...(byHour.get(label) ?? []), record]);
  }
  return [...byHour.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([label, items]) => ({
    label,
    count: items.length,
    top_sources: top(items.map(r => r.source.type), 5),
    top_schemas: top(items.map(r => r.schema.name), 5),
    sample_titles: items.slice(0, 5).map(r => r.content?.title ?? r.schema.name),
  }));
}

function compactRecord(record: StoredContextRecord) {
  return {
    id: record.id,
    schema: record.schema.name,
    source: record.source.type,
    connector: record.source.connector,
    title: record.content?.title,
    url: record.content?.url,
    path: record.content?.path,
    observed_at: record.time?.observed_at ?? record.created_at,
  };
}

function top(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}

function timelineKey(iso: string, minutes: number): string {
  return `${minutes}m:${iso.slice(0, 13)}`;
}

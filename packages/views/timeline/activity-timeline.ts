import { ContextStore } from "@info/core";
import { filterEventsForPlugin } from "@info/core";
import type { ContextView, RuntimeEvent, StoredContextRecord, StoredContextView, StoredRuntimeEvent } from "@info/core";
import { screenNoiseLevel } from "./screen-noise.js";

export const ACTIVITY_TIMELINE_COMPILER_ID = "builtin.activity-timeline";

export type CompileActivityTimelineOptions = {
  minutes?: number;
  limit?: number;
  eventLimit?: number;
  bucketMinutes?: number;
  write?: boolean;
  title?: string;
  includeRuntimeEvents?: boolean;
  includeLowLevelScreenpipe?: boolean;
  dedupe?: boolean;
  bucketItemLimit?: number | false;
  summarizeHeartbeats?: boolean;
  sourceFilter?: "screenpipe" | "browser" | "runtime" | "all";
  mergeContinuous?: boolean;
  mergeGapMinutes?: number;
  records?: StoredContextRecord[];
  runtimeEvents?: StoredRuntimeEvent[];
  pluginId?: string;
};

export type ActivityTimelineItem = {
  id: string;
  kind: "activity" | "activity_episode" | "heartbeat_summary" | "runtime_event";
  source: string;
  schema?: string;
  event_type?: string;
  title: string;
  subtitle?: string;
  url?: string;
  path?: string;
  app?: string;
  domain?: string;
  project?: string;
  text?: string;
  observed_at: string;
  importance: number;
  record_ids?: string[];
  event_ids?: string[];
  stats?: Record<string, unknown>;
};

export type ActivityTimelineBucket = {
  label: string;
  start: string;
  end: string;
  count: number;
  top_sources: string[];
  top_apps: string[];
  top_domains: string[];
  top_projects: string[];
  summary: string;
  items: ActivityTimelineItem[];
};

export type CompileActivityTimelineResult = {
  ok: true;
  compiler_id: string;
  view: ContextView | StoredContextView;
  records_used: number;
  events_used: number;
  buckets: ActivityTimelineBucket[];
};

export function compileActivityTimeline(options: CompileActivityTimelineOptions = {}, store = new ContextStore()): CompileActivityTimelineResult {
  const generatedAt = new Date().toISOString();
  const minutes = options.minutes ?? 24 * 60;
  const limit = options.limit ?? 300;
  const bucketMinutes = options.bucketMinutes ?? chooseBucketMinutes(minutes);
  const range = { start: new Date(Date.parse(generatedAt) - minutes * 60_000).toISOString(), end: generatedAt };
  const candidateLimit = options.records ? limit : Math.max(limit * 3, limit + 50);
  const sourceFilter = options.sourceFilter ?? "all";
  const candidates = options.records ?? (sourceFilter === "all"
    ? store.recent(candidateLimit, undefined, { minutes })
    : store.recentBySourceFilter(sourceFilter, candidateLimit, undefined, { minutes }));
  const records = candidates.filter(record => isRawActivityRecord(record, options)).slice(0, limit);
  const rawRuntimeEvents = options.runtimeEvents ?? store.listRuntimeEvents({ limit: Math.max((options.eventLimit ?? 80) * 3, options.eventLimit ?? 80), timeWindow: { minutes } });
  const runtimeEvents = options.includeRuntimeEvents === false
    ? []
    : filterEventsForPlugin(rawRuntimeEvents, store)
      .filter(isTimelineRuntimeEvent)
      .slice(0, options.eventLimit ?? 80);
  const items = buildTimelineItems(records, runtimeEvents, options);
  const buckets = bucketItems(items, bucketMinutes, options);
  const view: ContextView = {
    id: `view:timeline:activity:${minutes}m:${generatedAt.slice(0, 13)}`,
    view_type: "timeline.activity",
    title: options.title ?? `Activity timeline (${minutes}m)`,
    summary: `${items.length} activity items from ${records.length} records and ${runtimeEvents.length} runtime events across ${buckets.length} buckets.`,
    status: "candidate",
    source_records: records.map(record => record.id),
    compiler: { id: ACTIVITY_TIMELINE_COMPILER_ID, version: "1", mode: "deterministic" },
    purpose: "UI-friendly all-sensor activity timeline over browser, Screenpipe, local project, AI-session, and runtime event evidence.",
    scope: { time_range: range, plugin_id: options.pluginId ?? ACTIVITY_TIMELINE_COMPILER_ID },
    content: {
      minutes,
      bucket_minutes: bucketMinutes,
      buckets,
      items: items.slice(0, 500),
      signals: summarizeItems(items),
    },
    confidence: 0.9,
    stability: minutes <= 240 ? "session" : "project",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    metadata: { generated_at: generatedAt, record_count: records.length, runtime_event_count: runtimeEvents.length, item_count: items.length },
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
      plugin_id: options.pluginId ?? ACTIVITY_TIMELINE_COMPILER_ID,
      related_records: stored.source_records,
      related_views: stored.source_views,
      payload: { view_type: stored.view_type, records_used: records.length, events_used: runtimeEvents.length, bucket_count: buckets.length, item_count: items.length },
    });
  }
  return { ok: true, compiler_id: ACTIVITY_TIMELINE_COMPILER_ID, view: stored, records_used: records.length, events_used: runtimeEvents.length, buckets };
}

function isRawActivityRecord(record: StoredContextRecord, options: CompileActivityTimelineOptions = {}): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (!recordMatchesSourceFilter(record, options.sourceFilter)) return false;
  if (isScreenpipeTimelineEcho(record)) return false;
  if (!options.includeLowLevelScreenpipe && isDefaultActivityNoise(record)) return false;
  if (!options.includeLowLevelScreenpipe && record.schema.name === "observation.screenpipe_workspace_signal") return false;
  if (!options.includeLowLevelScreenpipe && record.schema.name === "observation.screenpipe_input_event") return false;
  if (record.privacy?.retention === "do_not_store") return false;
  return true;
}

function recordMatchesSourceFilter(record: StoredContextRecord, filter: CompileActivityTimelineOptions["sourceFilter"]): boolean {
  if (!filter || filter === "all") return true;
  const hay = `${record.source.type} ${record.source.connector ?? ""} ${record.schema.name}`.toLowerCase();
  return hay.includes(filter);
}

function isDefaultActivityNoise(record: StoredContextRecord): boolean {
  if (isInfoTimelineSelfObservation(record)) return true;
  if (isScreenpipeRecorderRecord(record)) return true;
  return false;
}

function isScreenpipeRecorderRecord(record: StoredContextRecord): boolean {
  if (record.source.type !== "screenpipe") return false;
  const app = (appOf(record) ?? "").toLowerCase();
  if (!["terminal", "warp", "iterm", "iterm2"].some(termApp => app.includes(termApp))) return false;
  const text = recordSearchText(record);
  const mentionsScreenpipeRecord = text.includes("screenpipe") && text.includes("record");
  const looksLikeCliProcess = text.includes("npm exec")
    || text.includes("screenpipe@")
    || text.includes("screenpipe record")
    || text.includes("cli-darwin")
    || text.includes("screenpipe ◂");
  return mentionsScreenpipeRecord && looksLikeCliProcess;
}

function isInfoTimelineSelfObservation(record: StoredContextRecord): boolean {
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  if (url) {
    try {
      const parsed = new URL(url);
      if (["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "5177") return true;
    } catch {
      // Fall through to text-based self-observation detection.
    }
  }
  const text = recordSearchText(record);
  const mentionsInfoTimeline = text.includes("info / screenpipe")
    || text.includes("info runtime")
    || text.includes("local runtime")
    || text.includes("live sync")
    || text.includes("activity episodes")
    || text.includes("evidence debug");
  const looksLikeOurTimeline = text.includes("timeline") && text.includes("screenpipe") && text.includes("focus");
  return mentionsInfoTimeline || looksLikeOurTimeline;
}

function recordSearchText(record: StoredContextRecord): string {
  return [
    record.content?.title,
    record.content?.text,
    record.content?.url,
    record.content?.path,
    record.scope?.app,
    record.scope?.domain,
    stringValue(record.payload?.app_name),
    stringValue(record.payload?.window_name),
    stringValue(record.payload?.browser_url),
    stringValue(record.payload?.text),
  ].filter(Boolean).join("\n").toLowerCase();
}

function isScreenpipeTimelineEcho(record: StoredContextRecord): boolean {
  if (record.schema.name !== "observation.screenpipe_workspace_signal") return false;
  if (record.payload?.content_type !== "frame_context") return false;
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${stringValue(record.payload?.text) ?? ""}`.toLowerCase();
  if (!text) return false;

  const showsTimelineChrome = text.includes("timeline") && text.includes("live sync");
  const showsFrameEvidence = text.includes("screenpipe frame context") || text.includes("content_type: frame_context");
  const showsWorkspaceSchema = text.includes("observation.screenpipe_workspace");
  return showsTimelineChrome && showsFrameEvidence && showsWorkspaceSchema;
}

function buildTimelineItems(records: StoredContextRecord[], runtimeEvents: StoredRuntimeEvent[], options: CompileActivityTimelineOptions = {}): ActivityTimelineItem[] {
  return buildRawTimelineItems(records, runtimeEvents, options);
}

function buildRawTimelineItems(records: StoredContextRecord[], runtimeEvents: StoredRuntimeEvent[], options: CompileActivityTimelineOptions = {}): ActivityTimelineItem[] {
  const items: ActivityTimelineItem[] = [];
  const heartbeatGroups = new Map<string, StoredContextRecord[]>();

  for (const record of records) {
    if (isHeartbeat(record) && options.summarizeHeartbeats !== false) {
      const key = `${bucketLabel(recordTime(record), 5)}|${record.content?.url ?? record.content?.title ?? record.scope?.app ?? "unknown"}`;
      heartbeatGroups.set(key, [...(heartbeatGroups.get(key) ?? []), record]);
      continue;
    }
    items.push(recordToItem(record));
  }

  for (const group of heartbeatGroups.values()) {
    const sorted = group.sort((a, b) => Date.parse(recordTime(a)) - Date.parse(recordTime(b)));
    const first = sorted[0];
    const last = sorted.at(-1) ?? first;
    const maxDwell = maxNumber(sorted.map(record => record.payload?.dwell_seconds));
    const maxScroll = maxNumber(sorted.map(record => record.payload?.scroll_depth));
    items.push({
      id: `heartbeat:${first.id}:${last.id}`,
      kind: "heartbeat_summary",
      source: sourceLabel(first),
      schema: first.schema.name,
      title: first.content?.title ?? first.content?.url ?? "Active page heartbeat",
      subtitle: `${sorted.length} heartbeat samples${maxDwell ? `, dwell ${Math.round(maxDwell)}s` : ""}${maxScroll ? `, scroll ${Math.round(maxScroll * 100)}%` : ""}`,
      url: first.content?.url,
      app: appOf(first),
      domain: domainOf(first),
      project: projectOf(first),
      observed_at: recordTime(last),
      importance: 0.25,
      record_ids: sorted.map(record => record.id),
      stats: { samples: sorted.length, dwell_seconds: maxDwell, scroll_depth: maxScroll },
    });
  }

  for (const event of runtimeEvents) items.push(runtimeEventToItem(event));

  const maybeMerged = options.mergeContinuous ? mergeContinuousItems(items, options.mergeGapMinutes ?? 3) : items;
  const sorted = maybeMerged.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  if (options.dedupe === false) return sorted;
  return sorted.filter((item, index, all) => index === all.findIndex(other => dedupeKey(other) === dedupeKey(item)));
}

function mergeContinuousItems(items: ActivityTimelineItem[], gapMinutes: number): ActivityTimelineItem[] {
  const sorted = [...items].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const out: ActivityTimelineItem[] = [];
  const active = new Map<string, { items: ActivityTimelineItem[]; lastAt: number }>();

  const flushKey = (key: string) => {
    const group = active.get(key);
    if (!group) return;
    out.push(group.items.length === 1 ? group.items[0] : continuousGroupToItem(group.items));
    active.delete(key);
  };

  const flushExpired = (nowMs: number) => {
    for (const [key, group] of active.entries()) {
      if (Number.isFinite(nowMs) && Number.isFinite(group.lastAt) && nowMs - group.lastAt <= gapMinutes * 60_000) continue;
      flushKey(key);
    }
  };

  for (const item of sorted) {
    const itemAt = Date.parse(item.observed_at);
    flushExpired(itemAt);
    const key = continuousMergeKey(item);
    if (!key) {
      out.push(item);
      continue;
    }
    const existing = active.get(key);
    if (!existing) active.set(key, { items: [item], lastAt: itemAt });
    else active.set(key, { items: [...existing.items, item], lastAt: itemAt });
  }
  for (const key of [...active.keys()]) flushKey(key);
  return out;
}

function continuousMergeKey(item: ActivityTimelineItem): string | undefined {
  if (item.schema === "observation.browser_page_heartbeat") {
    return `browser:${item.url ?? item.domain ?? item.title}`;
  }
  if (item.schema === "observation.screenpipe_activity_summary") {
    const windowName = stringStatFromItem(item, "window_name") ?? stringStatFromItem(item, "window_title") ?? "";
    const reportedUrl = stringStatFromItem(item, "browser_url") ?? stringStatFromItem(item, "reported_url") ?? item.url ?? "";
    return `screenpipe-summary:${item.app ?? ""}:${windowName}:${reportedUrl}`;
  }
  return undefined;
}

function continuousGroupToItem(group: ActivityTimelineItem[]): ActivityTimelineItem {
  const sorted = [...group].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const first = sorted[0];
  const last = sorted.at(-1) ?? first;
  const start = first.observed_at;
  const end = last.observed_at;
  const duration = durationMinutes(start, end);
  const recordIds = sorted.flatMap(item => item.record_ids ?? []);
  const eventIds = sorted.flatMap(item => item.event_ids ?? []);
  const frameIds = uniqueItemFrameIds(sorted);
  const stats = {
    ...(last.stats ?? {}),
    merged_continuous: true,
    samples: sorted.length,
    start,
    end,
    duration_minutes: duration,
    frame_ids: frameIds.length ? frameIds : undefined,
    frame_id: frameIds[0] ?? last.stats?.frame_id,
  };
  return {
    ...last,
    id: `continuous:${hashKey(`${continuousMergeKey(last)}|${start}|${end}|${recordIds.join("|")}`)}`,
    subtitle: `${last.subtitle ?? sourceLabelFromItem(last)} · ${formatRangeShort(start, end)}${duration ? ` · ${formatMinutes(duration)}` : ""} · ${sorted.length} samples`,
    observed_at: end,
    record_ids: recordIds.length ? recordIds : last.record_ids,
    event_ids: eventIds.length ? eventIds : last.event_ids,
    stats,
  };
}

function recordToItem(record: StoredContextRecord): ActivityTimelineItem {
  const source = sourceLabel(record);
  const title = titleForRecord(record);
  const subtitle = subtitleForRecord(record);
  const stats = recordStats(record);
  return {
    id: `record:${record.id}`,
    kind: "activity",
    source,
    schema: record.schema.name,
    title,
    subtitle,
    url: record.content?.url,
    path: record.content?.path,
    app: appOf(record),
    domain: domainOf(record),
    project: projectOf(record),
    text: textOf(record),
    observed_at: recordTime(record),
    importance: importanceOf(record),
    record_ids: [record.id],
    stats,
  };
}

function runtimeEventToItem(event: StoredRuntimeEvent): ActivityTimelineItem {
  return {
    id: `event:${event.id}`,
    kind: "runtime_event",
    source: "runtime",
    event_type: event.event_type,
    title: eventTitle(event),
    subtitle: event.plugin_id ? `plugin: ${event.plugin_id}` : event.subject_type ? `subject: ${event.subject_type}` : undefined,
    observed_at: event.created_at,
    importance: event.event_type.includes("failed") ? 0.9 : event.event_type.includes("view") || event.event_type.includes("trigger") ? 0.45 : 0.35,
    event_ids: [event.id],
    stats: compactPayload(event.payload),
  };
}

function bucketItems(items: ActivityTimelineItem[], bucketMinutes: number, options: CompileActivityTimelineOptions = {}): ActivityTimelineBucket[] {
  const byBucket = new Map<string, ActivityTimelineItem[]>();
  const itemLimit = options.bucketItemLimit ?? 30;
  for (const item of items) {
    const label = bucketLabel(item.observed_at, bucketMinutes);
    byBucket.set(label, [...(byBucket.get(label) ?? []), item]);
  }
  return [...byBucket.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([label, bucketItems]) => {
    const startMs = Date.parse(label);
    const start = Number.isNaN(startMs) ? label : new Date(startMs).toISOString();
    const end = Number.isNaN(startMs) ? label : new Date(startMs + bucketMinutes * 60_000).toISOString();
    const sorted = bucketItems.sort((a, b) => b.importance - a.importance || Date.parse(b.observed_at) - Date.parse(a.observed_at));
    const top_sources = top(sorted.map(item => item.source), 5);
    const top_apps = top(sorted.map(item => item.app).filter(Boolean) as string[], 5);
    const top_domains = top(sorted.map(item => item.domain).filter(Boolean) as string[], 5);
    const top_projects = top(sorted.map(item => item.project).filter(Boolean) as string[], 5);
    return {
      label,
      start,
      end,
      count: sorted.length,
      top_sources,
      top_apps,
      top_domains,
      top_projects,
      summary: summarizeBucket(sorted, top_sources, top_apps, top_projects, top_domains),
      items: itemLimit === false ? sorted : sorted.slice(0, itemLimit),
    };
  });
}

function summarizeItems(items: ActivityTimelineItem[]) {
  return {
    top_sources: top(items.map(item => item.source), 10),
    top_apps: top(items.map(item => item.app).filter(Boolean) as string[], 10),
    top_domains: top(items.map(item => item.domain).filter(Boolean) as string[], 10),
    top_projects: top(items.map(item => item.project).filter(Boolean) as string[], 10),
    item_kinds: top(items.map(item => item.kind), 10),
  };
}

function summarizeBucket(items: ActivityTimelineItem[], sources: string[], apps: string[], projects: string[], domains: string[]): string {
  const focus = projects[0] ?? domains[0] ?? apps[0] ?? sources[0] ?? "activity";
  const important = items.slice(0, 3).map(item => item.title).filter(Boolean);
  return `${items.length} items around ${focus}${important.length ? `: ${important.join("; ")}` : ""}`;
}

function subtitleForRecord(record: StoredContextRecord): string | undefined {
  if (record.schema.name === "observation.local_project") return `project: ${projectOf(record) ?? record.content?.path ?? "unknown"}`;
  if (record.schema.name === "observation.screenpipe_workspace_signal" && record.payload?.content_type === "frame_context") {
    return `Screenpipe frame${domainOf(record) ? ` · ${domainOf(record)}` : ""}`;
  }
  if (record.schema.name === "observation.screenpipe_workspace_signal" && record.payload?.content_type === "element") {
    return `Screenpipe UI element${record.payload?.role ? ` · ${String(record.payload.role)}` : ""}`;
  }
  if (record.schema.name === "observation.screenpipe_activity_summary") {
    const minutes = Number(record.payload?.minutes);
    return `${appOf(record) ?? "screen"}${Number.isFinite(minutes) ? ` · ${formatMinutes(minutes)}` : ""}`;
  }
  if (record.schema.name === "observation.screenpipe_activity" && stringValue(record.payload?.content_type)?.toLowerCase() === "ocr") {
    const parts = attributionParts(record);
    if (parts.length) return parts.join(" · ");
    return "OCR";
  }
  if (record.schema.name.includes("screenpipe")) return `${appOf(record) ?? "screen"}${record.payload?.window_name ? ` · ${normalizeWindowTitle(String(record.payload.window_name))}` : ""}`;
  if (record.schema.name.includes("ai_session")) return `AI session${projectOf(record) ? ` · ${projectOf(record)}` : ""}`;
  if (record.content?.url) return domainOf(record);
  return undefined;
}

function textOf(record: StoredContextRecord): string | undefined {
  const text = stringValue(record.content?.text) ?? stringValue(record.payload?.text);
  if (!text) return undefined;
  return text.replace(/\s+/g, " ").trim().slice(0, 800) || undefined;
}

function recordStats(record: StoredContextRecord): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of ["content_type", "app_name", "window_name", "browser_url", "minutes", "frame_count", "frame_id", "frame_ids", "role", "text_source", "node_count", "event_type", "capture_trigger"] as const) {
    if (record.payload?.[key] !== undefined && record.payload?.[key] !== "") out[key] = record.payload[key];
  }
  for (const [key, value] of Object.entries(attributionStats(record))) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  if (record.scope?.project_path) out.project_path = record.scope.project_path;
  if (record.scope?.repo) out.repo = record.scope.repo;
  return Object.keys(out).length ? out : undefined;
}

function titleForRecord(record: StoredContextRecord): string {
  if (record.schema.name === "observation.screenpipe_workspace_signal" && record.payload?.content_type === "frame_context") {
    const url = record.content?.url ?? stringValue(record.payload?.browser_url);
    return url ? `Web frame: ${readableUrl(url)}` : record.content?.title ?? "Screenpipe frame context";
  }
  if (record.schema.name === "observation.screenpipe_workspace_signal" && record.payload?.content_type === "element") {
    const role = stringValue(record.payload?.role) ?? "element";
    const text = textOf(record) ?? record.content?.title ?? "Screenpipe UI element";
    return `UI ${role}: ${stripRolePrefix(text, role)}`;
  }
  if (record.schema.name === "observation.screenpipe_activity_summary") {
    const app = appOf(record);
    const windowTitle = normalizeWindowTitle(stringValue(record.payload?.window_name));
    return [app, windowTitle].filter(Boolean).join(" - ") || record.content?.title || "Screen activity";
  }
  if (record.schema.name === "observation.screenpipe_activity" && stringValue(record.payload?.content_type)?.toLowerCase() === "ocr") {
    return "Screen OCR";
  }
  return record.content?.title ?? record.content?.url ?? record.content?.path ?? record.schema.name;
}

function attributionParts(record: StoredContextRecord): string[] {
  const attribution = attributionStats(record);
  return [
    attribution.interaction_app ? `interaction: ${attribution.interaction_app}` : undefined,
    attribution.reported_app ? `reported: ${attribution.reported_app}` : undefined,
    attribution.visible_label ? `visible: ${attribution.visible_label}` : attribution.visual_domain ? `visible: ${attribution.visual_domain}` : undefined,
    attribution.window_title ? `window: ${attribution.window_title}` : undefined,
  ].filter((part): part is string => Boolean(part));
}

function attributionStats(record: StoredContextRecord): Record<string, string> {
  const stats: Record<string, string> = {};
  const app = appOf(record);
  const windowTitle = normalizeWindowTitle(stringValue(record.payload?.window_name));
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  const contentType = stringValue(record.payload?.content_type)?.toLowerCase();
  if (record.schema.name === "observation.screenpipe_input_event") {
    if (app) stats.interaction_app = app;
    const rawResult = record.payload?.raw_result as Record<string, unknown> | undefined;
    const rawContent = rawResult?.content as Record<string, unknown> | undefined;
    const eventType = stringValue(record.payload?.event_type) ?? stringValue(rawResult?.event_type) ?? stringValue(rawContent?.event_type);
    if (eventType) stats.interaction_event = eventType;
    const elementRole = stringValue(rawContent?.element_role);
    const elementName = stringValue(rawContent?.element_name);
    if (elementRole) stats.interaction_element_role = elementRole;
    if (elementName) stats.interaction_element_name = elementName;
    if (windowTitle) stats.window_title = windowTitle;
    if (url) stats.interaction_url = url;
    stats.attribution_source = "ui_events";
    return stats;
  }

  if (record.schema.name.includes("screenpipe")) {
    if (app) stats.reported_app = app;
    if (windowTitle) stats.window_title = windowTitle;
    if (url) stats.reported_url = url;
    if (contentType) stats.reported_content_type = contentType;
    stats.attribution_source = "screenpipe_frame";
  }

  const visualDomain = url ? domainOf(record) : inferredDomainFromText(recordSearchText(record));
  const visualLabel = inferredVisualContext(record);
  if (visualDomain) stats.visual_domain = visualDomain;
  if (visualLabel) stats.visible_label = visualLabel;
  return stats;
}

function inferredVisualContext(record: StoredContextRecord): string | undefined {
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${stringValue(record.payload?.text) ?? ""}`;
  const domain = record.content?.url ? domainOf(record) : inferredDomainFromText(text);
  if (domain) return readableDomainLabel(domain);
  if (/抖音|douyin/i.test(text)) return "抖音";
  if (/chatgpt/i.test(text)) return "ChatGPT";
  return undefined;
}

function inferredDomainFromText(text: string): string | undefined {
  const matches = text.match(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\s/?#:&|)]|$)/gi) ?? [];
  const allowedTlds = new Set(["com", "cn", "net", "org", "ai", "io", "dev", "app", "co", "xyz", "edu", "gov", "me", "tv"]);
  const ignored = new Set(["screenpi.pe"]);
  for (const match of matches) {
    const host = match.replace(/^https?:\/\//i, "").toLowerCase();
    if (ignored.has(host)) continue;
    const tld = host.split(".").at(-1);
    if (!tld || !allowedTlds.has(tld)) continue;
    return host;
  }
  return undefined;
}

function readableDomainLabel(domain: string): string {
  const host = domain.replace(/^www\./, "");
  if (host === "douyin.com") return "抖音";
  if (host === "chatgpt.com") return "ChatGPT";
  return host;
}

function readableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/\/$/, "");
    return `${parsed.hostname}${path && path !== "/" ? path.slice(0, 80) : ""}`;
  } catch {
    return url.slice(0, 120);
  }
}

function stripRolePrefix(text: string, role: string): string {
  return text.replace(new RegExp(`^${escapeRegExp(role)}:\\s*`, "i"), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWindowTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const normalized = title
    .replace(/^[\s⠁-⣿⣀-⣿◐◓◑◒|/\\\-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || title.trim() || undefined;
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function eventTitle(event: RuntimeEvent): string {
  const title = typeof event.payload?.title === "string" ? event.payload.title : undefined;
  const viewType = typeof event.payload?.view_type === "string" ? event.payload.view_type : undefined;
  return title ?? (viewType ? `${event.event_type}: ${viewType}` : event.event_type);
}

function importanceOf(record: StoredContextRecord): number {
  if (typeof record.signal?.importance === "number") return record.signal.importance;
  const noise = screenNoiseLevel(record);
  if (noise === "high") return 0.05;
  if (noise === "low") return 0.18;
  if (record.acquisition?.mode === "manual") return 0.9;
  if (record.schema.name === "observation.local_project") return 0.85;
  if (record.schema.name.includes("ai_session")) return 0.8;
  if (record.schema.name.includes("screenpipe_workspace")) return 0.65;
  if (record.schema.name.includes("snapshot")) return 0.55;
  if (record.schema.name.includes("visit")) return 0.45;
  return 0.4;
}

function isHeartbeat(record: StoredContextRecord): boolean {
  return record.schema.name === "observation.browser_page_heartbeat";
}

function recordTime(record: StoredContextRecord): string {
  return record.time?.observed_at ?? record.created_at;
}

function sourceLabel(record: StoredContextRecord): string {
  return `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`;
}

function appOf(record: StoredContextRecord): string | undefined {
  return record.scope?.app ?? stringValue(record.payload?.app_name) ?? stringValue(record.payload?.app);
}

function projectOf(record: StoredContextRecord): string | undefined {
  return record.scope?.project ?? stringValue(record.payload?.project) ?? basename(stringValue(record.payload?.root) ?? record.scope?.project_path ?? record.content?.path);
}

function domainOf(record: StoredContextRecord): string | undefined {
  if (record.scope?.domain) return record.scope.domain;
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
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

function top(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}

function maxNumber(values: unknown[]): number | undefined {
  const nums = values.map(value => Number(value)).filter(value => Number.isFinite(value));
  return nums.length ? Math.max(...nums) : undefined;
}

function uniqueFrameIds(records: StoredContextRecord[]): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const id of frameIdsOfRecord(record)) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

function uniqueItemFrameIds(items: ActivityTimelineItem[]): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const raw = item.stats?.frame_ids;
    if (Array.isArray(raw)) {
      for (const id of raw) {
        if (typeof id !== "string" && typeof id !== "number") continue;
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
      }
    }
    const single = item.stats?.frame_id;
    if (typeof single === "string" || typeof single === "number") {
      const key = String(single);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(single);
    }
  }
  return out;
}

function frameIdsOfRecord(record: StoredContextRecord): Array<string | number> {
  const ids = record.payload?.frame_ids;
  const out: Array<string | number> = [];
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id === "string" || typeof id === "number") out.push(id);
    }
  }
  const single = record.payload?.frame_id;
  if (typeof single === "string" || typeof single === "number") out.push(single);
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringStatFromItem(item: ActivityTimelineItem, key: string): string | undefined {
  return stringValue(item.stats?.[key]);
}

function sourceLabelFromItem(item: ActivityTimelineItem): string {
  return [item.schema, item.event_type, item.app, item.domain].filter(Boolean).join(" · ") || item.source;
}

function durationMinutes(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  return (endMs - startMs) / 60_000;
}

function formatRangeShort(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return "continuous";
  const fmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${fmt.format(startDate)}-${fmt.format(endDate)}`;
}

function basename(path?: string): string | undefined {
  if (!path) return undefined;
  return path.split(/[\\/]/).filter(Boolean).at(-1);
}

function compactPayload(payload?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["view_type", "records_used", "events_used", "bucket_count", "item_count", "trigger_id", "action", "error"] as const) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function dedupeKey(item: ActivityTimelineItem): string {
  if (item.kind === "activity_episode") return item.id;
  if (item.kind === "heartbeat_summary") return item.id;
  if (item.kind === "activity" && item.url) return `${item.kind}|url:${normalizeUrl(item.url)}|${bucketLabel(item.observed_at, 5)}`;
  if (item.kind === "runtime_event") return `${item.kind}|${item.event_type ?? ""}|${item.title}|${bucketLabel(item.observed_at, 5)}`;
  return `${item.kind}|${item.schema ?? item.event_type ?? ""}|${item.title}|${item.url ?? item.path ?? ""}|${bucketLabel(item.observed_at, 5)}`;
}

function hashKey(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function isTimelineRuntimeEvent(event: StoredRuntimeEvent): boolean {
  if (event.status === "failed" || event.event_type.includes("failed")) return true;
  return [
    "trigger_matched",
    "view_compiled",
    "plugin_run_started",
    "plugin_run_completed",
    "pipeline_tick_completed",
    "timeline_view_compiled",
    "context_query_completed",
  ].includes(event.event_type);
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/#.*$/, "").replace(/\/$/, "");
  }
}

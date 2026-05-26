import { createHash } from "node:crypto";
import { basename } from "node:path";
import { ContextStore } from "../core/store.js";
import type { ContextView, StoredContextRecord, StoredContextView } from "../core/types.js";

export const EVIDENCE_VIEW_COMPILER_ID = "builtin.evidence-view";

export type CompileEvidenceViewsOptions = {
  minutes?: number;
  limit?: number;
  write?: boolean;
  records?: StoredContextRecord[];
  includeLowValue?: boolean;
};

export type CompileEvidenceViewsResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  records_scanned: number;
  records_used: number;
};

export function compileEvidenceViews(options: CompileEvidenceViewsOptions = {}, store = new ContextStore()): CompileEvidenceViewsResult {
  const generatedAt = new Date().toISOString();
  const minutes = options.minutes ?? 240;
  const limit = options.limit ?? 300;
  const candidateLimit = options.records ? options.records.length : Math.max(limit * 3, limit + 50);
  const records = options.records ?? store.recent(candidateLimit, undefined, { minutes });
  const selected = records.filter(record => isEvidenceInputRecord(record, options)).slice(0, limit);
  const views = selected.map(record => buildEvidenceView(record, generatedAt, minutes));
  const shouldWrite = options.write ?? true;
  const stored = shouldWrite ? views.map(view => store.upsertView(view)) : views;

  if (shouldWrite) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      plugin_id: EVIDENCE_VIEW_COMPILER_ID,
      related_records: selected.map(record => record.id),
      related_views: stored.map(view => view.id).filter(Boolean) as string[],
      payload: {
        view_type: "evidence",
        records_scanned: records.length,
        records_used: selected.length,
        views_compiled: stored.length,
        view_kinds: top(stored.map(view => stringValue(view.content?.kind)).filter((value): value is string => Boolean(value)), 12),
      },
    });
  }

  return {
    ok: true,
    compiler_id: EVIDENCE_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    records_scanned: records.length,
    records_used: selected.length,
  };
}

export function buildEvidenceView(record: StoredContextRecord, generatedAt = new Date().toISOString(), minutes = 240): ContextView {
  const classification = classifyEvidence(record);
  const observedAt = record.time?.observed_at ?? record.created_at;
  const title = evidenceTitle(record, classification.kind);
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  const frameIds = frameIdsOf(record);
  const windowTitle = stringValue(record.payload?.window_name);
  const app = appOf(record);
  const domain = domainOf(record);
  const project = projectOf(record);
  const contentType = stringValue(record.payload?.content_type);
  const text = excerpt(record.content?.text ?? stringValue(record.payload?.text), 1200);

  return {
    id: `evidence:${classification.kind}:${stableKey(record.id)}`,
    view_type: "evidence",
    title,
    summary: evidenceSummary(record, classification.kind),
    status: "candidate",
    source_records: [record.id],
    compiler: { id: EVIDENCE_VIEW_COMPILER_ID, version: "1", mode: "deterministic" },
    purpose: "Normalize a raw Observation into a reusable evidence node with explicit attribution and provenance.",
    scope: {
      ...record.scope,
      app,
      domain,
      project,
      plugin_id: EVIDENCE_VIEW_COMPILER_ID,
      time_range: { start: observedAt, end: observedAt },
    },
    content: {
      kind: classification.kind,
      observed_at: observedAt,
      origin: {
        schema: record.schema.name,
        source: record.source.type,
        connector: record.source.connector,
      },
      subject: {
        type: classification.subjectType,
        app,
        title,
        window: normalizeWindowTitle(windowTitle),
        url,
        domain,
        path: record.content?.path,
        project,
      },
      signals: {
        text,
        event: interactionAttribution(record).event_type,
        selected_text: classification.kind === "selection" ? text : undefined,
        duration_seconds: durationSecondsOf(record),
        frame_ids: frameIds.length ? frameIds : undefined,
        metrics: metricSignalsOf(record),
        audio: classification.kind === "audio" ? audioSignalsOf(record) : undefined,
      },
      claims: evidenceClaims(record, classification.kind),
      quality: {
        confidence: classification.confidence,
        reason: classification.reason,
      },
      data: {
        raw_keys: Object.keys(record.payload ?? {}).sort(),
        content_type: contentType,
      },
      // Legacy-friendly denormalized fields while callers migrate to content.subject/signals.
      evidence_kind: classification.kind,
      observation_schema: record.schema.name,
      observation_source: sourceLabel(record),
      title,
      text,
      url,
      path: record.content?.path,
      app,
      domain,
      project,
      project_path: record.scope?.project_path ?? stringValue(record.payload?.root) ?? stringValue(record.payload?.project_path),
      attribution: {
        source_type: record.source.type,
        connector: record.source.connector,
        reported_app: app,
        window_title: normalizeWindowTitle(windowTitle),
        reported_url: url,
        content_type: contentType,
        frame_id: frameIds[0],
        frame_ids: frameIds.length ? frameIds : undefined,
        interaction: interactionAttribution(record),
      },
      raw_keys: Object.keys(record.payload ?? {}).sort(),
    },
    confidence: classification.confidence,
    stability: classification.stability,
    lossiness: "low",
    privacy: record.privacy ?? { level: "private", retention: "normal", allow_external_llm: false },
    validity: {
      valid_from: observedAt,
      stale_after: classification.stability === "ephemeral"
        ? new Date(Date.parse(generatedAt) + Math.max(5, Math.min(minutes, 60)) * 60_000).toISOString()
        : undefined,
    },
    metadata: {
      generated_at: generatedAt,
      source_record_updated_at: record.updated_at,
      source_record_created_at: record.created_at,
      algorithm: "evidence-view-rules-v1",
    },
  };
}

function isEvidenceInputRecord(record: StoredContextRecord, options: CompileEvidenceViewsOptions): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (record.privacy?.retention === "do_not_store") return false;
  if (!options.includeLowValue && record.schema.name === "observation.browser_page_heartbeat" && !record.content?.url) return false;
  return true;
}

function classifyEvidence(record: StoredContextRecord): { kind: string; subjectType: string; confidence: number; stability: ContextView["stability"]; reason: string } {
  const schema = record.schema.name;
  const contentType = stringValue(record.payload?.content_type)?.toLowerCase();
  if (schema === "observation.browser_text_selected") return { kind: "selection", subjectType: "text", confidence: 0.92, stability: "session", reason: "browser extension reported selected text" };
  if (schema.startsWith("observation.browser_")) return { kind: "page", subjectType: "page", confidence: 0.9, stability: "session", reason: "browser extension reported current page URL" };
  if (schema === "observation.screenpipe_activity_summary") return { kind: "focus", subjectType: "app", confidence: 0.78, stability: "ephemeral", reason: "Screenpipe reported active app/window summary" };
  if (schema === "observation.screenpipe_audio" || contentType === "audio") return { kind: "audio", subjectType: "transcript", confidence: 0.84, stability: "session", reason: "Screenpipe audio transcription reported spoken content" };
  if (schema === "observation.screenpipe_input_event") return { kind: "input", subjectType: "ui_event", confidence: 0.82, stability: "ephemeral", reason: "Screenpipe UI event stream reported interaction" };
  if (schema === "observation.screenpipe_workspace_signal" && contentType === "element") return { kind: "input", subjectType: "ui_element", confidence: 0.72, stability: "ephemeral", reason: "Screenpipe accessibility element was visible" };
  if (schema === "observation.screenpipe_workspace_signal" || schema === "observation.screenpipe_activity") return { kind: "screen", subjectType: "screen_frame", confidence: 0.68, stability: "ephemeral", reason: "Screenpipe OCR/frame capture reported visible text" };
  if (schema === "observation.local_project") return { kind: "project", subjectType: "local_project", confidence: 0.95, stability: "project", reason: "local project connector read repository state" };
  if (schema.includes("ai_session")) return { kind: "agent_session", subjectType: "agent_session", confidence: 0.86, stability: "session", reason: "AI session locator found a local agent session" };
  if (schema.includes("terminal") || record.source.type === "terminal") return { kind: "other", subjectType: "terminal_event", confidence: 0.86, stability: "session", reason: "terminal connector reported an event" };
  if (record.content?.url) return { kind: "resource", subjectType: "url", confidence: 0.82, stability: "session", reason: "record contains a URL resource" };
  return { kind: "other", subjectType: "observation", confidence: record.signal?.confidence ?? 0.65, stability: "session", reason: "generic observation mapping" };
}

function evidenceTitle(record: StoredContextRecord, kind: string): string {
  if (kind === "focus") {
    return [appOf(record), normalizeWindowTitle(stringValue(record.payload?.window_name))].filter(Boolean).join(" - ") || "Focused app evidence";
  }
  if (kind === "screen") return record.content?.title ?? "Screen frame evidence";
  if (kind === "audio") return record.content?.title ?? "Audio transcript evidence";
  if (kind === "input") return record.content?.title ?? `${appOf(record) ?? "App"} interaction`;
  if (kind === "project") return record.content?.title ?? `Local project: ${projectOf(record) ?? "unknown"}`;
  return record.content?.title ?? record.content?.url ?? record.content?.path ?? record.schema.name;
}

function evidenceSummary(record: StoredContextRecord, kind: string): string {
  const title = evidenceTitle(record, kind);
  const source = sourceLabel(record);
  const observedAt = record.time?.observed_at ?? record.created_at;
  return `EvidenceView(kind=${kind}) from ${source} at ${observedAt}: ${title}`;
}

function evidenceClaims(record: StoredContextRecord, kind: string): string[] {
  const claims: string[] = [];
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  const app = appOf(record);
  const text = excerpt(record.content?.text ?? stringValue(record.payload?.text), 280);
  if (url) claims.push("url_seen", "resource_seen");
  if (app) claims.push(kind === "focus" ? "app_focused" : "app_reported");
  if (text) claims.push(kind === "screen" ? "text_visible" : kind === "audio" ? "speech_transcribed" : "text_observed");
  if (record.content?.path) claims.push("path_seen");
  if (kind === "input") {
    const interaction = interactionAttribution(record);
    if (interaction.event_type) claims.push("ui_event");
  }
  return [...new Set(claims)];
}

function interactionAttribution(record: StoredContextRecord): Record<string, unknown> {
  const rawResult = record.payload?.raw_result as Record<string, unknown> | undefined;
  const rawContent = rawResult?.content as Record<string, unknown> | undefined;
  return {
    event_type: stringValue(record.payload?.event_type) ?? stringValue(rawResult?.event_type) ?? stringValue(rawContent?.event_type),
    element_role: stringValue(rawContent?.element_role) ?? stringValue(record.payload?.role),
    element_name: stringValue(rawContent?.element_name),
  };
}

function appOf(record: StoredContextRecord): string | undefined {
  return record.scope?.app ?? stringValue(record.payload?.app_name) ?? stringValue(record.payload?.app);
}

function projectOf(record: StoredContextRecord): string | undefined {
  return record.scope?.project ?? stringValue(record.payload?.project) ?? basename(stringValue(record.payload?.root) ?? record.scope?.project_path ?? record.content?.path ?? "");
}

function domainOf(record: StoredContextRecord): string | undefined {
  if (record.scope?.domain) return record.scope.domain;
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

function durationSecondsOf(record: StoredContextRecord): number | undefined {
  const dwell = numberValue(record.payload?.dwell_seconds);
  if (dwell !== undefined) return dwell;
  const minutes = numberValue(record.payload?.minutes);
  return minutes !== undefined ? minutes * 60 : undefined;
}

function audioSignalsOf(record: StoredContextRecord): Record<string, unknown> | undefined {
  const transcript = excerpt(record.content?.text ?? stringValue(record.payload?.transcription) ?? stringValue(record.payload?.text), 4000);
  if (!transcript) return undefined;
  return {
    transcript,
    audio_chunk_id: stringOrNumber(record.payload?.audio_chunk_id),
    transcription_id: stringOrNumber(record.payload?.transcription_id),
    speaker_label: stringValue(record.payload?.speaker_label),
    device_name: stringValue(record.payload?.device_name),
    device_type: stringValue(record.payload?.device_type),
    start_time: numberValue(record.payload?.start_time),
    end_time: numberValue(record.payload?.end_time),
    transcription_engine: stringValue(record.payload?.transcription_engine),
  };
}

function metricSignalsOf(record: StoredContextRecord): Record<string, number> | undefined {
  const metrics: Record<string, number> = {};
  for (const key of ["scroll_depth", "selection_count", "active_seconds", "frame_count", "node_count"] as const) {
    const value = numberValue(record.payload?.[key]);
    if (value !== undefined) metrics[key] = value;
  }
  return Object.keys(metrics).length ? metrics : undefined;
}

function frameIdsOf(record: StoredContextRecord): Array<string | number> {
  const out: Array<string | number> = [];
  const frameIds = record.payload?.frame_ids;
  if (Array.isArray(frameIds)) {
    for (const frameId of frameIds) {
      if (typeof frameId === "string" || typeof frameId === "number") out.push(frameId);
    }
  }
  const frameId = record.payload?.frame_id;
  if (typeof frameId === "string" || typeof frameId === "number") out.push(frameId);
  return [...new Map(out.map(value => [String(value), value])).values()];
}

function sourceLabel(record: StoredContextRecord): string {
  return `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`;
}

function top(values: string[], limit: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })).slice(0, limit);
}

function excerpt(text: string | undefined, max: number): string | undefined {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function normalizeWindowTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const normalized = title
    .replace(/^[\s|/\\\-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || title.trim() || undefined;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringOrNumber(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

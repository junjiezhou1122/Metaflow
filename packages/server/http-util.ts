import type { ContextRecord, ContextView } from "@info/core";

export async function readJson(req: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value)))];
}

export function compactScope(scope: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => Boolean(value))) as Record<string, string>;
}

export function scopeFromSearchParams(params: URLSearchParams) {
  const scope = compactScope({
    domain: params.get("domain") ?? undefined,
    project: params.get("project") ?? undefined,
    project_path: params.get("project_path") ?? params.get("projectPath") ?? undefined,
    repo: params.get("repo") ?? undefined,
    app: params.get("app") ?? undefined,
    session: params.get("session") ?? undefined,
  });
  return Object.keys(scope).length ? scope : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function nextViewCursor(views: Array<{ updated_at?: string }>, fallback?: string): string | undefined {
  return views.reduce((cursor, view) => {
    if (!view.updated_at) return cursor;
    if (!cursor) return view.updated_at;
    return Date.parse(view.updated_at) > Date.parse(cursor) ? view.updated_at : cursor;
  }, fallback);
}

export function viewListCandidateLimit(input: { limit: number; query?: string; pluginScoped: boolean }): number {
  if (input.limit <= 0) return 0;
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  // View provenance/scope filtering can remove many recent candidates.
  // Use a wider pre-filter window so Application lists still return a full page.
  return input.query ? Math.max(input.limit * 8, input.limit) : Math.max(input.limit * 50, 500);
}

export function latestViewCandidateLimit(input: { query?: string; pluginScoped: boolean }): number {
  if (input.pluginScoped) return 200;
  return input.query ? 50 : 20;
}

export function runtimeEventCandidateLimit(input: { limit: number; pluginScoped: boolean }): number {
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  return input.limit;
}

export function contextRecordCandidateLimit(input: { limit: number; pluginScoped: boolean }): number {
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  return input.limit;
}

export function artifactCandidateLimit(input: { limit: number; pluginScoped: boolean }): number {
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  return input.limit;
}

export function send(res: any, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
}

export function sendBytes(res: any, status: number, body: Uint8Array, contentType: string) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "private, max-age=60",
  });
  res.end(Buffer.from(body));
}

export function pluginNotFoundBody(pluginId: string) {
  return { ok: false, error: `plugin not found: ${pluginId}`, plugin_id: pluginId, plugin_loaded: false };
}

export function recordSchemaIngestError(schemaName: string): string | undefined {
  if (!/^(observation|feedback)(\.|$)/.test(schemaName)) return `${schemaName} is not a raw observation/feedback Record schema; derived intelligence must be written as a View`;
  return undefined;
}

export function isHttpVisibleRecord(record: { schema: { name: string } }): boolean {
  return /^(observation|feedback)(\.|$)/.test(record.schema.name);
}

export function isBrowserSensorRecord(record: ContextRecord): boolean {
  return record.source.type === "browser" || record.source.connector === "chrome-extension" || record.schema.name.startsWith("observation.browser_");
}

export function sanitizeHttpIngestRecord(record: ContextRecord): ContextRecord {
  if (!isBrowserSensorRecord(record)) return record;
  if (!record.scope) return record;
  const scope = compactScope({
    domain: record.scope.domain,
    app: record.scope.app,
    plugin_id: record.scope.plugin_id,
  });
  return { ...record, scope: Object.keys(scope).length ? scope : undefined };
}

export function stringSummary(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function summarizeViewContent(content: ContextView["content"]) {
  const kind = typeof content?.kind === "string" ? content.kind : undefined;
  const category = typeof content?.category === "string" ? content.category : undefined;
  const timeRange = isPlainObject(content?.time_range) ? content.time_range : undefined;
  const summary: Record<string, unknown> = { kind, category, time_range: timeRange };
  if (kind === "audio" || kind === "transcript_semantics") {
    const transcriptExcerpt = stringSummary(content?.transcript_excerpt ?? content?.transcript, 360);
    if (transcriptExcerpt) summary.transcript_excerpt = transcriptExcerpt;
    if (typeof content?.speaker_label === "string") summary.speaker_label = content.speaker_label;
    if (typeof content?.device_name === "string") summary.device_name = content.device_name;
    if (typeof content?.transcript_quality === "string") summary.transcript_quality = content.transcript_quality;
    const topics = Array.isArray(content?.topics) ? content.topics.filter(item => typeof item === "string").slice(0, 5) : [];
    if (topics.length) summary.topics = topics;
    const intents = Array.isArray(content?.stated_intents) ? content.stated_intents.filter(item => typeof item === "string").slice(0, 3) : [];
    if (intents.length) summary.stated_intents = intents;
  }
  return summary;
}

export function summarizeViewForList(view: ContextView) {
  return {
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    status: view.status,
    source_record_count: view.source_records?.length ?? 0,
    source_view_count: view.source_views?.length ?? 0,
    confidence: view.confidence,
    stability: view.stability,
    lossiness: view.lossiness,
    compiler: view.compiler,
    updated_at: "updated_at" in view ? view.updated_at : undefined,
    created_at: "created_at" in view ? view.created_at : undefined,
    content: summarizeViewContent(view.content),
  };
}

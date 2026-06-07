import type { ContextRecord, StoredContextRecord } from "@info/core";

export type ScreenpipePackOptions = {
  enabled?: boolean;
  url?: string;
  api_key?: string;
  limit?: number;
  content_type?: string;
  q?: string;
  start_time?: string;
  end_time?: string;
  app_name?: string;
  window_name?: string;
  browser_url?: string;
};


export type ScreenpipeElementsOptions = {
  url?: string;
  api_key?: string;
  q?: string;
  frame_id?: string | number;
  source?: string;
  role?: string;
  start_time?: string;
  end_time?: string;
  app_name?: string;
  limit?: number;
  offset?: number;
};

export type ScreenpipeElementsResult = {
  ok: boolean;
  url: string;
  query: Record<string, string>;
  records: StoredContextRecord[];
  raw_items?: any[];
  error?: string;
};

export type ScreenpipeFrameContextResult = {
  ok: boolean;
  url: string;
  frame_id: string | number;
  record?: StoredContextRecord;
  context?: any;
  error?: string;
};

export type ScreenpipeWorkspaceSignalsResult = {
  ok: boolean;
  url: string;
  records: StoredContextRecord[];
  diagnostics: {
    element_queries: Array<{ q: string; ok: boolean; count: number; error?: string }>;
    frame_contexts: Array<{ frame_id: string | number; ok: boolean; error?: string }>;
  };
  error?: string;
};

export type ScreenpipeFetchResult = {
  ok: boolean;
  url: string;
  query: Record<string, string>;
  records: StoredContextRecord[];
  error?: string;
};

export type ScreenpipeActivitySummaryResult = {
  ok: boolean;
  url: string;
  records: StoredContextRecord[];
  summary?: any;
  error?: string;
};

function pickText(item: any): string | undefined {
  const c = item.content ?? item;
  const candidates = [
    c.text,
    c.transcription,
    c.ocr_text,
    c.accessibility_text,
    c.content,
    c.markdown,
    item.text,
    item.transcription,
  ];
  const text = candidates.find(v => typeof v === "string" && v.trim());
  return text ? String(text).slice(0, 4000) : undefined;
}

function pickTimestamp(item: any): string | undefined {
  const c = item.content ?? item;
  return c.timestamp ?? c.timestamp_utc ?? c.created_at ?? c.start_time ?? item.timestamp ?? item.created_at;
}

function pickTitle(item: any): string {
  const c = item.content ?? item;
  const app = c.app_name ?? c.app ?? item.app_name;
  const win = c.window_name ?? c.window_title ?? item.window_name ?? item.window_title;
  const typ = item.type ?? c.content_type ?? c.type ?? "activity";
  return [app, win, typ].filter(Boolean).join(" - ") || "Screenpipe activity";
}

function pickUrl(item: any): string | undefined {
  const c = item.content ?? item;
  return c.browser_url ?? c.url ?? item.browser_url ?? item.url;
}

function pickApp(item: any): string | undefined {
  const c = item.content ?? item;
  return c.app_name ?? c.app ?? item.app_name;
}

function pickWindow(item: any): string | undefined {
  const c = item.content ?? item;
  return c.window_name ?? c.window_title ?? item.window_name ?? item.window_title;
}

function pickContentType(item: any): string | undefined {
  const c = item.content ?? item;
  return c.content_type ?? c.type ?? item.type;
}

function isAudioContentType(value: string | undefined): boolean {
  return String(value ?? "").toLowerCase() === "audio";
}

function pickAudioChunkId(item: any): string | number | undefined {
  const c = item.content ?? item;
  const value = c.audio_chunk_id ?? c.chunk_id ?? item.audio_chunk_id ?? item.chunk_id;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isAudioResult(item: any): boolean {
  const contentType = pickContentType(item);
  if (isAudioContentType(contentType)) return true;
  const c = item.content ?? item;
  return pickAudioChunkId(item) !== undefined
    || c.transcription !== undefined
    || c.transcription_id !== undefined
    || item.transcription !== undefined
    || item.transcription_id !== undefined;
}

function pickTranscriptionId(item: any): string | number | undefined {
  const c = item.content ?? item;
  const value = c.transcription_id ?? c.id ?? item.transcription_id;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function pickSpeakerLabel(item: any): string | undefined {
  const c = item.content ?? item;
  const speaker = c.speaker ?? item.speaker;
  return c.speaker_label ?? c.speaker_name ?? speaker?.name ?? (speaker?.id !== undefined ? `speaker:${speaker.id}` : undefined);
}

function pickDeviceName(item: any): string | undefined {
  const c = item.content ?? item;
  return c.device_name ?? c.device ?? item.device_name ?? item.device;
}

function pickDeviceType(item: any): string | undefined {
  const c = item.content ?? item;
  return c.device_type ?? item.device_type;
}

function pickFrameId(item: any): string | number | undefined {
  const c = item.content ?? item;
  const value = c.frame_id ?? c.frameId ?? item.frame_id ?? item.frameId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function pickFrameIds(item: any): Array<string | number> | undefined {
  const c = item.content ?? item;
  const candidates = [c.frame_ids, c.frameIds, item.frame_ids, item.frameIds];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const ids = candidate.filter((value): value is string | number => typeof value === "string" || typeof value === "number");
    if (ids.length) return ids;
  }
  const single = pickFrameId(item);
  return single !== undefined ? [single] : undefined;
}

function makeSourceId(item: any, index: number): string {
  const c = item.content ?? item;
  const id = c.frame_id ?? c.id ?? c.audio_chunk_id ?? c.transcription_id ?? item.id ?? item.frame_id;
  return id ? String(id) : `screenpipe-result-${index}`;
}

function stableRecordId(sourceId: string, timestamp: string): string {
  return `screenpipe:${sourceId}:${timestamp}`.replace(/\s+/g, "_");
}

export function normalizeScreenpipeResult(item: any, index: number, screenpipeUrl: string, query?: string): StoredContextRecord {
  const now = new Date().toISOString();
  const sourceId = makeSourceId(item, index);
  const url = pickUrl(item);
  const app = pickApp(item);
  const content_type = pickContentType(item);
  const frameId = pickFrameId(item);
  const frameIds = pickFrameIds(item);
  const timestamp = pickTimestamp(item) ?? now;
  const text = pickText(item);
  let domain: string | undefined;
  if (url) {
    try { domain = new URL(url).hostname; } catch { domain = undefined; }
  }

  const schemaName = String(content_type ?? "").toLowerCase() === "input"
    ? "observation.screenpipe_input_event"
    : isAudioResult(item)
      ? "observation.screenpipe_audio"
      : "observation.screenpipe_activity";
  const record: ContextRecord = {
    id: stableRecordId(sourceId, timestamp),
    schema: { name: schemaName, version: 1 },
    source: { type: "screenpipe", id: sourceId, connector: "screenpipe-local-api" },
    scope: { app, domain },
    time: { observed_at: timestamp, captured_at: now },
    content: { title: pickTitle(item), text, url },
    acquisition: {
      mode: "sync",
      actor: "connector",
      reason: "Fetched on demand from Screenpipe local API for a ContextPack; raw media stays in Screenpipe.",
      query,
    },
    signal: { importance: 0.25, confidence: 0.8, status: "inbox" },
    privacy: {
      level: "private",
      retention: "normal",
      allow_embedding: false,
      allow_llm_summary: false,
      allow_external_reader: false,
      allow_external_llm: false,
    },
    memory: { kind: "observation", stability: "session" },
    payload: {
      screenpipe_api_url: screenpipeUrl,
      screenpipe_source_id: sourceId,
      content_type,
      app_name: app,
      window_name: pickWindow(item),
      browser_url: url,
      audio_chunk_id: pickAudioChunkId(item),
      transcription_id: pickTranscriptionId(item),
      speaker_label: pickSpeakerLabel(item),
      device_name: pickDeviceName(item),
      device_type: pickDeviceType(item),
      start_time: (item.content ?? item).start_time,
      end_time: (item.content ?? item).end_time,
      transcription_engine: (item.content ?? item).model ?? (item.content ?? item).transcription_engine,
      frame_id: frameId,
      frame_ids: frameIds,
      raw_result: item,
      provenance: {
        backend: "screenpipe",
        api_url: screenpipeUrl,
        source_id: sourceId,
        raw_media_stays_in_screenpipe: true,
      },
    },
  };

  return {
    ...record,
    id: record.id!,
    created_at: now,
    updated_at: now,
  };
}

export async function fetchScreenpipeRecords(options: ScreenpipePackOptions = {}): Promise<ScreenpipeFetchResult> {
  const screenpipeUrl = options.url ?? process.env.SCREENPIPE_URL ?? "http://localhost:3030";
  const apiKey = options.api_key ?? await getScreenpipeApiKey();
  const limit = options.limit ?? 8;
  const contentType = options.content_type ?? "all";
  const queryParams: Record<string, string> = {
    limit: String(limit),
    content_type: contentType,
  };
  if (options.q) queryParams.q = options.q;
  if (options.start_time) queryParams.start_time = options.start_time;
  if (options.end_time) queryParams.end_time = options.end_time;
  if (options.app_name) queryParams.app_name = options.app_name;
  if (options.window_name) queryParams.window_name = options.window_name;
  if (options.browser_url) queryParams.browser_url = options.browser_url;

  const params = new URLSearchParams(queryParams);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${screenpipeUrl}/search?${params.toString()}`, { headers });
    if (!res.ok) {
      return { ok: false, url: screenpipeUrl, query: queryParams, records: [], error: `${res.status} ${await res.text()}` };
    }
    const result = await res.json() as any;
    const items: any[] = Array.isArray(result) ? result : result.data ?? result.results ?? result.items ?? [];
    return {
      ok: true,
      url: screenpipeUrl,
      query: queryParams,
      records: items.map((item, index) => normalizeScreenpipeResult(item, index, screenpipeUrl, options.q)),
    };
  } catch (error: any) {
    return { ok: false, url: screenpipeUrl, query: queryParams, records: [], error: error?.message ?? String(error) };
  }
}


export async function fetchScreenpipeInputEvents(options: Omit<ScreenpipePackOptions, "content_type"> = {}): Promise<ScreenpipeFetchResult> {
  return fetchScreenpipeRecords({ ...options, content_type: "input" });
}

export async function fetchScreenpipeActivitySummary(options: { url?: string; api_key?: string; start_time?: string; end_time?: string } = {}): Promise<ScreenpipeActivitySummaryResult> {
  const screenpipeUrl = options.url ?? process.env.SCREENPIPE_URL ?? "http://localhost:3030";
  const apiKey = options.api_key ?? await getScreenpipeApiKey();
  const start = options.start_time ?? "10m ago";
  const end = options.end_time ?? "now";
  const params = new URLSearchParams({ start_time: start, end_time: end });
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${screenpipeUrl}/activity-summary?${params.toString()}`, { headers });
    if (!res.ok) return { ok: false, url: screenpipeUrl, records: [], error: `${res.status} ${await res.text()}` };
    const summary = await res.json() as any;
    return {
      ok: true,
      url: screenpipeUrl,
      summary,
      records: normalizeActivitySummary(summary, screenpipeUrl),
    };
  } catch (error: any) {
    return { ok: false, url: screenpipeUrl, records: [], error: error?.message ?? String(error) };
  }
}

function normalizeActivitySummary(summary: any, screenpipeUrl: string): StoredContextRecord[] {
  const now = new Date().toISOString();
  const records: StoredContextRecord[] = [];
  const windows = Array.isArray(summary?.windows) ? summary.windows : [];
  for (const [index, win] of windows.entries()) {
    const observed = summary?.time_range?.end ?? summary?.recording?.last_frame_at ?? now;
    const title = [win.app_name, win.window_name].filter(Boolean).join(" - ") || "Screenpipe active window";
    const browserUrl = typeof win.browser_url === "string" && win.browser_url ? win.browser_url : undefined;
    const frameId = pickFrameId(win);
    const frameIds = pickFrameIds(win);
    let domain: string | undefined;
    if (browserUrl) {
      try { domain = new URL(browserUrl).hostname; } catch { domain = undefined; }
    }
    records.push({
      id: stableRecordId(`activity-window-${index}-${win.app_name ?? ""}-${win.window_name ?? ""}`, observed),
      schema: { name: "observation.screenpipe_activity_summary", version: 1 },
      source: { type: "screenpipe", id: `activity-window-${index}`, connector: "screenpipe-activity-summary" },
      scope: { app: win.app_name, domain },
      time: { observed_at: observed, captured_at: now },
      content: {
        title,
        text: [
          `app: ${win.app_name ?? ""}`,
          `window: ${win.window_name ?? ""}`,
          `minutes: ${win.minutes ?? ""}`,
          browserUrl ? `url: ${browserUrl}` : undefined,
        ].filter(Boolean).join("\n"),
        url: browserUrl,
      },
      acquisition: { mode: "sync", actor: "connector", reason: "Fetched Screenpipe activity-summary as live workspace signal" },
      signal: { importance: Math.min(0.7, Number(win.minutes ?? 0) / 10), confidence: 0.75, status: "inbox" },
      privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: false, allow_external_reader: false, allow_external_llm: false },
      memory: { kind: "observation", stability: "session" },
      payload: { screenpipe_api_url: screenpipeUrl, app_name: win.app_name, window_name: win.window_name, browser_url: browserUrl, minutes: win.minutes, frame_count: win.frame_count, frame_id: frameId, frame_ids: frameIds, raw_result: win, raw_media_stays_in_screenpipe: true },
      created_at: now,
      updated_at: now,
    });
  }
  return records;
}


export async function fetchScreenpipeElements(options: ScreenpipeElementsOptions = {}): Promise<ScreenpipeElementsResult> {
  const screenpipeUrl = options.url ?? process.env.SCREENPIPE_URL ?? "http://localhost:3030";
  const apiKey = options.api_key ?? await getScreenpipeApiKey();
  const queryParams: Record<string, string> = { limit: String(options.limit ?? 10) };
  if (options.q) queryParams.q = options.q;
  if (options.frame_id !== undefined) queryParams.frame_id = String(options.frame_id);
  if (options.source) queryParams.source = options.source;
  if (options.role) queryParams.role = options.role;
  if (options.start_time) queryParams.start_time = options.start_time;
  if (options.end_time) queryParams.end_time = options.end_time;
  if (options.app_name) queryParams.app_name = options.app_name;
  if (options.offset !== undefined) queryParams.offset = String(options.offset);

  const params = new URLSearchParams(queryParams);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${screenpipeUrl}/elements?${params.toString()}`, { headers });
    if (!res.ok) return { ok: false, url: screenpipeUrl, query: queryParams, records: [], error: `${res.status} ${await res.text()}` };
    const result = await res.json() as any;
    const items: any[] = Array.isArray(result) ? result : result.data ?? result.results ?? result.items ?? [];
    return {
      ok: true,
      url: screenpipeUrl,
      query: queryParams,
      raw_items: items,
      records: items.map((item, index) => normalizeScreenpipeElement(item, index, screenpipeUrl, queryParams)),
    };
  } catch (error: any) {
    return { ok: false, url: screenpipeUrl, query: queryParams, records: [], error: error?.message ?? String(error) };
  }
}

export async function fetchScreenpipeFrameContext(frameId: string | number, options: { url?: string; api_key?: string } = {}): Promise<ScreenpipeFrameContextResult> {
  const screenpipeUrl = options.url ?? process.env.SCREENPIPE_URL ?? "http://localhost:3030";
  const apiKey = options.api_key ?? await getScreenpipeApiKey();
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${screenpipeUrl}/frames/${encodeURIComponent(String(frameId))}/context`, { headers });
    if (!res.ok) return { ok: false, url: screenpipeUrl, frame_id: frameId, error: `${res.status} ${await res.text()}` };
    const context = await res.json() as any;
    return { ok: true, url: screenpipeUrl, frame_id: frameId, context, record: normalizeScreenpipeFrameContext(context, screenpipeUrl) };
  } catch (error: any) {
    return { ok: false, url: screenpipeUrl, frame_id: frameId, error: error?.message ?? String(error) };
  }
}

export async function fetchScreenpipeFrameImage(frameId: string | number, options: { url?: string; api_key?: string } = {}): Promise<{ ok: true; contentType: string; bytes: Uint8Array } | { ok: false; status?: number; error: string }> {
  const screenpipeUrl = options.url ?? process.env.SCREENPIPE_URL ?? "http://localhost:3030";
  const apiKey = options.api_key ?? await getScreenpipeApiKey();
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${screenpipeUrl}/frames/${encodeURIComponent(String(frameId))}`, { headers });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
    return {
      ok: true,
      contentType: res.headers.get("content-type") ?? "image/jpeg",
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

export async function fetchScreenpipeWorkspaceSignals(options: { url?: string; api_key?: string; start_time?: string; end_time?: string; limit_per_query?: number; frame_context_limit?: number; queries?: string[] } = {}): Promise<ScreenpipeWorkspaceSignalsResult> {
  const screenpipeUrl = options.url ?? process.env.SCREENPIPE_URL ?? "http://localhost:3030";
  const apiKey = options.api_key ?? await getScreenpipeApiKey();
  const start = options.start_time ?? "10m ago";
  const end = options.end_time ?? "now";
  const queries = options.queries ?? ["~/", "/Users", "package.json", "src", "pnpm", "git"];
  const records: StoredContextRecord[] = [];
  const diagnostics: ScreenpipeWorkspaceSignalsResult["diagnostics"] = { element_queries: [], frame_contexts: [] };
  const frameIds = new Set<string | number>();

  for (const q of queries) {
    const result = await fetchScreenpipeElements({ url: screenpipeUrl, api_key: apiKey, q, start_time: start, end_time: end, limit: options.limit_per_query ?? 5 });
    diagnostics.element_queries.push({ q, ok: result.ok, count: result.records.length, error: result.error });
    records.push(...result.records);
    for (const item of result.raw_items ?? []) {
      const frameId = item?.frame_id ?? item?.content?.frame_id;
      if (frameId !== undefined && frameIds.size < (options.frame_context_limit ?? 2)) frameIds.add(frameId);
    }
  }

  for (const frameId of frameIds) {
    const context = await fetchScreenpipeFrameContext(frameId, { url: screenpipeUrl, api_key: apiKey });
    diagnostics.frame_contexts.push({ frame_id: frameId, ok: context.ok, error: context.error });
    if (context.record) records.push(context.record);
  }

  return { ok: diagnostics.element_queries.some(q => q.ok) || diagnostics.frame_contexts.some(f => f.ok), url: screenpipeUrl, records: dedupeScreenpipeRecords(records), diagnostics };
}

function normalizeScreenpipeElement(item: any, index: number, screenpipeUrl: string, query: Record<string, string>): StoredContextRecord {
  const now = new Date().toISOString();
  const sourceId = String(item.id ?? `element-${query.q ?? "query"}-${index}`);
  const frameId = item.frame_id ?? item.content?.frame_id;
  const text = typeof item.text === "string" ? item.text : pickText(item);
  const title = [item.role, text].filter(Boolean).join(": ").slice(0, 160) || "Screenpipe UI element";
  const observed = pickTimestamp(item) ?? now;
  return {
    id: stableRecordId(`element-${sourceId}`, observed),
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", id: sourceId, connector: "screenpipe-elements" },
    scope: {},
    time: { observed_at: observed, captured_at: now },
    content: { title, text },
    acquisition: { mode: "sync", actor: "connector", reason: "Fetched lightweight Screenpipe UI elements as workspace resolver signals.", query: query.q },
    signal: { importance: 0.35, confidence: Number(item.confidence ?? 0.75), status: "inbox" },
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: false, allow_external_reader: false, allow_external_llm: false },
    memory: { kind: "observation", stability: "session" },
    payload: {
      screenpipe_api_url: screenpipeUrl,
      screenpipe_source_id: sourceId,
      content_type: "element",
      frame_id: frameId,
      role: item.role,
      source: item.source,
      text,
      bounds: item.bounds,
      raw_result: item,
      provenance: { backend: "screenpipe", api_url: screenpipeUrl, source_id: sourceId, frame_id: frameId, raw_media_stays_in_screenpipe: true },
    },
    created_at: now,
    updated_at: now,
  };
}

function normalizeScreenpipeFrameContext(context: any, screenpipeUrl: string): StoredContextRecord {
  const now = new Date().toISOString();
  const frameId = context?.frame_id ?? "unknown-frame";
  const text = typeof context?.text === "string" ? context.text.slice(0, 5000) : undefined;
  const urls = Array.isArray(context?.urls) ? context.urls.filter((url: unknown) => typeof url === "string") : [];
  const primaryUrl = urls[0];
  let domain: string | undefined;
  if (primaryUrl) {
    try { domain = new URL(primaryUrl).hostname; } catch { domain = undefined; }
  }
  return {
    id: stableRecordId(`frame-context-${frameId}`, now),
    schema: { name: "observation.screenpipe_workspace_signal", version: 1 },
    source: { type: "screenpipe", id: String(frameId), connector: "screenpipe-frame-context" },
    scope: { domain },
    time: { observed_at: now, captured_at: now },
    content: { title: primaryUrl ? `Screenpipe frame: ${domain ?? primaryUrl}` : `Screenpipe frame context ${frameId}`, text, url: primaryUrl },
    acquisition: { mode: "sync", actor: "connector", reason: "Fetched bounded Screenpipe frame context to resolve active workspace.", query: `frame:${frameId}` },
    signal: { importance: 0.45, confidence: 0.8, status: "inbox" },
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: false, allow_external_reader: false, allow_external_llm: false },
    memory: { kind: "observation", stability: "session" },
    payload: {
      screenpipe_api_url: screenpipeUrl,
      screenpipe_source_id: String(frameId),
      content_type: "frame_context",
      frame_id: frameId,
      text_source: context?.text_source,
      urls,
      browser_url: primaryUrl,
      node_count: Array.isArray(context?.nodes) ? context.nodes.length : undefined,
      raw_result: context,
      provenance: { backend: "screenpipe", api_url: screenpipeUrl, source_id: String(frameId), frame_id: frameId, raw_media_stays_in_screenpipe: true },
    },
    created_at: now,
    updated_at: now,
  };
}

function dedupeScreenpipeRecords(records: StoredContextRecord[]): StoredContextRecord[] {
  const byId = new Map<string, StoredContextRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()];
}

async function getScreenpipeApiKey(): Promise<string | undefined> {
  if (process.env.SCREENPIPE_API_KEY) return process.env.SCREENPIPE_API_KEY;
  if (process.env.SCREENPIPE_LOCAL_API_KEY) return process.env.SCREENPIPE_LOCAL_API_KEY;
  if (process.env.SCREENPIPE_API_AUTH_KEY) return process.env.SCREENPIPE_API_AUTH_KEY;
  try {
    const { execFileSync } = await import("node:child_process");
    const token = execFileSync("screenpipe", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim().split(/\s+/).at(-1);
    return token || undefined;
  } catch {
    try {
      const { execFileSync } = await import("node:child_process");
      const token = execFileSync("npm", ["exec", "--", "screenpipe@latest", "auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim().split(/\s+/).at(-1);
      return token || undefined;
    } catch {
      return undefined;
    }
  }
}

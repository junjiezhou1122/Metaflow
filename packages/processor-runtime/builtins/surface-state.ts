import type { ContextRecord, StoredContextRecord } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const SURFACE_STATE_PROCESSOR_ID = "processor.surface_state";
export const SURFACE_STATE_VIEW_TYPE = "state.surface";

export type SurfaceStateOptions = {
  windowMinutes?: number;
  recordLimit?: number;
  now?: Date;
};

type SurfaceKind = "editor" | "youtube_video" | "browser_page" | "terminal" | "ide" | "desktop_app" | "unknown";

type SurfaceCandidate = {
  records: StoredContextRecord[];
  latest?: StoredContextRecord;
  page?: StoredContextRecord;
  editor?: StoredContextRecord;
  selection?: StoredContextRecord;
  media?: StoredContextRecord;
  screen?: StoredContextRecord;
  input?: StoredContextRecord;
  audio: StoredContextRecord[];
  localProject?: StoredContextRecord;
};

export function createSurfaceStateProcessor(options: SurfaceStateOptions = {}): ProcessorDefinition {
  return {
    id: SURFACE_STATE_PROCESSOR_ID,
    title: "Current Surface State",
    version: "0.0.1",
    description: "Fuses Chrome ACP and Screenpipe observations into one ephemeral current-surface View.",
    consumes: {
      observations: [
        "observation.browser_*",
        "observation.editor.*",
        "observation.media.*",
        "observation.youtube.*",
        "observation.screenpipe_*",
        "observation.local_project",
      ],
    },
    produces: { views: [SURFACE_STATE_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "reflex", autonomy: "draft", privacy: "private" },
    handler: surfaceStateHandler(options),
  };
}

export function surfaceStateHandler(options: SurfaceStateOptions = {}): ProcessorHandler {
  return (input, context) => {
    const now = options.now ?? new Date();
    const view = buildSurfaceStateView({
      seed: input.observation,
      records: collectSurfaceRecords(context.store.recent(options.recordLimit ?? 80, undefined, surfaceTimeWindow(now, options.windowMinutes ?? 10)), input.observation),
      now,
    });
    return {
      views: [view],
      diagnostics: {
        source_records: view.source_records?.length ?? 0,
        surface_kind: view.content?.surface_kind,
        source_priority: view.content?.source_priority,
      },
    };
  };
}

function surfaceTimeWindow(now: Date, minutes: number): { start_time: string; end_time: string; minutes: number } {
  return {
    start_time: new Date(now.getTime() - minutes * 60_000).toISOString(),
    end_time: now.toISOString(),
    minutes,
  };
}

export function buildSurfaceStateView(input: {
  seed?: StoredContextRecord;
  records: StoredContextRecord[];
  now?: Date;
}): ViewDraft {
  const now = input.now ?? new Date();
  const candidate = chooseSurfaceCandidate(input.records, input.seed);
  const surfaceKind = inferSurfaceKind(candidate);
  const activeUrl = firstString(
    candidate.editor?.content?.url,
    candidate.selection?.content?.url,
    candidate.page?.content?.url,
    stringValue(candidate.screen?.payload?.browser_url),
  );
  const activeTitle = firstString(
    candidate.editor?.content?.title,
    candidate.selection?.content?.title,
    candidate.page?.content?.title,
    stringValue(candidate.screen?.payload?.window_name),
    candidate.screen?.content?.title,
  );
  const activeApp = normalizeApp(firstString(
    candidate.editor?.scope?.app,
    candidate.page?.scope?.app,
    stringValue(candidate.screen?.payload?.app_name),
    candidate.screen?.scope?.app,
    candidate.latest?.scope?.app,
  ));
  const domain = firstString(
    candidate.editor?.scope?.domain,
    candidate.selection?.scope?.domain,
    candidate.page?.scope?.domain,
    candidate.screen?.scope?.domain,
    domainFromUrl(activeUrl),
  );
  const screenText = truncate(firstString(candidate.screen?.content?.text, textFromRawScreen(candidate.screen)), 1400);
  const pageText = truncate(candidate.page?.content?.text, 2000);
  const editorText = truncate(firstString(candidate.editor?.content?.text, stringValue(candidate.editor?.payload?.text)), 1600);
  const selectedText = truncate(firstString(candidate.selection?.content?.text, stringValue(candidate.page?.payload?.selected_text)), 1200);
  const inputState = inputStateFrom(candidate.input, now);
  const audio = audioContextFrom(candidate.audio);
  const sourceRecords = candidate.records.map(record => record.id).slice(0, 32);
  const sourcePriority = surfaceKind === "editor" || surfaceKind === "browser_page" || surfaceKind === "youtube_video"
    ? "browser_acp"
    : candidate.screen
      ? "screenpipe"
      : "unknown";

  return {
    id: "view:state_surface:current",
    type: SURFACE_STATE_VIEW_TYPE,
    title: `Current surface: ${activeTitle ?? activeApp ?? surfaceKind}`,
    summary: summaryFor({ surfaceKind, activeApp, activeTitle, activeUrl, editorText, selectedText, screenText }),
    status: "candidate",
    source_records: sourceRecords,
    purpose: "Ephemeral current context for ambient learning, writing assistance, browser actions, and current-screen summaries.",
    scope: {
      app: activeApp,
      domain,
      project: stringValue(candidate.localProject?.scope?.project),
      project_path: stringValue(candidate.localProject?.scope?.project_path ?? candidate.localProject?.payload?.root ?? candidate.localProject?.content?.path),
      time_range: timeRangeFor(candidate.records),
    },
    content: {
      surface_kind: surfaceKind,
      source_priority: sourcePriority,
      active_app: activeApp,
      active_title: activeTitle,
      active_url: activeUrl,
      domain,
      focused_element: candidate.editor ? {
        kind: stringValue(candidate.editor.payload?.element_kind) ?? stringValue(candidate.editor.payload?.tag_name) ?? "text_input",
        text_preview: editorText,
        text_length: numberValue(candidate.editor.payload?.text_length) ?? editorText?.length,
        writing_surface: stringValue(candidate.editor.payload?.writing_surface),
      } : undefined,
      selection: selectedText ? {
        text: selectedText,
        copied: Boolean(candidate.selection?.payload?.copied),
        attention_signal: stringValue(candidate.selection?.payload?.attention_signal),
      } : undefined,
      page: candidate.page ? {
        title: candidate.page.content?.title,
        url: candidate.page.content?.url,
        text_preview: pageText,
        scroll_depth: numberValue(candidate.page.payload?.scroll_depth),
        selected_text_length: numberValue(candidate.page.payload?.selected_text_length),
        text_quality: recordValue(candidate.page.payload?.text_quality),
      } : undefined,
      media: candidate.media ? {
        kind: candidate.media.schema.name,
        current_time: numberValue(candidate.media.payload?.current_time ?? candidate.media.payload?.current_time_seconds),
        captions_enabled: booleanValue(candidate.media.payload?.captions_enabled ?? candidate.media.payload?.enabled),
        caption_text: truncate(firstString(candidate.media.content?.text, stringValue(candidate.media.payload?.caption_text)), 1000),
      } : undefined,
      screen: candidate.screen ? {
        frame_id: stringValue(candidate.screen.payload?.frame_id),
        frame_ids: arrayOfStrings(candidate.screen.payload?.frame_ids),
        screenshot_path: screenshotPath(candidate.screen),
        visible_text_preview: screenText,
        text_source: stringValue(candidate.screen.payload?.raw_result && recordValue(candidate.screen.payload.raw_result)?.content && recordValue(recordValue(candidate.screen.payload.raw_result)?.content)?.text_source),
        device_name: stringValue(candidate.screen.payload?.device_name),
        window_name: stringValue(candidate.screen.payload?.window_name),
      } : undefined,
      audio,
      input_state: inputState,
      last_interaction: lastInteraction(candidate),
      source_record_ids: sourceRecords,
      generated_at: now.toISOString(),
    },
    confidence: confidenceFor(surfaceKind, candidate),
    stability: "ephemeral",
    lossiness: "medium",
    privacy: {
      level: "private",
      retention: "ephemeral",
      allow_embedding: false,
      allow_llm_summary: false,
      allow_external_reader: false,
      allow_external_llm: false,
    },
    metadata: {
      current_surface: true,
      browser_record_id: candidate.page?.id,
      editor_record_id: candidate.editor?.id,
      screenpipe_record_id: candidate.screen?.id,
      input_record_id: candidate.input?.id,
    },
  };
}

function collectSurfaceRecords(records: StoredContextRecord[], seed?: StoredContextRecord): StoredContextRecord[] {
  const byId = new Map(records.filter(isSurfaceRecord).map(record => [record.id, record]));
  if (seed && isSurfaceRecord(seed)) byId.set(seed.id, seed);
  return sortRecords([...byId.values()]);
}

function chooseSurfaceCandidate(records: StoredContextRecord[], seed?: StoredContextRecord): SurfaceCandidate {
  const sorted = sortRecords(seed && !records.some(record => record.id === seed.id) ? [seed, ...records] : records);
  const browser = sorted.filter(isBrowserRecord);
  const screenpipe = sorted.filter(record => record.source.type === "screenpipe" || record.schema.name.includes("screenpipe"));
  const candidate: SurfaceCandidate = {
    records: sorted,
    latest: sorted[0],
    page: firstRecord(browser, isPageRecord),
    editor: firstRecord(sorted, record => record.schema.name === "observation.editor.text_changed"),
    selection: firstRecord(sorted, record => record.schema.name === "observation.browser_text_selected" || record.schema.name === "observation.browser_text_copied"),
    media: firstRecord(sorted, record => record.schema.name.startsWith("observation.media.") || record.schema.name.startsWith("observation.youtube.")),
    screen: firstRecord(screenpipe, isScreenRecord),
    input: firstRecord(screenpipe, record => record.schema.name === "observation.screenpipe_input_event"),
    audio: screenpipe.filter(record => record.schema.name === "observation.screenpipe_audio" && Boolean(record.content?.text)).slice(0, 5),
    localProject: firstRecord(sorted, record => record.schema.name === "observation.local_project"),
  };
  return candidate;
}

function inferSurfaceKind(candidate: SurfaceCandidate): SurfaceKind {
  const url = firstString(candidate.editor?.content?.url, candidate.page?.content?.url, candidate.selection?.content?.url, stringValue(candidate.screen?.payload?.browser_url));
  const title = firstString(candidate.editor?.content?.title, candidate.page?.content?.title, candidate.screen?.content?.title, stringValue(candidate.screen?.payload?.window_name));
  const app = normalizeApp(firstString(candidate.screen?.scope?.app, stringValue(candidate.screen?.payload?.app_name), candidate.page?.scope?.app));
  const hay = `${url ?? ""} ${title ?? ""} ${app ?? ""}`.toLowerCase();
  if (candidate.editor) return "editor";
  if (hay.includes("youtube.com") || hay.includes("youtube")) return "youtube_video";
  if (url || candidate.page || candidate.selection) return "browser_page";
  if (/(warp|terminal|iterm|wezterm|alacritty)/i.test(app ?? "")) return "terminal";
  if (/(visual studio code|code|cursor|zed)/i.test(app ?? "")) return "ide";
  if (candidate.screen) return "desktop_app";
  return "unknown";
}

function isSurfaceRecord(record: StoredContextRecord): boolean {
  return isBrowserRecord(record)
    || record.schema.name.startsWith("observation.screenpipe_")
    || record.schema.name === "observation.local_project"
    || record.schema.name.startsWith("observation.media.")
    || record.schema.name.startsWith("observation.youtube.");
}

function isBrowserRecord(record: StoredContextRecord): boolean {
  return record.source.type === "browser"
    || record.source.connector === "chrome-acp"
    || record.source.connector === "chrome-extension"
    || record.schema.name.startsWith("observation.browser_")
    || record.schema.name.startsWith("observation.editor.");
}

function isPageRecord(record: StoredContextRecord): boolean {
  return [
    "observation.browser_page_snapshot",
    "observation.browser_page_saved",
    "observation.browser_ambient_requested",
    "observation.browser_page_heartbeat",
    "observation.browser_page_visit",
  ].includes(record.schema.name);
}

function isScreenRecord(record: StoredContextRecord): boolean {
  if (record.schema.name === "observation.screenpipe_audio") return false;
  if (record.schema.name === "observation.screenpipe_input_event") return false;
  return record.schema.name.startsWith("observation.screenpipe_");
}

function sortRecords(records: StoredContextRecord[]): StoredContextRecord[] {
  return [...records].sort((a, b) => timestampMs(b) - timestampMs(a));
}

function firstRecord(records: StoredContextRecord[], predicate: (record: StoredContextRecord) => boolean): StoredContextRecord | undefined {
  return records.find(predicate);
}

function timestampMs(record: StoredContextRecord): number {
  return Date.parse(record.time?.observed_at ?? record.updated_at ?? record.created_at);
}

function timeRangeFor(records: StoredContextRecord[]): { start?: string; end?: string } | undefined {
  const times = records.map(timestampMs).filter(Number.isFinite);
  if (!times.length) return undefined;
  return {
    start: new Date(Math.min(...times)).toISOString(),
    end: new Date(Math.max(...times)).toISOString(),
  };
}

function inputStateFrom(record: StoredContextRecord | undefined, now: Date) {
  if (!record) return undefined;
  const observed = timestampMs(record);
  const idleMs = Number.isFinite(observed) ? Math.max(0, now.getTime() - observed) : undefined;
  const event = firstString(record.content?.text, stringValue(record.payload?.event), stringValue(record.payload?.event_type), stringValue(record.payload?.content_type));
  return {
    last_event: event,
    observed_at: record.time?.observed_at,
    typing_active: event === "key" && idleMs !== undefined && idleMs < 8000,
    idle_ms: idleMs,
  };
}

function audioContextFrom(records: StoredContextRecord[]) {
  const chunks = records
    .map(record => ({
      record_id: record.id,
      audio_chunk_id: stringValue(record.payload?.audio_chunk_id),
      observed_at: record.time?.observed_at,
      text: truncate(record.content?.text, 500),
      device_name: stringValue(record.payload?.device_name),
      speaker_label: stringValue(record.payload?.speaker_label),
    }))
    .filter(chunk => chunk.text);
  if (!chunks.length) return undefined;
  return {
    recent_chunks: chunks,
    transcript_preview: truncate(chunks.map(chunk => chunk.text).join("\n"), 1200),
  };
}

function lastInteraction(candidate: SurfaceCandidate) {
  const latest = candidate.input ?? candidate.editor ?? candidate.selection ?? candidate.page ?? candidate.screen ?? candidate.audio[0] ?? candidate.latest;
  if (!latest) return undefined;
  return {
    kind: latest.schema.name,
    observed_at: latest.time?.observed_at,
    source_record_id: latest.id,
  };
}

function summaryFor(input: {
  surfaceKind: SurfaceKind;
  activeApp?: string;
  activeTitle?: string;
  activeUrl?: string;
  editorText?: string;
  selectedText?: string;
  screenText?: string;
}): string {
  const target = input.activeTitle ?? input.activeUrl ?? input.activeApp ?? input.surfaceKind;
  const text = input.editorText ?? input.selectedText ?? input.screenText;
  return text ? `${target}: ${truncate(text, 180)}` : String(target);
}

function confidenceFor(surfaceKind: SurfaceKind, candidate: SurfaceCandidate): number {
  if (surfaceKind === "editor" && candidate.editor) return 0.93;
  if ((surfaceKind === "browser_page" || surfaceKind === "youtube_video") && candidate.page) return 0.88;
  if (candidate.screen?.content?.text && candidate.input) return 0.82;
  if (candidate.screen) return 0.76;
  return 0.35;
}

function screenshotPath(record: StoredContextRecord | undefined): string | undefined {
  const raw = recordValue(record?.payload?.raw_result);
  const content = recordValue(raw?.content);
  return firstString(
    stringValue(record?.payload?.file_path),
    stringValue(record?.payload?.frame_name),
    stringValue(content?.file_path),
    stringValue(content?.frame_name),
    stringValue(raw?.frame_name),
  );
}

function textFromRawScreen(record: StoredContextRecord | undefined): string | undefined {
  const raw = recordValue(record?.payload?.raw_result);
  const content = recordValue(raw?.content);
  return stringValue(content?.text) ?? stringValue(raw?.text);
}

function normalizeApp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "chrome") return "Google Chrome";
  return value;
}

function domainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find(value => typeof value === "string" && value.trim());
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(item => typeof item === "string" || typeof item === "number" ? String(item) : undefined).filter((item): item is string => Boolean(item));
  return result.length ? result : undefined;
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

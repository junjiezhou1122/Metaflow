import type { ActivityTimelineResponse, ActivityTimelineWatermarkResponse, AudioTranscriptResponse, ContextRecordSummary, ContextViewInput, ContextViewSummary, ContextViewUpdateInput, FeedbackResponse, MemoryCandidateContent, MemoryGateDecision, ProcessorDefinitionSummary, ProcessorListResponse, ProcessorRun, ProcessorRunResponse, ProjectCurrentContent, RuntimeSettings, RuntimeSettingsResponse, RuntimeTickResponse, ViewCatalogResponse, ViewFamiliesResponse, ViewListResponse, ViewStatus, WorkFocusSetContent } from "./types";

const API_BASE = import.meta.env.VITE_CONTEXT_API_BASE ?? "http://localhost:3111";
const DEFAULT_TIMEOUT_MS = 8_000;
const VIEW_FAMILIES_TIMEOUT_MS = 3_000;
const VIEW_CATALOG_TIMEOUT_MS = 2_000;

export function screenpipeFrameUrl(frameId: string | number): string {
  return `${API_BASE}/screenpipe/frames/${encodeURIComponent(String(frameId))}`;
}

export async function syncScreenpipe(windowMinutes = 15, screenpipeLimit = screenpipeSyncLimit(windowMinutes)): Promise<RuntimeTickResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/runtime/tick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      include_screenpipe: true,
      include_ai_sessions: false,
      include_git: false,
      force: true,
      window_minutes: windowMinutes,
      compile_views: false,
      screenpipe_limit: screenpipeLimit,
    }),
  }, screenpipeSyncTimeoutMs(windowMinutes));
  if (!res.ok) throw new Error(`screenpipe sync failed: ${res.status}`);
  return res.json();
}

export async function runRuntimeTick(body: Record<string, unknown>): Promise<RuntimeTickResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/runtime/tick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 180_000);
  if (!res.ok) throw new Error(`runtime tick failed: ${res.status}`);
  return res.json();
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettingsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/runtime/settings`, undefined, 8_000);
  if (!res.ok) throw new Error(`runtime settings fetch failed: ${res.status}`);
  return res.json();
}

export async function saveRuntimeSettings(settings: RuntimeSettings): Promise<RuntimeSettingsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/runtime/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  }, 12_000);
  if (!res.ok) throw new Error(`runtime settings save failed: ${res.status}`);
  return res.json();
}

export async function fetchActivityTimeline(options: { minutes?: number; startTime?: string; endTime?: string; limit?: number; bucketMinutes?: number; includeLowLevelScreenpipe?: boolean; dedupe?: boolean; bucketItemLimit?: number | false; summarizeHeartbeats?: boolean; sourceFilter?: "screenpipe" | "browser" | "runtime" | "all"; mergeContinuous?: boolean; mergeGapMinutes?: number; write?: boolean; includeRuntimeEvents?: boolean } = {}): Promise<ActivityTimelineResponse> {
  const minutes = options.minutes ?? 90;
  const sourceFilter = options.sourceFilter ?? "all";
  const debugMode = options.includeLowLevelScreenpipe === true;
  const timeoutMs = sourceFilter === "screenpipe" && debugMode ? 60_000 : minutes > 240 ? 30_000 : 25_000;
  const res = await fetchWithTimeout(`${API_BASE}/timeline/activity/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      minutes,
      start_time: options.startTime,
      end_time: options.endTime,
      limit: options.limit ?? timelineRecordLimit(minutes, sourceFilter),
      bucket_minutes: options.bucketMinutes ?? 10,
      include_low_level_screenpipe: options.includeLowLevelScreenpipe ?? false,
      include_runtime_events: options.includeRuntimeEvents ?? false,
      dedupe: options.dedupe ?? !debugMode,
      bucket_item_limit: options.bucketItemLimit ?? (debugMode ? false : 50),
      summarize_heartbeats: options.summarizeHeartbeats ?? !debugMode,
      source_filter: sourceFilter,
      merge_continuous: options.mergeContinuous ?? true,
      merge_gap_minutes: options.mergeGapMinutes ?? 3,
      write: options.write ?? true,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`timeline compile failed: ${res.status}`);
  return res.json();
}

export async function fetchActivityTimelineWatermark(options: { minutes?: number; startTime?: string; endTime?: string; sourceFilter?: "screenpipe" | "browser" | "runtime" | "all"; includeRuntimeEvents?: boolean } = {}): Promise<ActivityTimelineWatermarkResponse> {
  const range = new URLSearchParams({
    minutes: String(options.minutes ?? 24 * 60),
    source_filter: options.sourceFilter ?? "all",
  });
  if (options.startTime) range.set("start_time", options.startTime);
  if (options.endTime) range.set("end_time", options.endTime);
  if (options.includeRuntimeEvents) range.set("include_runtime_events", "true");
  const res = await fetchWithTimeout(`${API_BASE}/timeline/activity/watermark?${range.toString()}`, undefined, 30_000);
  if (!res.ok) throw new Error(`timeline watermark failed: ${res.status}`);
  return res.json();
}

export async function fetchLatestActivityTimelineView(options: { todayOnly?: boolean } = {}): Promise<ActivityTimelineResponse | null> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=timeline.activity&active_only=true&limit=5&summary_only=false`, undefined, 4_000);
  if (!res.ok) throw new Error(`timeline view fetch failed: ${res.status}`);
  const body = await res.json();
  const views = (body.views ?? []) as ContextViewSummary[];
  const view = options.todayOnly ? views.find(isTodayTimelineView) : views[0];
  const buckets = Array.isArray(view?.content?.buckets) ? view.content.buckets as ActivityTimelineResponse["buckets"] : [];
  if (!view || !buckets.length) return null;
  return {
    ok: true,
    compiler_id: typeof view.compiler === "object" ? view.compiler?.id ?? "cached.timeline.activity" : view.compiler ?? "cached.timeline.activity",
    records_used: typeof view.metadata?.record_count === "number" ? view.metadata.record_count : buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    events_used: typeof view.metadata?.runtime_event_count === "number" ? view.metadata.runtime_event_count : 0,
    buckets,
    view: {
      id: view.id,
      view_type: view.view_type,
      title: view.title ?? "Activity Timeline",
      summary: view.summary ?? "",
      content: view.content as ActivityTimelineResponse["view"]["content"],
      metadata: view.metadata,
      updated_at: view.updated_at,
    },
  };
}

function isTodayTimelineView(view: ContextViewSummary): boolean {
  if (typeof view.id === "string" && view.id.startsWith("view:timeline:activity:day:")) return true;
  const minutes = view.content?.minutes;
  return typeof minutes === "number" && minutes > 4 * 60;
}

export async function fetchViewFamilies(): Promise<ViewFamiliesResponse> {
  const catalog = await fetchViewCatalog();
  const familyOrder = catalog.order;
  const res = await fetchWithTimeout(`${API_BASE}/context/views/families?view_types=${familyOrder.join(",")}&active_only=true`, undefined, VIEW_FAMILIES_TIMEOUT_MS);
  if (!res.ok) throw new Error(`view families fetch failed: ${res.status}`);
  const body = await res.json();
  const returned = Array.isArray(body.families) ? body.families : [];
  const byFamily = new Map(returned.map((family: any) => [family.family, family]));
  const byDefinition = new Map(catalog.families.map(family => [family.view_type, family]));
  const families = familyOrder.map(family => {
    const item = byFamily.get(family) as any;
    return {
      family,
      count: Number(item?.count ?? 0),
      kinds: Array.isArray(item?.kinds) ? item.kinds : [],
      latest: item?.latest,
      definition: item?.definition ?? byDefinition.get(family),
    };
  });
  const views = families.map(family => family.latest).filter(Boolean) as ContextViewSummary[];
  return { ok: true, views, families, catalog };
}

export async function fetchViewCatalog(): Promise<ViewCatalogResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views/catalog`, undefined, VIEW_CATALOG_TIMEOUT_MS);
  if (!res.ok) throw new Error(`view catalog fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchViewsByType(viewType: string, options: { limit?: number; cursor?: string; includeCandidates?: boolean; activeOnly?: boolean } = {}): Promise<ViewListResponse> {
  const params = new URLSearchParams({
    view_types: viewType,
    limit: String(options.limit === undefined ? 80 : options.limit),
    summary_only: viewType === "audio" || viewType === "activity.episode" ? "false" : "true",
  });
  if (options.activeOnly !== false && !options.includeCandidates) params.set("active_only", "true");
  if (options.cursor) params.set("updated_after", options.cursor);
  const res = await fetchWithTimeout(`${API_BASE}/context/views?${params.toString()}`, undefined, 8_000);
  if (!res.ok) throw new Error(`${viewType} views fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchActivityEpisodes(options: { limit?: number } = {}): Promise<ViewListResponse> {
  return fetchViewsByType("activity.episode", { limit: options.limit === undefined ? 300 : options.limit, activeOnly: true });
}

export async function fetchAudioTranscripts(options: { minutes?: number; limit?: number } = {}): Promise<AudioTranscriptResponse> {
  const params = new URLSearchParams({
    minutes: String(options.minutes ?? 120),
    limit: String(options.limit ?? 400),
    _: String(Date.now()),
  });
  const res = await fetchWithTimeout(`${API_BASE}/screenpipe/audio/transcripts?${params.toString()}`, undefined, 25_000);
  if (!res.ok) throw new Error(`audio transcripts fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchViewsByTypes(viewTypes: string[], options: { limit?: number } = {}): Promise<ViewListResponse> {
  const params = new URLSearchParams({
    view_types: viewTypes.join(","),
    limit: String(options.limit ?? 120),
    active_only: "true",
    summary_only: "true",
  });
  const res = await fetchWithTimeout(`${API_BASE}/context/views?${params.toString()}`, undefined, 8_000);
  if (!res.ok) throw new Error(`ambient views fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchContextView(viewId: string): Promise<ContextViewSummary> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views/${encodeURIComponent(viewId)}`);
  if (!res.ok) throw new Error(`view fetch failed: ${res.status}`);
  const body = await res.json();
  return body.view;
}

export async function fetchRecentRecords(limit = 80): Promise<ContextRecordSummary[]> {
  const res = await fetchWithTimeout(`${API_BASE}/context/recent?limit=${encodeURIComponent(String(limit))}`, undefined, 8_000);
  if (!res.ok) throw new Error(`recent records fetch failed: ${res.status}`);
  const body = await res.json();
  return (body.records ?? []) as ContextRecordSummary[];
}

export async function fetchProcessors(options: { sourceKind?: "observation" | "view"; sourceType?: string } = {}): Promise<ProcessorListResponse> {
  const params = new URLSearchParams();
  if (options.sourceKind) params.set("source_kind", options.sourceKind);
  if (options.sourceType) params.set("source_type", options.sourceType);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await fetchWithTimeout(`${API_BASE}/processors${suffix}`, undefined, 8_000);
  if (!res.ok) throw new Error(`processors fetch failed: ${res.status}`);
  return res.json();
}

export async function createDynamicProcessor(processor: Partial<ProcessorDefinitionSummary> & { id: string; runtime_config?: Record<string, unknown> }): Promise<ProcessorDefinitionSummary> {
  const runtime = processor.runtime_config ?? { kind: processor.runtime };
  const res = await fetchWithTimeout(`${API_BASE}/processors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ processor: { ...processor, runtime } }),
  }, 12_000);
  if (!res.ok) throw new Error(`processor create failed: ${res.status} ${await responseErrorText(res)}`);
  const body = await res.json();
  return body.processor as ProcessorDefinitionSummary;
}

export async function runProcessor(input: { processor_id: string; record_id?: string; view_id?: string; payload?: Record<string, unknown> }): Promise<ProcessorRunResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/processors/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 60_000);
  if (!res.ok) throw new Error(`processor run failed: ${res.status} ${await responseErrorText(res)}`);
  return res.json();
}

export async function createContextView(input: ContextViewInput): Promise<ContextViewSummary> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?source=manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 12_000);
  if (!res.ok) throw new Error(`view create failed: ${res.status} ${await responseErrorText(res)}`);
  const body = await res.json();
  return body.view as ContextViewSummary;
}

export async function updateContextView(viewId: string, input: ContextViewUpdateInput): Promise<ContextViewSummary> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views/${encodeURIComponent(viewId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 12_000);
  if (!res.ok) throw new Error(`view update failed: ${res.status} ${await responseErrorText(res)}`);
  const body = await res.json();
  return body.view as ContextViewSummary;
}

export async function submitViewFeedback(input: { view_id: string; type: "analysis.useful" | "analysis.dismissed" | "output.edited"; value?: unknown; reason?: string; payload?: Record<string, unknown> }): Promise<FeedbackResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/feedback?process=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      application_id: "runtime.ui.ambient",
      privacy: { level: "private", retention: "normal" },
      ...input,
    }),
  }, 12_000);
  if (!res.ok) throw new Error(`feedback failed: ${res.status}`);
  return res.json();
}

export async function fetchMemoryCandidates(): Promise<ContextViewSummary[]> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=memory.candidate&active_only=true&limit=160`, undefined, 8_000);
  if (!res.ok) throw new Error(`memory candidates fetch failed: ${res.status}`);
  const body = await res.json();
  return (body.views ?? []) as ContextViewSummary[];
}

export async function fetchMemoryGateViews(): Promise<ContextViewSummary[]> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=memory.gate&active_only=true&limit=80`, undefined, 8_000);
  if (!res.ok) throw new Error(`memory gate fetch failed: ${res.status}`);
  const body = await res.json();
  return (body.views ?? []) as ContextViewSummary[];
}

export async function fetchProjectCurrentViews(): Promise<ContextViewSummary[]> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=project.current,project.current_context&active_only=true&limit=40`, undefined, 8_000);
  if (!res.ok) throw new Error(`project.current fetch failed: ${res.status}`);
  const body = await res.json();
  return ((body.views ?? []) as ContextViewSummary[]).sort((a, b) => {
    if (a.view_type === b.view_type) return Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "");
    if (a.view_type === "project.current") return -1;
    if (b.view_type === "project.current") return 1;
    return a.view_type.localeCompare(b.view_type);
  });
}

export async function fetchWorkFocusSetViews(): Promise<ContextViewSummary[]> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=work.focus_set&active_only=true&limit=20`, undefined, 8_000);
  if (!res.ok) throw new Error(`work.focus_set fetch failed: ${res.status}`);
  const body = await res.json();
  return (body.views ?? []) as ContextViewSummary[];
}

export async function fetchProcessorTraces(): Promise<Array<{
  id: string;
  event_type: string;
  actor: string;
  status: string;
  subject_type: string;
  subject_id: string;
  payload?: Record<string, unknown>;
  created_at: string;
}>> {
  const res = await fetchWithTimeout(`${API_BASE}/runtime/events?types=processor.run.started,processor.run.completed,processor.run.failed&limit=120`, undefined, 8_000);
  if (!res.ok) throw new Error(`processor traces fetch failed: ${res.status}`);
  const body = await res.json();
  return (body.events ?? []) as Array<{
    id: string;
    event_type: string;
    actor: string;
    status: string;
    subject_type: string;
    subject_id: string;
    payload?: Record<string, unknown>;
    created_at: string;
  }>;
}

export async function fetchProactiveSuggestions(): Promise<ContextViewSummary[]> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=advice.research,draft.writing_continuation&active_only=true&limit=80`, undefined, 8_000);
  if (!res.ok) throw new Error(`proactive suggestions fetch failed: ${res.status}`);
  const body = await res.json();
  return (body.views ?? []) as ContextViewSummary[];
}

export async function patchViewStatus(
  viewId: string,
  status: ViewStatus,
): Promise<ContextViewSummary> {
  return updateContextView(viewId, { status });
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function responseErrorText(res: Response) {
  const text = await res.text().catch(() => "");
  return text ? text.slice(0, 500) : "";
}

function timelineRecordLimit(minutes: number, sourceFilter: "screenpipe" | "browser" | "runtime" | "all") {
  const samplesPerMinute = sourceFilter === "runtime" ? 2 : sourceFilter === "browser" ? 10 : sourceFilter === "screenpipe" ? 12 : 16;
  const minimum = sourceFilter === "runtime" ? 200 : 900;
  return Math.min(12_000, Math.max(minimum, Math.ceil(minutes * samplesPerMinute)));
}

function screenpipeSyncLimit(minutes: number) {
  return Math.min(4_000, Math.max(80, Math.ceil(minutes * 3)));
}

function screenpipeSyncTimeoutMs(minutes: number) {
  if (minutes > 12 * 60) return 60_000;
  if (minutes > 120) return 45_000;
  return 25_000;
}

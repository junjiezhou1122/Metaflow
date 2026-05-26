import type { ActivityTimelineResponse, ContextViewSummary, RuntimeTickResponse, ViewFamiliesResponse } from "./types";

const API_BASE = import.meta.env.VITE_CONTEXT_API_BASE ?? "http://localhost:3111";
const DEFAULT_TIMEOUT_MS = 8_000;

export function screenpipeFrameUrl(frameId: string | number): string {
  return `${API_BASE}/screenpipe/frames/${encodeURIComponent(String(frameId))}`;
}

export async function syncScreenpipe(windowMinutes = 15): Promise<RuntimeTickResponse> {
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
      screenpipe_limit: 60,
    }),
  }, 12_000);
  if (!res.ok) throw new Error(`screenpipe sync failed: ${res.status}`);
  return res.json();
}

export async function fetchActivityTimeline(options: { minutes?: number; limit?: number; bucketMinutes?: number; includeLowLevelScreenpipe?: boolean; dedupe?: boolean; bucketItemLimit?: number | false; summarizeHeartbeats?: boolean; sourceFilter?: "screenpipe" | "browser" | "runtime" | "all"; mergeContinuous?: boolean; mergeGapMinutes?: number } = {}): Promise<ActivityTimelineResponse> {
  const minutes = options.minutes ?? 180;
  const sourceFilter = options.sourceFilter ?? "all";
  const res = await fetchWithTimeout(`${API_BASE}/timeline/activity/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      minutes,
      limit: options.limit ?? timelineRecordLimit(minutes, sourceFilter),
      bucket_minutes: options.bucketMinutes ?? 10,
      include_low_level_screenpipe: options.includeLowLevelScreenpipe ?? true,
      include_runtime_events: false,
      dedupe: options.dedupe ?? false,
      bucket_item_limit: options.bucketItemLimit ?? false,
      summarize_heartbeats: options.summarizeHeartbeats ?? false,
      source_filter: sourceFilter,
      merge_continuous: options.mergeContinuous ?? true,
      merge_gap_minutes: options.mergeGapMinutes ?? 3,
      write: false,
    }),
  });
  if (!res.ok) throw new Error(`timeline compile failed: ${res.status}`);
  return res.json();
}

export async function fetchViewFamilies(): Promise<ViewFamiliesResponse> {
  const familyOrder = ["evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow", "memory"];
  const results = await Promise.all(familyOrder.map(async family => {
    const res = await fetchWithTimeout(`${API_BASE}/context/views?view_types=${family}&limit=all&active_only=true&summary_only=true`, undefined, 20_000);
    if (!res.ok) throw new Error(`${family} view fetch failed: ${res.status}`);
    const body = await res.json();
    return Array.isArray(body.views) ? body.views : [];
  }));
  const views = results.flat();
  const families = familyOrder.map(family => {
    const familyViews = views.filter((view: any) => view.view_type === family);
    const kinds = [...new Set(familyViews.map((view: any) => typeof view.content?.kind === "string" ? view.content.kind : undefined).filter(Boolean))] as string[];
    return {
      family,
      count: familyViews.length,
      kinds,
      latest: familyViews[0],
    };
  });
  return { ok: true, views, families };
}

export async function fetchContextView(viewId: string): Promise<ContextViewSummary> {
  const res = await fetchWithTimeout(`${API_BASE}/context/views/${encodeURIComponent(viewId)}`);
  if (!res.ok) throw new Error(`view fetch failed: ${res.status}`);
  const body = await res.json();
  return body.view;
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

function timelineRecordLimit(minutes: number, sourceFilter: "screenpipe" | "browser" | "runtime" | "all") {
  const samplesPerMinute = sourceFilter === "runtime" ? 2 : sourceFilter === "browser" ? 10 : sourceFilter === "screenpipe" ? 12 : 16;
  const minimum = sourceFilter === "runtime" ? 200 : 900;
  return Math.min(12_000, Math.max(minimum, Math.ceil(minutes * samplesPerMinute)));
}

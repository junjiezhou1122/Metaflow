import { handleInfoCaptureMessage, installInfoCaptureDefaults, startInfoCapture } from "./lib/info-capture";
import { ensureTrustedOperationStorageAccess } from "./lib/operation-auth-storage";
import {
  TRUSTED_BACKGROUND_RUNTIME_SENDER,
  authorizeRuntimeMessageSender,
} from "./lib/runtime-sender-policy";
import { SidepanelPromptQueue } from "./lib/sidepanel-prompt-queue";

const sidepanelPromptQueue = new SidepanelPromptQueue();
const RECENT_CAPTION_GAPS_KEY = "language.recent_caption_gaps";
const SAVED_CAPTION_GAPS_BY_VIDEO_KEY = "language.caption_gaps.by_video";
const MAX_RECENT_CAPTION_GAPS = 12;
const MAX_SAVED_CAPTION_VIDEOS = 80;
const MAX_SAVED_GAPS_PER_VIDEO = 50;
const syncedCaptionGapKeys = new Set<string>();

type CaptionGap = {
  id?: string;
  fragment_id?: string;
  video_id?: string;
  video_title?: string;
  video_url?: string;
  fragment_url?: string;
  start_seconds?: number;
  end_seconds?: number;
  duration_seconds?: number;
  video_current_seconds?: number;
  video_duration_seconds?: number;
  caption_on_ms?: number;
  toggles?: number;
  transcript_samples?: string[];
  subtitle_text?: string;
  caption_samples?: Array<{
    text: string;
    start_seconds?: number;
    end_seconds?: number;
    captured_at?: string;
  }>;
  current_caption?: string | null;
  trigger_reason?: string;
  ended_reason?: string;
  caption_state?: "on" | "off";
  playback_state?: "playing" | "paused" | "ended";
  fragment_started_at?: string;
  fragment_ended_at?: string;
  observed_at?: string;
  captured_at?: string;
  status?: string;
};

type SavedCaptionVideo = {
  video_id: string;
  video_title: string;
  video_url?: string;
  updated_at: string;
  segments: CaptionGap[];
};

const backgroundCaptionSender = TRUSTED_BACKGROUND_RUNTIME_SENDER;

async function injectContentScript(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["dist/content.js"],
  }).catch(() => undefined);
}

function captionVideoId(gap: CaptionGap): string {
  return String(gap.video_id || "unknown");
}

function captionSegmentKey(gap: CaptionGap): string {
  if (gap.fragment_id) return gap.fragment_id;
  if (gap.id) return gap.id;
  return [
    captionVideoId(gap),
    Math.round(Number(gap.start_seconds) || 0),
    Math.round(Number(gap.end_seconds) || 0),
    gap.observed_at || gap.captured_at || "",
  ].join(":");
}

function cleanCaptionText(text: unknown): string {
  return String(text ?? "")
    .replace(/\b[A-Za-z-]+\s+\(auto-generated\)\s*Click for settings\b/gi, " ")
    .replace(/\b[A-Za-z-]+\s+\(auto-generated\)\b/gi, " ")
    .replace(/\bClick for settings\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function captionTextScore(text: string): number {
  if (!text) return 0;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const letterCount = (text.match(/[A-Za-z]/g) ?? []).length;
  return wordCount * 10 + letterCount;
}

function isCaptionPrefix(shorter: string, longer: string): boolean {
  return longer === shorter || (longer.startsWith(shorter) && /^[\s,.;:!?]/.test(longer.slice(shorter.length, shorter.length + 1)));
}

function collapseIncrementalCaptionLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  for (const line of lines) {
    const text = cleanCaptionText(line);
    if (!text) continue;
    const existingLonger = collapsed.some(existing => isCaptionPrefix(text, existing));
    if (existingLonger) continue;
    for (let index = collapsed.length - 1; index >= 0; index -= 1) {
      if (isCaptionPrefix(collapsed[index], text)) collapsed.splice(index, 1);
    }
    collapsed.push(text);
  }
  return collapsed;
}

function bestCaptionText(gap: CaptionGap): string {
  const lines = [
    ...(Array.isArray(gap.caption_samples) ? gap.caption_samples.map(sample => sample?.text) : []),
    ...(Array.isArray(gap.transcript_samples) ? gap.transcript_samples : []),
    ...(typeof gap.subtitle_text === "string" ? gap.subtitle_text.split(/\n+/) : []),
    gap.current_caption,
  ]
    .map(cleanCaptionText)
    .filter(Boolean);
  const collapsed = collapseIncrementalCaptionLines(lines);
  if (collapsed.length) return collapsed.join(" ");
  return lines.sort((a, b) => captionTextScore(b) - captionTextScore(a))[0] ?? "";
}

async function persistCaptionGapByVideo(gap: CaptionGap): Promise<void> {
  if (gap.status === "active") return;
  const videoId = captionVideoId(gap);
  const now = new Date().toISOString();
  const stored = await chrome.storage?.local?.get?.(SAVED_CAPTION_GAPS_BY_VIDEO_KEY).catch(() => ({}));
  const current = stored?.[SAVED_CAPTION_GAPS_BY_VIDEO_KEY];
  const byVideo: Record<string, SavedCaptionVideo> = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : {};
  const existing = byVideo[videoId] ?? {
    video_id: videoId,
    video_title: gap.video_title || "YouTube caption segment",
    video_url: gap.video_url,
    updated_at: now,
    segments: [],
  };
  const key = captionSegmentKey(gap);
  const segments = [
    { ...gap, status: "saved", captured_at: gap.captured_at || now },
    ...(Array.isArray(existing.segments) ? existing.segments : []).filter(item => captionSegmentKey(item) !== key),
  ]
    .sort((a, b) => String(b.captured_at || b.observed_at || "").localeCompare(String(a.captured_at || a.observed_at || "")))
    .slice(0, MAX_SAVED_GAPS_PER_VIDEO);
  byVideo[videoId] = {
    ...existing,
    video_title: gap.video_title || existing.video_title,
    video_url: gap.video_url || existing.video_url,
    updated_at: now,
    segments,
  };
  const limited = Object.fromEntries(
    Object.entries(byVideo)
      .sort(([, a], [, b]) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, MAX_SAVED_CAPTION_VIDEOS),
  );
  await chrome.storage?.local?.set?.({ [SAVED_CAPTION_GAPS_BY_VIDEO_KEY]: limited }).catch(() => undefined);
}

async function mirrorCaptionGapToContext(gap: CaptionGap, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!gap.video_id) return undefined;
  const captionText = bestCaptionText(gap);
  if (!captionText) return undefined;
  const tab = sender.tab ?? await findCaptionTab(gap);
  return handleInfoCaptureMessage({
    type: "youtube-observation",
    schemaName: "observation.youtube.caption_fragment",
    payload: {
      ...gap,
      caption_text: captionText,
      subtitle_text: captionText,
      transcript_samples: [captionText],
      observed_at: gap.fragment_ended_at || gap.observed_at || gap.captured_at || new Date().toISOString(),
    },
  }, tab ? { ...sender, tab } : sender);
}

async function syncCaptionGapToContext(gap: CaptionGap, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!gap.video_id) return undefined;
  if (gap.status === "active" && Math.round((gap.caption_on_ms ?? 0) / 1000) < 5) return undefined;
  const captionText = bestCaptionText(gap);
  if (!captionText) return undefined;
  const key = [
    captionVideoId(gap),
    Math.round(Number(gap.start_seconds) || 0),
    Math.round(Number(gap.end_seconds) || Number(gap.video_current_seconds) || 0),
    captionText.slice(0, 80),
  ].join(":");
  if (syncedCaptionGapKeys.has(key)) return { ok: true, skipped: "already_synced", key };
  syncedCaptionGapKeys.add(key);
  return mirrorCaptionGapToContext({
    ...gap,
    status: "sent",
    ended_reason: gap.ended_reason || "storage_sync",
    end_seconds: gap.end_seconds ?? gap.video_current_seconds,
    fragment_ended_at: gap.fragment_ended_at || gap.captured_at || new Date().toISOString(),
  }, sender);
}

async function findCaptionTab(gap: CaptionGap): Promise<chrome.tabs.Tab | undefined> {
  const videoUrl = typeof gap.video_url === "string" ? gap.video_url : "";
  const videoId = typeof gap.video_id === "string" ? gap.video_id : "";
  const tabs = await chrome.tabs.query({}).catch(() => []);
  return tabs.find(tab => {
    const url = tab.url || "";
    if (!url) return false;
    if (videoUrl && url === videoUrl) return true;
    if (videoId && url.includes("youtube.com/watch") && url.includes(videoId)) return true;
    return false;
  }) ?? tabs.find(tab => {
    const url = tab.url || "";
    return videoId ? url.includes(videoId) : url.includes("youtube.com/watch");
  });
}

function gapsFromSavedByVideo(value: unknown): CaptionGap[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value as Record<string, SavedCaptionVideo>)
    .flatMap(video => Array.isArray(video?.segments) ? video.segments : []);
}

async function syncCaptionGapsFromStorage(gaps: CaptionGap[]): Promise<void> {
  for (const gap of gaps.slice(0, 40)) {
    if (!gap || typeof gap !== "object") continue;
    await syncCaptionGapToContext(gap, backgroundCaptionSender).catch(() => undefined);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await installInfoCaptureDefaults();
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  }
});

startInfoCapture();

// Open side panel when the extension icon is clicked.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    injectContentScript(tab.id);
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  injectContentScript(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") injectContentScript(tabId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes[RECENT_CAPTION_GAPS_KEY]) {
    const value = changes[RECENT_CAPTION_GAPS_KEY].newValue;
    if (Array.isArray(value)) void syncCaptionGapsFromStorage(value);
  }
  if (areaName === "local" && changes[SAVED_CAPTION_GAPS_BY_VIDEO_KEY]) {
    void syncCaptionGapsFromStorage(gapsFromSavedByVideo(changes[SAVED_CAPTION_GAPS_BY_VIDEO_KEY].newValue));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const authorization = authorizeRuntimeMessageSender(message, sender);
    if (!authorization.ok) {
      sendResponse(authorization);
      return;
    }
    if (message?.type === "selection-actions.get") {
      await ensureTrustedOperationStorageAccess();
      const stored = await chrome.storage.local.get("selectionActions");
      sendResponse({
        ok: true,
        selectionActions: Array.isArray(stored.selectionActions) ? stored.selectionActions : [],
      });
      return;
    }
    if (message?.type === "language.caption_gap.recent") {
      const gap = message.gap ?? {};
      const status = message.status === "sent" ? "sent" : "active";
      const observedKey = typeof gap.observed_at === "string" ? Date.parse(gap.observed_at) : 0;
      const fragmentKey = Number.isFinite(observedKey) && observedKey > 0 ? observedKey : Date.now();
      const fragmentId = typeof gap.fragment_id === "string" && gap.fragment_id
        ? gap.fragment_id
        : `${gap.video_id ?? "unknown"}:${Math.round(Number(gap.start_seconds) || 0)}:${fragmentKey}`;
      const id = status === "active" ? `${fragmentId}:active` : fragmentId;
      const stored = await chrome.storage?.session?.get?.(RECENT_CAPTION_GAPS_KEY).catch(() => ({}));
      const current = Array.isArray(stored?.[RECENT_CAPTION_GAPS_KEY]) ? stored[RECENT_CAPTION_GAPS_KEY] : [];
      const videoId = gap.video_id ?? "unknown";
      const startSeconds = Math.round(Number(gap.start_seconds) || 0);
      const activeId = `${fragmentId}:active`;
      const withoutSame = current.filter((item: any) => {
        if (item?.id === id || item?.id === activeId || item?.fragment_id === fragmentId) return false;
        return !(item?.video_id === gap.video_id
          && Math.round(Number(item?.start_seconds) || 0) === startSeconds
          && item?.observed_at === gap.observed_at);
      });
      const savedGap = {
        ...gap,
        fragment_id: fragmentId,
        id,
        status,
        captured_at: new Date().toISOString(),
      };
      const next = [
        savedGap,
        ...withoutSame,
      ].slice(0, MAX_RECENT_CAPTION_GAPS);
      await chrome.storage?.session?.set?.({ [RECENT_CAPTION_GAPS_KEY]: next }).catch(() => undefined);
      await persistCaptionGapByVideo(savedGap).catch(() => undefined);
      const mirrored = status === "sent"
        ? await mirrorCaptionGapToContext(savedGap, sender).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        : undefined;
      sendResponse({ ok: true, id, count: next.length, mirrored });
      return;
    }

    if (message?.type === "language.caption_gap.sync") {
      const gaps = Array.isArray(message.gaps) ? message.gaps : [];
      const results = [];
      for (const gap of gaps.slice(0, 20)) {
        if (!gap || typeof gap !== "object") continue;
        results.push(await syncCaptionGapToContext(gap as CaptionGap, sender)
          .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) })));
      }
      sendResponse({ ok: true, synced: results.filter(Boolean).length, results });
      return;
    }

    const sidepanelPromptResult = await sidepanelPromptQueue.handle(
      message,
      authorization,
      sender,
      async tabId => chrome.sidePanel.open({ tabId }).catch(() => undefined),
    );
    if (sidepanelPromptResult !== undefined) {
      sendResponse(sidepanelPromptResult);
      return;
    }

    const result = await handleInfoCaptureMessage(message, sender);
    if (result !== undefined) sendResponse(result);
  })().catch(error => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

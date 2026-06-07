import { ContextStore } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";
import type { LlmOptions } from "@info/core";
import {
  analyzeActivityBlockWithText,
  clamp,
  isRecord,
  isString,
  normalizeScore,
  numberValue,
  rangeForViews,
  renderViews,
  shouldUseActivityInVisualBlock,
  shouldUseAudioInActivityBlock,
  signalValue,
  stableKey,
  stringArray,
  stringValue,
  unique,
  uniqueViews,
  type VisualFrameAnalyzerResponse,
} from "../visual-frame/shared.js";
import type { CompileVisualViewsResult } from "../visual-frame/compiler.js";

export const AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID = "ai.activity.block";

export type ActivityBlockAnalyzerRequest = {
  prompt: string;
  input_views: Array<ContextView | StoredContextView>;
};

export type ActivityBlockAnalyzerResponse = VisualFrameAnalyzerResponse;

export type ActivityBlockAnalyzer = (request: ActivityBlockAnalyzerRequest) => Promise<ActivityBlockAnalyzerResponse>;

export type CompileActivityBlockViewsOptions = {
  write?: boolean;
  llm?: LlmOptions;
  limit?: number;
  minutes?: number;
  visualFrameViews?: Array<ContextView | StoredContextView>;
  audioViews?: Array<ContextView | StoredContextView>;
  activityViews?: Array<ContextView | StoredContextView>;
  analyzer?: ActivityBlockAnalyzer;
};

export type { CompileVisualViewsResult };

export async function compileActivityBlockViews(options: CompileActivityBlockViewsOptions = {}, store = new ContextStore()): Promise<CompileVisualViewsResult> {
  const generatedAt = new Date().toISOString();
  const minutes = options.minutes ?? 10;
  const limit = options.limit ?? 20;
  const visualFrameViews = (options.visualFrameViews ?? store.listViews({
    view_types: ["visual_frame"],
    active_only: true,
    limit,
    timeWindow: { minutes },
  })).filter(view => view.view_type === "visual_frame");
  const audioViews = (options.audioViews ?? store.listViews({
    view_types: ["audio"],
    active_only: true,
    limit,
    timeWindow: { minutes },
  })).filter(view => view.view_type === "audio" && shouldUseAudioInActivityBlock(view));
  const activityViews = (options.activityViews ?? store.listViews({
    view_types: ["activity"],
    active_only: true,
    limit,
    timeWindow: { minutes },
  })).filter(view => view.view_type === "activity" && shouldUseActivityInVisualBlock(view));
  const inputViews = uniqueViews([...visualFrameViews, ...audioViews, ...activityViews]);
  const timeRange = rangeForViews(inputViews, generatedAt, minutes);
  const blockId = `activity_block:visual:${stableKey(`${timeRange.start}|${timeRange.end}|${inputViews.map(view => view.id).join("|")}`)}`;

  let response: ActivityBlockAnalyzerResponse | undefined;
  let view: ContextView | undefined;
  if (visualFrameViews.length || audioViews.length) {
    const prompt = activityBlockPrompt(inputViews, timeRange);
    response = options.analyzer
      ? await options.analyzer({ prompt, input_views: inputViews })
      : await analyzeActivityBlockWithText(prompt, options);
    if (response.ok && response.content) {
      view = normalizeActivityBlockView(response.content, inputViews, blockId, timeRange, generatedAt, response);
    }
  }

  const stored = view && (options.write ?? true) ? [store.upsertView(view)] : view ? [view] : [];
  if (options.write ?? true) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      plugin_id: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID,
      related_views: stored.map(item => item.id).filter(isString),
      payload: {
        view_type: "activity_block",
        strategy: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID,
        mode: "llm",
        visual_frame_views_seen: visualFrameViews.length,
        audio_views_seen: audioViews.length,
        activity_views_seen: activityViews.length,
        views_compiled: stored.length,
        error: response?.error,
      },
    });
  }

  return {
    ok: true,
    compiler_id: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID,
    generated_at: generatedAt,
    views: stored,
    diagnostics: {
      strategy: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID,
      visual_frame_views_seen: visualFrameViews.length,
      audio_views_seen: audioViews.length,
      activity_views_seen: activityViews.length,
      produced: stored.length,
      error: response?.error,
    },
  };
}

export function normalizeActivityBlockView(
  content: Record<string, unknown>,
  inputViews: Array<ContextView | StoredContextView>,
  id: string,
  timeRange: { start: string; end: string },
  generatedAt: string,
  llm: ActivityBlockAnalyzerResponse,
): ContextView | undefined {
  const primaryWork = stringValue(content.primary_work) ?? stringValue(content.block_summary) ?? stringValue(content.summary);
  if (!primaryWork) return undefined;
  const confidence = clamp(numberValue(content.confidence) ?? 0.68);
  const memoryWorthiness = normalizeScore(content.memory_worthiness);
  const doneSignal = signalValue(content.done_signal);
  const continuationSignal = signalValue(content.continuation_signal);
  const shouldCreateMemory = Boolean(content.should_create_memory)
    && confidence >= 0.72
    && (memoryWorthiness ?? 0) >= 0.7
    && (doneSignal === "strong" || (doneSignal === "weak" && continuationSignal !== "strong"));
  const sourceViews = inputViews.map(view => view.id).filter(isString);
  return {
    id,
    view_type: "activity_block",
    title: stringValue(content.title) ?? primaryWork.slice(0, 90),
    summary: stringValue(content.block_summary) ?? primaryWork,
    status: "candidate",
    source_records: unique(inputViews.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID, version: "1", mode: "llm" },
    purpose: "Aggregate recent VisualFrameViews and ActivityViews into a short-lived block summary for later workflow inference.",
    scope: { ...inputViews[0]?.scope, plugin_id: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID, time_range: timeRange },
    content: {
      kind: "visual_activity_block",
      primary_work: primaryWork,
      secondary_context: stringArray(content.secondary_context),
      evidence: stringArray(content.evidence),
      noise: stringArray(content.noise),
      done_signal: doneSignal,
      continuation_signal: continuationSignal,
      memory_worthiness: memoryWorthiness,
      should_create_memory: shouldCreateMemory,
      view_candidates: Array.isArray(content.view_candidates) ? content.view_candidates.filter(isRecord).slice(0, 8) : [],
      extracted_from: sourceViews,
    },
    confidence,
    stability: "session",
    lossiness: "high",
    privacy: { level: "private", retention: "normal", allow_llm_summary: true, allow_external_llm: true },
    validity: { stale_after: new Date(Date.parse(generatedAt) + 2 * 60 * 60_000).toISOString() },
    metadata: {
      generated_at: generatedAt,
      strategy_id: AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID,
      prompt_id: "activity_block_v1",
      llm: { model: llm.model, base_url: llm.base_url },
    },
  };
}

export function activityBlockPrompt(inputViews: Array<ContextView | StoredContextView>, timeRange: { start: string; end: string }): string {
  return [
    "Compile one 10-minute ActivityBlockView from these VisualFrameViews, AudioViews, and ActivityViews.",
    "This is not long-term memory. It is a candidate block for later workflow inference.",
    "Separate true work from recorder, app-focus, terminal, desktop, and window-switching noise.",
    "Return JSON with keys: title, block_summary, primary_work, secondary_context, evidence, noise, done_signal, continuation_signal, memory_worthiness, should_create_memory, view_candidates, confidence.",
    "done_signal and continuation_signal must be one of: none, weak, strong.",
    `Time range: ${timeRange.start} to ${timeRange.end}`,
    renderViews(inputViews),
  ].join("\n\n");
}

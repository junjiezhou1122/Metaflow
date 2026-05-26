import { createHash } from "node:crypto";
import { fetchScreenpipeFrameImage } from "../connectors/screenpipe.js";
import { parseJsonObject, visionCompletion, type LlmOptions } from "../core/llm.js";
import { ContextStore } from "../core/store.js";
import type { ContextView, StoredContextView } from "../core/types.js";

export const AI_VISUAL_FRAME_VIEW_STRATEGY_ID = "ai.visual.frame";
export const AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID = "ai.activity.block";

export type VisualFrameAnalyzerRequest = {
  frame_id: string;
  mime_type: string;
  base64_image: string;
  evidence_views: Array<ContextView | StoredContextView>;
  prompt: string;
};

export type VisualFrameAnalyzerResponse = {
  ok: boolean;
  content?: Record<string, unknown>;
  raw?: string;
  model?: string;
  base_url?: string;
  error?: string;
};

export type VisualFrameAnalyzer = (request: VisualFrameAnalyzerRequest) => Promise<VisualFrameAnalyzerResponse>;

export type ActivityBlockAnalyzerRequest = {
  prompt: string;
  input_views: Array<ContextView | StoredContextView>;
};

export type ActivityBlockAnalyzerResponse = VisualFrameAnalyzerResponse;

export type ActivityBlockAnalyzer = (request: ActivityBlockAnalyzerRequest) => Promise<ActivityBlockAnalyzerResponse>;

export type CompileVisualFrameViewsOptions = {
  write?: boolean;
  llm?: LlmOptions;
  model?: string;
  limit?: number;
  concurrency?: number;
  sampleIntervalSeconds?: number;
  evidenceViews?: Array<ContextView | StoredContextView>;
  analyzer?: VisualFrameAnalyzer;
};

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

export type CompileVisualViewsResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  diagnostics: Record<string, unknown>;
};

export async function compileVisualFrameViews(options: CompileVisualFrameViewsOptions = {}, store = new ContextStore()): Promise<CompileVisualViewsResult> {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? Number(process.env.RUNTIME_VISUAL_FRAME_LIMIT ?? 0);
  const evidenceViews = (options.evidenceViews ?? store.listViews({
    view_types: ["evidence"],
    active_only: true,
    limit: limit > 0 ? Math.max(limit * 8, 20) : 0,
  })).filter(view => view.view_type === "evidence");
  const candidates = selectVisualFrameCandidates(evidenceViews, limit, options.sampleIntervalSeconds);
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? Number(process.env.RUNTIME_VISUAL_FRAME_CONCURRENCY ?? 6)));
  const existingFrameIds = new Set(store.listViews({ view_types: ["visual_frame"], active_only: true, limit: 0 })
    .map(view => stringValue(view.content?.frame_id))
    .filter(isString));
  const results = await mapWithConcurrency(candidates, concurrency, async (candidate) => {
    const frameId = candidate.frame_id;
    const frameStartedAt = Date.now();
    const sourceViews = candidate.views.map(view => view.id).filter(isString);
    if (existingFrameIds.has(frameId)) {
      return {
        frame_id: frameId,
        skipped: "existing_visual_frame",
        duration_ms: Date.now() - frameStartedAt,
      };
    }

    const prompt = visualFramePrompt(candidate.views, frameId);
    const response = options.analyzer
      ? await options.analyzer({ frame_id: frameId, mime_type: "image/jpeg", base64_image: "", evidence_views: candidate.views, prompt })
      : await analyzeFrameWithVision(frameId, candidate.views, prompt, options);
    if (!response.ok || !response.content) {
      return {
        frame_id: frameId,
        error: response.error ?? "empty visual response",
        duration_ms: Date.now() - frameStartedAt,
      };
    }
    const view = normalizeVisualFrameView(response.content, candidate.views, frameId, generatedAt, response);
    return {
      frame_id: frameId,
      view,
      duration_ms: Date.now() - frameStartedAt,
    };
  });
  const views = results.map(result => result.view).filter((view): view is ContextView => Boolean(view));
  const errors = results
    .filter(result => result.error)
    .map(result => ({ frame_id: result.frame_id, error: result.error, duration_ms: result.duration_ms }));
  const skipped = results
    .filter(result => result.skipped)
    .map(result => ({ frame_id: result.frame_id, reason: result.skipped, duration_ms: result.duration_ms }));

  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;
  if (options.write ?? true) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      plugin_id: AI_VISUAL_FRAME_VIEW_STRATEGY_ID,
      related_views: stored.map(view => view.id).filter(isString),
      payload: {
        view_type: "visual_frame",
        strategy: AI_VISUAL_FRAME_VIEW_STRATEGY_ID,
        mode: "llm_vision",
        evidence_views_seen: evidenceViews.length,
        frame_candidates: candidates.length,
        concurrency,
        frame_attempts: results.length,
        views_compiled: stored.length,
        duration_ms: Date.now() - startedAt,
        max_frame_duration_ms: Math.max(0, ...results.map(result => result.duration_ms)),
        skipped,
        errors,
      },
    });
  }

  return {
    ok: true,
    compiler_id: AI_VISUAL_FRAME_VIEW_STRATEGY_ID,
    generated_at: generatedAt,
    views: stored,
    diagnostics: {
      strategy: AI_VISUAL_FRAME_VIEW_STRATEGY_ID,
      evidence_views_seen: evidenceViews.length,
      frame_candidates: candidates.length,
      concurrency,
      frame_attempts: results.length,
      produced: stored.length,
      duration_ms: Date.now() - startedAt,
      max_frame_duration_ms: Math.max(0, ...results.map(result => result.duration_ms)),
      skipped,
      errors,
    },
  };
}

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

function selectVisualFrameCandidates(evidenceViews: Array<ContextView | StoredContextView>, limit: number, sampleIntervalSecondsOption?: number): Array<{ frame_id: string; views: Array<ContextView | StoredContextView>; score: number }> {
  const byFrame = new Map<string, { frame_id: string; views: Array<ContextView | StoredContextView>; score: number }>();
  for (const view of evidenceViews) {
    if (isLowValueVisualEvidence(view)) continue;
    for (const frameId of frameIdsOf(view)) {
      const current = byFrame.get(frameId) ?? { frame_id: frameId, views: [], score: 0 };
      current.views.push(view);
      current.score += visualEvidenceScore(view);
      byFrame.set(frameId, current);
    }
  }
  const sampleIntervalSeconds = sampleIntervalSecondsOption ?? Number(process.env.RUNTIME_VISUAL_FRAME_SAMPLE_SECONDS ?? 45);
  const sampled = sampleCandidatesBySurface([...byFrame.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit > 0 ? limit : undefined), sampleIntervalSeconds);
  return sampled.sort((a, b) => b.score - a.score);
}

function sampleCandidatesBySurface<T extends { views: Array<ContextView | StoredContextView>; score: number }>(candidates: T[], intervalSeconds: number): T[] {
  if (intervalSeconds <= 0) return candidates;
  const byBucket = new Map<string, T>();
  for (const candidate of candidates) {
    const key = visualSurfaceKey(candidate.views);
    const time = candidateTime(candidate.views);
    const bucket = Number.isFinite(time) ? Math.floor(time / (intervalSeconds * 1000)) : 0;
    const sampleKey = `${key}:${bucket}`;
    const existing = byBucket.get(sampleKey);
    if (!existing || candidate.score > existing.score) byBucket.set(sampleKey, candidate);
  }
  return [...byBucket.values()];
}

async function analyzeFrameWithVision(
  frameId: string,
  evidenceViews: Array<ContextView | StoredContextView>,
  prompt: string,
  options: CompileVisualFrameViewsOptions,
): Promise<VisualFrameAnalyzerResponse> {
  const image = await fetchScreenpipeFrameImage(frameId);
  if (!image.ok) return { ok: false, error: image.error };
  const base64 = Buffer.from(image.bytes).toString("base64");
  const llm = await visionCompletion([
    {
      role: "system",
      content: "You are a visual memory view compiler. Use only visible evidence. Return strict JSON only.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${image.contentType};base64,${base64}` } },
      ],
    },
  ], {
    ...options.llm,
    model: options.model ?? process.env.VISION_LLM_MODEL ?? "qwen3-vl-235b-a22b-instruct",
    temperature: options.llm?.temperature ?? 0.1,
    max_tokens: options.llm?.max_tokens ?? 900,
    allow_external: options.llm?.allow_external ?? true,
  });
  if (!llm.ok || !llm.content) return { ok: false, model: llm.model, base_url: llm.base_url, error: llm.error ?? "vision failed" };
  const parsed = parseJsonObject(llm.content);
  if (!parsed) return { ok: false, raw: llm.content, model: llm.model, base_url: llm.base_url, error: "vision model did not return JSON" };
  return { ok: true, content: parsed, raw: llm.content, model: llm.model, base_url: llm.base_url };
}

async function analyzeActivityBlockWithText(prompt: string, options: CompileActivityBlockViewsOptions): Promise<ActivityBlockAnalyzerResponse> {
  const llm = await visionCompletion([
    { role: "system", content: "You are an activity block compiler for an ambient memory system. Return strict JSON only." },
    { role: "user", content: prompt },
  ], {
    ...options.llm,
    temperature: options.llm?.temperature ?? 0.1,
    max_tokens: options.llm?.max_tokens ?? 900,
    allow_external: options.llm?.allow_external ?? true,
  });
  if (!llm.ok || !llm.content) return { ok: false, model: llm.model, base_url: llm.base_url, error: llm.error ?? "activity block llm failed" };
  const parsed = parseJsonObject(llm.content);
  if (!parsed) return { ok: false, raw: llm.content, model: llm.model, base_url: llm.base_url, error: "activity block model did not return JSON" };
  return { ok: true, content: parsed, raw: llm.content, model: llm.model, base_url: llm.base_url };
}

function normalizeVisualFrameView(
  content: Record<string, unknown>,
  inputViews: Array<ContextView | StoredContextView>,
  frameId: string,
  generatedAt: string,
  llm: VisualFrameAnalyzerResponse,
): ContextView | undefined {
  const sourceViews = inputViews.map(view => view.id).filter(isString);
  const usefulFacts = stringArray(content.useful_facts);
  const visibleText = stringArray(content.visible_text_lines).slice(0, 40);
  const topic = stringValue(content.topic) ?? stringValue(content.screen_topic) ?? usefulFacts[0];
  const app = stringValue(content.app) ?? commonString(inputViews.map(view => stringValue(view.content?.subject && isRecord(view.content.subject) ? view.content.subject.app : undefined)));
  const confidence = clamp(numberValue(content.confidence) ?? 0.65);
  if (!topic && !usefulFacts.length && !visibleText.length) return undefined;
  return {
    id: `visual_frame:${frameId}`,
    view_type: "visual_frame",
    title: stringValue(content.title) ?? ([app, topic].filter(Boolean).join(" - ") || `Visual frame ${frameId}`),
    summary: stringValue(content.summary) ?? topic ?? `VisualFrameView for frame ${frameId}`,
    status: "candidate",
    source_records: unique(inputViews.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: AI_VISUAL_FRAME_VIEW_STRATEGY_ID, version: "1", mode: "llm" },
    purpose: "Use a vision model to extract screen semantics from a representative Screenpipe frame without writing long-term memory.",
    scope: { ...inputViews[0]?.scope, plugin_id: AI_VISUAL_FRAME_VIEW_STRATEGY_ID, time_range: mergedTimeRange(inputViews) },
    content: {
      kind: "screen_semantics",
      frame_id: frameId,
      app,
      project: stringValue(content.project),
      visible_files: stringArray(content.visible_files),
      topic,
      useful_facts: usefulFacts,
      visible_text_lines: visibleText,
      noise: stringArray(content.noise),
      missing_signals: stringArray(content.missing_signals),
      extracted_from: sourceViews,
    },
    confidence,
    stability: "session",
    lossiness: "high",
    privacy: { level: "private", retention: "normal", allow_llm_summary: true, allow_external_llm: true },
    metadata: {
      generated_at: generatedAt,
      strategy_id: AI_VISUAL_FRAME_VIEW_STRATEGY_ID,
      prompt_id: "visual_frame_v1",
      llm: { model: llm.model, base_url: llm.base_url },
    },
  };
}

function normalizeActivityBlockView(
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

function visualFramePrompt(inputViews: Array<ContextView | StoredContextView>, frameId: string): string {
  return [
    "Analyze this representative screen frame for an ambient memory system.",
    "Extract screen semantics that structured app/window data misses.",
    "Do not infer task completion unless it is visibly supported.",
    "Return JSON with keys: title, summary, app, project, visible_files, topic, useful_facts, visible_text_lines, noise, missing_signals, confidence.",
    `Frame id: ${frameId}`,
    "Supporting EvidenceViews:",
    renderViews(inputViews),
  ].join("\n\n");
}

function activityBlockPrompt(inputViews: Array<ContextView | StoredContextView>, timeRange: { start: string; end: string }): string {
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

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function shouldUseAudioInActivityBlock(view: ContextView | StoredContextView): boolean {
  const transcript = stringValue(view.content?.transcript) ?? stringValue(view.content?.transcript_excerpt) ?? view.summary;
  if (!transcript || transcript.replace(/\s+/g, "").length < 4) return false;
  const confidence = view.confidence ?? 0;
  return confidence >= 0.45;
}

function shouldUseActivityInVisualBlock(view: ContextView | StoredContextView): boolean {
  const kind = stringValue(view.content?.kind);
  if (kind === "app_focus") return false;
  return true;
}

function frameIdsOf(view: ContextView | StoredContextView): string[] {
  const signals = isRecord(view.content?.signals) ? view.content.signals : {};
  const attribution = isRecord(view.content?.attribution) ? view.content.attribution : {};
  const ids = [
    ...arrayOfStrings(signals.frame_ids),
    ...arrayOfStrings(attribution.frame_ids),
    stringValue(signals.frame_id),
    stringValue(attribution.frame_id),
  ].filter(isString);
  return unique(ids);
}

function isLowValueVisualEvidence(view: ContextView | StoredContextView): boolean {
  const subject = isRecord(view.content?.subject) ? view.content.subject : {};
  const app = (stringValue(subject.app) ?? stringValue(view.scope?.app) ?? "").toLowerCase();
  const title = `${view.title ?? ""} ${stringValue(subject.title) ?? ""}`.toLowerCase();
  if (/screenpipe.*record|node .*screenpipe record/.test(title)) return true;
  if (/terminal\s*-\s*ocr/i.test(title)) return true;
  if (/^\s*terminal\s*$/i.test(app) && !looksLikeUsefulTerminalText(view)) return true;
  if (["finder"].includes(app) && !stringValue(view.content?.text)) return true;
  return false;
}

function visualEvidenceScore(view: ContextView | StoredContextView): number {
  const subject = isRecord(view.content?.subject) ? view.content.subject : {};
  const app = (stringValue(subject.app) ?? stringValue(view.scope?.app) ?? "").toLowerCase();
  let score = view.confidence ?? 0.5;
  if (/code|cursor|warp|terminal|chrome|chatgpt|atlas/.test(app)) score += 0.3;
  if (stringValue(view.content?.text)) score += 0.15;
  if (stringValue(subject.title)) score += 0.1;
  return score;
}

function visualSurfaceKey(views: Array<ContextView | StoredContextView>): string {
  const view = views[0];
  const subject = isRecord(view?.content?.subject) ? view.content.subject : {};
  const app = normalizeSurfacePart(stringValue(subject.app) ?? stringValue(view?.scope?.app));
  const title = normalizeSurfacePart(stringValue(subject.title) ?? view?.title);
  const url = normalizeSurfacePart(stringValue(subject.url));
  return [app, title, url].filter(Boolean).join("|") || "unknown";
}

function candidateTime(views: Array<ContextView | StoredContextView>): number {
  const rangeTimes = views
    .flatMap(view => [view.scope?.time_range?.end, view.scope?.time_range?.start])
    .filter(isString)
    .map(Date.parse)
    .filter(Number.isFinite);
  if (rangeTimes.length) return Math.max(...rangeTimes);
  const times = views
    .flatMap(view => ["updated_at" in view ? view.updated_at : undefined])
    .filter(isString)
    .map(Date.parse)
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

function normalizeSurfacePart(value?: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[⠁-⣿]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function looksLikeUsefulTerminalText(view: ContextView | StoredContextView): boolean {
  const text = [
    stringValue(view.content?.text),
    stringValue(isRecord(view.content?.signals) ? view.content.signals.text : undefined),
    view.title,
  ].filter(Boolean).join("\n").toLowerCase();
  return /error|failed|exception|pnpm|npm|node|pytest|tsx|git|commit|diff|src\/|tests?\/|\.ts|\.tsx|\.py|sqlite|visual|memory|screenpipe/.test(text);
}

function rangeForViews(views: Array<ContextView | StoredContextView>, generatedAt: string, minutes: number): { start: string; end: string } {
  const ranges = views.map(view => view.scope?.time_range).filter(Boolean);
  const starts = ranges.map(range => Date.parse(range?.start ?? range?.end ?? "")).filter(Number.isFinite);
  const ends = ranges.map(range => Date.parse(range?.end ?? range?.start ?? "")).filter(Number.isFinite);
  const end = ends.length ? new Date(Math.max(...ends)).toISOString() : generatedAt;
  const start = starts.length ? new Date(Math.min(...starts)).toISOString() : new Date(Date.parse(end) - minutes * 60_000).toISOString();
  return { start, end };
}

function mergedTimeRange(views: Array<ContextView | StoredContextView>): { start?: string; end?: string } | undefined {
  const starts = views.map(view => view.scope?.time_range?.start).filter(isString).map(Date.parse).filter(Number.isFinite);
  const ends = views.map(view => view.scope?.time_range?.end).filter(isString).map(Date.parse).filter(Number.isFinite);
  if (!starts.length && !ends.length) return undefined;
  return {
    start: starts.length ? new Date(Math.min(...starts)).toISOString() : undefined,
    end: ends.length ? new Date(Math.max(...ends)).toISOString() : undefined,
  };
}

function renderViews(views: Array<ContextView | StoredContextView>): string {
  return JSON.stringify(views.map(view => ({
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    source_views: view.source_views,
    scope: view.scope,
    content: view.content,
    confidence: view.confidence,
  })), null, 2);
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function uniqueViews<T extends ContextView | StoredContextView>(views: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const view of views) {
    const key = view.id ?? `${view.view_type}:${view.title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(view);
  }
  return out;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeScore(value: unknown): number | undefined {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
  if (raw === undefined) return undefined;
  if (raw > 1 && raw <= 10) return clamp(raw / 10);
  if (raw > 10 && raw <= 100) return clamp(raw / 100);
  return clamp(raw);
}

function signalValue(value: unknown): "none" | "weak" | "strong" {
  const signal = stringValue(value)?.toLowerCase();
  return signal === "weak" || signal === "strong" ? signal : "none";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => stringValue(item)).filter(isString);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === "number" ? String(item) : stringValue(item)).filter(isString);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commonString(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values.filter(isString)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

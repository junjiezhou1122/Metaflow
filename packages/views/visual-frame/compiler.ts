import { fetchScreenpipeFrameImage } from "../../connectors/screenpipe/index.js";
import { loadDotEnv } from "@info/core";
import { parseJsonObject, visionCompletion, type LlmOptions } from "@info/core";
import { ContextStore } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";
import {
  arrayOfStrings,
  clamp,
  commonString,
  isRecord,
  isString,
  mergedTimeRange,
  numberValue,
  renderViews,
  sampleCandidatesBySurface,
  stringArray,
  stringValue,
  unique,
  type VisualFrameAnalyzerResponse,
} from "./shared.js";

export const AI_VISUAL_FRAME_VIEW_STRATEGY_ID = "ai.visual.frame";

export type VisualFrameAnalyzerRequest = {
  frame_id: string;
  mime_type: string;
  base64_image: string;
  evidence_views: Array<ContextView | StoredContextView>;
  prompt: string;
};

export type { VisualFrameAnalyzerResponse };

export type VisualFrameAnalyzer = (request: VisualFrameAnalyzerRequest) => Promise<VisualFrameAnalyzerResponse>;

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

export function selectVisualFrameCandidates(evidenceViews: Array<ContextView | StoredContextView>, limit: number, sampleIntervalSecondsOption?: number): Array<{ frame_id: string; views: Array<ContextView | StoredContextView>; score: number }> {
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

async function analyzeFrameWithVision(
  frameId: string,
  evidenceViews: Array<ContextView | StoredContextView>,
  prompt: string,
  options: CompileVisualFrameViewsOptions,
): Promise<VisualFrameAnalyzerResponse> {
  loadDotEnv();
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
    base_url: options.llm?.base_url ?? process.env.VISION_LLM_BASE_URL,
    api_key: options.llm?.api_key ?? process.env.VISION_LLM_API_KEY,
    model: options.model ?? process.env.VISION_LLM_MODEL ?? "qwen3-vl-235b-a22b-instruct",
    temperature: options.llm?.temperature ?? 0.1,
    max_tokens: options.llm?.max_tokens ?? (Number(process.env.VISION_LLM_MAX_TOKENS || 0) || undefined),
    omit_max_tokens: options.llm?.max_tokens === undefined && !process.env.VISION_LLM_MAX_TOKENS,
    allow_external: options.llm?.allow_external ?? true,
  });
  if (!llm.ok || !llm.content) return { ok: false, model: llm.model, base_url: llm.base_url, error: llm.error ?? "vision failed" };
  const parsed = parseJsonObject(llm.content);
  if (!parsed) return { ok: false, raw: llm.content, model: llm.model, base_url: llm.base_url, error: "vision model did not return JSON" };
  return { ok: true, content: parsed, raw: llm.content, model: llm.model, base_url: llm.base_url };
}

export function normalizeVisualFrameView(
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

export function visualFramePrompt(inputViews: Array<ContextView | StoredContextView>, frameId: string): string {
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

export function frameIdsOf(view: ContextView | StoredContextView): string[] {
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

export function isLowValueVisualEvidence(view: ContextView | StoredContextView): boolean {
  const subject = isRecord(view.content?.subject) ? view.content.subject : {};
  const app = (stringValue(subject.app) ?? stringValue(view.scope?.app) ?? "").toLowerCase();
  const title = `${view.title ?? ""} ${stringValue(subject.title) ?? ""}`.toLowerCase();
  if (/screenpipe.*record|node .*screenpipe record/.test(title)) return true;
  if (/terminal\s*-\s*ocr/i.test(title)) return true;
  if (/^\s*terminal\s*$/i.test(app) && !looksLikeUsefulTerminalText(view)) return true;
  if (["finder"].includes(app) && !stringValue(view.content?.text)) return true;
  return false;
}

export function visualEvidenceScore(view: ContextView | StoredContextView): number {
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

import { createHash } from "node:crypto";
import { chatCompletion, parseJsonObject, type LlmOptions } from "@info/core";
import { ContextStore } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";

export const AI_AUDIO_VIEW_STRATEGY_ID = "ai.audio.semantic";

export type AudioViewAnalyzerRequest = {
  prompt: string;
  evidence_views: Array<ContextView | StoredContextView>;
};

export type AudioViewAnalyzerResponse = {
  ok: boolean;
  content?: Record<string, unknown>;
  raw?: string;
  model?: string;
  base_url?: string;
  error?: string;
};

export type AudioViewAnalyzer = (request: AudioViewAnalyzerRequest) => Promise<AudioViewAnalyzerResponse>;

export type CompileAudioViewsOptions = {
  write?: boolean;
  llm?: LlmOptions;
  limit?: number;
  evidenceViews?: Array<ContextView | StoredContextView>;
  analyzer?: AudioViewAnalyzer;
};

export type CompileAudioViewsResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  diagnostics: Record<string, unknown>;
};

export async function compileAudioViews(options: CompileAudioViewsOptions = {}, store = new ContextStore()): Promise<CompileAudioViewsResult> {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? Number(process.env.RUNTIME_AUDIO_VIEW_LIMIT ?? 0);
  const evidenceViews = (options.evidenceViews ?? store.listViews({
    view_types: ["evidence"],
    active_only: true,
    limit: limit > 0 ? Math.max(limit * 4, 50) : 0,
  })).filter(view => view.view_type === "evidence");
  const candidates = selectAudioCandidates(evidenceViews, limit);
  const existingIds = new Set(store.listViews({ view_types: ["audio"], active_only: true, limit: 0 }).map(view => view.id));
  const errors: Array<{ key: string; error: string }> = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const views: ContextView[] = [];

  for (const candidate of candidates) {
    const viewId = audioViewId(candidate);
    if (existingIds.has(viewId)) {
      skipped.push({ key: candidate.key, reason: "existing_audio_view" });
      continue;
    }
    const prompt = audioPrompt(candidate.views);
    const response = options.analyzer
      ? await options.analyzer({ prompt, evidence_views: candidate.views })
      : await analyzeAudioWithLlm(prompt, options.llm);
    if (!response.ok || !response.content) {
      errors.push({ key: candidate.key, error: response.error ?? "empty audio response" });
      views.push(normalizeAudioView({}, candidate.views, generatedAt, { ...response, ok: false, error: response.error ?? "fallback_without_llm" }, viewId));
      continue;
    }
    views.push(normalizeAudioView(response.content, candidate.views, generatedAt, response, viewId));
  }

  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;
  if (options.write ?? true) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      plugin_id: AI_AUDIO_VIEW_STRATEGY_ID,
      related_views: stored.map(view => view.id).filter(isString),
      payload: {
        view_type: "audio",
        strategy: AI_AUDIO_VIEW_STRATEGY_ID,
        mode: "hybrid_llm_with_fallback",
        evidence_views_seen: evidenceViews.length,
        audio_candidates: candidates.length,
        views_compiled: stored.length,
        skipped,
        errors,
      },
    });
  }

  return {
    ok: true,
    compiler_id: AI_AUDIO_VIEW_STRATEGY_ID,
    generated_at: generatedAt,
    views: stored,
    diagnostics: {
      strategy: AI_AUDIO_VIEW_STRATEGY_ID,
      evidence_views_seen: evidenceViews.length,
      audio_candidates: candidates.length,
      produced: stored.length,
      skipped,
      errors,
    },
  };
}

function selectAudioCandidates(evidenceViews: Array<ContextView | StoredContextView>, limit: number): Array<{ key: string; views: Array<ContextView | StoredContextView> }> {
  const byKey = new Map<string, Array<ContextView | StoredContextView>>();
  for (const view of evidenceViews) {
    if (view.content?.kind !== "audio") continue;
    const transcript = transcriptOf(view);
    if (!transcript || transcript.replace(/\s+/g, "").length < 3) continue;
    const key = audioKeyOf(view);
    const bucket = byKey.get(key) ?? [];
    bucket.push(view);
    byKey.set(key, bucket);
  }
  const candidates = [...byKey.entries()]
    .map(([key, views]) => ({ key, views: views.sort((a, b) => timeOf(a) - timeOf(b)) }))
    .sort((a, b) => timeOfMany(b.views) - timeOfMany(a.views));
  return limit > 0 ? candidates.slice(0, limit) : candidates;
}

function audioViewId(candidate: { key: string; views: Array<ContextView | StoredContextView> }): string {
  const chunkId = commonString(candidate.views.map(view => audioField(view, "audio_chunk_id") ?? audioField(view, "chunk_id")));
  if (chunkId) return `audio:chunk:${stableKey(chunkId)}`;
  return `audio:evidence:${stableKey(candidate.views.map(view => view.id).filter(isString).join("|"))}`;
}

async function analyzeAudioWithLlm(prompt: string, llm?: LlmOptions): Promise<AudioViewAnalyzerResponse> {
  const response = await chatCompletion([
    {
      role: "system",
      content: [
        "You are an AudioView compiler for a personal memory system.",
        "Use only the provided transcript evidence. Do not invent facts.",
        "Return strict JSON only.",
        "Keep Chinese when the transcript is Chinese.",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], llm);
  if (!response.ok || !response.content) return { ok: false, model: response.model, base_url: response.base_url, error: response.error ?? "llm failed" };
  const parsed = parseJsonObject(response.content);
  if (!parsed) return { ok: false, raw: response.content, model: response.model, base_url: response.base_url, error: "LLM did not return JSON object" };
  return { ok: true, content: parsed, raw: response.content, model: response.model, base_url: response.base_url };
}

function normalizeAudioView(content: Record<string, unknown>, inputViews: Array<ContextView | StoredContextView>, generatedAt: string, llm: AudioViewAnalyzerResponse, id: string): ContextView {
  const sourceViews = inputViews.map(view => view.id).filter(isString);
  const transcripts = inputViews.map(transcriptOf).filter(isString);
  const transcript = transcripts.join("\n").slice(0, 6000);
  const speaker = stringValue(content.speaker_label) ?? commonString(inputViews.map(view => audioField(view, "speaker_label"))) ?? commonString(inputViews.map(view => audioField(view, "speaker_id")));
  const device = stringValue(content.device_name) ?? commonString(inputViews.map(view => audioField(view, "device_name")));
  const kind = stringValue(content.kind) ?? "transcript_semantics";
  const summary = stringValue(content.summary) ?? (transcript.slice(0, 220) || "Audio transcript semantics.");
  const title = stringValue(content.title) ?? `Audio: ${summary.slice(0, 80)}`;
  const scopeSource = inputViews[0];
  const confidence = clamp(numberValue(content.confidence) ?? (llm.ok ? 0.72 : 0.5));
  return {
    id,
    view_type: "audio",
    title,
    summary,
    status: "candidate",
    source_records: unique(inputViews.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: AI_AUDIO_VIEW_STRATEGY_ID, version: "1", mode: "hybrid" },
    purpose: "AI-compressed semantic view of Screenpipe audio transcripts. It preserves transcript provenance and feeds ActivityBlock/Intent/Workflow compilers.",
    scope: { ...scopeSource?.scope, plugin_id: AI_AUDIO_VIEW_STRATEGY_ID, time_range: mergedTimeRange(inputViews) },
    content: {
      kind,
      transcript,
      transcript_excerpt: transcript.slice(0, 800),
      speaker_label: speaker,
      device_name: device,
      topics: stringArray(content.topics),
      stated_intents: stringArray(content.stated_intents),
      decisions: stringArray(content.decisions),
      action_items: stringArray(content.action_items),
      open_questions: stringArray(content.open_questions),
      useful_quotes: stringArray(content.useful_quotes),
      noise: stringArray(content.noise),
      transcript_quality: stringValue(content.transcript_quality) ?? (llm.ok ? "unknown" : "llm_unavailable_fallback"),
      extracted_from: sourceViews,
    },
    confidence,
    stability: "session",
    lossiness: llm.ok ? "medium" : "low",
    privacy: scopeSource?.privacy ?? { level: "private", retention: "normal", allow_llm_summary: true, allow_external_llm: false },
    metadata: {
      generated_at: generatedAt,
      algorithm: AI_AUDIO_VIEW_STRATEGY_ID,
      llm: { ok: llm.ok, model: llm.model, base_url: llm.base_url, error: llm.error },
    },
  };
}

function audioPrompt(inputViews: Array<ContextView | StoredContextView>): string {
  return [
    "Compile one AudioView from these EvidenceViews.",
    "AudioView is not durable memory. It is a semantic transcript node that later compilers can consume.",
    "Return JSON with keys: title, summary, kind, transcript_quality, speaker_label, device_name, topics, stated_intents, decisions, action_items, open_questions, useful_quotes, noise, confidence.",
    "If transcript is fragmentary, say so in transcript_quality and keep confidence lower.",
    renderViews(inputViews),
  ].join("\n\n");
}

function renderViews(views: Array<ContextView | StoredContextView>): string {
  return JSON.stringify(views.map(view => ({
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    source_records: view.source_records,
    scope: view.scope,
    content: view.content,
    confidence: view.confidence,
  })), null, 2);
}

function audioKeyOf(view: ContextView | StoredContextView): string {
  const chunkId = audioField(view, "audio_chunk_id") ?? audioField(view, "chunk_id");
  if (chunkId) return `chunk:${chunkId}`;
  const speaker = audioField(view, "speaker_label") ?? audioField(view, "speaker_id") ?? "speaker";
  const time = timeOf(view);
  const bucket = Number.isFinite(time) ? Math.floor(time / 30_000) : 0;
  return `bucket:${speaker}:${bucket}`;
}

function transcriptOf(view: ContextView | StoredContextView): string | undefined {
  const signals = isRecord(view.content?.signals) ? view.content.signals : undefined;
  const audio = isRecord(signals?.audio) ? signals.audio : undefined;
  return stringValue(audio?.transcript) ?? stringValue(signals?.text) ?? stringValue(view.content?.text) ?? view.summary;
}

function audioField(view: ContextView | StoredContextView, key: string): string | undefined {
  const signals = isRecord(view.content?.signals) ? view.content.signals : undefined;
  const audio = isRecord(signals?.audio) ? signals.audio : undefined;
  const data = isRecord(view.content?.data) ? view.content.data : undefined;
  return stringValue(audio?.[key]) ?? stringValue(data?.[key]);
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

function timeOfMany(views: Array<ContextView | StoredContextView>): number {
  return Math.max(0, ...views.map(timeOf).filter(Number.isFinite));
}

function timeOf(view: ContextView | StoredContextView): number {
  const stored = view as StoredContextView;
  return Date.parse(view.scope?.time_range?.start ?? view.scope?.time_range?.end ?? stored.created_at ?? stored.updated_at ?? "") || 0;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function commonString(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values.filter(isString)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === "number" ? String(item) : stringValue(item)).filter(isString);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

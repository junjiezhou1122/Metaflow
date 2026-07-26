import { createHash } from "node:crypto";
import { parseJsonObject, visionCompletion, type LlmOptions } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";

export type VisualFrameAnalyzerResponse = {
  ok: boolean;
  content?: Record<string, unknown>;
  raw?: string;
  model?: string;
  base_url?: string;
  error?: string;
};

export function sampleCandidatesBySurface<T extends { views: Array<ContextView | StoredContextView>; score: number }>(candidates: T[], intervalSeconds: number): T[] {
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

export async function analyzeActivityBlockWithText(prompt: string, options: { llm?: LlmOptions }): Promise<VisualFrameAnalyzerResponse> {
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

export function shouldUseAudioInActivityBlock(view: ContextView | StoredContextView): boolean {
  const transcript = stringValue(view.content?.transcript) ?? stringValue(view.content?.transcript_excerpt) ?? view.summary;
  if (!transcript || transcript.replace(/\s+/g, "").length < 4) return false;
  const confidence = view.confidence ?? 0;
  return confidence >= 0.45;
}

export function shouldUseActivityInVisualBlock(view: ContextView | StoredContextView): boolean {
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

export function rangeForViews(views: Array<ContextView | StoredContextView>, generatedAt: string, minutes: number): { start: string; end: string } {
  const ranges = views.map(view => view.scope?.time_range).filter(Boolean);
  const starts = ranges.map(range => Date.parse(range?.start ?? range?.end ?? "")).filter(Number.isFinite);
  const ends = ranges.map(range => Date.parse(range?.end ?? range?.start ?? "")).filter(Number.isFinite);
  const end = ends.length ? new Date(Math.max(...ends)).toISOString() : generatedAt;
  const start = starts.length ? new Date(Math.min(...starts)).toISOString() : new Date(Date.parse(end) - minutes * 60_000).toISOString();
  return { start, end };
}

export function mergedTimeRange(views: Array<ContextView | StoredContextView>): { start?: string; end?: string } | undefined {
  const starts = views.map(view => view.scope?.time_range?.start).filter(isString).map(Date.parse).filter(Number.isFinite);
  const ends = views.map(view => view.scope?.time_range?.end).filter(isString).map(Date.parse).filter(Number.isFinite);
  if (!starts.length && !ends.length) return undefined;
  return {
    start: starts.length ? new Date(Math.min(...starts)).toISOString() : undefined,
    end: ends.length ? new Date(Math.max(...ends)).toISOString() : undefined,
  };
}

export function renderViews(views: Array<ContextView | StoredContextView>): string {
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

export function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function uniqueViews<T extends ContextView | StoredContextView>(views: T[]): T[] {
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

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeScore(value: unknown): number | undefined {
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

export function signalValue(value: unknown): "none" | "weak" | "strong" {
  const signal = stringValue(value)?.toLowerCase();
  return signal === "weak" || signal === "strong" ? signal : "none";
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => stringValue(item)).filter(isString);
}

export function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === "number" ? String(item) : stringValue(item)).filter(isString);
}

export function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function commonString(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values.filter(isString)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

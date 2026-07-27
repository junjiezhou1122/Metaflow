import type { JsonValue } from "@info/view/schema";
import type { WebRendererInput } from "../contracts.js";

export type ExactProductRef = { view_id: string; revision: number };
export type PersonalAudioValue = {
  version: 1;
  started_at: string;
  ended_at: string;
  transcript: string;
  segments: Array<{ start_ms: number; end_ms: number; speaker: string; text: string }>;
  summary: string;
  topics: string[];
  decisions: string[];
  action_items: string[];
};
export type PersonalTimelineValue = {
  version: 1;
  date: string;
  timezone: string;
  started_at: string;
  ended_at: string;
  blocks: Array<{
    started_at: string;
    ended_at: string;
    title: string;
    summary: string;
    entries: Array<{ source_ref: ExactProductRef; occurred_at: string; kind: "audio" | "browser" | "application" | "project" | "other"; title: string; detail: string }>;
  }>;
  signals: { top_topics: string[]; decisions: string[]; unfinished_threads: string[] };
};
export type PersonalDailySummaryValue = {
  version: 1;
  date: string;
  headline: string;
  overview: string;
  themes: Array<{ title: string; narrative: string; highlights: string[] }>;
  decisions: string[];
  unfinished_threads: string[];
  tomorrow: string[];
  source_timeline: ExactProductRef;
};

export function parsePersonalAudioValue(input: WebRendererInput, kind: string): PersonalAudioValue {
  const value = inlineRecord(input, kind);
  return {
    version: literalVersion(value.version),
    started_at: timestamp(value.started_at, "started_at"),
    ended_at: timestamp(value.ended_at, "ended_at"),
    transcript: text(value.transcript, "transcript"),
    segments: records(value.segments, "segments").map((segment, index) => ({
      start_ms: integer(segment.start_ms, `segments[${index}].start_ms`),
      end_ms: integer(segment.end_ms, `segments[${index}].end_ms`),
      speaker: text(segment.speaker, `segments[${index}].speaker`),
      text: text(segment.text, `segments[${index}].text`),
    })),
    summary: text(value.summary, "summary"),
    topics: strings(value.topics, "topics"),
    decisions: strings(value.decisions, "decisions"),
    action_items: strings(value.action_items, "action_items"),
  };
}

export function parsePersonalTimelineValue(input: WebRendererInput, kind: string): PersonalTimelineValue {
  const value = inlineRecord(input, kind);
  return {
    version: literalVersion(value.version),
    date: date(value.date, "date"),
    timezone: text(value.timezone, "timezone"),
    started_at: timestamp(value.started_at, "started_at"),
    ended_at: timestamp(value.ended_at, "ended_at"),
    blocks: records(value.blocks, "blocks").map((block, blockIndex) => ({
      started_at: timestamp(block.started_at, `blocks[${blockIndex}].started_at`),
      ended_at: timestamp(block.ended_at, `blocks[${blockIndex}].ended_at`),
      title: text(block.title, `blocks[${blockIndex}].title`),
      summary: text(block.summary, `blocks[${blockIndex}].summary`),
      entries: records(block.entries, `blocks[${blockIndex}].entries`).map((entry, entryIndex) => ({
        source_ref: exactRef(entry.source_ref, `blocks[${blockIndex}].entries[${entryIndex}].source_ref`),
        occurred_at: timestamp(entry.occurred_at, `blocks[${blockIndex}].entries[${entryIndex}].occurred_at`),
        kind: activityKind(entry.kind, `blocks[${blockIndex}].entries[${entryIndex}].kind`),
        title: text(entry.title, `blocks[${blockIndex}].entries[${entryIndex}].title`),
        detail: text(entry.detail, `blocks[${blockIndex}].entries[${entryIndex}].detail`),
      })),
    })),
    signals: parseSignals(value.signals),
  };
}

export function parsePersonalDailySummaryValue(input: WebRendererInput, kind: string): PersonalDailySummaryValue {
  const value = inlineRecord(input, kind);
  return {
    version: literalVersion(value.version),
    date: date(value.date, "date"),
    headline: text(value.headline, "headline"),
    overview: text(value.overview, "overview"),
    themes: records(value.themes, "themes").map((theme, index) => ({
      title: text(theme.title, `themes[${index}].title`),
      narrative: text(theme.narrative, `themes[${index}].narrative`),
      highlights: strings(theme.highlights, `themes[${index}].highlights`),
    })),
    decisions: strings(value.decisions, "decisions"),
    unfinished_threads: strings(value.unfinished_threads, "unfinished_threads"),
    tomorrow: strings(value.tomorrow, "tomorrow"),
    source_timeline: exactRef(value.source_timeline, "source_timeline"),
  };
}

function inlineRecord(input: WebRendererInput, kind: string): Record<string, JsonValue> {
  if (input.representation.form !== "inline" || input.representation.kind !== kind) {
    throw new TypeError(`Renderer requires inline ${kind} Representation`);
  }
  return record(input.representation.value, `${kind} Representation`);
}

function parseSignals(value: JsonValue | undefined): PersonalTimelineValue["signals"] {
  const signals = record(value, "signals");
  return {
    top_topics: strings(signals.top_topics, "signals.top_topics"),
    decisions: strings(signals.decisions, "signals.decisions"),
    unfinished_threads: strings(signals.unfinished_threads, "signals.unfinished_threads"),
  };
}

function record(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function records(value: JsonValue | undefined, label: string): Array<Record<string, JsonValue>> {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function strings(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new TypeError(`${label} must be a string array`);
  return value as string[];
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function literalVersion(value: JsonValue | undefined): 1 {
  if (value !== 1) throw new TypeError("product View version must be 1");
  return 1;
}

function timestamp(value: JsonValue | undefined, label: string): string {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new TypeError(`${label} must be an RFC 3339 timestamp`);
  return parsed;
}

function date(value: JsonValue | undefined, label: string): string {
  const parsed = text(value, label);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(parsed)) throw new TypeError(`${label} must be an ISO date`);
  return parsed;
}

function exactRef(value: JsonValue | undefined, label: string): ExactProductRef {
  const ref = record(value, label);
  const viewId = text(ref.view_id, `${label}.view_id`);
  const revision = integer(ref.revision, `${label}.revision`);
  if (revision < 1) throw new TypeError(`${label}.revision must be positive`);
  return { view_id: viewId, revision };
}

function activityKind(value: JsonValue | undefined, label: string): PersonalTimelineValue["blocks"][number]["entries"][number]["kind"] {
  if (value === "audio" || value === "browser" || value === "application" || value === "project" || value === "other") return value;
  throw new TypeError(`${label} is unsupported`);
}

export function formatClock(value: string): string {
  const dateValue = new Date(value);
  if (Number.isNaN(dateValue.getTime())) throw new TypeError(`Invalid product View timestamp: ${value}`);
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(dateValue);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

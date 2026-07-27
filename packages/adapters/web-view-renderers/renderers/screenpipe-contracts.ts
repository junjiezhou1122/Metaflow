import type { JsonValue } from "@info/view/schema";
import type { WebRendererInput } from "../contracts.js";

export type ExactScreenpipeRef = { view_id: string; revision: number };
export type ScreenpipePeriod = { start: string; end: string; timezone: string };
export type ScreenpipeAudioValue = {
  contract_version: 1;
  period: ScreenpipePeriod;
  sources: Array<{ relation: "derived_from"; view: ExactScreenpipeRef }>;
  segments: Array<{
    at: string;
    source: ExactScreenpipeRef;
    text: string;
    device_type: "Input" | "Output";
    device_name?: string;
    speaker?: string;
    start_seconds?: number;
    end_seconds?: number;
  }>;
  transcript: string;
  stats: { source_count: number; segment_count: number; input_segments: number; output_segments: number };
};
export type ScreenpipeTimelineValue = {
  contract_version: 1;
  period: ScreenpipePeriod;
  sources: Array<{ relation: "derived_from"; view: ExactScreenpipeRef }>;
  entries: Array<{
    at: string;
    modality: "screen" | "audio" | "input" | "accessibility" | "element" | "activity";
    source: ExactScreenpipeRef;
    label: string;
    text?: string;
    app?: string;
    window?: string;
    url?: string;
  }>;
  stats: { source_count: number; counts_by_modality: Record<string, number> };
};

export function parseScreenpipeAudioValue(input: WebRendererInput): ScreenpipeAudioValue {
  const value = inlineRecord(input, "screenpipe_audio");
  return {
    contract_version: literalVersion(value.contract_version),
    period: period(value.period),
    sources: sources(value.sources),
    segments: records(value.segments, "segments").map((segment, index) => ({
      at: timestamp(segment.at, `segments[${index}].at`),
      source: exactRef(segment.source, `segments[${index}].source`),
      text: text(segment.text, `segments[${index}].text`),
      device_type: deviceType(segment.device_type, `segments[${index}].device_type`),
      ...optionalText(segment.device_name, "device_name"),
      ...optionalText(segment.speaker, "speaker"),
      ...optionalNumber(segment.start_seconds, "start_seconds"),
      ...optionalNumber(segment.end_seconds, "end_seconds"),
    })),
    transcript: stringValue(value.transcript, "transcript"),
    stats: audioStats(value.stats),
  };
}

export function parseScreenpipeTimelineValue(input: WebRendererInput): ScreenpipeTimelineValue {
  const value = inlineRecord(input, "screenpipe_timeline");
  return {
    contract_version: literalVersion(value.contract_version),
    period: period(value.period),
    sources: sources(value.sources),
    entries: records(value.entries, "entries").map((entry, index) => ({
      at: timestamp(entry.at, `entries[${index}].at`),
      modality: modality(entry.modality, `entries[${index}].modality`),
      source: exactRef(entry.source, `entries[${index}].source`),
      label: text(entry.label, `entries[${index}].label`),
      ...optionalText(entry.text, "text"),
      ...optionalText(entry.app, "app"),
      ...optionalText(entry.window, "window"),
      ...optionalText(entry.url, "url"),
    })),
    stats: timelineStats(value.stats),
  };
}

function inlineRecord(input: WebRendererInput, kind: string): Record<string, JsonValue> {
  if (input.representation.form !== "inline" || input.representation.kind !== kind) {
    throw new TypeError(`Screenpipe Renderer requires inline ${kind} Representation`);
  }
  return record(input.representation.value, `${kind} Representation`);
}

function period(value: JsonValue | undefined): ScreenpipePeriod {
  const item = record(value, "period");
  return {
    start: timestamp(item.start, "period.start"),
    end: timestamp(item.end, "period.end"),
    timezone: text(item.timezone, "period.timezone"),
  };
}

function sources(value: JsonValue | undefined): ScreenpipeAudioValue["sources"] {
  return records(value, "sources").map((source, index) => {
    if (source.relation !== "derived_from") throw new TypeError(`sources[${index}].relation must be derived_from`);
    return { relation: "derived_from", view: exactRef(source.view, `sources[${index}].view`) };
  });
}

function audioStats(value: JsonValue | undefined): ScreenpipeAudioValue["stats"] {
  const stats = record(value, "stats");
  return {
    source_count: integer(stats.source_count, "stats.source_count"),
    segment_count: integer(stats.segment_count, "stats.segment_count"),
    input_segments: integer(stats.input_segments, "stats.input_segments"),
    output_segments: integer(stats.output_segments, "stats.output_segments"),
  };
}

function timelineStats(value: JsonValue | undefined): ScreenpipeTimelineValue["stats"] {
  const stats = record(value, "stats");
  const counts = record(stats.counts_by_modality, "stats.counts_by_modality");
  return {
    source_count: integer(stats.source_count, "stats.source_count"),
    counts_by_modality: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, integer(count, `stats.counts_by_modality.${key}`)])),
  };
}

function record(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function records(value: JsonValue | undefined, label: string): Array<Record<string, JsonValue>> {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function exactRef(value: JsonValue | undefined, label: string): ExactScreenpipeRef {
  const item = record(value, label);
  return { view_id: text(item.view_id, `${label}.view_id`), revision: positiveInteger(item.revision, `${label}.revision`) };
}

function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  return value;
}

function timestamp(value: JsonValue | undefined, label: string): string {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new TypeError(`${label} must be an RFC 3339 timestamp`);
  return parsed;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value: JsonValue | undefined, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 1) throw new TypeError(`${label} must be positive`);
  return parsed;
}

function literalVersion(value: JsonValue | undefined): 1 {
  if (value !== 1) throw new TypeError("Screenpipe View contract_version must be 1");
  return 1;
}

function optionalText(value: JsonValue | undefined, key: string): Record<string, string> {
  return value === undefined ? {} : { [key]: text(value, key) };
}

function optionalNumber(value: JsonValue | undefined, key: string): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative number`);
  return { [key]: value };
}

function deviceType(value: JsonValue | undefined, label: string): "Input" | "Output" {
  if (value === "Input" || value === "Output") return value;
  throw new TypeError(`${label} is unsupported`);
}

function modality(value: JsonValue | undefined, label: string): ScreenpipeTimelineValue["entries"][number]["modality"] {
  if (value === "screen" || value === "audio" || value === "input" || value === "accessibility" || value === "element" || value === "activity") return value;
  throw new TypeError(`${label} is unsupported`);
}

export function formatScreenpipeClock(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

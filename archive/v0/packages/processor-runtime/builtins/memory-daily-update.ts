import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const MEMORY_DAILY_UPDATE_PROCESSOR_ID = "processor.memory_daily_update";
export const MEMORY_DAILY_VIEW_TYPE = "memory.daily";

export type MemoryDailyUpdateOptions = {
  now?: Date;
  recordLimit?: number;
  viewLimit?: number;
  timezone?: string;
};

export function createMemoryDailyUpdateProcessor(options: MemoryDailyUpdateOptions = {}): ProcessorDefinition {
  return {
    id: MEMORY_DAILY_UPDATE_PROCESSOR_ID,
    title: "Memory Daily Update",
    version: "0.0.1",
    description: "Builds an accepted markdown-backed daily memory from recent observations and core context views.",
    consumes: {
      observations: ["observation.*", "feedback.*"],
      views: ["state.surface", "timeline.activity", "activity", "project.current", "work.focus_set", "memory.daily"],
    },
    produces: { views: [MEMORY_DAILY_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "background", autonomy: "draft", privacy: "private" },
    handler: memoryDailyUpdateHandler(options),
  };
}

export function memoryDailyUpdateHandler(options: MemoryDailyUpdateOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    const date = isoDate(now, timezone);
    const generatedAt = now.toISOString();
    const bounds = localDayUtcBounds(date, timezone);
    const records = context.store.recent(options.recordLimit ?? 80, undefined, {
      start_time: bounds.start,
      end_time: bounds.end,
    }).filter(isDailyRecord);
    const views = context.store.listViews({
      view_types: ["state.surface", "timeline.activity", "activity", "project.current", "work.focus_set"],
      active_only: true,
      limit: options.viewLimit ?? 30,
    });

    const projects = unique([
      ...records.flatMap(record => [record.scope?.project, record.scope?.project_path]),
      ...views.flatMap(view => [view.scope?.project, view.scope?.project_path]),
    ]).slice(0, 8);
    const focus = firstText([
      ...views.filter(view => view.view_type === "project.current").map(view => view.summary ?? textFromContent(view.content)),
      ...views.filter(view => view.view_type === "work.focus_set").map(view => view.summary ?? textFromContent(view.content)),
      ...records.map(record => record.content?.title ?? record.content?.text),
    ]) ?? "Recent work context captured for the day.";
    const highlights = unique([
      ...views.map(view => view.title ?? view.summary ?? `${view.view_type} view`),
      ...records.map(record => record.content?.title ?? record.content?.text ?? record.schema.name),
    ].map(cleanLine)).filter(Boolean).slice(0, 10);
    const decisions = records
      .map(record => cleanLine(`${record.content?.title ?? ""} ${record.content?.text ?? ""}`))
      .filter(text => /\b(decision|decided|choose|chosen|确定|决定)\b/i.test(text))
      .slice(0, 8);
    const feedback = records
      .filter(record => record.schema.name.startsWith("feedback."))
      .map(record => cleanLine(record.content?.title ?? record.content?.text ?? record.schema.name))
      .slice(0, 8);
    const markdown = renderDailyMarkdown({ date, focus, projects, highlights, decisions, feedback });

    const view: ViewDraft = {
      id: `memory:daily:${date}`,
      type: MEMORY_DAILY_VIEW_TYPE,
      title: `Daily Memory ${date}`,
      summary: focus,
      status: "accepted",
      source_records: records.map(record => record.id),
      source_views: views.map(view => view.id),
      compiler: { id: MEMORY_DAILY_UPDATE_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Markdown-backed daily memory summarizing work, decisions, feedback, and supporting evidence.",
      scope: { user: "default", time_range: { start: bounds.start, end: bounds.end } },
      content: {
        date,
        timezone,
        markdown_path: `memory/daily/${date}.md`,
        markdown,
        summary: focus,
        projects,
        highlights,
        decisions,
        feedback,
        source_record_count: records.length,
        source_view_count: views.length,
        generated_at: generatedAt,
      },
      confidence: Math.min(0.92, 0.45 + (records.length + views.length) * 0.03),
      stability: "long_term",
      lossiness: "medium",
      privacy: { level: "private", retention: "normal", allow_external_llm: false, allow_external_reader: false },
      metadata: { generated_at: generatedAt, markdown_backed: true, algorithm: "memory-daily-update-v1" },
    };

    return { views: [view], diagnostics: { records_used: records.length, views_used: views.length, date } };
  };
}

function renderDailyMarkdown(input: {
  date: string;
  focus: string;
  projects: string[];
  highlights: string[];
  decisions: string[];
  feedback: string[];
}): string {
  const sections = [
    `# Daily Memory ${input.date}`,
    "",
    `## Focus`,
    input.focus,
    "",
    "## Projects",
    listOrNone(input.projects),
    "",
    "## Highlights",
    listOrNone(input.highlights),
    "",
    "## Decisions",
    listOrNone(input.decisions),
    "",
    "## Feedback",
    listOrNone(input.feedback),
    "",
  ];
  return sections.join("\n");
}

function isDailyRecord(record: StoredContextRecord): boolean {
  return record.schema.name.startsWith("observation.") || record.schema.name.startsWith("feedback.");
}

function textFromContent(content: StoredContextView["content"]): string {
  if (!content) return "";
  for (const key of ["focus", "summary", "title", "text", "claim", "pattern", "style"]) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function firstText(values: Array<unknown>): string | undefined {
  return values.map(value => typeof value === "string" ? cleanLine(value) : "").find(Boolean);
}

function listOrNone(values: string[]): string {
  return values.length ? values.map(value => `- ${value}`).join("\n") : "- None captured.";
}

function cleanLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => cleanLine(value)).filter(Boolean))];
}

function isoDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find(part => part.type === "year")?.value ?? date.toISOString().slice(0, 4);
  const month = parts.find(part => part.type === "month")?.value ?? date.toISOString().slice(5, 7);
  const day = parts.find(part => part.type === "day")?.value ?? date.toISOString().slice(8, 10);
  return `${year}-${month}-${day}`;
}

function localDayUtcBounds(date: string, timezone: string): { start: string; end: string } {
  const noonUtc = new Date(`${date}T12:00:00.000Z`);
  const offsetMinutes = timezoneOffsetMinutes(noonUtc, timezone);
  const start = new Date(Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60_000 - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function timezoneOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

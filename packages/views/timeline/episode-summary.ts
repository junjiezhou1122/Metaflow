import { ContextStore } from "@info/core";
import type { ContextView, StoredContextRecord, StoredWorkThread } from "@info/core";

export type ProjectWorkEpisodeSummary = {
  start_time: string;
  end_time: string;
  record_count: number;
  files: string[];
  urls: string[];
  commands: string[];
  schemas: string[];
  sources: string[];
  markdown: string;
};

export type ProjectWorkEpisodeResult = {
  ok: true;
  thread: StoredWorkThread;
  summary: ProjectWorkEpisodeSummary;
  view: ContextView;
  written?: string;
};

export function compileProjectWorkEpisode(
  thread: StoredWorkThread,
  records: StoredContextRecord[],
  options: { write?: boolean; store?: ContextStore } = {},
): ProjectWorkEpisodeResult {
  const summary = summarizeProjectWorkEpisode(thread, records);
  const view: ContextView = {
    id: `summary:project-work-episode:${thread.id}`,
    view_type: "summary.project_work_episode",
    title: `Episode: ${thread.title}`,
    summary: `${records.length} evidence records from ${summary.start_time} to ${summary.end_time}.`,
    status: "candidate",
    source_records: records.map(record => record.id),
    compiler: { id: "episode-summary", version: "1", mode: "deterministic" },
    purpose: "Deterministic project work episode summary compiled from WorkThread evidence.",
    scope: {
      project: thread.projects?.[0],
      repo: thread.repos?.[0],
      app: thread.apps?.[0],
      domain: thread.domains?.[0],
      time_range: { start: summary.start_time, end: summary.end_time },
    },
    content: { thread_id: thread.id, thread_title: thread.title, summary, markdown: summary.markdown },
    confidence: thread.confidence ?? 0.6,
    stability: "project",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    metadata: { record_count: records.length },
  };
  const written = options.write ? options.store?.upsertView(view).id : undefined;
  return { ok: true, thread, summary, view, written };
}

export function compileProjectWorkEpisodeForThread(threadId: string, options: { write?: boolean; store?: ContextStore } = {}): ProjectWorkEpisodeResult | { ok: false; error: string; threadId: string } {
  const store = options.store ?? new ContextStore();
  const thread = store.getWorkThread(threadId);
  if (!thread) return { ok: false, error: "thread not found", threadId };
  return compileProjectWorkEpisode(thread, store.recordsForThread(threadId, 200), { ...options, store });
}

export function summarizeProjectWorkEpisode(thread: StoredWorkThread, records: StoredContextRecord[]): ProjectWorkEpisodeSummary {
  const times = records.map(record => Date.parse(record.time?.observed_at ?? record.created_at)).filter(time => !Number.isNaN(time)).sort();
  const start_time = times.length ? new Date(times[0]).toISOString() : new Date().toISOString();
  const end_time = times.length ? new Date(times[times.length - 1]).toISOString() : start_time;
  const files = top(flat(records.map(record => [record.content?.path, ...stringArray(record.payload?.files_touched)])), 30);
  const urls = top(records.map(record => record.content?.url).filter(Boolean) as string[], 20);
  const commands = top(flat(records.map(record => stringArray(record.payload?.commands_run))), 20);
  const schemas = top(records.map(record => record.schema.name), 20);
  const sources = top(records.map(record => `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`), 20);
  const markdown = [
    `# Episode: ${thread.title}`,
    ``,
    `Thread: ${thread.id}`,
    `Time: ${start_time} → ${end_time}`,
    `Evidence records: ${records.length}`,
    `Confidence: ${thread.confidence ?? "unknown"}`,
    ``,
    `## Signals`,
    ...(thread.reasons ?? []).slice(0, 10).map(reason => `- ${reason}`),
    ``,
    `## Schemas`,
    ...schemas.map(item => `- ${item}`),
    ``,
    `## Sources`,
    ...sources.map(item => `- ${item}`),
    ``,
    `## Files`,
    ...files.slice(0, 20).map(item => `- ${item}`),
    ``,
    `## URLs`,
    ...urls.slice(0, 10).map(item => `- ${item}`),
    ``,
    `## Commands`,
    ...commands.slice(0, 10).map(item => `- ${item}`),
  ].join("\n");
  return { start_time, end_time, record_count: records.length, files, urls, commands, schemas, sources, markdown };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function flat<T>(xs: T[][]): T[] {
  return ([] as T[]).concat(...xs);
}

function top(values: Array<string | undefined>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean) as string[]) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}

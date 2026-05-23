import { ContextStore } from "../src/core/store.js";
import type { ContextRecord, StoredContextRecord } from "../src/core/types.js";

const store = new ContextStore();
const argv = process.argv.slice(2).filter(arg => arg !== "--");
const threadId = argv[0] ?? process.env.THREAD_ID;
const write = argv.includes("--write");
if (!threadId) {
  console.error("usage: pnpm run episode:summary -- <thread_id> [--write]");
  process.exit(1);
}
const thread = store.getWorkThread(threadId);
if (!thread) {
  console.error(JSON.stringify({ ok: false, error: "thread not found", threadId }, null, 2));
  process.exit(1);
}
const records = store.recordsForThread(threadId, 200);
const summary = summarize(thread, records);
let written: string | undefined;
if (write) {
  const record: ContextRecord = {
    schema: { name: "episode.project_work", version: 1 },
    source: { type: "episode_builder", connector: "deterministic-v1" },
    scope: { project: thread.projects?.[0], repo: thread.repos?.[0], app: thread.apps?.[0], domain: thread.domains?.[0] },
    time: { observed_at: summary.start_time, captured_at: new Date().toISOString() },
    content: { title: `Episode: ${thread.title}`, text: summary.markdown },
    acquisition: { mode: "derived", actor: "system", reason: "Deterministic episode summary from WorkThread evidence records" },
    signal: { importance: 0.75, confidence: thread.confidence ?? 0.6, status: "candidate" },
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    relations: { derived_from: records.map(r => r.id), thread_memberships: [{ thread_id: threadId, confidence: thread.confidence ?? 0.6, reasons: ["episode summary for thread"] }] },
    memory: { kind: "episode", stability: "project" },
    payload: { thread, summary },
  };
  written = store.insertRecord(record).id;
}
console.log(JSON.stringify({ ok: true, thread, summary, written }, null, 2));

function summarize(thread: any, records: StoredContextRecord[]) {
  const times = records.map(r => Date.parse(r.time?.observed_at ?? r.created_at)).filter(t => !Number.isNaN(t)).sort();
  const start_time = times.length ? new Date(times[0]).toISOString() : new Date().toISOString();
  const end_time = times.length ? new Date(times[times.length - 1]).toISOString() : start_time;
  const files = top(flat(records.map(r => [r.content?.path, ...(Array.isArray(r.payload?.files_touched) ? r.payload.files_touched as string[] : []), ...(Array.isArray(r.payload?.files_touched) ? r.payload.files_touched as string[] : [])])), 30);
  const urls = top(records.map(r => r.content?.url).filter(Boolean) as string[], 20);
  const commands = top(flat(records.map(r => Array.isArray(r.payload?.commands_run) ? r.payload.commands_run as string[] : [])), 20);
  const schemas = top(records.map(r => r.schema.name), 20);
  const sources = top(records.map(r => `${r.source.type}${r.source.connector ? `/${r.source.connector}` : ""}`), 20);
  const markdown = [
    `# Episode: ${thread.title}`,
    ``,
    `Thread: ${thread.id}`,
    `Time: ${start_time} → ${end_time}`,
    `Evidence records: ${records.length}`,
    `Confidence: ${thread.confidence ?? "unknown"}`,
    ``,
    `## Signals`,
    ...(thread.reasons ?? []).slice(0, 10).map((r: string) => `- ${r}`),
    ``,
    `## Schemas`,
    ...schemas.map(x => `- ${x}`),
    ``,
    `## Sources`,
    ...sources.map(x => `- ${x}`),
    ``,
    `## Files`,
    ...files.slice(0, 20).map(x => `- ${x}`),
    ``,
    `## URLs`,
    ...urls.slice(0, 10).map(x => `- ${x}`),
    ``,
    `## Commands`,
    ...commands.slice(0, 10).map(x => `- ${x}`),
  ].join("\n");
  return { start_time, end_time, record_count: records.length, files, urls, commands, schemas, sources, markdown };
}
function flat<T>(xs: T[][]): T[] { return ([] as T[]).concat(...xs); }
function top(values: Array<string | undefined>, limit: number) {
  const counts = new Map<string, number>();
  for (const v of values.filter(Boolean) as string[]) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a,b) => b[1]-a[1]).map(([v]) => v).slice(0, limit);
}

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { ContextStore } from "@info/core";
import type { ContextRecord, ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import { buildCandidateThreads, extractFeatures, type CandidateThread } from "./correlation.js";
import { isHighScreenNoise } from "./screen-noise.js";

export const WORK_THREAD_VIEW_COMPILER_ID = "builtin.work-thread-view";

export type CompileWorkThreadViewOptions = {
  minutes?: number;
  limit?: number;
  write?: boolean;
  min_score?: number;
  max_threads?: number;
  title?: string;
};

export type CompileWorkThreadViewResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  view: ContextView | StoredContextView;
  records_scanned: number;
  records_used: number;
  candidate_threads: CandidateThread[];
  active_thread?: CandidateThread;
  next_actions: string[];
};

const CODING_SCHEMAS = new Set([
  "observation.browser_page_snapshot",
  "observation.browser_text_selected",
  "observation.local_project",
  "observation.ai_session_locator_result",
  "observation.screenpipe_activity_summary",
  "observation.screenpipe_workspace_signal",
  "observation.screenpipe_input_event",
]);

export function compileWorkThreadView(options: CompileWorkThreadViewOptions = {}, store = new ContextStore()): CompileWorkThreadViewResult {
  const generatedAt = new Date().toISOString();
  const minutes = options.minutes ?? 180;
  const limit = options.limit ?? 160;
  const candidateLimit = Math.max(limit * 3, limit + 50);
  const records = store.recent(candidateLimit, undefined, { minutes });
  const selected = selectCodingRecords(records);
  const candidateThreads = buildCandidateThreads(selected, {
    minScore: options.min_score ?? 0.35,
    maxThreads: options.max_threads ?? 6,
  });
  const activeThread = candidateThreads[0];
  const evidenceRecords = activeThread
    ? selected.filter(record => activeThread.records.some(member => member.id === record.id))
    : selected.slice(0, Math.min(20, selected.length));
  const nextActions = inferNextActions(activeThread, evidenceRecords);
  const timeRange = {
    start: new Date(Date.parse(generatedAt) - minutes * 60_000).toISOString(),
    end: generatedAt,
  };
  const view: ContextView = {
    id: `view:work_thread:active:${stableKey(activeThread?.thread_id ?? "no-thread")}`,
    view_type: "work_thread",
    title: options.title ?? activeThread?.title ?? "Active WorkThread",
    summary: buildSummary(activeThread, evidenceRecords, selected.length),
    status: activeThread ? "candidate" : "archived",
    source_records: evidenceRecords.map(record => record.id),
    compiler: { id: WORK_THREAD_VIEW_COMPILER_ID, version: "1", mode: "deterministic" },
    purpose: "Active coding task view compiled from raw browser, Screenpipe, local project, and AI-session observations.",
    scope: {
      project: activeThread?.projects[0],
      repo: activeThread?.repos[0],
      app: activeThread?.apps[0],
      domain: activeThread?.domains[0],
      plugin_id: WORK_THREAD_VIEW_COMPILER_ID,
      time_range: timeRange,
    },
    content: {
      kind: "active_work_thread",
      active_thread: activeThread,
      candidate_threads: candidateThreads,
      evidence: evidenceRecords.map(compactEvidenceRecord),
      current_status: inferCurrentStatus(activeThread, evidenceRecords),
      next_actions: nextActions,
      signals: summarizeSignals(selected),
    },
    confidence: activeThread?.confidence ?? (evidenceRecords.length > 0 ? 0.45 : 0.1),
    stability: "session",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    validity: { valid_from: timeRange.start, stale_after: new Date(Date.parse(generatedAt) + 10 * 60_000).toISOString() },
    metadata: {
      generated_at: generatedAt,
      records_scanned: records.length,
      records_used: evidenceRecords.length,
      selected_records: selected.length,
      algorithm: "work-thread-view-rules-v1",
    },
  };

  const shouldWrite = options.write ?? true;
  const stored = shouldWrite ? store.upsertView(view) : view;
  if (shouldWrite) {
    store.setRuntimeState("active_work_thread_view", {
      view_id: stored.id,
      title: stored.title,
      confidence: stored.confidence,
      active_thread_id: activeThread?.thread_id,
      generated_at: generatedAt,
      next_actions: nextActions.slice(0, 5),
    });
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: stored.id,
      plugin_id: WORK_THREAD_VIEW_COMPILER_ID,
      related_records: stored.source_records,
      payload: {
        view_type: stored.view_type,
        records_scanned: records.length,
        records_used: evidenceRecords.length,
        candidate_threads: candidateThreads.length,
        active_thread_id: activeThread?.thread_id,
      },
    });
  }

  return {
    ok: true,
    compiler_id: WORK_THREAD_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    view: stored,
    records_scanned: records.length,
    records_used: evidenceRecords.length,
    candidate_threads: candidateThreads,
    active_thread: activeThread,
    next_actions: nextActions,
  };
}

function selectCodingRecords(records: StoredContextRecord[]): StoredContextRecord[] {
  return records
    .filter(record => record.schema.name !== "observation.route_candidate")
    .filter(record => record.schema.name !== "observation.browser_page_heartbeat")
    .filter(record => !record.schema.name.startsWith("derived."))
    .filter(record => !record.schema.name.startsWith("episode."))
    .filter(record => !isHighScreenNoise(record))
    .filter(record => CODING_SCHEMAS.has(record.schema.name) || hasCodingSignal(record))
    .filter(record => record.privacy?.retention !== "do_not_store");
}

function hasCodingSignal(record: StoredContextRecord): boolean {
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${record.content?.url ?? ""}\n${record.content?.path ?? ""}\n${JSON.stringify(record.payload ?? {})}`.toLowerCase();
  return [
    "/users/",
    "localhost",
    "github.com",
    "git ",
    "pnpm",
    "npm",
    "typescript",
    "codex",
    "claude",
    "screenpipe",
    "runtime",
    "plugin",
    "context",
  ].some(token => text.includes(token));
}

function compactEvidenceRecord(record: StoredContextRecord) {
  const features = extractFeatures(record);
  return {
    id: record.id,
    schema: record.schema.name,
    source: `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
    title: record.content?.title,
    url: record.content?.url,
    path: record.content?.path,
    observed_at: record.time?.observed_at ?? record.created_at,
    app: features.app,
    domain: features.domain,
    project: features.project,
    repo: features.repo,
    keywords: features.keywords.slice(0, 8),
    excerpt: excerpt(record.content?.text, 320),
  };
}

function buildSummary(activeThread: CandidateThread | undefined, evidence: StoredContextRecord[], selectedCount: number): string {
  if (!activeThread) return `No strong active work thread yet. ${selectedCount} coding-like records were available.`;
  const parts = [
    `Active thread: ${activeThread.title}.`,
    `${evidence.length} evidence records, confidence ${activeThread.confidence}.`,
  ];
  if (activeThread.projects.length) parts.push(`Projects: ${activeThread.projects.slice(0, 3).join(", ")}.`);
  if (activeThread.domains.length) parts.push(`Domains: ${activeThread.domains.slice(0, 3).join(", ")}.`);
  return parts.join(" ");
}

function inferCurrentStatus(activeThread: CandidateThread | undefined, evidence: StoredContextRecord[]): Record<string, unknown> {
  const latest = [...evidence].sort((a, b) => Date.parse(b.time?.observed_at ?? b.created_at) - Date.parse(a.time?.observed_at ?? a.created_at))[0];
  return {
    title: activeThread?.title ?? latest?.content?.title ?? "unknown",
    confidence: activeThread?.confidence ?? 0,
    latest_observation_at: latest?.time?.observed_at ?? latest?.created_at,
    latest_title: latest?.content?.title,
    project: activeThread?.projects[0],
    repo: activeThread?.repos[0],
    domains: activeThread?.domains ?? [],
    apps: activeThread?.apps ?? [],
    keywords: activeThread?.keywords ?? [],
  };
}

function inferNextActions(activeThread: CandidateThread | undefined, evidence: StoredContextRecord[]): string[] {
  const actions: string[] = [];
  const schemas = new Set(evidence.map(record => record.schema.name));
  const texts = evidence.map(record => `${record.content?.title ?? ""}\n${record.content?.text ?? ""}`).join("\n").toLowerCase();

  if (!activeThread) actions.push("Collect a local project snapshot and a few browser/screen observations before building an agent context pack.");
  if (!schemas.has("observation.local_project")) actions.push("Run local project snapshot so the agent can see current files, git status, and diff.");
  if (!schemas.has("observation.ai_session_locator_result")) actions.push("Scan recent Codex/Claude sessions for task continuity.");
  if (texts.includes("permission") || texts.includes("screenpipe")) actions.push("If Screenpipe keeps jumping to settings, verify macOS Screen Recording/Microphone permissions and restart the service once.");
  if (texts.includes("typecheck") || texts.includes("typescript") || texts.includes("tsc")) actions.push("Run pnpm typecheck after runtime/view changes.");
  if (texts.includes("trigger") || texts.includes("plugin") || texts.includes("runtime")) actions.push("Keep the next implementation step narrow: trigger evaluator → work_thread view compiler → context pack.");
  if (actions.length === 0) actions.push("Ask the broker for this work_thread view before the next coding step.");

  return [...new Set(actions)].slice(0, 6);
}

function summarizeSignals(records: StoredContextRecord[]) {
  const features = records.map(extractFeatures);
  return {
    schemas: top(records.map(record => record.schema.name), 8),
    sources: top(records.map(record => `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`), 8),
    domains: top(features.map(feature => feature.domain).filter(Boolean) as string[], 8),
    apps: top(features.map(feature => feature.app).filter(Boolean) as string[], 8),
    projects: top(features.map(feature => feature.project).filter(Boolean) as string[], 8),
    repos: top(features.map(feature => feature.repo).filter(Boolean) as string[], 8),
    keywords: top(features.flatMap(feature => feature.keywords), 12),
  };
}

function top(values: string[], limit: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })).slice(0, limit);
}

function excerpt(text: string | undefined, max: number): string | undefined {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function stableKey(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (slug) return slug;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export { workThreadViewToMarkdown } from "@info/core";

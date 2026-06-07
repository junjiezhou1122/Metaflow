import { ContextStore } from "@info/core";
import { buildCandidateThreads } from "../src/runtime/correlation.js";
import { compileWorkThreadView } from "../src/runtime/work-thread-view.js";
import { aiSessionRefToRecord, locateAiSessions, type AiSessionTool } from "@info/sensors";
import type { StoredContextRecord } from "@info/core";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const limit = Number(process.env.CORRELATE_LIMIT ?? 80);
const minScore = Number(process.env.CORRELATE_MIN_SCORE ?? 0.4);
const maxThreads = Number(process.env.CORRELATE_MAX_THREADS ?? 8);
const project = process.env.CORRELATE_PROJECT;
const includeSocial = process.env.CORRELATE_INCLUDE_SOCIAL === "1";
const includeAiSessions = process.env.CORRELATE_AI_SESSIONS === "1" || args.has("--ai-sessions");
const aiSessionProject = process.env.AI_SESSION_PROJECT ?? process.cwd();
const aiSessionMinutes = Number(process.env.AI_SESSION_MINUTES ?? 240);
const aiSessionTools = (process.env.AI_SESSION_TOOLS ?? "codex,claude-code").split(",").map(x => x.trim()).filter(Boolean) as AiSessionTool[];

const store = new ContextStore();
const baseRecords = store
  .recent(limit, project ? { project } : undefined)
  .filter(record => includeSocial || (record.source.type !== "social" && record.schema.name !== "observation.social_post_saved"));

const transientRecords: StoredContextRecord[] = [];
const diagnostics: Record<string, unknown> = {};
if (includeAiSessions) {
  const located = locateAiSessions({
    project_path: aiSessionProject,
    minutes: aiSessionMinutes,
    tools: aiSessionTools,
    limit: Number(process.env.AI_SESSION_LIMIT ?? 8),
    include_snippets: process.env.AI_SESSION_SNIPPETS === "1",
  });
  diagnostics.ai_sessions = { count: located.sessions.length, time_window: located.time_window, diagnostics: located.diagnostics };
  transientRecords.push(...located.sessions.map(aiSessionRefToRecord));
}

const records = [...baseRecords, ...transientRecords];
const candidate_threads = buildCandidateThreads(records, { minScore, maxThreads });

const written: string[] = [];
const written_views: string[] = [];
if (write) {
  for (const thread of candidate_threads) {
    const evidenceIds = thread.records.map(r => r.id);
    const stored = store.upsertWorkThread({
      id: thread.thread_id,
      title: thread.title,
      status: "candidate",
      confidence: thread.confidence,
      evidence_records: evidenceIds,
      keywords: thread.keywords,
      domains: thread.domains,
      apps: thread.apps,
      projects: thread.projects,
      repos: thread.repos,
      reasons: thread.reasons,
      metadata: { algorithm: "rules-v1", candidate: thread },
    });
    written.push(stored.id);
  }
  if (candidate_threads.length) {
    const compiled = compileWorkThreadView({ write: true, min_score: minScore, max_threads: maxThreads, limit }, store);
    written_views.push(compiled.view.id!);
  }
}

console.log(JSON.stringify({
  ok: true,
  algorithm: "rules-v1",
  input_records: records.length,
  persistent_records: baseRecords.length,
  transient_records: transientRecords.length,
  minScore,
  includeSocial,
  includeAiSessions,
  diagnostics,
  candidate_threads,
  written,
  written_views,
}, null, 2));

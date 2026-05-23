import { ContextStore } from "../src/core/store.js";
import { buildCandidateThreads } from "../src/runtime/correlation.js";
import { aiSessionRefToRecord, locateAiSessions, type AiSessionTool } from "../src/connectors/ai-sessions.js";
import type { ContextRecord, StoredContextRecord } from "../src/core/types.js";

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
if (write) {
  for (const thread of candidate_threads) {
    const evidenceIds = thread.records.map(r => r.id);
    const record: ContextRecord = {
      schema: { name: "episode.candidate_thread", version: 1 },
      source: { type: "correlator", connector: "rules-v1" },
      scope: {
        project: thread.projects[0],
        repo: thread.repos[0],
        app: thread.apps[0],
        domain: thread.domains[0],
      },
      content: {
        title: thread.title,
        text: [
          `Candidate WorkThread: ${thread.title}`,
          `confidence: ${thread.confidence}`,
          `records: ${thread.records.length}`,
          `keywords: ${thread.keywords.join(", ")}`,
          `reasons:\n${thread.reasons.map(r => `- ${r}`).join("\n")}`,
        ].join("\n\n"),
      },
      acquisition: {
        mode: "derived",
        actor: "system",
        reason: "Deterministic weak correlation over recent ContextRecords",
      },
      signal: { importance: Math.min(0.9, thread.confidence), confidence: thread.confidence, status: "candidate" },
      privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
      relations: { derived_from: evidenceIds },
      memory: { kind: "episode", stability: "session" },
      payload: { thread, algorithm: "rules-v1", minScore, limit },
    };
    written.push(store.insertRecord(record).id);
    store.upsertWorkThread({
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
}, null, 2));

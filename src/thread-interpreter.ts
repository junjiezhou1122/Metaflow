import { ContextStore } from "./store.js";
import type { ContextRecord, StoredContextRecord, StoredWorkThread, ThreadEvidenceMap } from "./types.js";
import { chatCompletion, parseJsonObject, type LlmOptions } from "./llm.js";
import { buildThreadEvidenceMap } from "./thread-evidence.js";

export type ThreadInterpretRequest = {
  thread_id: string;
  write?: boolean;
  update_thread?: boolean;
  max_records?: number;
  llm?: LlmOptions;
};

export type ThreadInterpretPolicy = {
  force?: boolean;
  min_interval_seconds?: number;
  min_evidence_delta?: number;
};

export type ThreadInterpretation = {
  display_title: string;
  brief: string;
  confidence: number;
};

export type ThreadInterpretResult = {
  ok: boolean;
  thread?: StoredWorkThread;
  interpretation?: ThreadInterpretation;
  written?: string;
  updated_thread?: StoredWorkThread;
  prompt_evidence_ids?: string[];
  llm?: Record<string, unknown>;
  error?: string;
};

export async function interpretThread(req: ThreadInterpretRequest, store = new ContextStore()): Promise<ThreadInterpretResult> {
  const thread = store.getWorkThread(req.thread_id);
  if (!thread) return { ok: false, error: "thread not found" };
  const records = store.recordsForThread(thread.id, req.max_records ?? 30);
  const evidenceMap = buildThreadEvidenceMap(thread, records);
  const evidence = renderEvidence(thread, records);
  const llm = await chatCompletion([
    {
      role: "system",
      content: [
        "You name and summarize a personal work thread.",
        "Use only the provided evidence. Do not invent external facts.",
        "Return strict JSON only with keys: display_title, brief, confidence.",
        "Do not output tags or next steps. This is only a display card, not a todo planner.",
        "Prefer task-level titles over keyword lists.",
        "Bad title: Info: screenpipe / scripts / recent.",
        "Good title: Personal Context Runtime: daemon + active thread.",
        "Use the same language as the user's recent evidence when appropriate; Chinese is okay.",
      ].join("\n"),
    },
    { role: "user", content: evidence },
  ], req.llm);

  if (!llm.ok || !llm.content) return { ok: false, thread, prompt_evidence_ids: records.map(r => r.id), llm, error: llm.error ?? "llm failed" };
  const parsed = parseJsonObject(llm.content);
  if (!parsed) return { ok: false, thread, prompt_evidence_ids: records.map(r => r.id), llm, error: "LLM did not return JSON object" };

  const interpretation = normalizeInterpretation(parsed, thread);
  const now = new Date().toISOString();
  let written: string | undefined;
  let updatedThread: StoredWorkThread | undefined;

  if (req.write ?? true) {
    const record: ContextRecord = {
      id: `interpretation:${thread.id}`,
      schema: { name: "episode.thread_interpretation", version: 1 },
      source: { type: "llm_interpreter", connector: "openai-compatible" },
      scope: { project: thread.projects?.[0], repo: thread.repos?.[0], app: thread.apps?.[0], domain: thread.domains?.[0] },
      time: { observed_at: now, captured_at: now },
      content: {
        title: interpretation.display_title,
        text: [`# ${interpretation.display_title}`, ``, interpretation.brief].join("\n"),
      },
      acquisition: { mode: "derived", actor: "system", reason: "LLM interpretation of deterministic WorkThread evidence" },
      signal: { importance: 0.7, confidence: interpretation.confidence, status: "candidate" },
      privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
      relations: { derived_from: records.map(r => r.id), related_to: [thread.id], thread_memberships: [{ thread_id: thread.id, confidence: thread.confidence ?? 0.6, reasons: ["thread interpretation"] }] },
      memory: { kind: "episode", stability: "session" },
      payload: { thread_id: thread.id, raw_title: thread.title, interpretation, llm: { model: llm.model, base_url: llm.base_url }, evidence_ids: records.map(r => r.id), evidence_map: evidenceMap },
    };
    written = store.insertRecord(record).id;
    store.upsertView({
      id: `view:thread-display:${thread.id}`,
      view_type: "thread.display_card",
      title: interpretation.display_title,
      summary: interpretation.brief,
      status: "candidate",
      source_records: records.map(r => r.id),
      compiler: { id: "thread-interpreter", version: "1", mode: "llm" },
      purpose: "Human-readable display card for a WorkThread view. Not a todo list or plugin memory.",
      scope: { project: thread.projects?.[0], repo: thread.repos?.[0] },
      content: { display_title: interpretation.display_title, brief: interpretation.brief, thread_id: thread.id },
      confidence: interpretation.confidence,
      stability: "session",
      lossiness: "medium",
      privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
      metadata: { evidence_map: evidenceMap, llm: { model: llm.model, base_url: llm.base_url } },
    });
  }

  if (req.update_thread ?? true) {
    updatedThread = store.upsertWorkThread({
      ...thread,
      title: interpretation.display_title || thread.title,
      metadata: {
        ...(thread.metadata ?? {}),
        raw_title: (thread.metadata?.raw_title as string | undefined) ?? thread.title,
        display_title: interpretation.display_title,
        llm_brief: interpretation.brief,
        interpreted_at: now,
        interpreter: {
          model: llm.model,
          base_url: llm.base_url,
          evidence_ids: records.map(r => r.id),
        },
        evidence_map: evidenceMap,
        evidence_refs: evidenceMap.refs,
      },
    });
    syncActiveThreadState(store, updatedThread, evidenceMap);
  }

  return { ok: true, thread, interpretation, written, updated_thread: updatedThread, prompt_evidence_ids: records.map(r => r.id), llm: { model: llm.model, base_url: llm.base_url } };
}

function syncActiveThreadState(store: ContextStore, thread: StoredWorkThread, evidenceMap: ThreadEvidenceMap) {
  const active = store.getRuntimeState("active_thread")?.value;
  if (active?.thread_id !== thread.id) return;
  store.setRuntimeState("active_thread", {
    ...active,
    title: thread.title,
    display_title: thread.metadata?.display_title,
    brief: thread.metadata?.llm_brief,
    evidence_count: thread.evidence_records?.length ?? active.evidence_count,
    evidence_ref_counts: evidenceMap.counts,
    interpreted_at: thread.metadata?.interpreted_at,
  });
}

export function shouldInterpretThread(thread: StoredWorkThread, policy: ThreadInterpretPolicy = {}): { ok: boolean; reason: string } {
  if (policy.force) return { ok: true, reason: "forced" };
  const minInterval = policy.min_interval_seconds ?? 300;
  const minEvidenceDelta = policy.min_evidence_delta ?? 2;
  const meta = thread.metadata ?? {};
  const interpretedAt = typeof meta.interpreted_at === "string" ? meta.interpreted_at : undefined;
  const lastEvidence = Array.isArray((meta.interpreter as any)?.evidence_ids) ? (meta.interpreter as any).evidence_ids.length : 0;
  const currentEvidence = thread.evidence_records?.length ?? 0;
  if (!interpretedAt) return { ok: true, reason: "never interpreted" };
  const age = (Date.now() - Date.parse(interpretedAt)) / 1000;
  if (Number.isNaN(age) || age >= minInterval) return { ok: true, reason: `interpretation stale: ${Math.round(age)}s` };
  if (currentEvidence - lastEvidence >= minEvidenceDelta) return { ok: true, reason: `evidence delta: ${currentEvidence - lastEvidence}` };
  return { ok: false, reason: `throttled: age ${Math.round(age)}s, evidence delta ${currentEvidence - lastEvidence}` };
}

export function activeThreadId(store = new ContextStore()): string | undefined {
  const active = store.getRuntimeState("active_thread")?.value;
  return typeof active?.thread_id === "string" ? active.thread_id : undefined;
}

function renderEvidence(thread: StoredWorkThread, records: StoredContextRecord[]): string {
  const compactRecords = records.slice(0, 30).map(record => ({
    id: record.id,
    schema: record.schema.name,
    source: `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
    title: record.content?.title,
    path: record.content?.path,
    url: record.content?.url,
    observed_at: record.time?.observed_at,
    text: (record.content?.text ?? "").slice(0, 1200),
    payload: pickPayload(record.payload ?? {}),
  }));
  return JSON.stringify({
    thread: {
      id: thread.id,
      current_title: thread.title,
      confidence: thread.confidence,
      keywords: thread.keywords,
      projects: thread.projects,
      reasons: thread.reasons,
    },
    evidence_records: compactRecords,
  }, null, 2).slice(0, 24_000);
}

function pickPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["root", "cwd", "branch", "status", "diffStat", "recentFiles", "files_touched", "commands_run", "project_path", "tool", "session_id"]) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

function normalizeInterpretation(value: Record<string, unknown>, thread: StoredWorkThread): ThreadInterpretation {
  const display_title = firstString(value.display_title, value.title)?.slice(0, 120) || thread.title;
  const brief = firstString(value.brief, value.summary)?.slice(0, 1200) || "";
  const rawConfidence = typeof value.confidence === "number" ? value.confidence : 0.6;
  const confidence = Math.max(0, Math.min(1, Number(rawConfidence.toFixed(3))));
  return { display_title, brief, confidence };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

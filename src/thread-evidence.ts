import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ContextStore } from "./store.js";
import type { StoredContextRecord, StoredWorkThread, ThreadEvidenceMap, ThreadEvidenceRef } from "./types.js";

export function buildThreadEvidenceMap(thread: StoredWorkThread, records: StoredContextRecord[]): ThreadEvidenceMap {
  const refs: ThreadEvidenceRef[] = [];
  for (const record of records) {
    refs.push(contextRecordRef(record));
    refs.push(...fileRefs(record));
    refs.push(...urlRefs(record));
    refs.push(...aiSessionRefs(record));
    refs.push(...screenpipeRefs(record));
    refs.push(...gitRefs(record));
  }
  refs.push(...runtimeRefs(thread));
  const deduped = dedupeRefs(refs);
  return {
    thread_id: thread.id,
    generated_at: new Date().toISOString(),
    refs: deduped,
    counts: countByType(deduped),
  };
}

export function buildThreadEvidenceMapById(threadId: string, store = new ContextStore()): ThreadEvidenceMap | undefined {
  const thread = store.getWorkThread(threadId);
  if (!thread) return undefined;
  return buildThreadEvidenceMap(thread, store.recordsForThread(threadId, 200));
}

export function persistThreadEvidenceMap(threadId: string, store = new ContextStore()): { ok: boolean; evidence_map?: ThreadEvidenceMap; thread?: StoredWorkThread; error?: string } {
  const thread = store.getWorkThread(threadId);
  if (!thread) return { ok: false, error: "thread not found" };
  const evidence_map = buildThreadEvidenceMap(thread, store.recordsForThread(threadId, 200));
  const updated = store.upsertWorkThread({
    ...thread,
    metadata: {
      ...(thread.metadata ?? {}),
      evidence_map,
      evidence_refs: evidence_map.refs,
      evidence_map_updated_at: evidence_map.generated_at,
    },
  });
  return { ok: true, evidence_map, thread: updated };
}

function contextRecordRef(record: StoredContextRecord): ThreadEvidenceRef {
  return {
    ref_type: "context_record",
    uri: `context://${record.id}`,
    title: record.content?.title ?? record.schema.name,
    observed_at: record.time?.observed_at,
    reason: `Evidence ContextRecord from ${record.schema.name}`,
    confidence: record.signal?.confidence ?? 0.75,
    role: record.schema.name.startsWith("episode.") ? "derived" : "supporting",
    record_id: record.id,
    metadata: { schema: record.schema, source: record.source },
  };
}

function fileRefs(record: StoredContextRecord): ThreadEvidenceRef[] {
  const refs: ThreadEvidenceRef[] = [];
  const add = (path: string | undefined, reason: string, confidence = 0.75) => {
    if (!path) return;
    const normalized = normalizeFilePath(path);
    if (!normalized) return;
    refs.push({
      ref_type: "file",
      uri: `file://${normalized}`,
      title: normalized,
      observed_at: record.time?.observed_at,
      reason,
      confidence,
      role: "primary",
      record_id: record.id,
    });
  };
  add(record.content?.path, record.schema.name === "observation.ai_session_locator_result" ? "AI session transcript pointer for this thread" : "record content path is part of this thread", 0.8);
  const payload = record.payload ?? {};
  if (Array.isArray(payload.files_touched)) {
    const projectPath = typeof payload.project_path === "string" ? payload.project_path : typeof payload.cwd === "string" ? payload.cwd : undefined;
    for (const path of payload.files_touched) {
      if (typeof path !== "string") continue;
      if (!isProjectRelevantPath(path, projectPath)) continue;
      add(path, "AI session touched this project file", 0.75);
    }
  }
  if (Array.isArray(payload.recentFiles)) {
    const root = typeof payload.root === "string" ? payload.root : undefined;
    for (const path of payload.recentFiles) if (typeof path === "string") add(root && !path.startsWith("/") ? `${root}/${path}` : path, "local project recent changed/untracked file", 0.85);
  }
  return refs;
}

function urlRefs(record: StoredContextRecord): ThreadEvidenceRef[] {
  const refs: ThreadEvidenceRef[] = [];
  const add = (url: string | undefined, reason: string, confidence = 0.7) => {
    if (!url || !url.match(/^https?:\/\//)) return;
    refs.push({
      ref_type: "browser_url",
      uri: url,
      title: record.content?.title ?? url,
      observed_at: record.time?.observed_at,
      reason,
      confidence,
      role: "source",
      record_id: record.id,
      metadata: { domain: safeDomain(url) },
    });
  };
  add(record.content?.url, "record URL is source/reference for this thread", 0.8);
  const payload = record.payload ?? {};
  add(typeof payload.browser_url === "string" ? payload.browser_url : undefined, "browser URL captured by connector", 0.75);
  add(typeof payload.url === "string" ? payload.url : undefined, "URL captured in payload", 0.65);
  return refs;
}

function aiSessionRefs(record: StoredContextRecord): ThreadEvidenceRef[] {
  if (record.schema.name !== "observation.ai_session_locator_result") return [];
  const payload = record.payload ?? {};
  const sourceUri = typeof payload.source_uri === "string" ? payload.source_uri : undefined;
  if (!sourceUri) return [];
  return [{
    ref_type: "ai_session",
    uri: sourceUri,
    title: record.content?.title ?? `${payload.tool ?? "AI"} session`,
    observed_at: record.time?.observed_at,
    reason: "AI coding session locator matched this project/time window; raw transcript not imported",
    confidence: typeof payload.confidence === "number" ? payload.confidence : record.signal?.confidence ?? 0.8,
    role: "source",
    record_id: record.id,
    metadata: {
      tool: payload.tool,
      session_id: payload.session_id,
      cwd: payload.cwd,
      source_path: payload.source_path,
      raw_transcript_imported: false,
    },
  }];
}

function screenpipeRefs(record: StoredContextRecord): ThreadEvidenceRef[] {
  if (record.source.type !== "screenpipe" && record.schema.name !== "observation.screenpipe_activity") return [];
  const payload = record.payload ?? {};
  const raw: any = payload.raw_result;
  const c = raw?.content ?? raw ?? {};
  const refs: ThreadEvidenceRef[] = [];
  const frameId = c.frame_id ?? c.id ?? payload.screenpipe_source_id;
  const chunkId = c.chunk_id ?? c.audio_chunk_id;
  if (frameId) refs.push({
    ref_type: "screenpipe_frame",
    uri: `screenpipe://frame/${frameId}`,
    title: record.content?.title,
    observed_at: record.time?.observed_at,
    reason: "Screenpipe screen/accessibility/OCR evidence for this thread",
    confidence: record.signal?.confidence ?? 0.75,
    role: "source",
    record_id: record.id,
    metadata: { app_name: payload.app_name, window_name: payload.window_name, browser_url: payload.browser_url, raw_media_stays_in_screenpipe: true },
  });
  if (chunkId) refs.push({
    ref_type: "screenpipe_audio",
    uri: `screenpipe://audio/${chunkId}`,
    title: record.content?.title,
    observed_at: record.time?.observed_at,
    reason: "Screenpipe audio/transcription evidence for this thread",
    confidence: record.signal?.confidence ?? 0.7,
    role: "source",
    record_id: record.id,
    metadata: { raw_media_stays_in_screenpipe: true },
  });
  return refs;
}

function gitRefs(record: StoredContextRecord): ThreadEvidenceRef[] {
  if (record.schema.name !== "observation.local_project") return [];
  const payload = record.payload ?? {};
  const root = typeof payload.root === "string" ? payload.root : record.content?.path;
  if (!root) return [];
  return [{
    ref_type: "git",
    uri: `git://${root}`,
    title: `Git/project state: ${root}`,
    observed_at: record.time?.observed_at,
    reason: "Local git/project snapshot anchors actual execution state",
    confidence: record.signal?.confidence ?? 0.9,
    role: "primary",
    record_id: record.id,
    metadata: { root, branch: payload.branch, repoRemote: payload.repoRemote, status: payload.status, diffStat: payload.diffStat },
  }];
}

function runtimeRefs(thread: StoredWorkThread): ThreadEvidenceRef[] {
  return [{
    ref_type: "runtime_state",
    uri: `runtime://work_threads/${thread.id}`,
    title: thread.title,
    observed_at: thread.updated_at,
    reason: "WorkThread row stores candidate/active thread state and derived metadata",
    confidence: thread.confidence ?? 0.6,
    role: "derived",
    metadata: { status: thread.status, evidence_count: thread.evidence_records?.length ?? 0 },
  }];
}

function normalizeFilePath(path: string): string | undefined {
  if (path.startsWith("file://")) path = path.slice("file://".length);
  if (!path.startsWith("/")) return undefined;
  const cleaned = path.replace(/[.,:;)\]}]+$/, "");
  const resolved = resolve(cleaned);
  if (resolved.includes("/.codex/sessions/") || resolved.includes("/.claude/projects/")) return resolved;
  if (resolved.includes("/.screenpipe/") || resolved.includes("/.nvm/") || resolved.includes("/.pm2") || resolved.includes("/node_modules/")) return undefined;
  if (resolved === "/Users" || resolved.match(/^\/Users\/[^/]+$/)) return undefined;
  if (!looksLikeSourceFile(resolved) && existsSync(resolved) && !isLikelyProjectRoot(resolved)) return undefined;
  return existsSync(resolved) || looksLikeSourceFile(resolved) ? resolved : undefined;
}

function isProjectRelevantPath(path: string, projectPath?: string): boolean {
  if (path.startsWith("/.codex/") || path.startsWith("/.claude/")) return false;
  if (path.startsWith("/")) {
    if (projectPath && path.startsWith(`${projectPath}/`)) return true;
    if (path.includes("/.codex/sessions/") || path.includes("/.claude/projects/")) return true;
    return false;
  }
  return looksLikeSourceFile(path) && !path.includes("://");
}

function looksLikeSourceFile(path: string): boolean {
  return Boolean(path.match(/\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)$/));
}

function isLikelyProjectRoot(path: string): boolean {
  return existsSync(`${path}/package.json`) || existsSync(`${path}/README.md`) || existsSync(`${path}/.git`);
}

function safeDomain(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}

function dedupeRefs(refs: ThreadEvidenceRef[]): ThreadEvidenceRef[] {
  const byKey = new Map<string, ThreadEvidenceRef>();
  for (const ref of refs) {
    const key = `${ref.ref_type}:${ref.uri}`;
    const prev = byKey.get(key);
    if (!prev || ref.confidence > prev.confidence) byKey.set(key, ref);
  }
  return [...byKey.values()].sort((a, b) => {
    const roleScore = (r: ThreadEvidenceRef) => ({ primary: 4, source: 3, supporting: 2, derived: 1, artifact: 1 }[r.role]);
    return roleScore(b) - roleScore(a) || b.confidence - a.confidence || a.ref_type.localeCompare(b.ref_type);
  });
}

function countByType(refs: ThreadEvidenceRef[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ref of refs) counts[ref.ref_type] = (counts[ref.ref_type] ?? 0) + 1;
  return counts;
}

import { ContextStore } from "./store.js";
import type { StoredWorkThread, WorkThread } from "./types.js";
import { persistThreadEvidenceMap } from "./thread-evidence.js";

export function mergeThreads(targetId: string, sourceIds: string[], options: { title?: string; write?: boolean } = {}, store = new ContextStore()) {
  const target = store.getWorkThread(targetId);
  if (!target) return { ok: false, error: "target thread not found", targetId };
  const sources = sourceIds.map(id => store.getWorkThread(id)).filter((x): x is StoredWorkThread => Boolean(x));
  const missing = sourceIds.filter(id => !sources.some(s => s.id === id));
  if (missing.length) return { ok: false, error: "source thread(s) not found", missing };

  const merged: WorkThread = {
    ...target,
    title: options.title ?? target.title,
    evidence_records: unique([...(target.evidence_records ?? []), ...sources.flatMap(s => s.evidence_records ?? [])]),
    keywords: top([...(target.keywords ?? []), ...sources.flatMap(s => s.keywords ?? [])], 12),
    domains: top([...(target.domains ?? []), ...sources.flatMap(s => s.domains ?? [])], 8),
    apps: top([...(target.apps ?? []), ...sources.flatMap(s => s.apps ?? [])], 8),
    projects: top([...(target.projects ?? []), ...sources.flatMap(s => s.projects ?? [])], 6),
    repos: top([...(target.repos ?? []), ...sources.flatMap(s => s.repos ?? [])], 6),
    reasons: unique([...(target.reasons ?? []), ...sources.flatMap(s => s.reasons ?? []), `merged from: ${sourceIds.join(", ")}`]).slice(0, 20),
    metadata: {
      ...(target.metadata ?? {}),
      merged_from: unique([...(Array.isArray(target.metadata?.merged_from) ? target.metadata.merged_from as string[] : []), ...sourceIds]),
      merge_updated_at: new Date().toISOString(),
    },
  };

  if (options.write === false) return { ok: true, merged, sources, dry_run: true };
  const updated = store.upsertWorkThread(merged);
  for (const source of sources) {
    store.upsertWorkThread({
      ...source,
      status: "archived",
      metadata: { ...(source.metadata ?? {}), merged_into: targetId, archived_reason: "merged", merged_at: new Date().toISOString() },
    });
  }
  persistThreadEvidenceMap(updated.id, store);
  syncActiveIfNeeded(updated, store);
  return { ok: true, thread: store.getWorkThread(updated.id), archived_sources: sources.map(s => s.id) };
}

export function splitThread(threadId: string, evidenceIds: string[], options: { title?: string; write?: boolean } = {}, store = new ContextStore()) {
  const thread = store.getWorkThread(threadId);
  if (!thread) return { ok: false, error: "thread not found", threadId };
  const current = thread.evidence_records ?? [];
  const move = unique(evidenceIds).filter(id => current.includes(id));
  if (!move.length) return { ok: false, error: "no matching evidence ids to split" };
  const remaining = current.filter(id => !move.includes(id));
  const newId = `${thread.id}:split:${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const newThread: WorkThread = {
    id: newId,
    title: options.title ?? `${thread.title} (split)`,
    status: "candidate",
    confidence: Math.max(0.4, (thread.confidence ?? 0.6) - 0.1),
    evidence_records: move,
    keywords: thread.keywords,
    domains: thread.domains,
    apps: thread.apps,
    projects: thread.projects,
    repos: thread.repos,
    reasons: [`split from: ${thread.id}`],
    metadata: { split_from: thread.id, split_at: now },
  };
  const updatedOriginal: WorkThread = {
    ...thread,
    evidence_records: remaining,
    metadata: { ...(thread.metadata ?? {}), split_children: unique([...(Array.isArray(thread.metadata?.split_children) ? thread.metadata.split_children as string[] : []), newId]), split_updated_at: now },
  };
  if (options.write === false) return { ok: true, original: updatedOriginal, split: newThread, dry_run: true };
  const original = store.upsertWorkThread(updatedOriginal);
  const created = store.upsertWorkThread(newThread);
  persistThreadEvidenceMap(original.id, store);
  persistThreadEvidenceMap(created.id, store);
  syncActiveIfNeeded(original, store);
  return { ok: true, original: store.getWorkThread(original.id), split: store.getWorkThread(created.id) };
}

function syncActiveIfNeeded(thread: StoredWorkThread, store: ContextStore) {
  const active = store.getRuntimeState("active_thread")?.value;
  if (active?.thread_id !== thread.id) return;
  store.setRuntimeState("active_thread", {
    ...active,
    title: thread.title,
    evidence_count: thread.evidence_records?.length ?? 0,
    candidate_thread_ids: unique([...(Array.isArray(active.candidate_thread_ids) ? active.candidate_thread_ids as string[] : []), thread.id]),
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function top(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}


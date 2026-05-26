import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { ContextStore } from "../core/store.js";
import type { LlmOptions } from "../core/llm.js";
import type { ContextRecord, StoredContextRecord, StoredWorkThread } from "../core/types.js";
import { fetchScreenpipeActivitySummary, fetchScreenpipeInputEvents, fetchScreenpipeRecords, fetchScreenpipeWorkspaceSignals } from "../connectors/screenpipe.js";
import { aiSessionRefToRecord, locateAiSessions, type AiSessionTool } from "../connectors/ai-sessions.js";
import { buildCandidateThreads, type CandidateThread } from "./correlation.js";
import { buildLocalProjectSnapshotRecord } from "../connectors/local-project.js";
import { buildThreadEvidenceMap } from "../threads/thread-evidence.js";
import { compileWorkThreadView } from "./work-thread-view.js";
import { compileActivityTimeline } from "./activity-timeline.js";
import { compileProjectTimeline } from "./project-timeline.js";
import { compileEvidenceViews } from "./evidence-view.js";
import { compileActivityViews, compileIntentViews, compileMemoryViews, compileProposalViews, compileResourceViews, compileWorkflowViews } from "./memory-views.js";
import { compileIntentViewsWithLlm, compileMemoryViewsWithLlm, compileWorkflowViewsWithLlm } from "./view-compression.js";
import { compileActivityBlockViews, compileVisualFrameViews } from "./visual-views.js";
import { compileAudioViews } from "./audio-views.js";

export type RuntimeTickRequest = {
  window_minutes?: number;
  project_hints?: string[];
  include_screenpipe?: boolean;
  include_ai_sessions?: boolean;
  include_git?: boolean;
  write?: boolean;
  force?: boolean;
  min_score?: number;
  max_threads?: number;
  ai_session_tools?: AiSessionTool[];
  ai_session_limit?: number;
  screenpipe_limit?: number;
  project_snapshot_interval_seconds?: number;
  ai_session_interval_seconds?: number;
  compile_views?: boolean;
  ai_view_compression?: boolean;
  visual_view_compression?: boolean;
  llm?: LlmOptions;
  view_compile_interval_seconds?: number;
  work_thread_view_minutes?: number;
  activity_timeline_minutes?: number;
  project_timeline_minutes?: number;
};

export type WorkspaceCandidate = {
  project_path: string;
  project: string;
  confidence: number;
  reasons: string[];
  sources: string[];
  score_breakdown?: Record<string, number>;
};

export type RuntimeTickResult = {
  ok: true;
  mode: "runtime_tick";
  generated_at: string;
  window_minutes: number;
  active_workspace?: WorkspaceCandidate;
  workspace_candidates: WorkspaceCandidate[];
  evidence: {
    base_records: number;
    screenpipe_records: number;
    local_project_records: number;
    ai_session_records: number;
    total_records: number;
    written_records: string[];
  };
  candidate_threads: CandidateThread[];
  top_thread?: StoredWorkThread | CandidateThread;
  written_threads: string[];
  compiled_views: Array<{ view_type: string; view_id?: string; title?: string; records_used?: number; view_count?: number; bucket_count?: number; work_thread_count?: number; skipped?: string }>;
  diagnostics: Record<string, unknown>;
};

export type RuntimeStatus = {
  ok: true;
  generated_at: string;
  active_thread?: Record<string, unknown>;
  last_tick?: Record<string, unknown>;
  recent_threads: StoredWorkThread[];
  runtime_state: Array<{ key: string; updated_at: string; value: Record<string, unknown> }>;
};

export function runtimeStatus(store = new ContextStore()): RuntimeStatus {
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    active_thread: store.getRuntimeState("active_thread")?.value,
    last_tick: store.getRuntimeState("last_tick")?.value,
    recent_threads: store.listWorkThreads("candidate").slice(0, 8),
    runtime_state: store.listRuntimeState().map(state => ({ key: state.key, updated_at: state.updated_at, value: state.value })),
  };
}

export async function runtimeTick(req: RuntimeTickRequest = {}, store = new ContextStore()): Promise<RuntimeTickResult> {
  const generatedAt = new Date().toISOString();
  const windowMinutes = req.window_minutes ?? 10;
  const timeWindow = { minutes: windowMinutes };
  const includeScreenpipe = req.include_screenpipe ?? true;
  const includeAiSessions = req.include_ai_sessions ?? true;
  const includeGit = req.include_git ?? true;
  const write = req.write ?? true;
  const force = req.force ?? false;
  const diagnostics: Record<string, unknown> = {};
  const compiledViews: RuntimeTickResult["compiled_views"] = [];
  const previousTick = store.getRuntimeState("last_tick")?.value ?? {};
  const activeState = store.getRuntimeState("active_thread")?.value ?? {};
  const writtenRecords: string[] = [];

  const baseRecords = store.recent(80, undefined, timeWindow)
    .filter(record => record.source.type !== "social" && record.schema.name !== "observation.social_post_saved");

  const screenpipeRecords: StoredContextRecord[] = [];
  if (includeScreenpipe) {
    const activity = await fetchScreenpipeActivitySummary({
      start_time: `${windowMinutes}m ago`,
      end_time: "now",
    });
    diagnostics.screenpipe_activity = {
      ok: activity.ok,
      url: activity.url,
      count: activity.records.length,
      error: activity.error,
      windows: activity.summary?.windows?.slice?.(0, 8),
    };
    screenpipeRecords.push(...activity.records);
    const workspaceSignals = await fetchScreenpipeWorkspaceSignals({
      start_time: `${windowMinutes}m ago`,
      end_time: "now",
      limit_per_query: 5,
      frame_context_limit: 2,
    });
    diagnostics.screenpipe_workspace_signals = {
      ok: workspaceSignals.ok,
      url: workspaceSignals.url,
      count: workspaceSignals.records.length,
      element_queries: workspaceSignals.diagnostics.element_queries,
      frame_contexts: workspaceSignals.diagnostics.frame_contexts,
      examples: workspaceSignals.records.slice(0, 5).map(record => ({
        schema: record.schema.name,
        title: record.content?.title,
        text: record.content?.text?.slice(0, 180),
        frame_id: record.payload?.frame_id,
      })),
      error: workspaceSignals.error,
    };
    screenpipeRecords.push(...workspaceSignals.records);

    const inputEvents = await fetchScreenpipeInputEvents({
      limit: req.screenpipe_limit ?? 8,
      start_time: `${windowMinutes}m ago`,
      end_time: "now",
    });
    diagnostics.screenpipe_input_events = {
      ok: inputEvents.ok,
      url: inputEvents.url,
      query: inputEvents.query,
      count: inputEvents.records.length,
      error: inputEvents.error,
    };
    screenpipeRecords.push(...inputEvents.records);

    const screenpipe = await fetchScreenpipeRecords({
      limit: req.screenpipe_limit ?? 8,
      content_type: "all",
      start_time: `${windowMinutes}m ago`,
      end_time: "now",
    });
    diagnostics.screenpipe = {
      ok: screenpipe.ok,
      url: screenpipe.url,
      query: screenpipe.query,
      count: screenpipe.records.length,
      error: screenpipe.error,
    };
    screenpipeRecords.push(...screenpipe.records);
  }
  if (write && screenpipeRecords.length) {
    for (const record of dedupeRecords(screenpipeRecords)) {
      const stored = store.insertRecord(record);
      writtenRecords.push(stored.id);
    }
  }

  const workspaceCandidates = resolveWorkspaceCandidates({
    project_hints: req.project_hints,
    records: [...baseRecords, ...screenpipeRecords],
    fallback_paths: [
      process.cwd(),
      ...(stringValue(previousTick.active_workspace_path) ? [stringValue(previousTick.active_workspace_path)!] : []),
      ...(stringValue(activeState.project_path) ? [stringValue(activeState.project_path)!] : []),
      ...store.recent(120)
        .filter(r => r.schema.name === "observation.local_project")
        .map(r => stringValue(r.payload?.root) ?? r.content?.path)
        .filter((x): x is string => Boolean(x)),
    ],
  });
  const activeWorkspace = workspaceCandidates[0];

  const localProjectRecords: StoredContextRecord[] = [];
  const projectSnapshotIntervalSeconds = req.project_snapshot_interval_seconds ?? 120;
  const lastProjectSnapshotAt = stringValue(previousTick.last_project_snapshot_at);
  const hasCurrentProjectSnapshot = activeWorkspace?.project_path
    ? baseRecords.some(record => record.schema.name === "observation.local_project" && normalizeProjectPath(record.scope?.project_path ?? stringValue(record.payload?.root) ?? record.content?.path) === activeWorkspace.project_path)
    : false;
  const shouldSnapshotProject = includeGit && activeWorkspace?.project_path && (force || !hasCurrentProjectSnapshot || secondsSince(lastProjectSnapshotAt) >= projectSnapshotIntervalSeconds || previousTick.active_workspace_path !== activeWorkspace.project_path);
  diagnostics.throttle = {
    project_snapshot_interval_seconds: projectSnapshotIntervalSeconds,
    project_snapshot_skipped: includeGit && activeWorkspace?.project_path ? !shouldSnapshotProject : true,
  };
  if (shouldSnapshotProject && activeWorkspace?.project_path) {
    const record = buildLocalProjectSnapshotRecord({
      cwd: activeWorkspace.project_path,
      acquisitionMode: "sync",
      actor: "system",
      reason: `runtime tick project snapshot; workspace confidence ${activeWorkspace.confidence}`,
    });
    const stored = write ? store.insertRecord(record) : transientRecord(record);
    localProjectRecords.push(stored);
    if (write) writtenRecords.push(stored.id);
  }

  const aiSessionRecords: StoredContextRecord[] = [];
  const aiSessionIntervalSeconds = req.ai_session_interval_seconds ?? 60;
  const lastAiSessionScanAt = stringValue(previousTick.last_ai_session_scan_at);
  const shouldScanAiSessions = includeAiSessions && activeWorkspace?.project_path && (force || secondsSince(lastAiSessionScanAt) >= aiSessionIntervalSeconds || previousTick.active_workspace_path !== activeWorkspace.project_path);
  diagnostics.throttle = {
    ...(diagnostics.throttle as Record<string, unknown>),
    ai_session_interval_seconds: aiSessionIntervalSeconds,
    ai_session_scan_skipped: includeAiSessions && activeWorkspace?.project_path ? !shouldScanAiSessions : true,
  };
  if (shouldScanAiSessions && activeWorkspace?.project_path) {
    const located = locateAiSessions({
      project_path: activeWorkspace.project_path,
      minutes: Math.max(windowMinutes, 120),
      tools: req.ai_session_tools,
      limit: req.ai_session_limit ?? 6,
      include_snippets: false,
    });
    diagnostics.ai_sessions = {
      count: located.sessions.length,
      time_window: located.time_window,
      diagnostics: located.diagnostics,
    };
    for (const session of located.sessions) {
      const record = aiSessionRefToRecord(session);
      const stored = write ? store.insertRecord(record) : record;
      aiSessionRecords.push(stored);
      if (write) writtenRecords.push(stored.id);
    }
  } else if (includeAiSessions) {
    diagnostics.ai_sessions = { skipped: true, reason: activeWorkspace?.project_path ? "throttled" : "no active workspace candidate" };
  }

  const records = dedupeRecords([...baseRecords, ...screenpipeRecords, ...localProjectRecords, ...aiSessionRecords]);
  const { records: threadRecords, filtered } = selectThreadRecords(records, activeWorkspace);
  diagnostics.thread_input = {
    total_records: records.length,
    thread_records: threadRecords.length,
    filtered_records: filtered.length,
    active_workspace: activeWorkspace?.project_path,
    filtered_examples: filtered.slice(0, 5),
  };
  const candidateThreads = buildCandidateThreads(threadRecords, {
    minScore: req.min_score ?? 0.45,
    maxThreads: req.max_threads ?? 6,
  });

  const writtenThreads: string[] = [];
  let topThread: StoredWorkThread | CandidateThread | undefined = candidateThreads[0];
  if (write) {
    for (const thread of candidateThreads) {
      const evidenceIds = [...new Set(thread.records.map(r => r.id))];
      const storedThread = store.upsertWorkThread({
        id: thread.thread_id,
        title: thread.title,
        status: "candidate",
        confidence: thread.confidence,
        evidence_records: evidenceIds,
        keywords: thread.keywords,
        domains: thread.domains,
        apps: thread.apps,
        projects: thread.projects.length ? thread.projects : activeWorkspace ? [activeWorkspace.project] : [],
        repos: thread.repos,
        reasons: thread.reasons,
        metadata: {
          algorithm: "runtime-rules-v1",
          candidate: thread,
          evidence_map: buildThreadEvidenceMap({
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
            metadata: {},
            created_at: generatedAt,
            updated_at: generatedAt,
          }, records.filter(r => evidenceIds.includes(r.id))),
          runtime: {
            last_tick_at: generatedAt,
            last_seen_at: generatedAt,
            window_minutes: windowMinutes,
            active_workspace: activeWorkspace,
            active: thread === candidateThreads[0],
          },
        },
      });
      writtenThreads.push(storedThread.id);
      if (thread === candidateThreads[0]) topThread = storedThread;
    }
    const top = topThread as StoredWorkThread | undefined;
    if (top?.id) {
      store.setRuntimeState("active_thread", {
        thread_id: top.id,
        title: top.title,
        confidence: top.confidence,
        project_path: activeWorkspace?.project_path,
        project: activeWorkspace?.project,
        evidence_count: top.evidence_records?.length ?? 0,
        candidate_thread_ids: candidateThreads.map(t => t.thread_id),
        last_seen_at: generatedAt,
      });
    }
  }

  const shouldCompileViews = req.compile_views ?? true;
  const viewCompileIntervalSeconds = req.view_compile_interval_seconds ?? 120;
  const lastViewCompileAt = stringValue(previousTick.last_view_compile_at);
  const shouldRunViewCompilers = shouldCompileViews && (force || secondsSince(lastViewCompileAt) >= viewCompileIntervalSeconds);
  diagnostics.view_compile = {
    enabled: shouldCompileViews,
    interval_seconds: viewCompileIntervalSeconds,
    skipped: !shouldRunViewCompilers,
    last_view_compile_at: lastViewCompileAt,
  };
  if (shouldRunViewCompilers) {
    compiledViews.push(...await compileRuntimeViews({
      store,
      write,
      records,
      activeWorkspace,
      windowMinutes,
      aiViewCompression: req.ai_view_compression,
      visualViewCompression: req.visual_view_compression ?? req.ai_view_compression,
      llm: req.llm,
      workThreadMinutes: req.work_thread_view_minutes,
      activityMinutes: req.activity_timeline_minutes,
      projectMinutes: req.project_timeline_minutes,
    }));
    diagnostics.compiled_views = compiledViews;
  }

  if (write) {
    store.setRuntimeState("last_tick", {
      generated_at: generatedAt,
      active_workspace_path: activeWorkspace?.project_path,
      active_workspace: activeWorkspace,
      top_thread_id: topThreadId(topThread),
      top_thread_title: (topThread as StoredWorkThread | CandidateThread | undefined)?.title,
      candidate_count: candidateThreads.length,
      last_project_snapshot_at: shouldSnapshotProject ? generatedAt : previousTick.last_project_snapshot_at,
      last_ai_session_scan_at: shouldScanAiSessions ? generatedAt : previousTick.last_ai_session_scan_at,
      last_view_compile_at: shouldRunViewCompilers ? generatedAt : previousTick.last_view_compile_at,
      compiled_views: compiledViews,
      evidence: {
        base_records: baseRecords.length,
        screenpipe_records: screenpipeRecords.length,
        local_project_records: localProjectRecords.length,
        ai_session_records: aiSessionRecords.length,
        total_records: records.length,
      },
      diagnostics,
    });
  }

  return {
    ok: true,
    mode: "runtime_tick",
    generated_at: generatedAt,
    window_minutes: windowMinutes,
    active_workspace: activeWorkspace,
    workspace_candidates: workspaceCandidates,
    evidence: {
      base_records: baseRecords.length,
      screenpipe_records: screenpipeRecords.length,
      local_project_records: localProjectRecords.length,
      ai_session_records: aiSessionRecords.length,
      total_records: records.length,
      written_records: writtenRecords,
    },
    candidate_threads: candidateThreads,
    top_thread: topThread,
    written_threads: writtenThreads,
    compiled_views: compiledViews,
    diagnostics,
  };
}

async function compileRuntimeViews(input: {
  store: ContextStore;
  write: boolean;
  records?: StoredContextRecord[];
  activeWorkspace?: WorkspaceCandidate;
  windowMinutes: number;
  aiViewCompression?: boolean;
  visualViewCompression?: boolean;
  llm?: LlmOptions;
  workThreadMinutes?: number;
  activityMinutes?: number;
  projectMinutes?: number;
}): Promise<RuntimeTickResult["compiled_views"]> {
  const out: RuntimeTickResult["compiled_views"] = [];
  try {
    const compiled = compileEvidenceViews({
      minutes: Math.max(input.windowMinutes, 240),
      limit: 500,
      write: input.write,
      records: input.records,
    }, input.store);
    out.push({ view_type: "evidence", records_used: compiled.records_used, view_count: compiled.views.length, title: "Evidence Views" });

    const activities = compileActivityViews({
      minutes: Math.max(input.windowMinutes, 240),
      limit: 500,
      write: input.write,
      evidenceViews: compiled.views,
    }, input.store);
    out.push({ view_type: "activity", records_used: compiled.records_used, view_count: activities.views.length, title: "Activity Views" });

    const audioViews = await compileAudioViews({
      write: input.write,
      evidenceViews: compiled.views,
      llm: input.llm,
    }, input.store);
    out.push({ view_type: "audio", view_count: audioViews.views.length, title: "AI Audio Views" });

    let activityBlocks: Awaited<ReturnType<typeof compileActivityBlockViews>> | undefined;
    if (input.visualViewCompression) {
      const visualFrames = await compileVisualFrameViews({
        write: input.write,
        evidenceViews: compiled.views,
        llm: input.llm,
      }, input.store);
      out.push({ view_type: "visual_frame", view_count: visualFrames.views.length, title: "AI VisualFrame Views" });

      activityBlocks = await compileActivityBlockViews({
        write: input.write,
        visualFrameViews: visualFrames.views,
        audioViews: audioViews.views,
        activityViews: activities.views,
        llm: input.llm,
        minutes: 10,
      }, input.store);
      out.push({ view_type: "activity_block", view_count: activityBlocks.views.length, title: "AI ActivityBlock Views" });
    }

    const proposals = compileProposalViews({
      write: input.write,
      activityViews: activities.views,
    }, input.store);
    out.push({ view_type: "proposal", view_count: proposals.views.length, title: "Proposal Views" });

    const resources = compileResourceViews({
      write: input.write,
      proposalViews: proposals.views,
    }, input.store);
    out.push({ view_type: "resource", view_count: resources.views.length, title: "Resource Views" });

    const intents = input.aiViewCompression
      ? await compileIntentViewsWithLlm({
        write: input.write,
        proposalViews: proposals.views,
        activityBlockViews: activityBlocks?.views,
        llm: input.llm,
      }, input.store)
      : compileIntentViews({
      write: input.write,
      proposalViews: proposals.views,
    }, input.store);
    out.push({ view_type: "intent", view_count: intents.views.length, title: input.aiViewCompression ? "AI Intent Views" : "Intent Views" });

    const workflows = input.aiViewCompression
      ? await compileWorkflowViewsWithLlm({
        write: input.write,
        intentViews: intents.views,
        resourceViews: resources.views,
        activityBlockViews: activityBlocks?.views,
        llm: input.llm,
      }, input.store)
      : compileWorkflowViews({
      write: input.write,
      intentViews: intents.views,
      resourceViews: resources.views,
    }, input.store);
    out.push({ view_type: "workflow", view_count: workflows.views.length, title: input.aiViewCompression ? "AI Workflow Views" : "Workflow Views" });

    const memories = input.aiViewCompression
      ? await compileMemoryViewsWithLlm({
        write: input.write,
        workflowViews: workflows.views,
        llm: input.llm,
      }, input.store)
      : compileMemoryViews({
      write: input.write,
      workflowViews: workflows.views,
    }, input.store);
    out.push({ view_type: "memory", view_count: memories.views.length, title: input.aiViewCompression ? "AI Memory Views" : "Memory Views" });
  } catch (error) {
    out.push({ view_type: "evidence", skipped: error instanceof Error ? error.message : String(error) });
  }

  try {
    const compiled = compileWorkThreadView({
      minutes: input.workThreadMinutes ?? Math.max(input.windowMinutes, 180),
      limit: 180,
      write: input.write,
    }, input.store);
    out.push({ view_type: "work_thread", view_id: compiled.view.id, title: compiled.view.title, records_used: compiled.records_used, work_thread_count: compiled.candidate_threads.length });
  } catch (error) {
    out.push({ view_type: "work_thread", skipped: error instanceof Error ? error.message : String(error) });
  }

  try {
    const compiled = compileActivityTimeline({
      minutes: input.activityMinutes ?? Math.max(input.windowMinutes, 240),
      limit: 400,
      eventLimit: 120,
      write: input.write,
    }, input.store);
    out.push({ view_type: "timeline.activity", view_id: compiled.view.id, title: compiled.view.title, records_used: compiled.records_used, bucket_count: compiled.buckets.length });
  } catch (error) {
    out.push({ view_type: "timeline.activity", skipped: error instanceof Error ? error.message : String(error) });
  }

  if (input.activeWorkspace?.project_path) {
    try {
      const compiled = compileProjectTimeline({
        projectPath: input.activeWorkspace.project_path,
        minutes: input.projectMinutes ?? 2 * 24 * 60,
        limit: 500,
        eventLimit: 120,
        write: input.write,
      }, input.store);
      out.push({ view_type: "project_timeline", view_id: compiled.view.id, title: compiled.view.title, records_used: compiled.records_used, bucket_count: compiled.buckets.length, work_thread_count: compiled.work_threads.length });
    } catch (error) {
      out.push({ view_type: "project_timeline", skipped: error instanceof Error ? error.message : String(error) });
    }
  } else {
    out.push({ view_type: "project_timeline", skipped: "no active workspace" });
  }
  return out;
}

export function resolveWorkspaceCandidates(input: { project_hints?: string[]; records: StoredContextRecord[]; fallback_paths?: string[] }): WorkspaceCandidate[] {
  const byPath = new Map<string, WorkspaceCandidate>();
  const add = (projectPath: string | undefined, confidence: number, reason: string, source: string) => {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized || confidence <= 0) return;
    const bucket = evidenceBucket(reason, source);
    const capped = Math.min(confidence, bucketCap(bucket));
    const existing = byPath.get(normalized);
    if (existing) {
      const breakdown = existing.score_breakdown ?? {};
      breakdown[bucket] = Math.min(bucketCap(bucket), Number(((breakdown[bucket] ?? 0) + capped).toFixed(3)));
      existing.score_breakdown = breakdown;
      existing.confidence = aggregateWorkspaceScore(breakdown);
      existing.reasons.push(reason);
      existing.sources.push(source);
    } else {
      const breakdown = { [bucket]: capped };
      byPath.set(normalized, {
        project_path: normalized,
        project: basename(normalized),
        confidence: aggregateWorkspaceScore(breakdown),
        reasons: [reason],
        sources: [source],
        score_breakdown: breakdown,
      });
    }
  };

  for (const hint of input.project_hints ?? []) add(hint, 0.8, "explicit project hint", "request");
  for (const path of input.fallback_paths ?? []) add(path, path === process.cwd() ? 0.18 : 0.12, "fallback known workspace", "runtime");

  for (const record of input.records) {
    const payload = record.payload ?? {};
    const source = `${record.schema.name}:${record.id}`;
    add(record.scope?.project_path, 0.45, "record scope project_path", source);
    add(stringValue(payload.root), 0.65, "local project root", source);
    add(stringValue(payload.cwd), 0.45, "payload cwd", source);
    add(stringValue(payload.project_path), 0.45, "payload project_path", source);
    add(record.content?.path, pathConfidence(record.content?.path), "record content path", source);
    for (const path of extractPayloadPathValues(payload)) {
      add(path, pathConfidence(path) || 0.35, "payload path-like value", source);
    }
    const browserUrl = stringValue(payload.browser_url) ?? record.content?.url;
    for (const path of extractProjectPathFromUrl(browserUrl)) {
      add(path, 0.3, "browser_url path signal", source);
    }
    const windowName = normalizeWindowProjectName(stringValue(payload.window_name));
    const windowMinutes = typeof payload.minutes === "number" ? payload.minutes : Number(payload.minutes ?? 0);
    for (const fallback of input.fallback_paths ?? []) {
      if (windowName && basename(fallback) === windowName) {
        const weight = record.schema.name === "observation.screenpipe_activity_summary"
          ? Math.min(0.75, 0.2 + Math.max(0, windowMinutes) / 12)
          : 0.35;
        add(fallback, weight, `Screenpipe active window matches project: ${windowName}`, source);
      }
    }

    const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${JSON.stringify(payload)}`;
    for (const path of extractLikelyAbsoluteProjectPaths(text)) {
      add(path, path.includes("/.codex/") || path.includes("/.claude/") ? 0.05 : 0.35, "absolute path in text", source);
    }
    for (const name of extractEditorProjectNames(text)) {
      for (const fallback of input.fallback_paths ?? []) {
        if (basename(fallback) === name) add(fallback, 0.25, `window/editor text mentions project: ${name}`, source);
      }
    }
  }

  return [...byPath.values()]
    .map(candidate => ({
      ...candidate,
      confidence: Math.min(1, Number(candidate.confidence.toFixed(3))),
      reasons: [...new Set(candidate.reasons)].slice(0, 8),
      sources: [...new Set(candidate.sources)].slice(0, 8),
      score_breakdown: candidate.score_breakdown,
    }))
    .filter(candidate => candidate.confidence >= 0.2)
    .sort((a, b) => b.confidence - a.confidence || liveSourceCount(b) - liveSourceCount(a) || a.project_path.length - b.project_path.length)
    .slice(0, 8);
}





function selectThreadRecords(records: StoredContextRecord[], workspace?: WorkspaceCandidate): { records: StoredContextRecord[]; filtered: Array<{ id: string; title?: string; reason: string }> } {
  const selected: StoredContextRecord[] = [];
  const filtered: Array<{ id: string; title?: string; reason: string }> = [];
  const localProjectIds = new Set(records.filter(record => record.schema.name === "observation.local_project" && isRecordRelevantToWorkspace(record, workspace)).map(record => record.id));

  for (const record of records) {
    if (record.schema.name.startsWith("derived.") || record.schema.name.startsWith("episode.")) {
      filtered.push({ id: record.id, title: record.content?.title, reason: "legacy-derived-or-episode" });
      continue;
    }
    if (record.schema.name === "observation.screenpipe_workspace_signal") {
      filtered.push({ id: record.id, title: record.content?.title, reason: "workspace-signal-only" });
      continue;
    }
    if (!isRecordRelevantToWorkspace(record, workspace)) {
      filtered.push({ id: record.id, title: record.content?.title, reason: "different-workspace" });
      continue;
    }
    if (record.source.type === "screenpipe" && localProjectIds.size > 0) {
      record.relations = { ...(record.relations ?? {}), related_to: [...new Set([...(record.relations?.related_to ?? []), ...localProjectIds])] };
    }
    selected.push(record);
  }
  return { records: selected, filtered };
}

function isRecordRelevantToWorkspace(record: StoredContextRecord, workspace?: WorkspaceCandidate): boolean {
  if (!workspace?.project_path) return true;
  if (record.schema.name === "observation.local_project") return normalizeProjectPath(record.scope?.project_path ?? stringValue(record.payload?.root) ?? record.content?.path) === workspace.project_path;
  if (record.schema.name === "observation.ai_session_locator_result") return normalizeProjectPath(record.scope?.project_path ?? stringValue(record.payload?.project_path)) === workspace.project_path;
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${record.content?.url ?? ""}\n${record.content?.path ?? ""}\n${JSON.stringify(record.payload ?? {})}`;
  const paths = extractLikelyAbsoluteProjectPaths(text).map(normalizeProjectPath).filter(Boolean);
  if (paths.length > 0) return paths.includes(workspace.project_path);
  const windowName = normalizeWindowProjectName(stringValue(record.payload?.window_name));
  if (windowName && windowName === workspace.project) return true;
  if (record.scope?.project_path) return normalizeProjectPath(record.scope.project_path) === workspace.project_path;
  if (record.scope?.project && record.scope.project === workspace.project) return true;
  return record.source.type !== "screenpipe";
}

function evidenceBucket(reason: string, source: string): string {
  if (reason.includes("explicit")) return "explicit";
  if (reason.includes("fallback")) return "fallback";
  if (reason.includes("active window")) return "active_window";
  if (reason.includes("local project root")) return "local_project";
  if (reason.includes("ai_session") || source.includes("ai_session")) return "ai_session";
  if (reason.includes("browser_url")) return "browser_url";
  if (reason.includes("path")) return "path_text";
  if (reason.includes("window/editor")) return "editor_text";
  return "other";
}

function bucketCap(bucket: string): number {
  const caps: Record<string, number> = {
    explicit: 0.95,
    fallback: 0.2,
    active_window: 0.8,
    local_project: 0.75,
    ai_session: 0.65,
    browser_url: 0.5,
    path_text: 0.55,
    editor_text: 0.45,
    other: 0.3,
  };
  return caps[bucket] ?? 0.3;
}

function aggregateWorkspaceScore(breakdown: Record<string, number>): number {
  return Math.min(1, Number(Object.values(breakdown).reduce((sum, value) => sum + value, 0).toFixed(3)));
}

function liveSourceCount(candidate: WorkspaceCandidate): number {
  return candidate.sources.filter(source => source.includes("screenpipe") || source.includes("ai_session") || source.includes("local_project")).length;
}

function normalizeWindowProjectName(name?: string): string | undefined {
  if (!name) return undefined;
  return name.replace(/^[^A-Za-z0-9_.-]+/, "").trim();
}

function normalizeProjectPath(path?: string): string | undefined {
  if (!path) return undefined;
  const expanded = expandUserPath(path);
  if (!expanded.startsWith("/")) return undefined;
  const cleaned = expanded.replace(/^file:\/\//, "").replace(/\/$/, "");
  if (cleaned.includes("/.codex/") || cleaned.includes("/.claude/") || cleaned.includes("/.screenpipe/")) return undefined;
  const resolved = resolve(cleaned);
  if (!existsSync(resolved)) return undefined;
  if (!isLikelyProjectPath(resolved)) return undefined;
  return resolved;
}

function isLikelyProjectPath(path: string): boolean {
  return existsSync(`${path}/package.json`) || existsSync(`${path}/README.md`) || existsSync(`${path}/.git`) || path === process.cwd();
}

function pathConfidence(path?: string): number {
  if (!path?.startsWith("/")) return 0;
  if (path.match(/\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)$/)) return 0.2;
  return 0.35;
}


function extractPayloadPathValues(payload: Record<string, unknown>): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 2) return;
    if (typeof value === "string") {
      if (value.startsWith("/Users/") || value.startsWith("file:///Users/") || value.startsWith("~/")) values.add(value.replace(/^file:\/\//, ""));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (["path", "cwd", "root", "project_path", "file", "file_path", "workspace", "text", "url", "browser_url"].some(k => key.toLowerCase().includes(k))) visit(child, depth + 1);
      }
    }
  };
  visit(payload, 0);
  return [...values].slice(0, 20);
}

function extractProjectPathFromUrl(url?: string): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return [decodeURIComponent(parsed.pathname)];
    const decoded = decodeURIComponent(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    return extractLikelyAbsoluteProjectPaths(decoded);
  } catch {
    return extractLikelyAbsoluteProjectPaths(url);
  }
}

function extractLikelyAbsoluteProjectPaths(text: string): string[] {
  const absoluteMatches = text.match(/\/Users\/[^\s"'`),;]+/g) ?? [];
  const homeMatches = text.match(/~\/[^\s"'`),;]+/g) ?? [];
  const matches = [...absoluteMatches, ...homeMatches];
  return [...new Set(matches.map(trimPathToProjectRoot).filter(Boolean) as string[])].slice(0, 20);
}

function extractEditorProjectNames(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:^|\n|["'])\s*([A-Za-z0-9_.-]{2,64})\s+[—-]\s+(?:Visual Studio Code|Cursor|Code|Windsurf)/g,
    /(?:Visual Studio Code|Cursor|Code|Windsurf).*?[—-]\s*([A-Za-z0-9_.-]{2,64})/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

function trimPathToProjectRoot(path: string): string | undefined {
  const cleaned = expandUserPath(path.replace(/[.,:;)\]}]+$/, ""));
  if (cleaned.includes("/.codex/") || cleaned.includes("/.claude/") || cleaned.includes("/.screenpipe/")) return undefined;
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 3) return undefined;
  if (parts[0] !== "Users") return undefined;
  const fileIndex = parts.findIndex(part => part.match(/\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)$/));
  const keep = fileIndex >= 0 ? parts.slice(0, Math.max(3, fileIndex)) : parts.slice(0, Math.min(parts.length, 4));
  return `/${keep.join("/")}`;
}

function expandUserPath(path: string): string {
  const withoutFileScheme = path.replace(/^file:\/\//, "");
  if (withoutFileScheme === "~") return homedir();
  if (withoutFileScheme.startsWith("~/")) return `${homedir()}/${withoutFileScheme.slice(2)}`;
  return withoutFileScheme;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function secondsSince(iso?: string): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 1000;
}

function topThreadId(thread?: StoredWorkThread | CandidateThread): string | undefined {
  if (!thread) return undefined;
  return "id" in thread ? thread.id : thread.thread_id;
}

function dedupeRecords(records: StoredContextRecord[]): StoredContextRecord[] {
  const byId = new Map<string, StoredContextRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()];
}

function transientRecord(record: ContextRecord): StoredContextRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    id: record.id ?? randomUUID(),
    time: {
      observed_at: record.time?.observed_at ?? now,
      captured_at: record.time?.captured_at ?? now,
    },
    payload: record.payload ?? {},
    created_at: now,
    updated_at: now,
  };
}

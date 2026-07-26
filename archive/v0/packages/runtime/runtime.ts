import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { ContextStore } from "@info/core";
import type { LlmOptions } from "@info/core";
import type { ContextRecord, StoredContextRecord, StoredContextView, StoredWorkThread } from "@info/core";
import { fetchScreenpipeActivitySummary, fetchScreenpipeInputEvents, fetchScreenpipeRecords, fetchScreenpipeWorkspaceSignals } from "@info/sensors";
import { aiSessionRefToRecord, locateAiSessions, type AiSessionTool } from "@info/sensors";
import { buildCandidateThreads, type CandidateThread } from "@info/views/timeline/correlation.js";
import { compileProjectWorkEpisodeForThread } from "@info/views/timeline/episode-summary.js";
import { buildLocalProjectSnapshotRecord } from "@info/sensors";
import { buildThreadEvidenceMap } from "@info/views/threads/thread-evidence.js";
import {
  buildCandidateRoutes,
  buildRouteCandidateRecord,
  buildSurfaceStateView,
  createDurableMemoryMinerProcessor,
  createMemoryDailyUpdateProcessor,
  createMemoryProfileUpdateProcessor,
  createProjectDecisionExtractorProcessor,
  createProjectInboxProcessor,
  createProjectTasksProcessor,
  createSurfaceStateProcessor,
  createViewPromotionEngineProcessor,
  extractRouteFeatures,
  ProcessorRuntime,
} from "@info/processor-runtime";
import { createDefaultProgramRuntime } from "@info/programs/registry.js";
import { processAmbientBackgroundTasks } from "./background-tasks.js";
import type { AmbientBackgroundTaskMode } from "./background-tasks.js";
import { processToolsmithSandboxArtifacts } from "./toolsmith-artifacts.js";
import type { AutonomyProfile } from "@info/programs/types.js";

const VIEW_WORKER_FUNCTIONS = {
  evidence: "view::evidence_compile",
  activity: "view::activity_compile",
  activityEpisode: "view::activity_episode_compile",
  audio: "view::audio_compile",
  visualFrame: "view::visual_frame_compile",
  activityBlock: "view::activity_block_compile",
  proposal: "view::proposal_compile",
  resource: "view::resource_compile",
  intent: "view::intent_compile",
  workflow: "view::workflow_compile",
  memory: "view::memory_compile",
  memoryCandidate: "view::memory_candidate_compile",
  memoryGate: "view::memory_gate_compile",
  workThread: "view::work_thread_compile",
  workFocusSet: "view::work_focus_set_compile",
  projectCurrent: "view::project_current_compile",
  observationTimeline: "view::timeline_observations_compile",
  activityTimeline: "view::timeline_activity_compile",
  projectTimeline: "view::project_timeline_compile",
  projectWorkEpisode: "view::summary_project_work_episode_compile",
} as const;

export type RuntimeIiiClient = {
  trigger(input: { function_id: string; payload?: unknown; action?: unknown }): Promise<unknown> | unknown;
};

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
  vision_llm?: LlmOptions;
  visual_frame_limit?: number;
  visual_frame_concurrency?: number;
  visual_frame_sample_seconds?: number;
  view_compile_interval_seconds?: number;
  work_thread_view_minutes?: number;
  activity_timeline_minutes?: number;
  project_timeline_minutes?: number;
  process_background_tasks?: boolean;
  background_task_limit?: number;
  background_task_mode?: AmbientBackgroundTaskMode;
  background_task_runtime?: string;
  background_task_dry_run?: boolean;
  background_task_autonomy?: AutonomyProfile;
  process_toolsmith_artifacts?: boolean;
  toolsmith_artifact_limit?: number;
  toolsmith_artifact_output_dir?: string;
};

export const RUNTIME_SETTINGS_KEY = "runtime_settings";

export type RuntimeSettings = {
  compile_views?: boolean;
  ai_view_compression?: boolean;
  visual_view_compression?: boolean;
  ai_paused?: boolean;
  visual_paused?: boolean;
  view_compile_interval_seconds?: number;
  visual_frame_limit?: number;
  visual_frame_concurrency?: number;
  visual_frame_sample_seconds?: number;
  llm?: LlmOptions;
  vision_llm?: LlmOptions;
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

export type RuntimeTickOptions = {
  iii?: RuntimeIiiClient;
};

export function defaultRuntimeSettings(): RuntimeSettings {
  return {
    compile_views: true,
    ai_view_compression: false,
    visual_view_compression: false,
    ai_paused: false,
    visual_paused: false,
    view_compile_interval_seconds: 120,
    visual_frame_limit: Number(process.env.RUNTIME_VISUAL_FRAME_LIMIT ?? 0),
    visual_frame_concurrency: Number(process.env.RUNTIME_VISUAL_FRAME_CONCURRENCY ?? 6),
    visual_frame_sample_seconds: Number(process.env.RUNTIME_VISUAL_FRAME_SAMPLE_SECONDS ?? 45),
    llm: compactLlmOptions({
      base_url: process.env.AI_VIEW_LLM_BASE_URL ?? process.env.LLM_BASE_URL,
      api_key: process.env.AI_VIEW_LLM_API_KEY ?? process.env.LLM_API_KEY,
      model: process.env.AI_VIEW_LLM_MODEL ?? process.env.LLM_MODEL,
      allow_external: true,
      omit_max_tokens: true,
    }),
    vision_llm: compactLlmOptions({
      base_url: process.env.VISION_LLM_BASE_URL,
      api_key: process.env.VISION_LLM_API_KEY,
      model: process.env.VISION_LLM_MODEL,
      allow_external: true,
      omit_max_tokens: true,
    }),
  };
}

export function runtimeSettings(store = new ContextStore()): RuntimeSettings {
  const saved = sanitizeRuntimeSettings(store.getRuntimeState(RUNTIME_SETTINGS_KEY)?.value ?? {});
  return {
    ...defaultRuntimeSettings(),
    ...saved,
    llm: mergeLlm(defaultRuntimeSettings().llm, saved.llm),
    vision_llm: mergeLlm(defaultRuntimeSettings().vision_llm, saved.vision_llm),
  };
}

export function saveRuntimeSettings(input: Record<string, unknown>, store = new ContextStore()): RuntimeSettings {
  const current = runtimeSettings(store);
  const next = sanitizeRuntimeSettings({
    ...current,
    ...input,
    llm: mergeLlm(current.llm, isRecord(input.llm) ? input.llm : undefined),
    vision_llm: mergeLlm(current.vision_llm, isRecord(input.vision_llm) ? input.vision_llm : undefined),
  });
  store.setRuntimeState(RUNTIME_SETTINGS_KEY, next as Record<string, unknown>);
  return next;
}

export function publicRuntimeSettings(settings: RuntimeSettings): RuntimeSettings {
  return {
    ...settings,
    llm: redactLlm(settings.llm),
    vision_llm: redactLlm(settings.vision_llm),
  };
}

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

export async function runtimeTick(req: RuntimeTickRequest = {}, store = new ContextStore(), options: RuntimeTickOptions = {}): Promise<RuntimeTickResult> {
  const generatedAt = new Date().toISOString();
  const settings = runtimeSettings(store);
  const windowMinutes = req.window_minutes ?? 10;
  const timeWindow = { minutes: windowMinutes };
  const includeScreenpipe = req.include_screenpipe ?? true;
  const includeAiSessions = req.include_ai_sessions ?? true;
  const includeGit = req.include_git ?? true;
  const write = req.write ?? true;
  const force = req.force ?? false;
  const diagnostics: Record<string, unknown> = {};
  const compiledViews: RuntimeTickResult["compiled_views"] = [];
  const iii = options.iii;
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

    const screenpipeAudio = await fetchScreenpipeRecords({
      limit: Math.max(req.screenpipe_limit ?? 8, Number(process.env.RUNTIME_SCREENPIPE_AUDIO_LIMIT ?? 20)),
      content_type: "audio",
      start_time: `${windowMinutes}m ago`,
      end_time: "now",
    });
    diagnostics.screenpipe_audio = {
      ok: screenpipeAudio.ok,
      url: screenpipeAudio.url,
      query: screenpipeAudio.query,
      count: screenpipeAudio.records.length,
      error: screenpipeAudio.error,
    };
    screenpipeRecords.push(...screenpipeAudio.records);
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
  const routeCandidateRecords = buildRuntimeRouteCandidates(records, store, write);
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

  const effectiveLlm = mergeLlm(settings.llm, req.llm);
  const effectiveVisionLlm = mergeLlm(settings.vision_llm, req.vision_llm);
  const shouldCompileViews = req.compile_views ?? settings.compile_views ?? true;
  const effectiveAiCompression = settings.ai_paused ? false : (req.ai_view_compression ?? settings.ai_view_compression ?? true);
  const effectiveVisualCompression = settings.visual_paused ? false : (req.visual_view_compression ?? settings.visual_view_compression ?? effectiveAiCompression);
  const viewCompileIntervalSeconds = req.view_compile_interval_seconds ?? settings.view_compile_interval_seconds ?? 120;
  const lastViewCompileAt = stringValue(previousTick.last_view_compile_at);
  const shouldRunViewCompilers = shouldCompileViews && (force || secondsSince(lastViewCompileAt) >= viewCompileIntervalSeconds);
  diagnostics.view_compile = {
    enabled: shouldCompileViews,
    ai_view_compression: effectiveAiCompression,
    visual_view_compression: effectiveVisualCompression,
    ai_paused: settings.ai_paused,
    visual_paused: settings.visual_paused,
    interval_seconds: viewCompileIntervalSeconds,
    skipped: !shouldRunViewCompilers,
    last_view_compile_at: lastViewCompileAt,
  };
  if (shouldRunViewCompilers) {
    compiledViews.push(...await compileRuntimeViews({
      store,
      iii,
      write,
      records,
      routeCandidateRecords,
      activeWorkspace,
      windowMinutes,
      aiViewCompression: effectiveAiCompression,
      visualViewCompression: effectiveVisualCompression,
      llm: effectiveLlm,
      visionLlm: effectiveVisionLlm,
      visualFrameLimit: req.visual_frame_limit ?? settings.visual_frame_limit,
      visualFrameConcurrency: req.visual_frame_concurrency ?? settings.visual_frame_concurrency,
      visualFrameSampleSeconds: req.visual_frame_sample_seconds ?? settings.visual_frame_sample_seconds,
      force,
      workThreadMinutes: req.work_thread_view_minutes,
      activityMinutes: req.activity_timeline_minutes,
      projectMinutes: req.project_timeline_minutes,
    }));
    diagnostics.compiled_views = compiledViews;
  }

  const shouldProcessBackgroundTasks = req.process_background_tasks ?? process.env.RUNTIME_BACKGROUND_TASKS === "1";
  if (shouldProcessBackgroundTasks) {
    const backgroundTasks = await processAmbientBackgroundTasks({
      limit: req.background_task_limit,
      write,
      iii,
      mode: req.background_task_mode,
      runtime: req.background_task_runtime,
      dry_run: req.background_task_dry_run,
      autonomy: req.background_task_autonomy,
    }, store);
    diagnostics.background_tasks = backgroundTasks;
    compiledViews.push({
      view_type: "background_tasks",
      view_count: backgroundTasks.processed,
      title: "Ambient Background Tasks",
      skipped: backgroundTasks.skipped ? `${backgroundTasks.skipped} skipped` : undefined,
    });
  }

  const shouldProcessToolsmithArtifacts = req.process_toolsmith_artifacts ?? process.env.RUNTIME_TOOLSMITH_ARTIFACTS === "1";
  if (shouldProcessToolsmithArtifacts) {
    const toolsmithArtifacts = processToolsmithSandboxArtifacts({
      limit: req.toolsmith_artifact_limit,
      write,
      output_dir: req.toolsmith_artifact_output_dir,
    }, store);
    diagnostics.toolsmith_artifacts = toolsmithArtifacts;
    compiledViews.push({
      view_type: "toolsmith_artifacts",
      view_count: toolsmithArtifacts.processed,
      title: "Toolsmith Sandbox Artifacts",
      skipped: toolsmithArtifacts.skipped ? `${toolsmithArtifacts.skipped} skipped` : undefined,
    });
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
  iii?: RuntimeIiiClient;
  write: boolean;
  records?: StoredContextRecord[];
  routeCandidateRecords?: StoredContextRecord[];
  activeWorkspace?: WorkspaceCandidate;
  windowMinutes: number;
  aiViewCompression?: boolean;
  visualViewCompression?: boolean;
  llm?: LlmOptions;
  visionLlm?: LlmOptions;
  visualFrameLimit?: number;
  visualFrameConcurrency?: number;
  visualFrameSampleSeconds?: number;
  force?: boolean;
  workThreadMinutes?: number;
  activityMinutes?: number;
  projectMinutes?: number;
}): Promise<RuntimeTickResult["compiled_views"]> {
  const out: RuntimeTickResult["compiled_views"] = [];
  const surface = await compileSurfaceStateView(input.store, input.records ?? [], input.windowMinutes, input.write);
  out.push(surface);
  out.push(...compileAutomationOutcomeViews(input.store, { write: input.write, minutes: Math.max(input.windowMinutes, 240) }));
  out.push(...compileProjectWorkEpisodeSummaries(input.store, { write: input.write, limit: 6 }));
  if (!input.iii) {
    out.push({ view_type: "iii_runtime", skipped: "iii runtime client required for remote view compilation" });
    return out;
  }
  const iii = input.iii;
  try {
    const compiled = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.evidence, {
      minutes: Math.max(input.windowMinutes, 240),
      limit: 500,
      write: input.write,
      source_record_ids: input.records?.map(record => record.id),
    });
    out.push({ view_type: "evidence", records_used: numberValue(compiled.diagnostics.records_used), view_count: compiled.views.length, title: "Evidence Views" });

    const activities = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.activity, {
      minutes: Math.max(input.windowMinutes, 240),
      limit: 500,
      write: input.write,
      source_view_ids: compiled.views_written,
    });
    out.push({ view_type: "activity", records_used: numberValue(compiled.diagnostics.records_used), view_count: activities.views.length, title: "Activity Views" });

    const episodes = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.activityEpisode, {
      minutes: input.activityMinutes ?? Math.max(input.windowMinutes, 240),
      limit: 500,
      write: input.write,
      source_record_ids: input.records?.map(record => record.id),
      llm: input.aiViewCompression ? input.llm : undefined,
      summarize_with_llm: input.aiViewCompression,
      llm_episode_limit: 6,
    });
    out.push({ view_type: "activity.episode", records_used: numberValue(episodes.diagnostics.records_used), view_count: episodes.views.length, title: input.aiViewCompression ? "AI Activity Episodes" : "Activity Episodes" });

    const audioViews = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.audio, {
      write: input.write,
      source_view_ids: compiled.views_written,
      llm: input.llm,
    });
    out.push({ view_type: "audio", view_count: audioViews.views.length, title: "AI Audio Views" });

    let activityBlocks: RuntimeViewWorkerResult | undefined;
    if (input.visualViewCompression) {
      const visualFrames = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.visualFrame, {
        write: input.write,
        source_view_ids: compiled.views_written,
        llm: input.visionLlm,
        visual_frame_limit: input.visualFrameLimit,
        visual_frame_concurrency: input.visualFrameConcurrency,
        visual_frame_sample_seconds: input.visualFrameSampleSeconds,
        force: input.force,
      });
      out.push({ view_type: "visual_frame", view_count: visualFrames.views.length, title: "AI VisualFrame Views" });

      activityBlocks = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.activityBlock, {
        write: input.write,
        source_view_ids: [...visualFrames.views_written, ...audioViews.views_written, ...activities.views_written],
        llm: input.llm,
        minutes: 10,
      });
      out.push({ view_type: "activity_block", view_count: activityBlocks.views.length, title: "AI ActivityBlock Views" });
    }

    const proposals = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.proposal, {
      write: input.write,
      source_view_ids: [...activities.views_written, ...(activityBlocks?.views_written ?? [])],
    });
    out.push({ view_type: "proposal", view_count: proposals.views.length, title: "Proposal Views" });

    const resources = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.resource, {
      write: input.write,
      source_view_ids: proposals.views_written,
    });
    out.push({ view_type: "resource", view_count: resources.views.length, title: "Resource Views" });

    const intents = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.intent, {
      write: input.write,
      source_view_ids: [...proposals.views_written, ...(activityBlocks?.views_written ?? [])],
      llm: input.aiViewCompression ? input.llm : undefined,
    });
    out.push({ view_type: "intent", view_count: intents.views.length, title: input.aiViewCompression ? "AI Intent Views" : "Intent Views" });

    const workflows = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.workflow, {
      write: input.write,
      source_view_ids: [...intents.views_written, ...resources.views_written, ...(activityBlocks?.views_written ?? [])],
      llm: input.aiViewCompression ? input.llm : undefined,
    });
    out.push({ view_type: "workflow", view_count: workflows.views.length, title: input.aiViewCompression ? "AI Workflow Views" : "Workflow Views" });

    const memories = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.memory, {
      write: input.write,
      source_view_ids: workflows.views_written,
      llm: input.aiViewCompression ? input.llm : undefined,
    });
    out.push({ view_type: "memory", view_count: memories.views.length, title: input.aiViewCompression ? "AI Memory Views" : "Memory Views" });
  } catch (error) {
    out.push({ view_type: "evidence", skipped: error instanceof Error ? error.message : String(error) });
  }

  try {
    const compiled = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.workThread, {
      minutes: input.workThreadMinutes ?? Math.max(input.windowMinutes, 180),
      limit: 180,
      write: input.write,
    });
    out.push({
      view_type: "work_thread",
      view_id: compiled.views[0]?.id,
      title: compiled.views[0]?.title,
      records_used: numberValue(compiled.diagnostics.records_used),
      work_thread_count: numberValue(compiled.diagnostics.work_thread_count),
    });
  } catch (error) {
    out.push({ view_type: "work_thread", skipped: error instanceof Error ? error.message : String(error) });
  }

  try {
    const compiled = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.workFocusSet, {
      minutes: Math.max(input.windowMinutes, 90),
      limit: 200,
      write: input.write,
      source_record_ids: [...(input.records?.map(record => record.id) ?? []), ...(input.routeCandidateRecords?.map(record => record.id) ?? [])],
    });
    out.push({
      view_type: "work.focus_set",
      view_id: compiled.views[0]?.id,
      title: compiled.views[0]?.title,
      records_used: numberValue(compiled.diagnostics.route_candidates_used),
      view_count: compiled.views.length,
    });

    const projectCurrent = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.projectCurrent, {
      write: input.write,
      source_view_ids: compiled.views_written,
      source_record_ids: input.records?.map(record => record.id),
    });
    out.push({
      view_type: "project.current",
      view_id: projectCurrent.views[0]?.id,
      title: projectCurrent.views[0]?.title,
      view_count: projectCurrent.views.length,
    });

    out.push(...await runLocalViewProducers({
      store: input.store,
      write: input.write,
      records: input.records ?? [],
      sourceViewIds: [...compiled.views_written, ...projectCurrent.views_written],
      windowMinutes: input.windowMinutes,
    }));

    const memoryCandidates = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.memoryCandidate, {
      write: input.write,
      source_record_ids: input.records?.map(record => record.id),
      source_view_ids: [...compiled.views_written, ...projectCurrent.views_written],
    });
    out.push({
      view_type: "memory.candidate",
      view_count: memoryCandidates.views.length,
      title: "Memory Candidate Views",
    });

    const gatedMemory = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.memoryGate, {
      write: input.write,
      source_view_ids: memoryCandidates.views_written,
    });
    out.push({
      view_type: "memory.gate",
      view_count: gatedMemory.views.length,
      title: "Memory Gate",
    });
  } catch (error) {
    out.push({ view_type: "work.focus_set/project.current", skipped: error instanceof Error ? error.message : String(error) });
  }

  try {
    const compiled = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.activityTimeline, {
      minutes: input.activityMinutes ?? Math.max(input.windowMinutes, 240),
      limit: 400,
      write: input.write,
    });
    out.push({
      view_type: "timeline.activity",
      view_id: compiled.views[0]?.id,
      title: compiled.views[0]?.title,
      records_used: numberValue(compiled.diagnostics.records_used),
      bucket_count: numberValue(compiled.diagnostics.bucket_count),
    });
  } catch (error) {
    out.push({ view_type: "timeline.activity", skipped: error instanceof Error ? error.message : String(error) });
  }

  if (input.activeWorkspace?.project_path) {
    try {
      const compiled = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.projectTimeline, {
        project_path: input.activeWorkspace.project_path,
        project: input.activeWorkspace.project,
        minutes: input.projectMinutes ?? 2 * 24 * 60,
        limit: 500,
        write: input.write,
      });
      out.push({
        view_type: "project_timeline",
        view_id: compiled.views[0]?.id,
        title: compiled.views[0]?.title,
        records_used: numberValue(compiled.diagnostics.records_used),
        bucket_count: numberValue(compiled.diagnostics.bucket_count),
        work_thread_count: numberValue(compiled.diagnostics.work_thread_count),
      });
    } catch (error) {
      out.push({ view_type: "project_timeline", skipped: error instanceof Error ? error.message : String(error) });
    }
  } else {
    out.push({ view_type: "project_timeline", skipped: "no active workspace" });
  }

  try {
    const compiled = await triggerViewWorker(iii, VIEW_WORKER_FUNCTIONS.projectWorkEpisode, {
      limit: 6,
      write: input.write,
    });
    out.push({
      view_type: "summary.project_work_episode",
      view_id: compiled.views[0]?.id,
      title: compiled.views[0]?.title,
      view_count: compiled.views.length,
      records_used: numberValue(compiled.diagnostics.threads_summarized),
    });
  } catch (error) {
    out.push({ view_type: "summary.project_work_episode", skipped: error instanceof Error ? error.message : String(error) });
  }
  return out;
}

async function compileSurfaceStateView(
  store: ContextStore,
  records: StoredContextRecord[],
  windowMinutes: number,
  write: boolean,
): Promise<RuntimeTickResult["compiled_views"][number]> {
  const seed = records.slice().sort((a, b) => recordTimeMs(b) - recordTimeMs(a)).find(isSurfaceSeedRecord);
  if (!seed) {
    return {
      view_type: "state.surface",
      skipped: "no recent surface observations",
    };
  }
  if (!write) {
    const view = buildSurfaceStateView({
      seed,
      records,
    });
    return {
      view_type: "state.surface",
      title: view.title,
      records_used: view.source_records?.length ?? 0,
      view_count: 1,
    };
  }
  const runtime = new ProcessorRuntime({
    store,
    processors: [createSurfaceStateProcessor({ windowMinutes: Math.max(windowMinutes, 10) })],
  });
  const result = await runtime.processObservation(seed);
  const run = result.runs.find(item => item.processor_id === "processor.surface_state");
  const viewId = result.views_written[0];
  if (!run?.ok) {
    return {
      view_type: "state.surface",
      skipped: run?.error ?? "surface processor did not complete",
    };
  }
  return {
    view_type: "state.surface",
    view_id: write ? viewId : undefined,
    title: "Current Surface",
    records_used: numberValue(run.diagnostics.source_records),
    view_count: result.views_written.length,
  };
}

function isSurfaceSeedRecord(record: StoredContextRecord): boolean {
  const schema = record.schema.name;
  return schema.startsWith("observation.browser_")
    || schema.startsWith("observation.editor.")
    || schema.startsWith("observation.media.")
    || schema.startsWith("observation.youtube.")
    || schema.startsWith("observation.screenpipe_")
    || schema === "observation.local_project";
}

function recordTimeMs(record: StoredContextRecord): number {
  const value = record.time?.observed_at ?? record.updated_at ?? record.created_at;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

type RuntimeViewWorkerPayload = {
  write?: boolean;
  minutes?: number;
  limit?: number;
  llm?: LlmOptions;
  vision_llm?: LlmOptions;
  visual_frame_limit?: number;
  visual_frame_concurrency?: number;
  visual_frame_sample_seconds?: number;
  force?: boolean;
  summarize_with_llm?: boolean;
  llm_episode_limit?: number;
  project_path?: string;
  project?: string;
  plugin_id?: string;
  source_record_ids?: string[];
  source_view_ids?: string[];
  thread_id?: string;
  thread_ids?: string[];
};

type RuntimeViewWorkerResult = {
  ok: true;
  function_id: string;
  view_type: string;
  generated_at: string;
  views_written: string[];
  views: any[];
  diagnostics: Record<string, unknown>;
};

type LocalViewProducerResult = {
  view_type: string;
  view_id?: string;
  title?: string;
  view_count?: number;
  records_used?: number;
  skipped?: string;
};

function compileProjectWorkEpisodeSummaries(
  store: ContextStore,
  options: { write: boolean; limit: number },
): RuntimeTickResult["compiled_views"] {
  const threads = store.listWorkThreads("candidate").slice(0, options.limit);
  if (!threads.length) return [{ view_type: "summary.project_work_episode", skipped: "no candidate work threads" }];
  const summaries: RuntimeTickResult["compiled_views"] = [];
  for (const thread of threads) {
    const evidenceCount = store.recordsForThread(thread.id, 1).length;
    if (!evidenceCount) {
      summaries.push({ view_type: "summary.project_work_episode", skipped: `no evidence records for ${thread.id}` });
      continue;
    }
    const result = compileProjectWorkEpisodeForThread(thread.id, { write: options.write, store });
    if (!result.ok) {
      summaries.push({ view_type: "summary.project_work_episode", skipped: result.error });
      continue;
    }
    summaries.push({
      view_type: "summary.project_work_episode",
      view_id: options.write ? result.written : result.view.id,
      title: result.view.title,
      records_used: result.summary.record_count,
      view_count: 1,
    });
  }
  return summaries;
}

function compileAutomationOutcomeViews(
  store: ContextStore,
  options: { write: boolean; minutes: number },
): RuntimeTickResult["compiled_views"] {
  const events = store.listRuntimeEvents({ limit: 80, timeWindow: { minutes: options.minutes } })
    .filter(isActionOutcomeEvent);
  if (!events.length) return [{ view_type: "automation.outcome", skipped: "no recent action outcome events" }];
  const views = events.map(event => buildAutomationOutcomeView(event));
  const stored = options.write ? views.map(view => store.upsertView(view)) : views;
  return [{
    view_type: "automation.outcome",
    view_id: stored[0]?.id,
    title: stored[0]?.title,
    view_count: stored.length,
  }];
}

function isActionOutcomeEvent(event: { event_type: string; actor: string; status?: string; plugin_id?: string }): boolean {
  if (!["completed", "failed", "denied"].includes(event.status ?? "")) return false;
  if (event.event_type.startsWith("agent_task.")) return true;
  if (event.event_type.startsWith("browser_action.")) return true;
  if (event.event_type.startsWith("tool.")) return true;
  if (event.event_type.startsWith("capability.run.") && /agent_task|browser|tool/i.test(event.plugin_id ?? event.event_type)) return true;
  return false;
}

function buildAutomationOutcomeView(event: {
  id: string;
  event_type: string;
  actor: "user" | "system" | "connector" | "plugin" | "agent";
  status?: "started" | "completed" | "failed" | "denied";
  subject_type?: "record" | "view" | "thread" | "plugin" | "query" | "runtime" | "action";
  subject_id?: string;
  plugin_id?: string;
  related_records?: string[];
  related_views?: string[];
  related_threads?: string[];
  payload?: Record<string, unknown>;
  created_at: string;
}): StoredContextView {
  const status = event.status ?? (event.event_type.endsWith(".failed") ? "failed" : "completed");
  const actionType = stringValue(event.payload?.action_type) ?? event.plugin_id ?? event.event_type;
  const requestId = stringValue(event.payload?.request_id) ?? event.subject_id ?? event.id;
  const ok = status === "completed";
  return {
    id: `automation:outcome:${event.id}`,
    view_type: "automation.outcome",
    title: `Automation outcome: ${actionType}`,
    summary: `${actionType} ${status}`,
    status: status === "failed" || status === "denied" ? "candidate" : "accepted",
    source_records: event.related_records ?? [],
    source_views: event.related_views ?? [],
    compiler: { id: "runtime.automation_outcome", version: "1", mode: "deterministic" },
    purpose: "Unified outcome record for agent task, browser action, and tool automation loops.",
    scope: { app: stringValue(event.payload?.app), plugin_id: event.plugin_id },
    content: {
      request_id: requestId,
      action_type: actionType,
      status,
      ok,
      event_id: event.id,
      event_type: event.event_type,
      actor: event.actor,
      subject_type: event.subject_type,
      subject_id: event.subject_id,
      plugin_id: event.plugin_id,
      outcome: {
        ok,
        request_id: requestId,
        action_type: actionType,
        status,
        error: stringValue(event.payload?.error),
        reason: stringValue(event.payload?.reason),
        output_views: event.related_views ?? [],
        output_records: event.related_records ?? [],
        diagnostics: event.payload,
        started_at: stringValue(event.payload?.started_at) ?? event.created_at,
        finished_at: stringValue(event.payload?.finished_at) ?? event.created_at,
      },
      created_at: event.created_at,
    },
    confidence: ok ? 0.82 : 0.9,
    stability: "session",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    metadata: { source_event_id: event.id, source_event_type: event.event_type, related_threads: event.related_threads ?? [] },
    created_at: event.created_at,
    updated_at: event.created_at,
  };
}

async function triggerViewWorker(iii: RuntimeIiiClient, functionId: string, payload: RuntimeViewWorkerPayload): Promise<RuntimeViewWorkerResult> {
  const result = await iii.trigger({ function_id: functionId, payload });
  if (!isRecord(result) || result.ok !== true || !Array.isArray(result.views)) {
    throw new Error(`iii view worker returned invalid result: ${functionId}`);
  }
  return result as RuntimeViewWorkerResult;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

async function runLocalViewProducers(input: {
  store: ContextStore;
  write: boolean;
  records: StoredContextRecord[];
  sourceViewIds: string[];
  windowMinutes: number;
}): Promise<LocalViewProducerResult[]> {
  const processors = [
    createProjectInboxProcessor({ limit: 30 }),
    createProjectTasksProcessor({ limit: 30 }),
    createProjectDecisionExtractorProcessor({ limit: 30 }),
    createMemoryDailyUpdateProcessor({ recordLimit: 120, viewLimit: 40 }),
    createDurableMemoryMinerProcessor({ recordLimit: 160, viewLimit: 60 }),
    createMemoryProfileUpdateProcessor({ dailyLimit: 14, feedbackLimit: 60 }),
  ];
  const promotionProcessor = createViewPromotionEngineProcessor({ windowMinutes: Math.max(input.windowMinutes, 12 * 60) });
  if (!input.write) {
    return [...processors, promotionProcessor].flatMap(processor => (processor.produces.views ?? []).map(viewType => ({
      view_type: viewType,
      skipped: "dry-run local processor wiring",
    })));
  }

  const runtime = new ProcessorRuntime({ store: input.store, processors });
  const seeds = localViewProducerSeeds(input.store, input.records, input.sourceViewIds);
  const writtenByType = new Map<string, string[]>();
  const skipped = new Map<string, string>();

  for (const seed of seeds) {
    const result = seed.kind === "record"
      ? await runtime.processObservation(seed.value)
      : await runtime.processView(seed.value);
    for (const run of result.runs) {
      const processor = processors.find(item => item.id === run.processor_id);
      if (!processor) continue;
      if (!run.ok) {
        for (const viewType of processor.produces.views ?? []) skipped.set(viewType, run.error ?? "processor failed");
        continue;
      }
      for (const id of run.views_written) {
        const view = input.store.getView(id);
        if (!view) continue;
        const ids = writtenByType.get(view.view_type) ?? [];
        ids.push(id);
        writtenByType.set(view.view_type, ids);
      }
    }
  }

  const localSummaries = processors.flatMap(processor => processor.produces.views ?? []).map(viewType => {
    const ids = [...new Set(writtenByType.get(viewType) ?? [])];
    const view = ids.length ? input.store.getView(ids[0]) : undefined;
    return {
      view_type: viewType,
      view_id: view?.id,
      title: view?.title,
      view_count: ids.length,
      skipped: ids.length ? undefined : skipped.get(viewType) ?? "no matching seed produced this view",
    };
  });

  const promotionSummary = await runViewPromotionProducer(input.store, promotionProcessor, seeds);
  const languageSummaries = await runLanguageLearningProducer(input.store, seeds, input.write);
  return [...localSummaries, promotionSummary, ...languageSummaries];
}

async function runViewPromotionProducer(
  store: ContextStore,
  processor: ReturnType<typeof createViewPromotionEngineProcessor>,
  seeds: Array<{ kind: "record"; value: StoredContextRecord } | { kind: "view"; value: StoredContextView }>,
): Promise<LocalViewProducerResult> {
  const seed = seeds.find(item => item.kind === "record") ?? seeds[0];
  if (!seed) return { view_type: "view.promotion_candidates", view_count: 0, skipped: "no local producer seed" };
  const runtime = new ProcessorRuntime({ store, processors: [processor] });
  const result = seed.kind === "record"
    ? await runtime.processObservation(seed.value)
    : await runtime.processView(seed.value);
  const ids = result.runs.flatMap(run => run.views_written);
  const view = ids.length ? store.getView(ids[0]) : undefined;
  return {
    view_type: "view.promotion_candidates",
    view_id: view?.id,
    title: view?.title,
    view_count: ids.length,
    skipped: ids.length ? undefined : result.runs.find(run => !run.ok)?.error ?? "no promotion candidate view written",
  };
}

function localViewProducerSeeds(
  store: ContextStore,
  records: StoredContextRecord[],
  sourceViewIds: string[],
): Array<{ kind: "record"; value: StoredContextRecord } | { kind: "view"; value: StoredContextView }> {
  const recordSeeds = [
    ...records,
    ...store.recent(80).filter(record =>
      record.schema.name === "observation.codex.message" ||
      record.schema.name === "observation.claude.message" ||
      record.schema.name.startsWith("feedback.") ||
      record.schema.name === "observation.route_candidate" ||
      record.schema.name === "observation.youtube.comprehension_gap",
    ),
  ];
  const recordById = new Map(recordSeeds.map(record => [record.id, record]));
  const viewIds = new Set([
    ...sourceViewIds,
    ...store.listViews({
      view_types: ["project.current", "project.inbox", "project.decisions", "memory.daily", "work.focus_set"],
      active_only: true,
      limit: 24,
    }).map(view => view.id),
  ]);
  return [
    ...[...recordById.values()]
      .sort((a, b) => recordTimeMs(b) - recordTimeMs(a))
      .slice(0, 80)
      .map(value => ({ kind: "record" as const, value })),
    ...[...viewIds]
      .map(id => store.getView(id))
      .filter((view): view is StoredContextView => Boolean(view))
      .map(value => ({ kind: "view" as const, value })),
  ];
}

async function runLanguageLearningProducer(
  store: ContextStore,
  seeds: Array<{ kind: "record"; value: StoredContextRecord } | { kind: "view"; value: StoredContextView }>,
  write: boolean,
): Promise<LocalViewProducerResult[]> {
  if (!write) {
    return [
      { view_type: "app.language.learning_pack", skipped: "dry-run local program wiring" },
      { view_type: "memory.language.vocabulary_exposure", skipped: "dry-run local program wiring" },
    ];
  }

  const runtime = createDefaultProgramRuntime(store);
  const languageSeeds = seeds
    .filter((seed): seed is { kind: "record"; value: StoredContextRecord } => seed.kind === "record")
    .filter(seed => seed.value.schema.name.startsWith("feedback.language."))
    .slice(0, 12);
  const writtenIds: string[] = [];
  for (const seed of languageSeeds) {
    const result = await runtime.processObject(seed.value, {
      program_id: "program.language_learning",
      max_programs: 1,
      speed: "background",
      autonomy: "draft",
    });
    writtenIds.push(...result.runs.flatMap(run => run.written_views));
  }
  const byType = new Map<string, string[]>();
  for (const id of writtenIds) {
    const view = store.getView(id);
    if (!view) continue;
    const ids = byType.get(view.view_type) ?? [];
    ids.push(id);
    byType.set(view.view_type, ids);
  }
  return ["app.language.learning_pack", "memory.language.vocabulary_exposure"].map(viewType => {
    const ids = [...new Set(byType.get(viewType) ?? [])];
    const view = ids.length ? store.getView(ids[0]) : undefined;
    return {
      view_type: viewType,
      view_id: view?.id,
      title: view?.title,
      view_count: ids.length,
      skipped: ids.length ? undefined : "no recent language feedback seed",
    };
  });
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

function sanitizeRuntimeSettings(input: Record<string, unknown>): RuntimeSettings {
  const out: RuntimeSettings = {};
  for (const key of ["compile_views", "ai_view_compression", "visual_view_compression", "ai_paused", "visual_paused"] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  const numbers: Array<[keyof RuntimeSettings, unknown]> = [
    ["view_compile_interval_seconds", input.view_compile_interval_seconds],
    ["visual_frame_limit", input.visual_frame_limit],
    ["visual_frame_concurrency", input.visual_frame_concurrency],
    ["visual_frame_sample_seconds", input.visual_frame_sample_seconds],
  ];
  for (const [key, value] of numbers) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) (out as Record<string, unknown>)[key] = Math.floor(n);
  }
  if (isRecord(input.llm)) out.llm = compactLlmOptions(input.llm);
  if (isRecord(input.vision_llm)) out.vision_llm = compactLlmOptions(input.vision_llm);
  return out;
}

function mergeLlm(base?: LlmOptions, override?: Record<string, unknown> | LlmOptions): LlmOptions | undefined {
  const merged = compactLlmOptions({ ...(base ?? {}), ...(override ?? {}) });
  return Object.keys(merged).length ? merged : undefined;
}

function compactLlmOptions(input: Record<string, unknown>): LlmOptions {
  const out: LlmOptions = {};
  const baseUrl = stringValue(input.base_url);
  const apiKey = stringValue(input.api_key);
  const model = stringValue(input.model);
  if (baseUrl) out.base_url = baseUrl;
  if (apiKey && !isRedactedSecret(apiKey)) out.api_key = apiKey;
  if (model) out.model = model;
  const temperature = Number(input.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const maxTokens = Number(input.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.floor(maxTokens);
  if (typeof input.omit_max_tokens === "boolean") out.omit_max_tokens = input.omit_max_tokens;
  if (typeof input.allow_external === "boolean") out.allow_external = input.allow_external;
  return out;
}

function redactLlm(llm?: LlmOptions): LlmOptions | undefined {
  if (!llm) return undefined;
  return {
    ...llm,
    api_key: llm.api_key ? redactSecret(llm.api_key) : undefined,
  };
}

function redactSecret(secret: string): string {
  if (secret.length <= 10) return "********";
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

function isRedactedSecret(secret: string): boolean {
  return secret.includes("…") || /^\*+$/.test(secret);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function buildRuntimeRouteCandidates(records: StoredContextRecord[], store: ContextStore, write: boolean): StoredContextRecord[] {
  const out: StoredContextRecord[] = [];
  for (const record of records) {
    if (record.schema.name === "observation.route_candidate") continue;
    if (record.privacy?.retention === "do_not_store" || record.privacy?.level === "secret") continue;
    const features = extractRouteFeatures(record);
    const routes = buildCandidateRoutes(features, out);
    if (!routes.length) continue;
    const draft = buildRouteCandidateRecord(record, features, routes);
    const stored = write ? store.insertRecord(draft) : transientRecord(draft);
    out.push(stored);
  }
  return out;
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

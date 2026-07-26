import { buildContextPack } from "@info/core";
import { ContextStore } from "@info/core";
import type { ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import { signalFromObject } from "@info/programs/signals.js";
import type { AutonomyProfile } from "@info/programs/types.js";
import { buildAgentTaskList } from "./agent-tasks.js";

const BACKGROUND_TASK_TYPES = ["task.background_research"] as const;
const BACKGROUND_TASK_SOURCE_TYPES = ["project.current", "work.focus_set"] as const;
const AGENT_TASK_SUBMIT_FUNCTION = "capability::agent_task_submit";

export type BackgroundTaskIiiClient = {
  trigger(input: { function_id: string; payload?: unknown; action?: unknown }): Promise<unknown> | unknown;
};

export type AmbientBackgroundTaskMode = "queue" | "process" | "queue_and_process";

export type AmbientBackgroundTaskResult = {
  ok: true;
  generated_at: string;
  mode: AmbientBackgroundTaskMode;
  queued: number;
  processed: number;
  skipped: number;
  written_views: string[];
  tasks: Array<{
    task_view_id: string;
    task_view_type: string;
    status: "queued" | "completed" | "failed" | "skipped";
    reason?: string;
    runtime?: string;
    output_view_type?: string;
    written_views?: string[];
    source_view_id?: string;
  }>;
};

export async function processAmbientBackgroundTasks(options: {
  limit?: number;
  write?: boolean;
  iii?: BackgroundTaskIiiClient;
  mode?: AmbientBackgroundTaskMode;
  runtime?: string;
  dry_run?: boolean;
  autonomy?: AutonomyProfile;
} = {}, store = new ContextStore()): Promise<AmbientBackgroundTaskResult> {
  const generatedAt = new Date().toISOString();
  const mode = options.mode ?? "queue_and_process";
  const write = options.write ?? true;
  const dryRun = options.dry_run ?? write === false;
  const limit = options.limit ?? 8;
  const tasks: AmbientBackgroundTaskResult["tasks"] = [];
  const writtenViews: string[] = [];

  if (mode === "queue" || mode === "queue_and_process") {
    for (const source of queueableSourceViews(store, limit)) {
      const planned = planTaskForSourceView(source, generatedAt, store);
      if (!planned.ok) {
        tasks.push({ task_view_id: source.id, task_view_type: source.view_type, status: "skipped", reason: planned.reason, source_view_id: source.id });
        continue;
      }
      writtenViews.push(planned.view.id!);
      tasks.push({
        task_view_id: planned.view.id!,
        task_view_type: planned.view.view_type,
        status: "queued",
        reason: "queued safe proactive background research task",
        output_view_type: "brief.background_research",
        written_views: [planned.view.id!],
        source_view_id: source.id,
      });
      if (write && !dryRun) writeQueuedTask(store, source, planned.view, generatedAt, dryRun);
    }
  }

  if (write && !dryRun) buildAgentTaskList({ write: true }, store);
  if (mode === "queue") return result(generatedAt, mode, tasks, writtenViews, 0);

  const candidates = store.listViews({ view_types: [...BACKGROUND_TASK_TYPES], active_only: true, limit })
    .filter(view => !taskAlreadyFinished(view));

  for (const view of candidates) {
    if (!hasProvenance(view)) {
      tasks.push({ task_view_id: view.id, task_view_type: view.view_type, status: "skipped", reason: `background task ${view.id} has no source_records or source_views` });
      continue;
    }

    const requiredAutonomy = requiredAutonomyForTask(view);
    const autonomy = options.autonomy ?? requiredAutonomy;
    if (!autonomyAllowed(autonomy, requiredAutonomy)) {
      tasks.push({ task_view_id: view.id, task_view_type: view.view_type, status: "skipped", reason: `autonomy denied: requires ${requiredAutonomy}, got ${autonomy}` });
      continue;
    }

    const runtimeId = runtimeForTask(view, options.runtime);
    if (!runtimeId) {
      const reason = `background task delegation disabled for ${view.view_type}`;
      tasks.push({ task_view_id: view.id, task_view_type: view.view_type, status: "skipped", reason });
      continue;
    }

    const privacyDenial = privacyDenialForTask(view, store, runtimeId, dryRun);
    if (privacyDenial) {
      tasks.push({ task_view_id: view.id, task_view_type: view.view_type, status: "skipped", reason: privacyDenial, runtime: runtimeId });
      continue;
    }

    const task = buildAgentTask(view, runtimeId, store);
    if (!options.iii) {
      const reason = "iii runtime client missing for background task capability";
      tasks.push({ task_view_id: view.id, task_view_type: view.view_type, status: "failed", reason, runtime: runtimeId, output_view_type: task.output_contract.view_type, written_views: [] });
      continue;
    }

    const response = await options.iii.trigger({
      function_id: AGENT_TASK_SUBMIT_FUNCTION,
      payload: {
        signal: signalFromObject(view),
        speed: "background",
        autonomy,
        dry_run: dryRun,
        payload: { task },
      },
    });
    const capability = unwrapCapabilityResult(response);
    const outputViewIds = capability.written_views ?? [];
    writtenViews.push(...outputViewIds);
    const entry = {
      task_view_id: view.id,
      task_view_type: view.view_type,
      status: capability.ok ? "completed" : "failed",
      reason: capability.reason,
      runtime: runtimeId,
      output_view_type: task.output_contract.view_type,
      written_views: outputViewIds,
    } as const;
    tasks.push(entry);
    if (write && !dryRun) markTaskProcessed(store, view, entry, generatedAt);
  }

  if (write && !dryRun) buildAgentTaskList({ write: true }, store);
  return result(generatedAt, mode, tasks, writtenViews);
}

function result(generatedAt: string, mode: AmbientBackgroundTaskMode, tasks: AmbientBackgroundTaskResult["tasks"], writtenViews: string[], processedOverride?: number): AmbientBackgroundTaskResult {
  return {
    ok: true,
    generated_at: generatedAt,
    mode,
    queued: tasks.filter(task => task.status === "queued").length,
    processed: processedOverride ?? tasks.filter(task => task.status === "completed" || task.status === "failed").length,
    skipped: tasks.filter(task => task.status === "skipped").length,
    written_views: writtenViews,
    tasks,
  };
}

function queueableSourceViews(store: ContextStore, limit: number): StoredContextView[] {
  return store.listViews({ view_types: [...BACKGROUND_TASK_SOURCE_TYPES], active_only: true, limit })
    .filter(hasProvenance)
    .filter(view => !queuedTaskExistsForSource(store, view));
}

function planTaskForSourceView(source: StoredContextView, generatedAt: string, store: ContextStore): { ok: true; view: ContextView } | { ok: false; reason: string } {
  if (!hasProvenance(source)) return { ok: false, reason: `source View ${source.id} has no source_records or source_views` };
  const privacyDenial = privacyDenialForTask(source, store, "local_queue", true);
  if (privacyDenial) return { ok: false, reason: privacyDenial };
  const focus = focusText(source);
  return {
    ok: true,
    view: {
      id: `task:background-research:runtime:${stableKey(`${source.id}:${focus}`)}`,
      view_type: "task.background_research",
      title: `Background research task: ${focus}`.slice(0, 180),
      summary: `Prepare brief, read-only background research for ${focus}`.slice(0, 300),
      status: "candidate",
      source_records: source.source_records,
      source_views: unique([source.id, ...(source.source_views ?? [])]),
      compiler: { id: "runtime.background_tasks", version: "0.1.0", mode: "deterministic" },
      purpose: "Runtime-queued safe background research task derived from current project/focus Views.",
      scope: { ...(source.scope ?? {}), plugin_id: "runtime.background_tasks" },
      content: {
        focus,
        speed: "background",
        autonomy: "suggest",
        goal: backgroundResearchGoal(source, focus),
        allowed_actions: ["read_context", "read_public_context_if_allowed", "return_views"],
        forbidden_actions: ["modify_files", "post_or_send", "mutate_remote_systems", "write_legacy_records"],
        source_view_type: source.view_type,
        source_view_id: source.id,
        queued_at: generatedAt,
      },
      confidence: Math.max(0.45, Math.min(0.82, source.confidence ?? 0.6)),
      stability: "session",
      lossiness: "low",
      privacy: source.privacy,
      metadata: {
        generated_at: generatedAt,
        queued_by: "runtime.background_tasks",
        output_view_type: "brief.background_research",
      },
    },
  };
}

function writeQueuedTask(store: ContextStore, source: StoredContextView, view: ContextView, generatedAt: string, dryRun: boolean): void {
  const stored = store.upsertView(view);
  store.appendRuntimeEvent({
    event_type: "background_task.queued",
    actor: "system",
    status: "completed",
    subject_type: "view",
    subject_id: stored.id,
    plugin_id: "runtime.background_tasks",
    related_views: [source.id, stored.id],
    related_records: stored.source_records,
    payload: {
      source_view_id: source.id,
      source_view_type: source.view_type,
      task_view_id: stored.id,
      task_view_type: stored.view_type,
      dry_run: dryRun,
      queued_at: generatedAt,
    },
  });
}

function buildAgentTask(view: StoredContextView, runtime: string, store: ContextStore) {
  const goal = stringValue(view.content?.goal) ?? `Process ${view.view_type}: ${view.title ?? view.id}`;
  const pack = buildContextPack({
    goal,
    include_records: true,
    include_views: true,
    include_events: false,
    allow_external_llm: view.privacy?.allow_external_llm === true,
    scope: view.scope,
    limit: 12,
  }, store);
  const output = outputContractForTask(view);
  return {
    runtime,
    goal,
    context_pack: { markdown: pack.markdown, sources: pack.sources, diagnostics: pack.diagnostics },
    constraints: {
      ...(isRecord(view.content?.constraints) ? view.content.constraints : {}),
      write_policy: "views_only",
      no_file_edits: true,
      no_legacy_records: true,
      require_provenance: true,
    },
    output_contract: output,
  };
}

function outputContractForTask(view: StoredContextView): { view_type: string; title: string; purpose: string } {
  const focus = stringValue(view.content?.focus) ?? view.title ?? view.id;
  return {
    view_type: "brief.background_research",
    title: `Background research: ${focus}`.slice(0, 180),
    purpose: "Background research prepared asynchronously from a proactive ambient task.",
  };
}

function markTaskProcessed(store: ContextStore, view: StoredContextView, task: AmbientBackgroundTaskResult["tasks"][number], generatedAt: string): void {
  const updated: ContextView = {
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    status: view.status,
    source_records: view.source_records,
    source_views: view.source_views,
    compiler: view.compiler,
    purpose: view.purpose,
    scope: view.scope,
    content: {
      ...(view.content ?? {}),
      background_task: {
        status: task.status,
        processed_at: generatedAt,
        runtime: task.runtime,
        reason: task.reason,
        output_view_type: task.output_view_type,
        written_views: task.written_views ?? [],
      },
    },
    confidence: view.confidence,
    stability: view.stability,
    lossiness: view.lossiness,
    privacy: view.privacy,
    validity: view.validity,
    metadata: {
      ...(view.metadata ?? {}),
      last_background_task_processed_at: generatedAt,
    },
  };
  store.upsertView(updated);
  store.appendRuntimeEvent({
    event_type: "background_task.processed",
    actor: "system",
    status: task.status === "completed" ? "completed" : "failed",
    subject_type: "view",
    subject_id: view.id,
    plugin_id: "runtime.background_tasks",
    related_views: [view.id, ...(task.written_views ?? [])],
    related_records: view.source_records,
    payload: task,
  });
  buildAgentTaskList({ write: true }, store);
}

function runtimeForTask(view: StoredContextView, override?: string): string | undefined {
  if (override) return override;
  if (view.view_type === "task.background_research") return process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
  return undefined;
}

function requiredAutonomyForTask(view: StoredContextView): AutonomyProfile {
  return "suggest";
}

function taskAlreadyFinished(view: StoredContextView): boolean {
  const status = isRecord(view.content?.background_task) ? view.content.background_task.status : undefined;
  return status === "completed" || status === "failed" || status === "cancelled";
}

function queuedTaskExistsForSource(store: ContextStore, source: StoredContextView): boolean {
  return store.listViews({ view_types: ["task.background_research"], active_only: true, limit: 50 })
    .some(task => task.source_views?.includes(source.id) || task.content?.source_view_id === source.id);
}

function hasProvenance(view: StoredContextView): boolean {
  return Boolean(view.source_records?.length || view.source_views?.length);
}

function privacyDenialForTask(view: StoredContextView, store: ContextStore, runtime: string, dryRun: boolean): string | undefined {
  const sources = collectPrivacySources(view, store);
  if (sources.views.some(item => item.privacy?.retention === "do_not_store" || item.privacy?.level === "secret")) return "privacy denied: source View is secret or do_not_store";
  if (sources.records.some(item => item.privacy?.retention === "do_not_store" || item.privacy?.level === "secret")) return "privacy denied: source record is secret or do_not_store";
  if (dryRun || runtime === "local_mock" || runtime === "local_queue") return undefined;
  if (sources.views.some(item => item.privacy?.allow_external_llm === false) || sources.records.some(item => item.privacy?.allow_external_llm === false)) {
    return "privacy denied: provenance disallows external LLM use";
  }
  return undefined;
}

function collectPrivacySources(view: StoredContextView, store: ContextStore): { views: StoredContextView[]; records: StoredContextRecord[] } {
  const views = new Map<string, StoredContextView>();
  const records = new Map<string, StoredContextRecord>();
  collectViewSources(view, store, views, records, 0);
  return { views: [...views.values()], records: [...records.values()] };
}

function collectViewSources(view: StoredContextView, store: ContextStore, views: Map<string, StoredContextView>, records: Map<string, StoredContextRecord>, depth: number): void {
  if (depth > 3 || views.has(view.id)) return;
  views.set(view.id, view);
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (record) records.set(record.id, record);
  }
  for (const id of view.source_views ?? []) {
    const source = store.getView(id);
    if (source) collectViewSources(source, store, views, records, depth + 1);
  }
}

function focusText(view: StoredContextView): string {
  return stringValue(view.content?.focus)
    ?? stringValue(view.content?.title)
    ?? view.summary
    ?? view.title
    ?? view.id;
}

function backgroundResearchGoal(source: StoredContextView, focus: string): string {
  return [
    "Prepare a concise background research brief for the user's current work.",
    `Current focus: ${focus}.`,
    `Source View: ${source.view_type} ${source.id}.`,
    "Use only provided context and public/read-only material when privacy permits.",
    "Return a brief.background_research View with key findings, gaps, and citations or source notes.",
    "Do not modify files, post messages, mutate accounts, or write legacy records.",
  ].join("\n");
}

function autonomyAllowed(requested: AutonomyProfile, required: AutonomyProfile): boolean {
  return autonomyRank(requested) >= autonomyRank(required);
}

function autonomyRank(value: AutonomyProfile): number {
  return {
    manual: 0,
    suggest: 1,
    draft: 2,
    sandbox_auto: 3,
    full_auto: 4,
  }[value];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapCapabilityResult(response: unknown): { ok?: boolean; reason?: string; written_views?: string[] } {
  const body = isRecord(response) && isRecord(response.result) ? response.result : response;
  if (!isRecord(body)) return { ok: false, reason: "invalid iii capability response" };
  return {
    ok: body.ok === true,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    written_views: Array.isArray(body.written_views) ? body.written_views.filter((id): id is string => typeof id === "string") : [],
  };
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

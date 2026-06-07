import { buildContextPack } from "@info/core";
import { ContextStore } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";
import { createDefaultProgramRuntime } from "../programs/registry.js";
import { signalFromObject } from "../programs/signals.js";
import type { AutonomyProfile } from "../programs/types.js";

const BACKGROUND_TASK_TYPES = ["task.background_research", "task.toolsmith_prototype"] as const;

export type AmbientBackgroundTaskResult = {
  ok: true;
  generated_at: string;
  processed: number;
  skipped: number;
  written_views: string[];
  tasks: Array<{
    task_view_id: string;
    task_view_type: string;
    status: "completed" | "failed" | "skipped";
    reason?: string;
    runtime?: string;
    output_view_type?: string;
    written_views?: string[];
  }>;
};

export async function processAmbientBackgroundTasks(options: { limit?: number; write?: boolean } = {}, store = new ContextStore()): Promise<AmbientBackgroundTaskResult> {
  const generatedAt = new Date().toISOString();
  const candidates = store.listViews({ view_types: [...BACKGROUND_TASK_TYPES], active_only: true, limit: options.limit ?? 8 })
    .filter(view => !taskAlreadyFinished(view));
  const runtime = createDefaultProgramRuntime(store);
  const tasks: AmbientBackgroundTaskResult["tasks"] = [];
  const writtenViews: string[] = [];

  for (const view of candidates) {
    const runtimeId = runtimeForTask(view);
    if (!runtimeId) {
      const reason = `background task delegation disabled for ${view.view_type}`;
      tasks.push({ task_view_id: view.id, task_view_type: view.view_type, status: "skipped", reason });
      continue;
    }

    const task = buildAgentTask(view, runtimeId, store);
    const result = await runtime.runCapability("capability.agent_task.submit", {
      signal: signalFromObject(view),
      speed: "background",
      autonomy: autonomyForTask(view),
      dry_run: options.write === false,
      payload: { task },
    });
    const outputViewIds = result.written_views ?? [];
    writtenViews.push(...outputViewIds);
    const status = result.ok ? "completed" : "failed";
    const entry = {
      task_view_id: view.id,
      task_view_type: view.view_type,
      status,
      reason: result.reason,
      runtime: runtimeId,
      output_view_type: task.output_contract.view_type,
      written_views: outputViewIds,
    } as const;
    tasks.push(entry);
    if (options.write !== false) markTaskProcessed(store, view, entry, generatedAt);
  }

  return {
    ok: true,
    generated_at: generatedAt,
    processed: tasks.filter(task => task.status !== "skipped").length,
    skipped: tasks.filter(task => task.status === "skipped").length,
    written_views: writtenViews,
    tasks,
  };
}

function buildAgentTask(view: StoredContextView, runtime: string, store: ContextStore) {
  const goal = stringValue(view.content?.goal) ?? `Process ${view.view_type}: ${view.title ?? view.id}`;
  const pack = buildContextPack({
    goal,
    include_records: true,
    include_views: true,
    include_events: false,
    allow_external_llm: true,
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
    },
    output_contract: output,
  };
}

function outputContractForTask(view: StoredContextView): { view_type: string; title: string; purpose: string } {
  const focus = stringValue(view.content?.focus) ?? view.title ?? view.id;
  if (view.view_type === "task.toolsmith_prototype") {
    return {
      view_type: "draft.tool_prototype",
      title: `Tool prototype draft: ${focus}`.slice(0, 180),
      purpose: "Background no-file-edit prototype plan for a small workflow-improving tool.",
    };
  }
  return {
    view_type: "brief.background_research",
    title: `Background research: ${focus}`.slice(0, 180),
    purpose: "Background research prepared asynchronously from a proactive ambient task.",
  };
}

function markTaskProcessed(store: ContextStore, view: StoredContextView, result: AmbientBackgroundTaskResult["tasks"][number], generatedAt: string): void {
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
        status: result.status,
        processed_at: generatedAt,
        runtime: result.runtime,
        reason: result.reason,
        output_view_type: result.output_view_type,
        written_views: result.written_views ?? [],
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
    status: result.status === "completed" ? "completed" : "failed",
    subject_type: "view",
    subject_id: view.id,
    plugin_id: "runtime.background_tasks",
    related_views: [view.id, ...(result.written_views ?? [])],
    related_records: view.source_records,
    payload: result,
  });
}

function runtimeForTask(view: StoredContextView): string | undefined {
  if (view.view_type === "task.toolsmith_prototype") return process.env.TOOLSMITH_AGENT_TASK_RUNTIME;
  if (view.view_type === "task.background_research") return process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
  return undefined;
}

function autonomyForTask(view: StoredContextView): AutonomyProfile {
  if (view.view_type === "task.toolsmith_prototype") return "draft";
  return "suggest";
}

function taskAlreadyFinished(view: StoredContextView): boolean {
  const status = isRecord(view.content?.background_task) ? view.content.background_task.status : undefined;
  return status === "completed" || status === "failed";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

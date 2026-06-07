import { createDefaultAgentRuntimeAdapter, type AgentMcpServerConfig, type AgentTaskOutput, type AgentTaskOutputView } from "../../../packages/adapters/agent-runtime/index.js";
import type { ContextRecord, ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import type { Capability, CapabilityRunResult, ContextSignal } from "../types.js";

export type AgentTaskPayload = {
  runtime?: string;
  goal?: string;
  context_pack?: { markdown?: string; sources?: unknown[]; diagnostics?: Record<string, unknown> };
  output_contract?: {
    view_type?: string;
    title?: string;
    purpose?: string;
  };
  constraints?: Record<string, unknown>;
  mcp_servers?: AgentMcpServerConfig[];
};

export const agentTaskSubmitCapability: Capability = {
  id: "capability.agent_task.submit",
  title: "Submit Agent Task",
  purpose: "Submit a generic agent task to an agent runtime adapter and write the structured result back as Views.",
  version: "0.1.0",
  mode: "agent",
  default_speed: "work",
  default_autonomy: "suggest",
  produces: ["agent_task.result", "view.from_agent_task"],

  async run({ signal, store, payload, program, dry_run }): Promise<CapabilityRunResult> {
    const task = normalizeTask(payload?.task);
    if (agentTaskHasCallerSelectedSkills(payload?.task)) return { ok: false, reason: "agent task must not include skills or tools; external runtime owns them" };
    if (!task.goal) return { ok: false, reason: "agent task missing goal" };
    const viewType = task.output_contract?.view_type;
    if (!viewType) return { ok: false, reason: "agent task output_contract.view_type is required" };
    const viewTypeError = validateAgentTaskViewType(viewType);
    if (viewTypeError) return { ok: false, reason: viewTypeError, diagnostics: { output_view_type: viewType } };
    const runtime = task.runtime ?? defaultAgentTaskRuntime();
    const provenance = agentTaskProvenance(task, signal, store);
    const runtimeTask = toRuntimeTask(task, runtime, signal, provenance, Boolean(dry_run));
    const selection = createDefaultAgentRuntimeAdapter(runtime);
    if (!selection.adapter) return { ok: false, reason: selection.reason ?? `agent runtime adapter not available: ${runtime}`, diagnostics: { runtime } };

    if (dry_run) {
      const result = await selection.adapter.submit(runtimeTask, { signal, mcpServers: task.mcp_servers ?? [] });
      return {
        ok: result.ok,
        reason: result.reason,
        diagnostics: {
          ...result.diagnostics,
          runtime,
          task_goal: task.goal,
          output_view_type: task.output_contract?.view_type,
          context_source_count: provenanceCount(provenance),
        },
      };
    }

    const privacyDenial = agentTaskPrivacyDenial(runtime, signal, provenance, store);
    if (privacyDenial) {
      return {
        ok: false,
        reason: privacyDenial.reason,
        diagnostics: {
          runtime,
          policy_denied: true,
          policy: privacyDenial.policy,
          related_records: privacyDenial.related_records,
          related_views: privacyDenial.related_views,
          task_goal: task.goal,
          context_source_count: provenanceCount(provenance),
        },
      };
    }

    const submitted = agentTaskSubmittedEvent(task, provenance, runtime, program?.id);
    const result = await selection.adapter.submit(runtimeTask, { signal, mcpServers: task.mcp_servers ?? [] });
    if (!result.ok || !result.output) {
      const reason = result.reason || `${runtime} agent task failed`;
      return {
        ok: false,
        reason,
        events: [
          submitted,
          {
            event_type: "agent_task.failed",
            actor: "agent",
            status: "failed",
            subject_type: "plugin",
            subject_id: "capability.agent_task.submit",
            plugin_id: "capability.agent_task.submit",
            related_records: provenance.source_records,
            related_views: provenance.source_views,
            payload: { runtime, goal: task.goal, reason, requested_by_program: program?.id },
          },
        ],
        diagnostics: {
          ...result.diagnostics,
          runtime,
          error: reason,
          task_goal: task.goal,
          context_source_count: provenanceCount(provenance),
        },
      };
    }

    const object = loadSignalObject(signal, store);
    const evidenceViews = buildAgentReturnedViews({
      task,
      signal,
      object,
      output: result.output,
      provenance,
      store,
      compilerId: "capability.agent_task.submit",
      requestedByProgram: program?.id,
      runtime,
    });
    const view = buildAgentOutputView({
      task,
      signal,
      object,
      output: result.output,
      provenance,
      store,
      compilerId: "capability.agent_task.submit",
      requestedByProgram: program?.id,
      runtime,
      extraSourceViews: evidenceViews.map(item => item.id!),
    });
    const views = [...evidenceViews, view];
    return {
      ok: true,
      reason: `submitted agent task to ${runtime} and received ${views.length} View${views.length === 1 ? "" : "s"}`,
      views,
      events: [
        submitted,
        {
          event_type: "agent_task.completed",
          actor: "agent",
          status: "completed",
          subject_type: "plugin",
          subject_id: "capability.agent_task.submit",
          plugin_id: "capability.agent_task.submit",
          related_records: provenance.source_records,
          related_views: [...provenance.source_views, ...views.map(item => item.id!)],
          payload: { runtime, goal: task.goal, output_view_id: view.id, output_view_ids: views.map(item => item.id!), output_view_type: view.view_type, evidence_view_count: evidenceViews.length, output_contract: task.output_contract, requested_by_program: program?.id },
        },
      ],
      diagnostics: {
        ...result.diagnostics,
        runtime,
        output_view_type: view.view_type,
        output_view_id: view.id,
        output_view_ids: views.map(item => item.id!),
        evidence_view_count: evidenceViews.length,
        task_goal: task.goal,
        context_source_count: provenanceCount(provenance),
      },
    };
  },
};

function buildAgentOutputView(input: {
  task: AgentTaskPayload;
  signal: ContextSignal;
  object?: StoredContextRecord | StoredContextView;
  output: AgentTaskOutput;
  provenance: AgentTaskProvenance;
  store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined };
  compilerId: string;
  requestedByProgram?: string;
  runtime: string;
  extraSourceViews?: string[];
}): ContextView {
  const { task, signal, object, output, provenance, store, compilerId, requestedByProgram, runtime, extraSourceViews = [] } = input;
  const summary = output.summary || summarize(task, signal, object);
  return {
    id: `${task.output_contract?.view_type}:${stableKey(`${runtime}:${task.goal}:${signal.object_id}`)}`,
    view_type: task.output_contract?.view_type ?? "analysis.agent_task",
    title: (task.output_contract?.title ?? `Agent task result: ${signal.title ?? signal.object_id}`).slice(0, 180),
    summary,
    status: "candidate",
    source_records: provenance.source_records,
    source_views: unique([...provenance.source_views, ...extraSourceViews]),
    compiler: { id: compilerId, version: "0.1.0", mode: "hybrid" },
    purpose: task.output_contract?.purpose ?? "Structured View produced by a generic external agent task adapter.",
    scope: {
      domain: signal.domain,
      project: signal.project,
      project_path: signal.project_path,
      repo: signal.repo,
      app: signal.app,
      plugin_id: requestedByProgram ?? compilerId,
    },
    content: {
      summary,
      analysis: output.analysis,
      key_points: output.key_points,
      agent_task: {
        runtime,
        goal: task.goal,
        output_contract: task.output_contract,
        constraints: task.constraints,
      },
      agent_output: {
        summary,
        analysis: output.analysis,
        key_points: output.key_points,
        confidence: output.confidence ?? 0.5,
        output_contract: task.output_contract,
      },
      context_pack_markdown_excerpt: task.context_pack?.markdown?.slice(0, 1200),
    },
    confidence: output.confidence ?? 0.5,
    stability: "session",
    lossiness: "medium",
    privacy: mergedPrivacy(provenance, store) ?? (object && "privacy" in object ? object.privacy : undefined),
    metadata: {
      agent_runtime: runtime,
      requested_by_program: requestedByProgram,
      source_object_type: signal.object_type,
      source_object_kind: signal.object_kind,
    },
  };
}

function buildAgentReturnedViews(input: {
  task: AgentTaskPayload;
  signal: ContextSignal;
  object?: StoredContextRecord | StoredContextView;
  output: AgentTaskOutput;
  provenance: AgentTaskProvenance;
  store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined };
  compilerId: string;
  requestedByProgram?: string;
  runtime: string;
}): ContextView[] {
  return (input.output.views ?? []).map((view, index) => buildAgentReturnedView({ ...input, view, index }));
}

function buildAgentReturnedView(input: {
  task: AgentTaskPayload;
  signal: ContextSignal;
  object?: StoredContextRecord | StoredContextView;
  view: AgentTaskOutputView;
  index: number;
  provenance: AgentTaskProvenance;
  store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined };
  compilerId: string;
  requestedByProgram?: string;
  runtime: string;
}): ContextView {
  const { task, signal, object, view, index, provenance, store, compilerId, requestedByProgram, runtime } = input;
  const scope = {
    domain: signal.domain,
    project: signal.project,
    project_path: signal.project_path,
    repo: signal.repo,
    app: signal.app,
    plugin_id: requestedByProgram ?? compilerId,
  };
  const summary = view.summary || stringValue(view.content?.summary) || stringValue(view.content?.text)?.slice(0, 360) || `Agent returned ${view.view_type} evidence.`;
  return {
    id: `${view.view_type}:${stableKey(`${runtime}:${task.goal}:${signal.object_id}:${index}:${summary}`)}`,
    view_type: view.view_type,
    title: (view.title ?? `Agent evidence: ${signal.title ?? signal.object_id}`).slice(0, 180),
    summary,
    status: "candidate",
    source_records: provenance.source_records,
    source_views: provenance.source_views,
    compiler: { id: compilerId, version: "0.1.0", mode: "hybrid" },
    purpose: view.purpose ?? "Evidence View returned by an external agent runtime and validated by Info.",
    scope,
    content: {
      ...(view.content ?? {}),
      agent_task: {
        runtime,
        goal: task.goal,
        output_contract: task.output_contract,
        returned_view_index: index,
      },
    },
    confidence: view.confidence ?? 0.6,
    stability: "session",
    lossiness: "medium",
    privacy: mergedPrivacy(provenance, store) ?? (object && "privacy" in object ? object.privacy : undefined),
    metadata: {
      ...(view.metadata ?? {}),
      agent_runtime: runtime,
      requested_by_program: requestedByProgram,
      source_object_type: signal.object_type,
      source_object_kind: signal.object_kind,
      agent_returned_view: true,
    },
  };
}

function contextSourcesForPrompt(task: AgentTaskPayload, provenance: AgentTaskProvenance): unknown[] {
  const sources: Array<{ id: string; kind: "record" | "view"; uri: string }> = [];
  for (const id of provenance.source_records) {
    sources.push({ id, kind: "record", uri: `context://records/${id}` });
  }
  for (const id of provenance.source_views) {
    sources.push({ id, kind: "view", uri: `context://views/${id}` });
  }
  return sources.slice(0, 40);
}

function toRuntimeTask(task: AgentTaskPayload, runtime: string, signal: ContextSignal, provenance: AgentTaskProvenance, dryRun: boolean) {
  return {
    id: `agent-task:${stableKey(`${runtime}:${task.goal}:${signal.object_id}`)}`,
    runtime,
    goal: task.goal!,
    cwd: signal.project_path,
    dryRun,
    contextPack: {
      markdown: task.context_pack?.markdown,
      sources: contextSourcesForPrompt(task, provenance),
      diagnostics: task.context_pack?.diagnostics,
    },
    outputContract: {
      viewType: task.output_contract!.view_type!,
      title: task.output_contract?.title,
      purpose: task.output_contract?.purpose,
    },
    constraints: task.constraints,
  };
}

type AgentTaskProvenance = {
  source_records: string[];
  source_views: string[];
};

function agentTaskSubmittedEvent(task: AgentTaskPayload, provenance: AgentTaskProvenance, runtime: string, requestedByProgram?: string) {
  return {
    event_type: "agent_task.submitted",
    actor: "system" as const,
    status: "started" as const,
    subject_type: "plugin" as const,
    subject_id: "capability.agent_task.submit",
    plugin_id: "capability.agent_task.submit",
    related_records: provenance.source_records,
    related_views: provenance.source_views,
    payload: {
      runtime,
      goal: task.goal,
      output_contract: task.output_contract,
      constraints: task.constraints,
      requested_by_program: requestedByProgram,
    },
  };
}

function agentTaskProvenance(task: AgentTaskPayload, signal: ContextSignal, store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined }): AgentTaskProvenance {
  const sourceRecords = signal.object_kind === "observation" ? [signal.object_id] : signal.source_records ?? [];
  const sourceViews = signal.object_kind === "view" ? [signal.object_id] : signal.source_views ?? [];
  for (const source of task.context_pack?.sources ?? []) {
    if (!source || typeof source !== "object") continue;
    const id = typeof (source as { id?: unknown }).id === "string" ? (source as { id: string }).id : undefined;
    const kind = (source as { kind?: unknown }).kind;
    if (!id) continue;
    if (kind === "record" && store.getRecord(id)) sourceRecords.push(id);
    if (kind === "view" && store.getView(id)) sourceViews.push(id);
  }
  return {
    source_records: unique(sourceRecords),
    source_views: unique(sourceViews),
  };
}

function agentTaskPrivacyDenial(
  runtime: string,
  signal: ContextSignal,
  provenance: AgentTaskProvenance,
  store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined },
): { reason: string; policy: string; related_records: string[]; related_views: string[] } | undefined {
  if (runtime !== "claude_code") return undefined;
  const sources = agentTaskPrivacySources(provenance, store);
  if (!sources.records.some(record => record.privacy?.allow_external_llm === false) && !sources.views.some(view => view.privacy?.allow_external_llm === false)) return undefined;
  return {
    reason: `privacy denied: agent task for ${signal.object_kind} ${signal.object_id} includes provenance that disallows external LLM use`,
    policy: "privacy.external_llm",
    related_records: sources.records.map(record => record.id),
    related_views: sources.views.map(view => view.id),
  };
}

function agentTaskPrivacySources(
  provenance: AgentTaskProvenance,
  store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined },
): { records: StoredContextRecord[]; views: StoredContextView[] } {
  const records = new Map<string, StoredContextRecord>();
  const views = new Map<string, StoredContextView>();
  for (const id of provenance.source_records) {
    const record = store.getRecord(id);
    if (record) records.set(record.id, record);
  }
  for (const id of provenance.source_views) collectAgentTaskViewSources(id, store, records, views, 0);
  return { records: [...records.values()], views: [...views.values()] };
}

function collectAgentTaskViewSources(
  viewId: string,
  store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined },
  records: Map<string, StoredContextRecord>,
  views: Map<string, StoredContextView>,
  depth: number,
): void {
  if (depth > 3 || views.has(viewId)) return;
  const view = store.getView(viewId);
  if (!view) return;
  views.set(view.id, view);
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (record) records.set(record.id, record);
  }
  for (const id of view.source_views ?? []) collectAgentTaskViewSources(id, store, records, views, depth + 1);
}


function agentTaskHasCallerSelectedSkills(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (Object.hasOwn(value, "skills") || Object.hasOwn(value, "tools")));
}

function normalizeTask(value: unknown): AgentTaskPayload {
  return value && typeof value === "object" ? value as AgentTaskPayload : {};
}

function validateAgentTaskViewType(viewType: string): string | undefined {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(viewType)) return `agent task output_contract.view_type is invalid: ${viewType}`;
  if (/^(observation|feedback|episode|derived)\./.test(viewType)) return `agent task output_contract.view_type must be a View type, not ${viewType}`;
  return undefined;
}

function defaultAgentTaskRuntime(): string {
  return process.env.AGENT_TASK_DEFAULT_RUNTIME || "claude_code";
}

function loadSignalObject(signal: ContextSignal, store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined }): StoredContextRecord | StoredContextView | undefined {
  return signal.object_kind === "observation" ? store.getRecord(signal.object_id) : store.getView(signal.object_id);
}

function summarize(task: AgentTaskPayload, signal: ContextSignal, object?: StoredContextRecord | StoredContextView): string {
  const text = signal.text_preview ?? objectText(object);
  const base = text ? firstSentence(text, 220) : `Agent task completed for ${signal.object_type}.`;
  return `${base} Goal: ${task.goal}`.slice(0, 360);
}

function keyPoints(task: AgentTaskPayload, signal: ContextSignal): string[] {
  return [
    `Agent runtime: ${task.runtime ?? "local_mock"}`,
    `Input object: ${signal.object_type}`,
    `Output View type: ${task.output_contract?.view_type}`,
    ...(signal.url ? [`URL: ${signal.url}`] : []),
  ].filter((item): item is string => Boolean(item));
}

function objectText(object?: StoredContextRecord | StoredContextView): string | undefined {
  if (!object) return undefined;
  if ("view_type" in object) return object.summary ?? stringValue(object.content?.analysis);
  return object.content?.text ?? object.content?.title;
}

function firstSentence(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0] || normalized;
  return sentence.slice(0, max);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function provenanceCount(provenance: AgentTaskProvenance): number {
  return provenance.source_records.length + provenance.source_views.length;
}

type Privacy = ContextRecord["privacy"];

function mergedPrivacy(provenance: AgentTaskProvenance, store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined }): Privacy | undefined {
  const values: NonNullable<Privacy>[] = [];
  for (const id of provenance.source_records) {
    const privacy = store.getRecord(id)?.privacy;
    if (privacy) values.push(privacy);
  }
  for (const id of provenance.source_views) collectViewPrivacy(id, store, values, new Set(), 0);
  if (!values.length) return undefined;
  return {
    level: maxByRank(values.map(value => value.level), { public: 0, workspace: 1, private: 2, secret: 3 }),
    retention: maxByRank(values.map(value => value.retention), { ephemeral: 0, normal: 1, archive: 2, do_not_store: 3 }),
    allow_embedding: mergedBoolean(values.map(value => value.allow_embedding)),
    allow_llm_summary: mergedBoolean(values.map(value => value.allow_llm_summary)),
    allow_external_llm: mergedBoolean(values.map(value => value.allow_external_llm)),
    allow_external_reader: mergedBoolean(values.map(value => value.allow_external_reader)),
  };
}

function collectViewPrivacy(viewId: string, store: { getRecord(id: string): StoredContextRecord | undefined; getView(id: string): StoredContextView | undefined }, values: NonNullable<Privacy>[], seen: Set<string>, depth: number): void {
  if (depth > 3 || seen.has(viewId)) return;
  seen.add(viewId);
  const view = store.getView(viewId);
  if (!view) return;
  if (view.privacy) values.push(view.privacy);
  for (const id of view.source_records ?? []) {
    const privacy = store.getRecord(id)?.privacy;
    if (privacy) values.push(privacy);
  }
  for (const id of view.source_views ?? []) collectViewPrivacy(id, store, values, seen, depth + 1);
}

function maxByRank<T extends string>(values: Array<T | undefined>, rank: Record<T, number>): T | undefined {
  return values.filter((value): value is T => Boolean(value)).sort((a, b) => rank[b] - rank[a])[0];
}

function mergedBoolean(values: Array<boolean | undefined>): boolean | undefined {
  if (values.some(value => value === false)) return false;
  if (values.some(value => value === true)) return true;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

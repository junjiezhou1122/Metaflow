import type { ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import { activeContextView } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";
import { analysisTextFromView, isGenericAgentAnalysisView, keyPointsFromView } from "@info/core";

const INPUT_VIEWS = new Set([
  "analysis.browser_page",
  "analysis.repo",
  "analysis.github_issue",
  "analysis.code_project",
  "analysis.code_change",
  "brief.research",
  "thread.active_work",
]);

export const projectAmbientProgram: Program = {
  id: "program.project_ambient",
  title: "Project Ambient",
  purpose: "Assemble project-relevant Views into reusable current project context.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "suggest",
  capabilities: ["context.project.assemble"],
  applications: ["project.cockpit", "agent.context_pack"],
  produces: ["project.current_context", "thread.active_work", "brief.project_next_state", "memory.project.patterns"],
  learns_from: ["feedback.project_context.useful", "feedback.project_context.dismissed"],

  attention(signal: ContextSignal, store): AttentionDecision {
    if (signal.object_kind !== "view") return { action: "ignore", reason: "project ambient assembles derived Views", confidence: 0.9 };
    const view = store.getView(signal.object_id);
    if (!view || !activeContextView(view)) return { action: "ignore", reason: "inactive source View", confidence: 0.95 };
    if (signal.object_type === "project.current_context") return { action: "ignore", reason: "own project context view", confidence: 0.95 };
    if (!INPUT_VIEWS.has(signal.object_type) && !isGenericAgentAnalysisView(view)) return { action: "ignore", reason: "view is not project ambient input", confidence: 0.75 };

    const score = projectSignalScore(signal);
    if (score >= 0.55) return { action: "run", reason: `project-relevant View (${score})`, confidence: score, speed: "background" };
    return { action: "defer", reason: `weak project relevance (${score})`, confidence: score };
  },

  run({ signal, store, buildContextPack }): ProgramRunResult {
    const view = store.getView(signal.object_id);
    if (!view) return { ok: false, reason: `source view not found: ${signal.object_id}` };

    const pack = buildContextPack({
      mode: "source",
      include_records: true,
      include_views: false,
      scope: projectContextScope(view),
      limit: 8,
    });
    const projectContext = buildProjectContextView(view, pack.records);
    const activeWorkThread = buildActiveWorkThreadView(view, projectContext, pack.records);
    const projectBrief = buildProjectNextStateBrief(view, projectContext, activeWorkThread, pack.records);
    const projectMemory = buildProjectPatternsMemoryView(view, projectContext, activeWorkThread, projectBrief, pack.records);
    return {
      ok: true,
      reason: `compiled project context from ${view.view_type}`,
      views: [projectContext, activeWorkThread, projectBrief, projectMemory],
      diagnostics: {
        input_view_type: view.view_type,
        source_records: view.source_records?.length ?? 0,
        context_record_count: pack.records.length,
        source_views: view.source_views?.length ?? 0,
        active_work_thread_view_id: activeWorkThread.id,
        project_next_state_brief_view_id: projectBrief.id,
        project_patterns_memory_view_id: projectMemory.id,
      },
    };
  },
};

function projectContextScope(view: StoredContextView): StoredContextView["scope"] {
  if (view.scope?.project_path) return { domain: undefined, project_path: view.scope.project_path };
  if (view.scope?.project) return { domain: undefined, project: view.scope.project };
  if (view.scope?.repo) return { domain: undefined, repo: view.scope.repo };
  if (view.scope?.domain) return { domain: view.scope.domain };
  return undefined;
}

function projectSignalScore(signal: ContextSignal): number {
  let score = 0;
  if (signal.project || signal.project_path) score += 0.35;
  if (signal.domain === "github.com") score += 0.3;
  if (signal.object_type === "analysis.browser_agent_task" && signal.domain === "github.com") score += 0.25;
  if (signal.url?.includes("github.com")) score += 0.25;
  const hay = [signal.title, signal.text_preview, signal.url, signal.path, ...(signal.keywords ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/repo|repository|github|issue|pull request|readme|runtime|architecture|typescript|code/.test(hay)) score += 0.25;
  if (signal.confidence !== undefined) score += Math.min(0.15, Math.max(0, signal.confidence) * 0.15);
  return Number(Math.min(1, score).toFixed(3));
}

function buildProjectContextView(source: StoredContextView, contextRecords: StoredContextRecord[] = []): ContextView {
  const now = new Date().toISOString();
  const title = source.title?.replace(/^Browser analysis:\s*/i, "") || source.summary || source.id;
  const keyPoints = keyPointsFromView(source, 8);
  const analysis = analysisTextFromView(source);
  const id = `project:current-context:${stableKey([source.scope?.project_path, source.scope?.project, source.scope?.domain, source.id].filter(Boolean).join(":"))}`;

  return {
    id,
    view_type: "project.current_context",
    title: `Project context: ${title}`.slice(0, 180),
    summary: `Project-relevant context from ${title}`.slice(0, 300),
    status: "candidate",
    source_records: [...new Set([...(source.source_records ?? []), ...contextRecords.map(record => record.id)])],
    source_views: [source.id],
    compiler: { id: "program.project_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Reusable project context assembled from circulating Views for later agents and applications.",
    scope: {
      project: source.scope?.project,
      project_path: source.scope?.project_path,
      repo: source.scope?.repo,
      domain: source.scope?.domain,
      app: source.scope?.app,
      time_range: { start: source.scope?.time_range?.start, end: now },
      plugin_id: "program.project_ambient",
    },
    content: {
      focus: title,
      source_view_type: source.view_type,
      analysis,
      key_points: keyPoints,
      related_views: [{ id: source.id, view_type: source.view_type, title: source.title }],
      related_records: contextRecords.map(record => ({
        id: record.id,
        schema: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        url: record.content?.url,
        path: record.content?.path,
        observed_at: record.time?.observed_at,
      })),
    },
    confidence: Math.max(0.45, Math.min(0.9, source.confidence ?? 0.55)),
    stability: "session",
    lossiness: "medium",
    privacy: source.privacy,
    metadata: { source_view_id: source.id, source_compiler: source.compiler?.id },
  };
}

function buildActiveWorkThreadView(source: StoredContextView, projectContext: ContextView, contextRecords: StoredContextRecord[] = []): ContextView {
  const now = new Date().toISOString();
  const focus = projectContext.content?.focus ?? projectContext.title ?? source.title ?? source.id;
  const sourceRecords = [...new Set([...(projectContext.source_records ?? []), ...contextRecords.map(record => record.id)])];
  const id = `thread:active-work:${stableKey([source.scope?.project_path, source.scope?.project, source.scope?.domain, source.id].filter(Boolean).join(":"))}`;

  return {
    id,
    view_type: "thread.active_work",
    title: `Active work: ${String(focus)}`.slice(0, 180),
    summary: `Active project work thread derived from ${source.view_type}`.slice(0, 300),
    status: "candidate",
    source_records: sourceRecords,
    source_views: [source.id, projectContext.id!],
    compiler: { id: "program.project_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Reusable active work thread that lets agents and applications continue the current project context.",
    scope: {
      project: source.scope?.project,
      project_path: source.scope?.project_path,
      repo: source.scope?.repo,
      domain: source.scope?.domain,
      app: source.scope?.app,
      time_range: { start: source.scope?.time_range?.start, end: now },
      plugin_id: "program.project_ambient",
    },
    content: {
      focus,
      source_view_type: source.view_type,
      project_context_view_id: projectContext.id,
      evidence_record_ids: contextRecords.map(record => record.id),
      related_records: projectContext.content?.related_records,
      related_views: [
        { id: source.id, view_type: source.view_type, title: source.title },
        { id: projectContext.id, view_type: projectContext.view_type, title: projectContext.title },
      ],
      current_status: {
        project: source.scope?.project,
        project_path: source.scope?.project_path,
        repo: source.scope?.repo,
        domain: source.scope?.domain,
        evidence_count: contextRecords.length,
      },
    },
    confidence: Math.max(0.4, Math.min(0.88, projectContext.confidence ?? source.confidence ?? 0.55)),
    stability: "session",
    lossiness: "medium",
    privacy: source.privacy,
    validity: { stale_after: new Date(Date.parse(now) + 30 * 60_000).toISOString() },
    metadata: { source_view_id: source.id, project_context_view_id: projectContext.id, source_compiler: source.compiler?.id },
  };
}

function buildProjectNextStateBrief(source: StoredContextView, projectContext: ContextView, activeWorkThread: ContextView, contextRecords: StoredContextRecord[] = []): ContextView {
  const now = new Date().toISOString();
  const focus = projectContext.content?.focus ?? activeWorkThread.content?.focus ?? source.title ?? source.id;
  const sourceRecords = [...new Set([...(projectContext.source_records ?? []), ...(activeWorkThread.source_records ?? []), ...contextRecords.map(record => record.id)])];
  const id = `brief:project-next-state:${stableKey([source.scope?.project_path, source.scope?.project, source.scope?.domain, source.id].filter(Boolean).join(":"))}`;

  return {
    id,
    view_type: "brief.project_next_state",
    title: `Project next state: ${String(focus)}`.slice(0, 180),
    summary: `Project next-state brief derived from ${source.view_type}`.slice(0, 300),
    status: "candidate",
    source_records: sourceRecords,
    source_views: [source.id, projectContext.id!, activeWorkThread.id!],
    compiler: { id: "program.project_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Compact project state brief for applications and later agents. It is descriptive, not an action list.",
    scope: {
      project: source.scope?.project,
      project_path: source.scope?.project_path,
      repo: source.scope?.repo,
      domain: source.scope?.domain,
      app: source.scope?.app,
      time_range: { start: source.scope?.time_range?.start, end: now },
      plugin_id: "program.project_ambient",
    },
    content: {
      focus,
      source_view_type: source.view_type,
      project_context_view_id: projectContext.id,
      active_work_thread_view_id: activeWorkThread.id,
      current_state: {
        project: source.scope?.project,
        project_path: source.scope?.project_path,
        repo: source.scope?.repo,
        domain: source.scope?.domain,
        evidence_count: contextRecords.length,
      },
      evidence_record_ids: contextRecords.map(record => record.id),
      key_points: projectContext.content?.key_points,
      related_records: projectContext.content?.related_records,
      related_views: [
        { id: source.id, view_type: source.view_type, title: source.title },
        { id: projectContext.id, view_type: projectContext.view_type, title: projectContext.title },
        { id: activeWorkThread.id, view_type: activeWorkThread.view_type, title: activeWorkThread.title },
      ],
    },
    confidence: Math.max(0.4, Math.min(0.86, activeWorkThread.confidence ?? projectContext.confidence ?? source.confidence ?? 0.55)),
    stability: "session",
    lossiness: "medium",
    privacy: source.privacy,
    validity: { stale_after: new Date(Date.parse(now) + 30 * 60_000).toISOString() },
    metadata: { source_view_id: source.id, project_context_view_id: projectContext.id, active_work_thread_view_id: activeWorkThread.id },
  };
}

function buildProjectPatternsMemoryView(source: StoredContextView, projectContext: ContextView, activeWorkThread: ContextView, projectBrief: ContextView, contextRecords: StoredContextRecord[] = []): ContextView {
  const focus = projectContext.content?.focus ?? source.title ?? source.id;
  const sourceRecords = [...new Set([...(projectBrief.source_records ?? []), ...contextRecords.map(record => record.id)])];
  const observedSources = [...new Set(contextRecords.map(record => record.source.type).filter(Boolean))].sort();
  const keyPoints = arrayOfStrings(projectContext.content?.key_points).slice(0, 8);
  const id = `memory:project-patterns:${stableKey([source.scope?.project_path, source.scope?.project, source.scope?.domain, source.id].filter(Boolean).join(":"))}`;

  return {
    id,
    view_type: "memory.project.patterns",
    title: `Project patterns: ${String(focus)}`.slice(0, 180),
    summary: `Reusable project pattern memory from ${source.view_type}`.slice(0, 300),
    status: "candidate",
    source_records: sourceRecords,
    source_views: [source.id, projectContext.id!, activeWorkThread.id!, projectBrief.id!],
    compiler: { id: "program.project_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Memory View that lets future Programs understand recurring project context without re-reading all raw observations.",
    scope: {
      project: source.scope?.project,
      project_path: source.scope?.project_path,
      repo: source.scope?.repo,
      domain: source.scope?.domain,
      app: source.scope?.app,
      plugin_id: "program.project_ambient",
    },
    content: {
      focus,
      source_view_type: source.view_type,
      project_context_view_id: projectContext.id,
      active_work_thread_view_id: activeWorkThread.id,
      project_next_state_brief_view_id: projectBrief.id,
      observed_sources: observedSources,
      evidence_count: sourceRecords.length,
      key_points: keyPoints,
    },
    confidence: Math.max(0.42, Math.min(0.82, projectBrief.confidence ?? projectContext.confidence ?? source.confidence ?? 0.55)),
    stability: "session",
    lossiness: "medium",
    privacy: source.privacy,
    metadata: { source_view_id: source.id, project_context_view_id: projectContext.id, active_work_thread_view_id: activeWorkThread.id },
  };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

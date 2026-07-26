import { createHash } from "node:crypto";
import { ContextStore, type ContextView, type StoredContextRecord, type StoredContextView } from "@info/core";

export const PROJECT_CURRENT_VIEW_TYPE = "project.current";
export const PROJECT_CURRENT_COMPILER_ID = "processor.project_current";

export type CompileProjectCurrentOptions = {
  write?: boolean;
  limit?: number;
  focusSetViews?: StoredContextView[];
  records?: StoredContextRecord[];
  now?: Date;
  minConfidence?: number;
};

export type CompileProjectCurrentResult = {
  ok: true;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  projects: Array<Record<string, unknown>>;
  diagnostics: Record<string, unknown>;
};

type ProjectLane = {
  lane_key: string;
  lane_kind: string;
  label: string;
  confidence: number;
  attention_share: number;
  source_records: string[];
  candidate_route_ids: string[];
  evidence: Record<string, unknown>;
};

type ProjectArtifact = {
  id: string;
  title?: string;
  observed_at?: string;
  evidence: string[];
};

export function compileProjectCurrent(options: CompileProjectCurrentOptions = {}, store = new ContextStore()): CompileProjectCurrentResult {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const focusSetViews = options.focusSetViews ?? store.listViews({ view_types: ["work.focus_set"], active_only: true, limit: options.limit ?? 5 });
  const explicitRecords = options.records;
  const recordsById = new Map((explicitRecords ?? collectRecordsForViews(focusSetViews, store)).map(record => [record.id, record]));
  const lanes = focusSetViews.flatMap(view => projectLanesFrom(view)).filter(lane => lane.confidence >= (options.minConfidence ?? 0.35));
  const views = lanes
    .map(lane => buildProjectCurrentView(lane, focusSetViews, recordsById, generatedAt))
    .filter(view => (view.source_records?.length ?? 0) > 0);
  const stored = options.write ?? true ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) {
    for (const view of stored) {
      store.appendRuntimeEvent({
        event_type: "view_compiled",
        actor: "system",
        status: "completed",
        subject_type: "view",
        subject_id: view.id,
        plugin_id: PROJECT_CURRENT_COMPILER_ID,
        related_records: view.source_records,
        related_views: view.source_views,
        payload: { view_type: PROJECT_CURRENT_VIEW_TYPE, project: view.scope?.project, project_path: view.scope?.project_path },
      });
    }
  }

  return {
    ok: true,
    generated_at: generatedAt,
    views: stored,
    projects: stored.map(view => ({ id: view.id, project: view.scope?.project, project_path: view.scope?.project_path, confidence: view.confidence })),
    diagnostics: { focus_set_views: focusSetViews.length, project_lanes: lanes.length },
  };
}

function buildProjectCurrentView(
  lane: ProjectLane,
  focusSetViews: StoredContextView[],
  recordsById: Map<string, StoredContextRecord>,
  generatedAt: string,
): ContextView {
  const sourceRecords = lane.source_records.filter(id => recordsById.has(id));
  const evidenceRecords = sourceRecords.map(id => recordsById.get(id)!).filter(record => record.privacy?.retention !== "do_not_store" && record.privacy?.level !== "secret");
  const projectPath = stringValue(lane.evidence.project_path) ?? lane.lane_key.replace(/^project:/, "");
  const project = stringValue(lane.evidence.project) ?? lane.label;
  const activeFiles = unique([
    ...arrayStrings(lane.evidence.file_paths),
    ...evidenceRecords.flatMap(record => arrayStrings(record.payload?.files_touched)),
    ...evidenceRecords.flatMap(record => arrayStrings(record.payload?.changed_files)),
  ]).slice(0, 20);
  const activeSessions = unique([
    ...evidenceRecords.map(record => stringValue(record.scope?.session)).filter((value): value is string => Boolean(value)),
    ...evidenceRecords.map(record => stringValue(record.payload?.session_id) ?? stringValue(record.payload?.sessionId)).filter((value): value is string => Boolean(value)),
  ]).slice(0, 10);
  const webpages = projectWebpages(evidenceRecords);
  const conversations = projectConversations(evidenceRecords);
  const files = projectFiles(activeFiles, evidenceRecords);
  const interruptions = projectInterruptions(evidenceRecords);
  const recentContext = evidenceRecords.map(compactProjectRecord).slice(0, 12);
  const text = evidenceRecords.map(record => `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${JSON.stringify(record.payload ?? {})}`).join("\n");
  const decisions = extractDecisionCandidates(text);
  const openQuestions = extractQuestions(text);
  const nextActions = inferNextActions({ activeFiles, activeSessions, decisions, openQuestions, evidenceRecords, interruptions, webpages });

  return {
    id: `view:project_current:${stableKey(projectPath || project)}`,
    view_type: PROJECT_CURRENT_VIEW_TYPE,
    title: `Project current: ${project}`,
    summary: `${project} focus from ${evidenceRecords.length} routed records. ${nextActions[0] ?? "No next action inferred."}`,
    status: "candidate",
    source_records: evidenceRecords.map(record => record.id),
    source_views: focusSetViews.map(view => view.id),
    compiler: { id: PROJECT_CURRENT_COMPILER_ID, version: "0.0.1", mode: "deterministic" },
    purpose: "Current project state generated from high-confidence work focus lanes and supporting evidence.",
    scope: {
      project,
      project_path: projectPath,
      repo: stringValue(lane.evidence.repo),
      time_range: focusSetViews[0]?.scope?.time_range,
    },
    content: {
      focus: inferFocus(lane, evidenceRecords),
      current_work: {
        doing: inferFocus(lane, evidenceRecords),
        attention_share: lane.attention_share,
        last_seen_at: laneLastSeen(lane, evidenceRecords),
        interruption_count: interruptions.length,
      },
      recent_context: recentContext,
      decisions,
      open_questions: openQuestions,
      next_actions: nextActions,
      active_files: activeFiles,
      active_sessions: activeSessions,
      active_webpages: webpages.map(page => page.url),
      active_conversations: conversations.map(conversation => conversation.id),
      interruptions,
      project_artifacts: {
        webpages,
        conversations,
        files,
      },
      supporting_sources: evidenceRecords.map(record => ({
        id: record.id,
        schema: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        url: record.content?.url,
        path: record.content?.path,
      })),
      lane: {
        lane_key: lane.lane_key,
        attention_share: lane.attention_share,
        confidence: lane.confidence,
        candidate_route_ids: lane.candidate_route_ids,
      },
      generated_at: generatedAt,
    },
    confidence: Math.min(1, Number((lane.confidence * 0.75 + lane.attention_share * 0.25).toFixed(3))),
    stability: "project",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    validity: { valid_from: focusSetViews[0]?.scope?.time_range?.start, stale_after: new Date(Date.parse(generatedAt) + 30 * 60_000).toISOString() },
    metadata: {
      generated_at: generatedAt,
      algorithm: "project-current-from-focus-set-v1",
      gated_by: "work.focus_set",
      legacy_bridge: "work_thread compatible downstream project summary",
    },
  };
}

function collectRecordsForViews(views: StoredContextView[], store: ContextStore): StoredContextRecord[] {
  const ids = unique(views.flatMap(view => view.source_records ?? []));
  return ids.map(id => store.getRecord(id)).filter((record): record is StoredContextRecord => Boolean(record));
}

function projectLanesFrom(view: StoredContextView): ProjectLane[] {
  const lanes = Array.isArray(view.content?.active_lanes) ? view.content.active_lanes : [];
  return lanes
    .filter((lane): lane is Record<string, unknown> => lane && typeof lane === "object" && !Array.isArray(lane))
    .filter(lane => stringValue(lane.lane_kind) === "project" || stringValue(lane.lane_key)?.startsWith("project:") || stringValue(lane.lane_key)?.startsWith("repo:"))
    .map(lane => ({
      lane_key: stringValue(lane.lane_key) ?? "",
      lane_kind: stringValue(lane.lane_kind) ?? "project",
      label: stringValue(lane.label) ?? stringValue(lane.lane_key) ?? "project",
      confidence: numberValue(lane.confidence) ?? 0,
      attention_share: numberValue(lane.attention_share) ?? 0,
      source_records: arrayStrings(lane.source_records),
      candidate_route_ids: arrayStrings(lane.candidate_route_ids),
      evidence: recordValue(lane.evidence) ?? {},
    }));
}

function inferFocus(lane: ProjectLane, records: StoredContextRecord[]): string {
  const titles = records
    .filter(record => record.source.type !== "browser")
    .map(record => record.content?.title)
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);
  if (titles.length) return titles.join(" / ");
  const files = arrayStrings(lane.evidence.file_paths).slice(0, 3);
  if (files.length) return `Work around ${files.join(", ")}`;
  const browserTitles = records
    .filter(record => record.source.type === "browser")
    .map(record => record.content?.title)
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);
  if (browserTitles.length) return `Researching ${browserTitles.join(" / ")}`;
  return `Active project lane ${lane.label}`;
}

function compactProjectRecord(record: StoredContextRecord): Record<string, unknown> {
  return {
    id: record.id,
    schema: record.schema.name,
    title: record.content?.title,
    url: record.content?.url,
    path: record.content?.path,
    observed_at: record.time?.observed_at ?? record.created_at,
    files_touched: arrayStrings(record.payload?.files_touched).slice(0, 8),
    commands_run: arrayStrings(record.payload?.commands_run).slice(0, 5),
  };
}

function extractDecisionCandidates(text: string): string[] {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  return unique(lines.filter(line =>
    /decision|decided|we should|should use|不要|需要|确定|决定|推荐|建议/i.test(line)
  ).map(line => line.replace(/\s+/g, " ").slice(0, 220))).slice(0, 8);
}

function extractQuestions(text: string): string[] {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  return unique(lines.filter(line => line.includes("?") || /如何|为啥|怎么|whether|should we/i.test(line))
    .map(line => line.replace(/\s+/g, " ").slice(0, 220))).slice(0, 8);
}

function inferNextActions(input: {
  activeFiles: string[];
  activeSessions: string[];
  decisions: string[];
  openQuestions: string[];
  evidenceRecords: StoredContextRecord[];
  interruptions: Array<Record<string, unknown>>;
  webpages: Array<ProjectArtifact & { url: string }>;
}): string[] {
  const actions: string[] = [];
  if (input.interruptions.length) actions.push("Resume from the latest interruption before starting a new branch of work.");
  if (input.activeFiles.length) actions.push(`Review and continue changes around ${input.activeFiles.slice(0, 3).join(", ")}.`);
  if (input.webpages.length) actions.push(`Use ${input.webpages[0].title ?? input.webpages[0].url} as supporting project research context.`);
  if (input.openQuestions.length) actions.push("Resolve the highest-priority open question before expanding scope.");
  if (input.decisions.length) actions.push("Preserve confirmed decisions in project memory or docs.");
  if (input.activeSessions.length) actions.push("Use the recent AI session as primary continuity context.");
  if (input.evidenceRecords.some(record => record.schema.name === "observation.local_project")) actions.push("Run typecheck/tests after local project changes.");
  if (!actions.length) actions.push("Collect more AI-session or local-project evidence before taking action.");
  return unique(actions).slice(0, 6);
}

function projectWebpages(records: StoredContextRecord[]): Array<ProjectArtifact & { url: string; domain?: string }> {
  return records
    .filter(record => record.source.type === "browser" || record.schema.name.startsWith("observation.browser_"))
    .flatMap(record => {
      const url = stringValue(record.content?.url) ?? stringValue(record.payload?.url) ?? stringValue(record.payload?.browser_url);
      if (!url) return [];
      const page: ProjectArtifact & { url: string; domain?: string } = {
        id: record.id,
        url,
        domain: stringValue(record.scope?.domain) ?? domainFromUrl(url),
        title: record.content?.title,
        observed_at: record.time?.observed_at ?? record.created_at,
        evidence: ["routed_by_work.focus_set", record.schema.name],
      };
      return [page];
    })
    .slice(0, 12);
}

function projectConversations(records: StoredContextRecord[]): Array<ProjectArtifact & { session?: string; tool?: string }> {
  return records
    .filter(isConversationRecord)
    .map(record => ({
      id: record.id,
      session: stringValue(record.scope?.session) ?? stringValue(record.payload?.session_id) ?? stringValue(record.payload?.sessionId),
      tool: conversationTool(record),
      title: record.content?.title,
      observed_at: record.time?.observed_at ?? record.created_at,
      evidence: ["routed_by_work.focus_set", record.schema.name],
    }))
    .slice(0, 12);
}

function projectFiles(activeFiles: string[], records: StoredContextRecord[]): ProjectArtifact[] {
  return activeFiles.map(path => {
    const sourceIds = records
      .filter(record => [
        ...arrayStrings(record.payload?.files_touched),
        ...arrayStrings(record.payload?.changed_files),
        ...arrayStrings(record.payload?.file_paths),
        stringValue(record.content?.path),
      ].filter((value): value is string => Boolean(value)).includes(path))
      .map(record => record.id);
    return {
      id: path,
      title: path.split("/").at(-1) ?? path,
      evidence: unique(["routed_by_work.focus_set", ...sourceIds]).slice(0, 8),
    };
  }).slice(0, 20);
}

function projectInterruptions(records: StoredContextRecord[]): Array<Record<string, unknown>> {
  return records
    .flatMap(record => {
      const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${JSON.stringify(record.payload ?? {})}`;
      if (!hasInterruptionSignal(text, record.payload)) return [];
      return [{
        id: record.id,
        title: record.content?.title,
        observed_at: record.time?.observed_at ?? record.created_at,
        session: stringValue(record.scope?.session) ?? stringValue(record.payload?.session_id) ?? stringValue(record.payload?.sessionId),
        reason: interruptionReason(text),
      }];
    })
    .slice(0, 8);
}

function laneLastSeen(lane: ProjectLane, records: StoredContextRecord[]): string | undefined {
  return records
    .map(record => record.time?.observed_at ?? record.created_at)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? stringValue(lane.evidence.last_seen_at);
}

function isConversationRecord(record: StoredContextRecord): boolean {
  return record.source.type === "ai_session"
    || record.schema.name === "observation.ai_session_locator_result"
    || record.schema.name === "observation.codex.message"
    || record.schema.name === "observation.claude.message"
    || /codex|claude/i.test([record.source.connector, record.content?.title, stringValue(record.payload?.tool)].filter(Boolean).join(" "));
}

function conversationTool(record: StoredContextRecord): string | undefined {
  const raw = [record.source.connector, stringValue(record.payload?.tool), record.schema.name, record.content?.title].filter(Boolean).join(" ");
  if (/claude/i.test(raw)) return "claude";
  if (/codex/i.test(raw)) return "codex";
  return stringValue(record.source.connector) ?? stringValue(record.payload?.tool);
}

function hasInterruptionSignal(text: string, payload: Record<string, unknown> | undefined): boolean {
  return Boolean(payload?.interrupted)
    || Boolean(payload?.interruption)
    || /interrupted|interruption|context switch|paused|resume from|继续之前|打断|中断/i.test(text);
}

function interruptionReason(text: string): string {
  return text.split(/\n+/).map(line => line.trim()).find(line => /interrupted|interruption|context switch|paused|resume from|继续之前|打断|中断/i.test(line))?.slice(0, 220)
    ?? "Interruption signal found in project evidence.";
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function stableKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

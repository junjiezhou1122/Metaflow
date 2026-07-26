import { createHash } from "node:crypto";
import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const DURABLE_MEMORY_MINER_PROCESSOR_ID = "processor.durable_memory_miner";
export const WORKFLOW_PATTERN_MINER_PROCESSOR_ID = "processor.workflow_pattern_miner";
export const SKILL_GAP_MINER_PROCESSOR_ID = "processor.skill_gap_miner";
export const AGENT_COLLABORATION_STYLE_PROCESSOR_ID = "processor.agent_collaboration_style";
export const PROJECT_MEMORY_PROCESSOR_ID = "processor.project_memory";

export type DurableMemoryMinerOptions = {
  now?: Date;
  recordLimit?: number;
  viewLimit?: number;
};

type DurableMemoryKind =
  | "workflow_pattern"
  | "skill_gap"
  | "agent_collaboration_style"
  | "project_memory";

type DurableMemoryCandidate = {
  kind: DurableMemoryKind;
  target: "memory.workflow_patterns" | "memory.skill_gaps" | "memory.agent_collaboration_style" | "project.memory";
  compilerId: string;
  title: string;
  claim: string;
  sourceRecordIds: string[];
  sourceViewIds: string[];
  subject?: Record<string, unknown>;
  confidence: number;
};

export function createDurableMemoryMinerProcessor(options: DurableMemoryMinerOptions = {}): ProcessorDefinition {
  return {
    id: DURABLE_MEMORY_MINER_PROCESSOR_ID,
    title: "Durable Memory Miner",
    version: "0.0.1",
    description: "Directly writes stable durable memories from daily/project/work/feedback evidence without memory.candidate gating.",
    consumes: {
      observations: ["observation.*", "feedback.*"],
      views: ["memory.daily", "project.current", "work.focus_set", "project.tasks", "project.decisions", "learning.review_queue"],
    },
    produces: {
      views: ["memory.workflow_patterns", "memory.skill_gaps", "memory.agent_collaboration_style", "project.memory"],
    },
    runtime: { kind: "local" },
    policy: { speed: "background", autonomy: "draft", privacy: "private" },
    handler: durableMemoryMinerHandler(options),
  };
}

export function durableMemoryMinerHandler(options: DurableMemoryMinerOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const generatedAt = now.toISOString();
    const records = context.store.recent(options.recordLimit ?? 120, undefined, undefined)
      .filter(record => record.schema.name.startsWith("observation.") || record.schema.name.startsWith("feedback."));
    const views = context.store.listViews({
      view_types: ["memory.daily", "project.current", "work.focus_set", "project.tasks", "project.decisions", "learning.review_queue"],
      active_only: true,
      limit: options.viewLimit ?? 40,
    });
    const candidates = [
      workflowPattern(records, views),
      skillGap(records, views),
      agentCollaborationStyle(records, views),
      projectMemory(records, views),
    ].filter((candidate): candidate is DurableMemoryCandidate => Boolean(candidate));

    const drafts: ViewDraft[] = candidates.map(candidate => ({
      id: durableMemoryId(candidate.target, candidate.claim),
      type: candidate.target,
      title: candidate.title,
      summary: candidate.claim,
      status: "accepted",
      source_records: candidate.sourceRecordIds,
      source_views: candidate.sourceViewIds,
      compiler: { id: candidate.compilerId, version: "0.0.1", mode: "deterministic" },
      purpose: "Direct durable memory mined from stable project, workflow, feedback, and daily evidence.",
      scope: { user: "default" },
      content: {
        memory_kind: candidate.kind,
        target_view_type: candidate.target,
        claim: candidate.claim,
        evidence_count: candidate.sourceRecordIds.length + candidate.sourceViewIds.length,
        subject: candidate.subject ?? {},
        generated_at: generatedAt,
        direct_miner: DURABLE_MEMORY_MINER_PROCESSOR_ID,
      },
      confidence: candidate.confidence,
      stability: "long_term",
      lossiness: "low",
      privacy: { level: "private", retention: "normal", allow_external_llm: false, allow_external_reader: false },
      metadata: {
        generated_at: generatedAt,
        algorithm: "durable-memory-miner-v1",
        direct_memory_miner: true,
        processor_alias: DURABLE_MEMORY_MINER_PROCESSOR_ID,
      },
    }));

    return {
      views: drafts,
      diagnostics: {
        records_scanned: records.length,
        views_scanned: views.length,
        durable_memories: drafts.map(draft => draft.type),
      },
    };
  };
}

function workflowPattern(records: StoredContextRecord[], views: StoredContextView[]): DurableMemoryCandidate | undefined {
  const evidenceRecords = records.filter(record => {
    const text = recordText(record);
    return /\b(test|typecheck|verify|implement|ship|fix|review|commit|pr)\b/i.test(text) || /测试|验证|实现|修复/.test(text);
  }).slice(0, 12);
  const evidenceViews = views.filter(view => ["memory.daily", "work.focus_set", "project.tasks"].includes(view.view_type)).slice(0, 8);
  if (evidenceRecords.length + evidenceViews.length < 2) return undefined;
  const command = mostCommon(records.flatMap(record => arrayStrings(record.payload?.commands_run))).find(Boolean);
  const claim = command
    ? `Workflow pattern: verify implementation work with ${command}.`
    : "Workflow pattern: collect recent project context, make a focused implementation change, then verify it with tests or runtime checks.";
  return {
    kind: "workflow_pattern",
    target: "memory.workflow_patterns",
    compilerId: WORKFLOW_PATTERN_MINER_PROCESSOR_ID,
    title: "Workflow Pattern",
    claim,
    sourceRecordIds: evidenceRecords.map(record => record.id),
    sourceViewIds: evidenceViews.map(view => view.id),
    confidence: 0.78,
  };
}

function skillGap(records: StoredContextRecord[], views: StoredContextView[]): DurableMemoryCandidate | undefined {
  const learningViews = views.filter(view => view.view_type === "learning.review_queue");
  const gapRecords = records.filter(record => {
    const text = recordText(record);
    return record.schema.name.includes("comprehension_gap") ||
      record.schema.name.includes("review") ||
      /\b(gap|confusing|unclear|review|practice|learn)\b/i.test(text) ||
      /不懂|困难|复习|学习|听力/.test(text);
  }).slice(0, 12);
  if (!learningViews.length && gapRecords.length < 2) return undefined;
  const claim = "Skill gap: recurring review or comprehension signals should be retained for targeted future practice.";
  return {
    kind: "skill_gap",
    target: "memory.skill_gaps",
    compilerId: SKILL_GAP_MINER_PROCESSOR_ID,
    title: "Skill Gap",
    claim,
    sourceRecordIds: gapRecords.map(record => record.id),
    sourceViewIds: learningViews.map(view => view.id),
    confidence: 0.74,
  };
}

function agentCollaborationStyle(records: StoredContextRecord[], views: StoredContextView[]): DurableMemoryCandidate | undefined {
  const feedback = records.filter(record => record.schema.name.startsWith("feedback.") || /用户说|please|prefer|直接|不要|先|最后/.test(recordText(record))).slice(0, 12);
  const daily = views.filter(view => view.view_type === "memory.daily").slice(0, 5);
  if (feedback.length + daily.length < 1) return undefined;
  const text = `${feedback.map(recordText).join(" ")} ${daily.map(viewText).join(" ")}`;
  const claim = /直接|implement|直接实现/i.test(text)
    ? "Agent collaboration style: prefer direct implementation after reading relevant context, with concise progress and verification notes."
    : "Agent collaboration style: preserve momentum, explain progress briefly, and ground changes in observed project context.";
  return {
    kind: "agent_collaboration_style",
    target: "memory.agent_collaboration_style",
    compilerId: AGENT_COLLABORATION_STYLE_PROCESSOR_ID,
    title: "Agent Collaboration Style",
    claim,
    sourceRecordIds: feedback.map(record => record.id),
    sourceViewIds: daily.map(view => view.id),
    confidence: 0.8,
  };
}

function projectMemory(records: StoredContextRecord[], views: StoredContextView[]): DurableMemoryCandidate | undefined {
  const projectViews = views.filter(view => ["project.current", "project.decisions", "memory.daily"].includes(view.view_type)).slice(0, 8);
  const projectRecords = records.filter(record =>
    Boolean(record.scope?.project || record.scope?.project_path || record.payload?.cwd || record.payload?.root) ||
    /\b(project|repo|runtime|processor|view|memory)\b/i.test(recordText(record))
  ).slice(0, 12);
  if (projectViews.length + projectRecords.length < 1) return undefined;
  const projectPath = firstString([
    ...projectRecords.flatMap(record => [record.scope?.project_path, record.payload?.cwd, record.payload?.root]),
    ...projectViews.map(view => view.scope?.project_path),
  ]);
  const projectName = firstString([
    ...projectRecords.map(record => record.scope?.project),
    ...projectViews.map(view => view.scope?.project),
  ]) ?? (projectPath ? String(projectPath).split("/").filter(Boolean).at(-1) : "current project");
  const claim = projectPath
    ? `Project memory: ${projectName} lives at ${projectPath} and should use its current processor/view architecture as durable context.`
    : `Project memory: retain current ${projectName} project architecture and decisions as durable context.`;
  return {
    kind: "project_memory",
    target: "project.memory",
    compilerId: PROJECT_MEMORY_PROCESSOR_ID,
    title: "Project Memory",
    claim,
    sourceRecordIds: projectRecords.map(record => record.id),
    sourceViewIds: projectViews.map(view => view.id),
    subject: { project: projectName, project_path: projectPath },
    confidence: 0.82,
  };
}

function durableMemoryId(viewType: string, claim: string): string {
  const hash = createHash("sha256").update(`${viewType}:${normalizeClaim(claim)}`).digest("hex").slice(0, 16);
  return `${viewType}:direct:${hash}`;
}

function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, " ").trim();
}

function recordText(record: StoredContextRecord): string {
  return [record.content?.title, record.content?.text, JSON.stringify(record.payload ?? {})].filter(Boolean).join(" ");
}

function viewText(view: StoredContextView): string {
  return [view.title, view.summary, JSON.stringify(view.content ?? {})].filter(Boolean).join(" ");
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mostCommon(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

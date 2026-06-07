import type { ContextBrokerPack, ContextQuery, ContextRecord, ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import { activeContextView } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";
import { analysisTextFromView, keyPointsFromView } from "@info/core";

const AGENT_TASK_CAPABILITY = "capability.agent_task.submit";
const WRITING_SCAFFOLD_ENV = "WRITING_AMBIENT_ENABLE_SCAFFOLD";

const FOCUS_VIEW_TYPES = new Set([
  "thread.active_work",
  "project.current_context",
  "brief.project_next_state",
  "brief.research",
]);

const TOOLSMITH_VIEW_TYPES = new Set([
  "workflow",
  "workflow.recipe",
  "workflow.trace",
  "memory.routine_patterns",
  "memory.project.patterns",
  "brief.project_next_state",
  "thread.active_work",
]);

const WRITING_SCHEMAS = new Set([
  "observation.editor.text_changed",
  "observation.editor.text_inserted",
  "observation.editor.selection",
  "observation.note.text_changed",
  "observation.document.text_changed",
  "observation.codex.message",
  "observation.browser_text_copied",
  "observation.browser_text_selected",
]);

export const proactiveResearchProgram: Program = {
  id: "program.proactive_research",
  title: "Proactive Research",
  purpose: "When the user appears focused on a project or work thread, prepare background research tasks and reusable research suggestions.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "suggest",
  capabilities: [AGENT_TASK_CAPABILITY],
  applications: ["project.cockpit", "research.inbox", "agent.context_pack"],
  produces: ["task.background_research", "advice.research", "brief.background_research"],
  learns_from: ["feedback.research_suggestion.useful", "feedback.research_suggestion.dismissed"],

  attention(signal: ContextSignal, store): AttentionDecision {
    if (signal.object_kind !== "view") return { action: "ignore", reason: "proactive research starts from focus Views", confidence: 0.9 };
    const view = store.getView(signal.object_id);
    if (!view || !activeContextView(view)) return { action: "ignore", reason: "inactive focus View", confidence: 0.95 };
    if (!FOCUS_VIEW_TYPES.has(signal.object_type)) return { action: "ignore", reason: "not a project/research focus View", confidence: 0.8 };

    const score = focusScore(signal, view);
    if (score >= 0.55) {
      return {
        action: "run",
        reason: `focused project/research context (${score})`,
        confidence: score,
        speed: "background",
        capability_ids: [AGENT_TASK_CAPABILITY],
      };
    }
    return { action: "defer", reason: `weak focus signal (${score})`, confidence: score };
  },

  async run({ signal, store, buildContextPack, runCapability }): Promise<ProgramRunResult> {
    const view = store.getView(signal.object_id);
    if (!view) return { ok: false, reason: `focus view not found: ${signal.object_id}` };

    const task = buildBackgroundResearchTask(view, buildContextPack);
    const taskView = buildBackgroundResearchTaskView(view, task.goal);
    const adviceView = buildResearchAdviceView(view, taskView);
    const agentResult = process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME
      ? await runCapability(AGENT_TASK_CAPABILITY, { payload: { task } })
      : skippedAgentTask("set PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME to enable live background research delegation");
    const agentViews = (agentResult.written_views ?? [])
      .map(id => store.getView(id))
      .filter((item): item is StoredContextView => Boolean(item));

    return {
      ok: true,
      reason: agentResult.ok
        ? "queued proactive background research through generic AgentTask"
        : "created proactive research task/advice; AgentTask delegation was unavailable",
      views: [...agentViews, taskView, adviceView],
      diagnostics: {
        focus_view_type: view.view_type,
        agent_task: {
          ok: agentResult.ok,
          reason: agentResult.reason,
          written_views: agentResult.written_views,
          diagnostics: agentResult.diagnostics,
        },
      },
    };
  },
};

export const writingAmbientProgram: Program = {
  id: "program.writing_ambient",
  title: "Writing Ambient",
  purpose: "Notice active writing and provide low-friction wording, continuation, and structure help without taking over the editor.",
  version: "0.1.0",
  default_speed: "glance",
  default_autonomy: "suggest",
  applications: ["editor.inline_assist", "browser.sidebar", "project.cockpit"],
  produces: ["advice.writing_assist", "draft.writing_continuation"],
  learns_from: ["feedback.writing_suggestion.accepted", "feedback.writing_suggestion.dismissed", "feedback.writing_suggestion.edited"],

  attention(signal: ContextSignal): AttentionDecision {
    if (signal.object_kind !== "observation") return { action: "ignore", reason: "writing ambient starts from writing observations", confidence: 0.9 };
    const score = writingScore(signal);
    if (score >= 0.55) return { action: "run", reason: `active writing signal (${score})`, confidence: score, speed: "glance" };
    return { action: "defer", reason: `weak writing signal (${score})`, confidence: score };
  },

  run({ signal, store }): ProgramRunResult {
    const record = store.getRecord(signal.object_id);
    if (!record) return { ok: false, reason: `writing record not found: ${signal.object_id}` };
    if (!writingScaffoldEnabled()) {
      return {
        ok: true,
        reason: `captured active writing but skipped generated advice; set ${WRITING_SCAFFOLD_ENV}=1 only for local scaffold demos`,
        views: [],
        diagnostics: {
          writing_schema: record.schema.name,
          generated: false,
          generator: "none",
          scaffold_env: WRITING_SCAFFOLD_ENV,
        },
      };
    }
    const advice = buildWritingAdviceView(record);
    const draft = buildWritingDraftView(record, advice);
    return {
      ok: true,
      reason: "created local scaffold writing assistance candidate",
      views: [advice, draft],
      diagnostics: {
        writing_schema: record.schema.name,
        generated: true,
        generator: "deterministic_scaffold",
        advice_view_id: advice.id,
        draft_view_id: draft.id,
      },
    };
  },
};

export const toolsmithAmbientProgram: Program = {
  id: "program.toolsmith_ambient",
  title: "Toolsmith Ambient",
  purpose: "Detect repeated or costly workflows and propose small tools or agent tasks that could improve the user's work loop.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "draft",
  capabilities: [AGENT_TASK_CAPABILITY],
  applications: ["project.cockpit", "task.inbox"],
  produces: ["opportunity.tool", "task.toolsmith_prototype", "draft.tool_prototype"],
  learns_from: ["feedback.tool_opportunity.accepted", "feedback.tool_opportunity.dismissed", "feedback.tool_prototype.used"],

  attention(signal: ContextSignal, store): AttentionDecision {
    if (signal.object_kind !== "view") return { action: "ignore", reason: "toolsmith ambient consumes workflow/project Views", confidence: 0.9 };
    const view = store.getView(signal.object_id);
    if (!view || !activeContextView(view)) return { action: "ignore", reason: "inactive toolsmith source View", confidence: 0.95 };
    if (!TOOLSMITH_VIEW_TYPES.has(signal.object_type)) return { action: "ignore", reason: "not a toolsmith opportunity source", confidence: 0.8 };

    const score = toolOpportunityScore(signal, view);
    if (score >= 0.55) {
      return {
        action: "run",
        reason: `workflow/tool opportunity (${score})`,
        confidence: score,
        speed: "background",
        capability_ids: [AGENT_TASK_CAPABILITY],
      };
    }
    return { action: "defer", reason: `weak tool opportunity (${score})`, confidence: score };
  },

  async run({ signal, store, buildContextPack, runCapability }): Promise<ProgramRunResult> {
    const source = store.getView(signal.object_id);
    if (!source) return { ok: false, reason: `toolsmith source view not found: ${signal.object_id}` };
    const opportunity = buildToolOpportunityView(source);
    const prototypeTask = buildToolPrototypeTaskView(source, opportunity);
    const agentTask = buildToolPrototypeAgentTask(source, opportunity, buildContextPack);
    const agentResult = process.env.TOOLSMITH_AGENT_TASK_RUNTIME
      ? await runCapability(AGENT_TASK_CAPABILITY, { payload: { task: agentTask } })
      : skippedAgentTask("set TOOLSMITH_AGENT_TASK_RUNTIME to enable live tool prototype delegation");
    const agentViews = (agentResult.written_views ?? [])
      .map(id => store.getView(id))
      .filter((item): item is StoredContextView => Boolean(item));

    return {
      ok: true,
      reason: agentResult.ok
        ? "created tool opportunity and requested a no-file-edit prototype draft"
        : "created tool opportunity and prototype task; AgentTask delegation was unavailable",
      views: [...agentViews, opportunity, prototypeTask],
      diagnostics: {
        source_view_type: source.view_type,
        opportunity_view_id: opportunity.id,
        prototype_task_view_id: prototypeTask.id,
        agent_task: {
          ok: agentResult.ok,
          reason: agentResult.reason,
          written_views: agentResult.written_views,
          diagnostics: agentResult.diagnostics,
        },
      },
    };
  },
};

type BuildContextPack = (query?: ContextQuery) => ContextBrokerPack;

function buildBackgroundResearchTask(source: StoredContextView, buildContextPack: BuildContextPack) {
  const focus = focusText(source);
  const goal = [
    "You are helping Info act as a proactive ambient research shadow.",
    `The user appears focused on: ${focus}.`,
    "Search/read only public or policy-allowed material that would help the current project.",
    "Return concise findings, missing references, and why they matter.",
    "Do not modify files or perform account-changing actions.",
  ].join("\n");
  const pack = buildContextPack({
    goal,
    mode: "thread",
    include_records: true,
    include_views: true,
    allow_external_llm: true,
    scope: source.scope,
    limit: 12,
  });
  return {
    runtime: process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME || process.env.AGENT_TASK_DEFAULT_RUNTIME || "claude_code",
    goal,
    context_pack: { markdown: pack.markdown, sources: pack.sources, diagnostics: pack.diagnostics },
    constraints: {
      write_policy: "views_only",
      no_file_edits: true,
      read_only_external_research: true,
    },
    output_contract: {
      view_type: "brief.background_research",
      title: `Background research: ${focus}`.slice(0, 180),
      purpose: "Proactive background research prepared while the user is focused on a project or thread.",
    },
  };
}

function buildToolPrototypeAgentTask(source: StoredContextView, opportunity: ContextView, buildContextPack: BuildContextPack) {
  const focus = focusText(source);
  const goal = [
    "You are helping Info act as an ambient toolsmith.",
    `Workflow/opportunity focus: ${focus}.`,
    "Design a small local tool, script, CLI, or Program that could improve this workflow.",
    "Return a prototype plan and interface contract only.",
    "Do not modify files. Do not run destructive commands. Do not call external services except read-only documentation if needed.",
  ].join("\n");
  const pack = buildContextPack({
    goal,
    include_records: true,
    include_views: true,
    allow_external_llm: true,
    scope: source.scope,
    view_types: [source.view_type, opportunity.view_type],
    limit: 12,
  });
  return {
    runtime: process.env.TOOLSMITH_AGENT_TASK_RUNTIME || process.env.AGENT_TASK_DEFAULT_RUNTIME || "claude_code",
    goal,
    context_pack: { markdown: pack.markdown, sources: pack.sources, diagnostics: pack.diagnostics },
    constraints: {
      write_policy: "views_only",
      no_file_edits: true,
      prototype_only: true,
    },
    output_contract: {
      view_type: "draft.tool_prototype",
      title: `Tool prototype draft: ${focus}`.slice(0, 180),
      purpose: "No-file-edit prototype plan for a small workflow-improving tool.",
    },
  };
}

function buildBackgroundResearchTaskView(source: StoredContextView, goal: string): ContextView {
  const focus = focusText(source);
  const id = `task:background-research:${stableKey(`${source.id}:${focus}`)}`;
  return {
    id,
    view_type: "task.background_research",
    title: `Background research task: ${focus}`.slice(0, 180),
    summary: `Find supporting material for ${focus}`.slice(0, 300),
    status: "candidate",
    source_records: source.source_records,
    source_views: [source.id],
    compiler: { id: "program.proactive_research", version: "0.1.0", mode: "hybrid" },
    purpose: "Represents proactive read-only background research that can be delegated to an agent runtime.",
    scope: withPlugin(source.scope, "program.proactive_research"),
    content: {
      focus,
      speed: "background",
      autonomy: "suggest",
      goal,
      allowed_actions: ["read_public_context", "return_views"],
      forbidden_actions: ["modify_files", "post_or_send", "mutate_remote_systems"],
      source_view_type: source.view_type,
      source_view_id: source.id,
    },
    confidence: Math.max(0.45, Math.min(0.88, source.confidence ?? 0.6)),
    stability: "session",
    lossiness: "low",
    privacy: source.privacy,
  };
}

function buildResearchAdviceView(source: StoredContextView, taskView: ContextView): ContextView {
  const focus = focusText(source);
  return {
    id: `advice:research:${stableKey(`${source.id}:${taskView.id}`)}`,
    view_type: "advice.research",
    title: `Research suggestion: ${focus}`.slice(0, 180),
    summary: `Info can prepare background research for the current focus: ${focus}`.slice(0, 300),
    status: "candidate",
    source_records: source.source_records,
    source_views: [source.id, taskView.id!],
    compiler: { id: "program.proactive_research", version: "0.1.0", mode: "deterministic" },
    purpose: "Glanceable suggestion that a proactive background research task is available.",
    scope: withPlugin(source.scope, "program.proactive_research"),
    content: {
      focus,
      suggested_surface: "research.inbox",
      task_view_id: taskView.id,
      source_view_type: source.view_type,
      key_points: keyPointsFromView(source, 5),
    },
    confidence: taskView.confidence,
    stability: "session",
    lossiness: "medium",
    privacy: source.privacy,
  };
}

function buildWritingAdviceView(record: StoredContextRecord): ContextView {
  const text = record.content?.text ?? record.content?.title ?? "";
  const topic = writingTopic(record);
  return {
    id: `advice:writing-assist:${stableKey(`${record.id}:${text.slice(0, 120)}`)}`,
    view_type: "advice.writing_assist",
    title: `Writing assist: ${topic}`.slice(0, 180),
    summary: "Low-friction writing help is available for the current text.",
    status: "candidate",
    source_records: [record.id],
    compiler: { id: "program.writing_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Glance-speed writing intervention that can be shown inline without changing the user's text.",
    scope: withPlugin(record.scope, "program.writing_ambient"),
    content: {
      speed: "glance",
      autonomy: "suggest",
      topic,
      suggestions: writingSuggestions(text),
      source_schema: record.schema.name,
      source_path: record.content?.path,
      generated_by: "deterministic_scaffold",
      scaffold_only: true,
    },
    confidence: Math.max(0.52, Math.min(0.86, record.signal?.confidence ?? 0.62)),
    stability: "ephemeral",
    lossiness: "medium",
    privacy: record.privacy,
    validity: { stale_after: new Date(Date.now() + 10 * 60_000).toISOString() },
  };
}

function buildWritingDraftView(record: StoredContextRecord, advice: ContextView): ContextView {
  const text = record.content?.text ?? "";
  const continuation = draftContinuation(text);
  return {
    id: `draft:writing-continuation:${stableKey(`${record.id}:${continuation}`)}`,
    view_type: "draft.writing_continuation",
    title: `Writing draft: ${writingTopic(record)}`.slice(0, 180),
    summary: continuation,
    status: "candidate",
    source_records: [record.id],
    source_views: [advice.id!],
    compiler: { id: "program.writing_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Small draft continuation that the user may accept, edit, or ignore.",
    scope: withPlugin(record.scope, "program.writing_ambient"),
    content: {
      speed: "glance",
      autonomy: "draft",
      draft_text: continuation,
      based_on_text_excerpt: text.slice(0, 800),
      advice_view_id: advice.id,
      generated_by: "deterministic_scaffold",
      scaffold_only: true,
    },
    confidence: Math.max(0.42, Math.min(0.78, advice.confidence ?? 0.55)),
    stability: "ephemeral",
    lossiness: "high",
    privacy: record.privacy,
    validity: { stale_after: new Date(Date.now() + 10 * 60_000).toISOString() },
  };
}

function buildToolOpportunityView(source: StoredContextView): ContextView {
  const focus = focusText(source);
  const id = `opportunity:tool:${stableKey(`${source.id}:${focus}`)}`;
  return {
    id,
    view_type: "opportunity.tool",
    title: `Tool opportunity: ${focus}`.slice(0, 180),
    summary: `A small tool may improve this workflow: ${focus}`.slice(0, 300),
    status: "candidate",
    source_records: source.source_records,
    source_views: [source.id],
    compiler: { id: "program.toolsmith_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Identifies a repeated or costly workflow that may deserve a small tool, script, or Program.",
    scope: withPlugin(source.scope, "program.toolsmith_ambient"),
    content: {
      focus,
      source_view_type: source.view_type,
      source_view_id: source.id,
      opportunity_kind: inferToolKind(source),
      evidence: keyPointsFromView(source, 6),
      autonomy_boundary: "suggest_or_draft_first; file edits require sandbox_auto or explicit user approval",
    },
    confidence: Math.max(0.48, Math.min(0.84, source.confidence ?? 0.58)),
    stability: "project",
    lossiness: "medium",
    privacy: source.privacy,
  };
}

function buildToolPrototypeTaskView(source: StoredContextView, opportunity: ContextView): ContextView {
  const focus = focusText(source);
  return {
    id: `task:toolsmith-prototype:${stableKey(`${source.id}:${opportunity.id}`)}`,
    view_type: "task.toolsmith_prototype",
    title: `Prototype tool task: ${focus}`.slice(0, 180),
    summary: `Prepare a no-file-edit prototype plan for ${focus}`.slice(0, 300),
    status: "candidate",
    source_records: source.source_records,
    source_views: [source.id, opportunity.id!],
    compiler: { id: "program.toolsmith_ambient", version: "0.1.0", mode: "deterministic" },
    purpose: "Delegable task for an agent runtime to draft a small workflow-improving tool without changing files.",
    scope: withPlugin(source.scope, "program.toolsmith_ambient"),
    content: {
      focus,
      opportunity_view_id: opportunity.id,
      output_target: "draft.tool_prototype",
      constraints: {
        no_file_edits: true,
        prototype_only: true,
        require_user_approval_before_implementation: true,
      },
    },
    confidence: opportunity.confidence,
    stability: "session",
    lossiness: "low",
    privacy: source.privacy,
  };
}

function focusScore(signal: ContextSignal, view: StoredContextView): number {
  let score = signal.object_type === "thread.active_work" || signal.object_type === "project.current_context" ? 0.45 : 0.3;
  if (signal.project || signal.project_path || signal.repo) score += 0.25;
  const hay = haystack(signal, view);
  if (/agent|runtime|architecture|research|docs|issue|workflow|tool|package|adapter|project|implementation/.test(hay)) score += 0.25;
  if ((view.source_records?.length ?? 0) >= 2) score += 0.1;
  if (signal.confidence !== undefined) score += Math.min(0.12, Math.max(0, signal.confidence) * 0.12);
  return Number(Math.min(1, score).toFixed(3));
}

function writingScore(signal: ContextSignal): number {
  let score = WRITING_SCHEMAS.has(signal.object_type) ? 0.35 : 0;
  const hay = [signal.title, signal.text_preview, signal.path, signal.app, ...(signal.keywords ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/\.(md|mdx|txt|rst|docx?)$|readme|docs?|issue|proposal|draft|writing|note|design|spec/.test(hay)) score += 0.3;
  const wordCount = (signal.text_preview ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (wordCount >= 12) score += 0.2;
  if (signal.source === "editor" || /obsidian|notion|cursor|vscode|code|editor/.test(String(signal.app ?? "").toLowerCase())) score += 0.15;
  if (signal.confidence !== undefined) score += Math.min(0.1, Math.max(0, signal.confidence) * 0.1);
  return Number(Math.min(1, score).toFixed(3));
}

function toolOpportunityScore(signal: ContextSignal, view: StoredContextView): number {
  let score = signal.object_type.startsWith("workflow") ? 0.45 : 0.28;
  if (signal.object_type === "memory.routine_patterns" || signal.object_type === "memory.project.patterns") score += 0.2;
  const hay = haystack(signal, view);
  if (/repeat|routine|manual|workflow|script|tool|automation|cli|generate|extract|summari[sz]e|search|issue|doc|package/.test(hay)) score += 0.3;
  const count = numberValue(view.content?.workflow_count) ?? numberValue(view.content?.evidence_count);
  if (count !== undefined && count >= 2) score += 0.15;
  if (signal.confidence !== undefined) score += Math.min(0.1, Math.max(0, signal.confidence) * 0.1);
  return Number(Math.min(1, score).toFixed(3));
}

function haystack(signal: ContextSignal, view: StoredContextView): string {
  return [
    signal.title,
    signal.text_preview,
    signal.url,
    signal.path,
    ...(signal.keywords ?? []),
    ...(signal.topics ?? []),
    view.title,
    view.summary,
    analysisTextFromView(view),
    ...keyPointsFromView(view, 8),
  ].filter(Boolean).join(" ").toLowerCase();
}

function focusText(source: StoredContextView): string {
  return String(source.content?.focus ?? source.title ?? source.summary ?? source.id).replace(/\s+/g, " ").trim().slice(0, 160);
}

function writingTopic(record: StoredContextRecord): string {
  return String(record.content?.title ?? record.content?.path ?? record.scope?.project ?? "current text").replace(/\s+/g, " ").trim().slice(0, 120);
}

function writingSuggestions(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return ["Clarify the main claim before adding details."];
  return [
    "Make the main claim explicit before listing mechanisms.",
    "Separate what the system observes from what it is allowed to do.",
    "Keep the next sentence anchored to the current project/workflow context.",
  ];
}

function draftContinuation(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/ambient|主动|自动|proactive/i.test(normalized)) {
    return "A practical version is to let Info prepare low-risk help in the background, then surface it as suggestions, drafts, or sandboxed tasks depending on trust.";
  }
  if (/tool|workflow|工具|流程/i.test(normalized)) {
    return "The next step is to capture the repeated workflow as evidence, propose a small tool boundary, and only move to implementation after the user accepts the prototype.";
  }
  return "The useful next move is to state the concrete user state, the evidence behind it, and the smallest reversible intervention the system should offer.";
}

function writingScaffoldEnabled(): boolean {
  return process.env[WRITING_SCAFFOLD_ENV] === "1" || process.env[WRITING_SCAFFOLD_ENV] === "true";
}

function inferToolKind(source: StoredContextView): string {
  const hay = `${source.title ?? ""} ${source.summary ?? ""} ${analysisTextFromView(source) ?? ""}`.toLowerCase();
  if (/search|research|source|reader|firecrawl|jina/.test(hay)) return "research_helper";
  if (/issue|github|pr|repo|code/.test(hay)) return "project_coding_helper";
  if (/doc|writing|draft|markdown|proposal/.test(hay)) return "writing_helper";
  if (/summary|daily|timeline/.test(hay)) return "summary_helper";
  return "workflow_helper";
}

function withPlugin(scope: ContextRecord["scope"] | undefined, plugin_id: string): ContextView["scope"] {
  return { ...(scope ?? {}), plugin_id };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function skippedAgentTask(reason: string) {
  return {
    ok: false,
    reason,
    written_views: [] as string[],
    diagnostics: { delegated: false, reason },
  };
}

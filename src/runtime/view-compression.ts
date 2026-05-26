import { createHash } from "node:crypto";
import { ContextStore } from "../core/store.js";
import { chatCompletion, parseJsonObject, type LlmOptions } from "../core/llm.js";
import type { ContextView, StoredContextView } from "../core/types.js";

export type CompressionMode = "deterministic" | "llm" | "hybrid";
export type CompressionCost = "low" | "medium" | "high";

export type CompressionStrategy = {
  id: string;
  version: string;
  output_view_type: string;
  output_kind: string;
  input_view_types: string[];
  mode: CompressionMode;
  trigger: string;
  prompt_id: string;
  max_input_views: number;
  cost: CompressionCost;
};

export type LlmCompressionRequest = {
  strategy: CompressionStrategy;
  prompt: string;
  input_views: Array<ContextView | StoredContextView>;
};

export type LlmCompressionResponse = {
  ok: boolean;
  content?: Record<string, unknown>;
  raw?: string;
  model?: string;
  base_url?: string;
  error?: string;
};

export type LlmViewCompressor = (request: LlmCompressionRequest) => Promise<LlmCompressionResponse>;

export type CompileLlmViewOptions = {
  limit?: number;
  write?: boolean;
  llm?: LlmOptions;
  compressor?: LlmViewCompressor;
};

export type CompileLlmViewResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  source_views_used: number;
  diagnostics: Record<string, unknown>;
};

export type CompileIntentViewsWithLlmOptions = CompileLlmViewOptions & {
  proposalViews?: Array<ContextView | StoredContextView>;
  activityBlockViews?: Array<ContextView | StoredContextView>;
};

export type CompileWorkflowViewsWithLlmOptions = CompileLlmViewOptions & {
  intentViews?: Array<ContextView | StoredContextView>;
  resourceViews?: Array<ContextView | StoredContextView>;
  activityBlockViews?: Array<ContextView | StoredContextView>;
};

export type CompileMemoryViewsWithLlmOptions = CompileLlmViewOptions & {
  workflowViews?: Array<ContextView | StoredContextView>;
  existingMemoryViews?: Array<ContextView | StoredContextView>;
};

export const AI_INTENT_VIEW_STRATEGY: CompressionStrategy = {
  id: "ai.intent.candidate",
  version: "1",
  output_view_type: "intent",
  output_kind: "candidate",
  input_view_types: ["proposal", "activity", "resource"],
  mode: "llm",
  trigger: "proposal.decision=defer_or_agent OR explicit_request",
  prompt_id: "intent_candidate_v1",
  max_input_views: 20,
  cost: "medium",
};

export const AI_WORKFLOW_VIEW_STRATEGY: CompressionStrategy = {
  id: "ai.workflow.session",
  version: "1",
  output_view_type: "workflow",
  output_kind: "session",
  input_view_types: ["intent", "activity", "resource"],
  mode: "llm",
  trigger: "focus_block_closed OR session_end OR explicit_request",
  prompt_id: "workflow_session_v1",
  max_input_views: 40,
  cost: "medium",
};

export const AI_MEMORY_VIEW_STRATEGY: CompressionStrategy = {
  id: "ai.memory.family",
  version: "1",
  output_view_type: "memory",
  output_kind: "episode",
  input_view_types: ["workflow"],
  mode: "llm",
  trigger: "workflow_closed OR session_consolidation OR explicit_request",
  prompt_id: "memory_family_v1",
  max_input_views: 50,
  cost: "high",
};

export async function compileIntentViewsWithLlm(options: CompileIntentViewsWithLlmOptions = {}, store = new ContextStore()): Promise<CompileLlmViewResult> {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? AI_INTENT_VIEW_STRATEGY.max_input_views;
  const candidates = (options.proposalViews ?? store.listViews({
    view_types: ["proposal"],
    active_only: true,
    limit: Math.max(limit * 3, limit + 20),
  })).filter(view => view.view_type === "proposal");
  const proposalViews = candidates
    .filter(proposal => shouldCompileIntentProposal(proposal, store))
    .slice(0, limit);
  const blockCandidates = (options.activityBlockViews ?? store.listViews({
    view_types: ["activity_block"],
    active_only: true,
    limit: Math.max(limit * 2, limit + 20),
  })).filter(view => view.view_type === "activity_block");
  const activityBlockViews = blockCandidates
    .filter(shouldCompileWorkflowActivityBlock)
    .slice(0, limit);

  const proposalIntents = await mapWithCompressor(proposalViews, AI_INTENT_VIEW_STRATEGY, generatedAt, options, (proposal) => {
    const inputViews = compactViews([proposal, ...sourceViewsOf(proposal, store), ...relatedResourceViews(proposal, store)]);
    return {
      inputViews,
      prompt: intentPrompt(inputViews),
      normalize: (content, llm) => normalizeIntentView(content, inputViews, generatedAt, llm),
    };
  });
  const blockIntents = await mapWithCompressor(activityBlockViews, AI_INTENT_VIEW_STRATEGY, generatedAt, options, (block) => {
    const sourceViews = sourceViewsOf(block, store)
      .filter(view => ["visual_frame", "activity"].includes(view.view_type))
      .slice(0, AI_INTENT_VIEW_STRATEGY.max_input_views - 1);
    const inputViews = compactViews([block, ...sourceViews]);
    return {
      inputViews,
      prompt: intentFromActivityBlockPrompt(inputViews),
      normalize: (content, llm) => normalizeIntentView(content, inputViews, generatedAt, llm),
    };
  });
  const views = uniqueViews([...blockIntents, ...proposalIntents]);

  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;
  if (options.write ?? true) appendCompileEvent(store, AI_INTENT_VIEW_STRATEGY, stored, {
    proposal_views_seen: candidates.length,
    proposal_views_used: proposalViews.length,
    proposal_views_skipped_by_gate: candidates.length - proposalViews.length,
    activity_block_views_seen: blockCandidates.length,
    activity_block_views_used: activityBlockViews.length,
    activity_block_views_skipped_by_gate: blockCandidates.length - activityBlockViews.length,
    views_compiled: stored.length,
  });

  return {
    ok: true,
    compiler_id: AI_INTENT_VIEW_STRATEGY.id,
    generated_at: generatedAt,
    views: stored,
    source_views_used: proposalViews.length,
    diagnostics: {
      strategy: AI_INTENT_VIEW_STRATEGY.id,
      candidates_seen: candidates.length + blockCandidates.length,
      skipped_by_gate: candidates.length - proposalViews.length + blockCandidates.length - activityBlockViews.length,
      attempted: proposalViews.length + activityBlockViews.length,
      produced: stored.length,
    },
  };
}

export async function compileWorkflowViewsWithLlm(options: CompileWorkflowViewsWithLlmOptions = {}, store = new ContextStore()): Promise<CompileLlmViewResult> {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? AI_WORKFLOW_VIEW_STRATEGY.max_input_views;
  const candidates = (options.intentViews ?? store.listViews({
    view_types: ["intent"],
    active_only: true,
    limit: Math.max(limit * 3, limit + 20),
  })).filter(view => view.view_type === "intent");
  const intentViews = candidates
    .filter(intent => shouldCompileWorkflowIntent(intent, store))
    .slice(0, limit);
  const resourceViews = (options.resourceViews ?? store.listViews({
    view_types: ["resource"],
    active_only: true,
    limit: Math.max(limit * 2, limit + 20),
  })).filter(view => view.view_type === "resource");
  const blockCandidates = (options.activityBlockViews ?? store.listViews({
    view_types: ["activity_block"],
    active_only: true,
    limit: Math.max(limit * 2, limit + 20),
  })).filter(view => view.view_type === "activity_block");
  const activityBlockViews = blockCandidates
    .filter(shouldCompileWorkflowActivityBlock)
    .slice(0, limit);

  const intentWorkflows = await mapWithCompressor(intentViews, AI_WORKFLOW_VIEW_STRATEGY, generatedAt, options, (intent) => {
    const linkedViews = sourceViewsOf(intent, store)
      .filter(view => ["activity_block", "visual_frame", "audio", "activity"].includes(view.view_type));
    const activityViews = linkedViews.filter(view => view.view_type === "activity");
    const resources = relatedResourcesForActivityIds(resourceViews, activityViews.map(view => view.id).filter(isString));
    const inputViews = compactViews([intent, ...linkedViews, ...resources]);
    return {
      inputViews,
      prompt: workflowPrompt(inputViews),
      normalize: (content, llm) => normalizeWorkflowView(content, inputViews, generatedAt, llm),
    };
  });
  const blockWorkflows = await mapWithCompressor(activityBlockViews, AI_WORKFLOW_VIEW_STRATEGY, generatedAt, options, (block) => {
    const sourceViews = sourceViewsOf(block, store)
      .filter(view => ["visual_frame", "audio", "activity", "resource"].includes(view.view_type))
      .slice(0, AI_WORKFLOW_VIEW_STRATEGY.max_input_views - 1);
    const inputViews = compactViews([block, ...sourceViews]);
    return {
      inputViews,
      prompt: workflowFromActivityBlockPrompt(inputViews),
      normalize: (content, llm) => normalizeWorkflowView(content, inputViews, generatedAt, llm),
    };
  });
  const views = uniqueViews([...blockWorkflows, ...intentWorkflows]);

  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;
  if (options.write ?? true) appendCompileEvent(store, AI_WORKFLOW_VIEW_STRATEGY, stored, {
    intent_views_seen: candidates.length,
    intent_views_used: intentViews.length,
    intent_views_skipped_by_gate: candidates.length - intentViews.length,
    activity_block_views_seen: blockCandidates.length,
    activity_block_views_used: activityBlockViews.length,
    activity_block_views_skipped_by_gate: blockCandidates.length - activityBlockViews.length,
    resource_views_used: resourceViews.length,
    views_compiled: stored.length,
  });

  return {
    ok: true,
    compiler_id: AI_WORKFLOW_VIEW_STRATEGY.id,
    generated_at: generatedAt,
    views: stored,
    source_views_used: intentViews.length + resourceViews.length,
    diagnostics: {
      strategy: AI_WORKFLOW_VIEW_STRATEGY.id,
      candidates_seen: candidates.length + blockCandidates.length,
      skipped_by_gate: candidates.length - intentViews.length + blockCandidates.length - activityBlockViews.length,
      attempted: intentViews.length + activityBlockViews.length,
      produced: stored.length,
    },
  };
}

export async function compileMemoryViewsWithLlm(options: CompileMemoryViewsWithLlmOptions = {}, store = new ContextStore()): Promise<CompileLlmViewResult> {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? AI_MEMORY_VIEW_STRATEGY.max_input_views;
  const candidates = (options.workflowViews ?? store.listViews({
    view_types: ["workflow"],
    active_only: true,
    limit: Math.max(limit * 3, limit + 20),
  })).filter(view => view.view_type === "workflow");
  const workflowViews = candidates
    .filter(shouldCompileMemoryWorkflow)
    .slice(0, limit);
  const existingMemoryViews = (options.existingMemoryViews ?? []).filter(view => view.view_type === "memory");
  const inputViews = compactViews(workflowViews);

  const response = workflowViews.length
    ? await runCompression({
      strategy: AI_MEMORY_VIEW_STRATEGY,
      inputViews,
      prompt: memoryPrompt(inputViews),
      options,
    })
    : undefined;
  const views = response?.ok && response.content
    ? normalizeMemoryViews(response.content, inputViews, generatedAt, response)
    : [];
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;
  if (options.write ?? true) appendCompileEvent(store, AI_MEMORY_VIEW_STRATEGY, stored, {
    workflow_views_seen: candidates.length,
    workflow_views_used: workflowViews.length,
    workflow_views_skipped_by_gate: candidates.length - workflowViews.length,
    existing_memory_views_used: existingMemoryViews.length,
    views_compiled: stored.length,
  });

  return {
    ok: true,
    compiler_id: AI_MEMORY_VIEW_STRATEGY.id,
    generated_at: generatedAt,
    views: stored,
    source_views_used: inputViews.length,
    diagnostics: {
      strategy: AI_MEMORY_VIEW_STRATEGY.id,
      candidates_seen: candidates.length,
      skipped_by_gate: candidates.length - workflowViews.length,
      attempted: inputViews.length ? 1 : 0,
      produced: stored.length,
      llm_error: response?.error,
    },
  };
}

async function mapWithCompressor(
  sourceViews: Array<ContextView | StoredContextView>,
  strategy: CompressionStrategy,
  generatedAt: string,
  options: CompileLlmViewOptions,
  build: (view: ContextView | StoredContextView) => {
    inputViews: Array<ContextView | StoredContextView>;
    prompt: string;
    normalize: (content: Record<string, unknown>, llm: LlmCompressionResponse) => ContextView | undefined;
  },
): Promise<ContextView[]> {
  const views: ContextView[] = [];
  for (const source of sourceViews) {
    const job = build(source);
    if (!job.inputViews.length) continue;
    const response = await runCompression({ strategy, inputViews: job.inputViews, prompt: job.prompt, options });
    if (!response.ok || !response.content) continue;
    const view = job.normalize(response.content, response);
    if (view) views.push(view);
  }
  return uniqueViews(views);
}

async function runCompression(input: {
  strategy: CompressionStrategy;
  inputViews: Array<ContextView | StoredContextView>;
  prompt: string;
  options: CompileLlmViewOptions;
}): Promise<LlmCompressionResponse> {
  if (input.options.compressor) {
    return input.options.compressor({
      strategy: input.strategy,
      prompt: input.prompt,
      input_views: input.inputViews,
    });
  }
  const llm = await chatCompletion([
    {
      role: "system",
      content: [
        "You are a memory view compiler.",
        "Use only the provided Views. Do not invent external facts.",
        "Return strict JSON only.",
        "Keep the same language as the input when obvious; Chinese is okay.",
      ].join("\n"),
    },
    { role: "user", content: input.prompt },
  ], input.options.llm);
  if (!llm.ok || !llm.content) return { ok: false, model: llm.model, base_url: llm.base_url, error: llm.error ?? "llm failed" };
  const parsed = parseJsonObject(llm.content);
  if (!parsed) return { ok: false, raw: llm.content, model: llm.model, base_url: llm.base_url, error: "LLM did not return JSON object" };
  return { ok: true, content: parsed, raw: llm.content, model: llm.model, base_url: llm.base_url };
}

function normalizeIntentView(content: Record<string, unknown>, inputViews: Array<ContextView | StoredContextView>, generatedAt: string, llm: LlmCompressionResponse): ContextView {
  const sourceViews = inputViews.map(view => view.id).filter(isString);
  const activity = inputViews.find(view => view.view_type === "activity");
  const proposal = inputViews.find(view => view.view_type === "proposal");
  const block = inputViews.find(view => view.view_type === "activity_block");
  const scopeSource = activity ?? block ?? proposal;
  const kind = stringValue(content.kind) ?? "candidate";
  const hypothesis = stringValue(content.hypothesis) ?? stringValue(content.summary) ?? "Possible user intent inferred from activity.";
  const title = stringValue(content.title) ?? `Possible intent: ${hypothesis.slice(0, 80)}`;
  return {
    id: `intent:${kind}:${stableKey(`${hypothesis}|${sourceViews.join("|")}`)}`,
    view_type: "intent",
    title,
    summary: stringValue(content.summary) ?? hypothesis,
    status: "candidate",
    source_records: unique(inputViews.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: AI_INTENT_VIEW_STRATEGY.id, version: AI_INTENT_VIEW_STRATEGY.version, mode: "llm" },
    purpose: "AI-compressed hypothesis about what the user is trying to do, derived from lower-level Views.",
    scope: { ...scopeSource?.scope, plugin_id: AI_INTENT_VIEW_STRATEGY.id },
    content: {
      kind,
      hypothesis,
      supporting_signals: stringArray(content.supporting_signals),
      counter_signals: stringArray(content.counter_signals),
      suggested_workflow_kind: stringValue(content.suggested_workflow_kind) ?? "research_session",
      extracted_from: sourceViews,
    },
    confidence: clamp(numberValue(content.confidence) ?? 0.68),
    stability: "session",
    lossiness: "high",
    privacy: activity?.privacy ?? block?.privacy ?? proposal?.privacy ?? { level: "private", retention: "normal", allow_llm_summary: true, allow_external_llm: false },
    metadata: llmMetadata(AI_INTENT_VIEW_STRATEGY, generatedAt, llm),
  };
}

function normalizeWorkflowView(content: Record<string, unknown>, inputViews: Array<ContextView | StoredContextView>, generatedAt: string, llm: LlmCompressionResponse): ContextView | undefined {
  const sourceViews = inputViews.map(view => view.id).filter(isString);
  const activity = inputViews.find(view => view.view_type === "activity");
  const intent = inputViews.find(view => view.view_type === "intent");
  const block = inputViews.find(view => view.view_type === "activity_block");
  const scopeSource = activity ?? block ?? intent;
  const kind = stringValue(content.kind) ?? stringValue(intent?.content?.suggested_workflow_kind) ?? "research_session";
  const confidence = clamp(numberValue(content.confidence) ?? 0.72);
  if (isNonMaterialWorkflowKind(kind) || confidence < 0.6) return undefined;
  const title = stringValue(content.title) ?? `${kind.replace(/_/g, " ")} workflow`;
  return {
    id: `workflow:${kind}:${stableKey(`${title}|${sourceViews.join("|")}`)}`,
    view_type: "workflow",
    title,
    summary: stringValue(content.summary) ?? `${title} compressed from activity, intent, and resource Views.`,
    status: "candidate",
    source_records: unique(inputViews.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: AI_WORKFLOW_VIEW_STRATEGY.id, version: AI_WORKFLOW_VIEW_STRATEGY.version, mode: "llm" },
    purpose: "AI-compressed task/session structure that can feed MemoryViews and agents.",
    scope: { ...scopeSource?.scope, plugin_id: AI_WORKFLOW_VIEW_STRATEGY.id },
    content: {
      kind,
      phases: stringArray(content.phases),
      decisions: stringArray(content.decisions),
      outputs: stringArray(content.outputs),
      blockers: stringArray(content.blockers),
      open_questions: stringArray(content.open_questions),
      topic_candidates: stringArray(content.topic_candidates),
      extracted_from: sourceViews,
    },
    confidence,
    stability: "project",
    lossiness: "high",
    privacy: activity?.privacy ?? block?.privacy ?? intent?.privacy ?? { level: "private", retention: "normal", allow_llm_summary: true, allow_external_llm: false },
    metadata: llmMetadata(AI_WORKFLOW_VIEW_STRATEGY, generatedAt, llm),
  };
}

function normalizeMemoryViews(content: Record<string, unknown>, inputViews: Array<ContextView | StoredContextView>, generatedAt: string, llm: LlmCompressionResponse): ContextView[] {
  const rawMemories = Array.isArray(content.memories) ? content.memories : [content];
  return rawMemories
    .filter(isRecord)
    .map(item => normalizeMemoryView(item, inputViews, generatedAt, llm))
    .filter((view): view is ContextView => Boolean(view));
}

function normalizeMemoryView(content: Record<string, unknown>, inputViews: Array<ContextView | StoredContextView>, generatedAt: string, llm: LlmCompressionResponse): ContextView | undefined {
  const sourceViews = inputViews.map(view => view.id).filter(isString);
  const workflow = inputViews.find(view => view.view_type === "workflow");
  const kind = stringValue(content.kind) ?? "episode";
  const summary = stringValue(content.summary) ?? stringValue(content.claim);
  if (!summary) return undefined;
  const confidence = clamp(numberValue(content.confidence) ?? (Boolean(content.stable) ? 0.78 : 0.68));
  const stable = Boolean(content.stable);
  const workflowCount = inputViews.filter(view => view.view_type === "workflow").length;
  if (kind === "user_profile" && (!stable || confidence < 0.85 || workflowCount < 3)) return undefined;
  const title = stringValue(content.title) ?? `Memory: ${kind.replace(/_/g, " ")}`;
  return {
    id: `memory:${kind}:${stableKey(`${title}|${summary}|${sourceViews.join("|")}`)}`,
    view_type: "memory",
    title,
    summary,
    status: stable ? "accepted" : "candidate",
    source_records: unique(inputViews.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: AI_MEMORY_VIEW_STRATEGY.id, version: AI_MEMORY_VIEW_STRATEGY.version, mode: "llm" },
    purpose: "AI-compressed memory-oriented View for agents and applications.",
    scope: { ...workflow?.scope, plugin_id: AI_MEMORY_VIEW_STRATEGY.id },
    content: {
      kind,
      summary,
      extracted_from: sourceViews,
      use_for: stringArray(content.use_for),
      facts: stringArray(content.facts),
      signals: stringArray(content.signals),
      stable,
    },
    confidence,
    stability: stable ? "long_term" : "project",
    lossiness: "high",
    privacy: workflow?.privacy ?? { level: "private", retention: stable ? "archive" : "normal", allow_embedding: true, allow_llm_summary: true, allow_external_llm: false },
    metadata: llmMetadata(AI_MEMORY_VIEW_STRATEGY, generatedAt, llm),
  };
}

function intentPrompt(inputViews: Array<ContextView | StoredContextView>): string {
  return [
    "Compile one IntentView from these lower-level Views.",
    "Return JSON with keys: title, summary, kind, hypothesis, supporting_signals, counter_signals, suggested_workflow_kind, confidence.",
    "The intent is a hypothesis, not a fact. Include counter_signals when evidence is weak.",
    renderViews(inputViews),
  ].join("\n\n");
}

function intentFromActivityBlockPrompt(inputViews: Array<ContextView | StoredContextView>): string {
  return [
    "Compile one IntentView from this ActivityBlockView and visual/audio evidence.",
    "The intent is a hypothesis about what the user is trying to accomplish in the block.",
    "Return JSON with keys: title, summary, kind, hypothesis, supporting_signals, counter_signals, suggested_workflow_kind, confidence.",
    "Use counter_signals for uncertainty. Do not infer durable preference or long-term memory here.",
    renderViews(inputViews),
  ].join("\n\n");
}

function workflowPrompt(inputViews: Array<ContextView | StoredContextView>): string {
  const hasActivityBlock = inputViews.some(view => view.view_type === "activity_block");
  return [
    "Compile one WorkflowView from these Views.",
    hasActivityBlock ? "ActivityBlockView evidence is present; use it as the primary work-block signal and keep VisualFrameView evidence attached." : undefined,
    "Return JSON with keys: title, summary, kind, phases, decisions, outputs, blockers, open_questions, topic_candidates, confidence.",
    "Focus on task/session structure: what happened, what decisions were made, what is still open.",
    renderViews(inputViews),
  ].filter(isString).join("\n\n");
}

function memoryPrompt(inputViews: Array<ContextView | StoredContextView>): string {
  return [
    "Compile MemoryViews from these WorkflowView nodes.",
    "MemoryView is a family, not only long-term memory.",
    "Do not summarize existing MemoryViews. Use only new WorkflowView evidence.",
    "Return JSON: { \"memories\": [ { title, summary, kind, use_for, facts, signals, stable, confidence } ] }.",
    "Allowed memory kinds: episode, semantic_fact, user_profile, project_context, workflow_recipe, agent_case, agent_skill, surfacing_policy, other.",
    "Mark stable=true only for durable facts, preferences, project context, reusable procedures, or confirmed patterns.",
    renderViews(inputViews),
  ].join("\n\n");
}

function workflowFromActivityBlockPrompt(inputViews: Array<ContextView | StoredContextView>): string {
  return [
    "Compile one WorkflowView from this ActivityBlockView and its supporting VisualFrameView/AudioView/ActivityView evidence.",
    "The ActivityBlockView is the primary signal; VisualFrameViews explain what was on screen, and AudioViews explain spoken intent/context.",
    "Return JSON with keys: title, summary, kind, phases, decisions, outputs, blockers, open_questions, topic_candidates, confidence.",
    "Use kind coding_session, research_session, learning_session, debugging_session, design_session, or defer.",
    "Only use defer when the block is mostly noise or lacks a coherent primary_work.",
    renderViews(inputViews),
  ].join("\n\n");
}

function renderViews(views: Array<ContextView | StoredContextView>): string {
  return JSON.stringify(views.map(view => ({
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    source_views: view.source_views,
    content: view.content,
    confidence: view.confidence,
    scope: view.scope,
  })), null, 2);
}

function sourceViewsOf(view: ContextView | StoredContextView, store: ContextStore): StoredContextView[] {
  return (view.source_views ?? [])
    .map(id => store.getView(id))
    .filter((item): item is StoredContextView => Boolean(item));
}

function relatedResourceViews(view: ContextView | StoredContextView, store: ContextStore): StoredContextView[] {
  const activityIds = new Set(sourceViewsOf(view, store).filter(item => item.view_type === "activity").map(item => item.id));
  if (!activityIds.size) return [];
  return store.listViews({ view_types: ["resource"], active_only: true, limit: 100 })
    .filter(resource => (resource.source_views ?? []).some(id => activityIds.has(id)));
}

function relatedResourcesForActivityIds(resourceViews: Array<ContextView | StoredContextView>, activityIds: string[]): Array<ContextView | StoredContextView> {
  const ids = new Set(activityIds);
  return resourceViews.filter(view => (view.source_views ?? []).some(id => ids.has(id)));
}

function shouldCompileIntentProposal(proposal: ContextView | StoredContextView, store: ContextStore): boolean {
  const intentProposal = proposedViewsOf(proposal)
    .filter(item => stringValue(item.view_type) === "intent")
    .find(item => ["materialize_now", "defer_or_agent"].includes(stringValue(item.decision) ?? ""));
  if (!intentProposal) return false;
  if ((numberValue(intentProposal.confidence) ?? proposal.confidence ?? 0) < 0.5) return false;
  const activity = sourceViewsOf(proposal, store).find(view => view.view_type === "activity");
  if (activity && isWeakActivityForAiCompression(activity)) return false;
  return true;
}

function shouldCompileWorkflowIntent(intent: ContextView | StoredContextView, store: ContextStore): boolean {
  if ((intent.confidence ?? 0) < 0.55) return false;
  const kind = stringValue(intent.content?.kind);
  if (kind && ["defer", "gather", "gather_more_evidence"].includes(kind)) return false;
  const activity = sourceViewsOf(intent, store).find(view => view.view_type === "activity");
  if (activity && isWeakActivityForAiCompression(activity)) return false;
  return true;
}

function shouldCompileMemoryWorkflow(workflow: ContextView | StoredContextView): boolean {
  if ((workflow.confidence ?? 0) < 0.72) return false;
  const kind = stringValue(workflow.content?.kind);
  if (!kind || kind === "research_session") {
    const decisions = stringArray(workflow.content?.decisions);
    const outputs = stringArray(workflow.content?.outputs);
    const topics = stringArray(workflow.content?.topic_candidates);
    if (decisions.length + outputs.length === 0 && topics.length < 2) return false;
  }
  return true;
}

function shouldCompileWorkflowActivityBlock(block: ContextView | StoredContextView): boolean {
  if ((block.confidence ?? 0) < 0.7) return false;
  const primaryWork = stringValue(block.content?.primary_work) ?? stringValue(block.summary);
  if (!primaryWork || /^(activity|using app|app focus)$/i.test(primaryWork)) return false;
  const worth = normalizeScore(block.content?.memory_worthiness) ?? 0;
  const done = stringValue(block.content?.done_signal);
  const continuation = stringValue(block.content?.continuation_signal);
  const sources = block.source_views ?? [];
  const visualEvidence = sources.filter(id => id.startsWith("visual_frame:")).length;
  return worth >= 0.55 || done === "weak" || done === "strong" || continuation === "strong" || visualEvidence >= 2;
}

function isWeakActivityForAiCompression(activity: ContextView | StoredContextView): boolean {
  const kind = stringValue(activity.content?.kind);
  if (kind === "app_focus") return true;
  if (kind !== "resource_consumption" && kind !== "coding") {
    const resource = isRecord(activity.content?.resource) ? activity.content.resource : undefined;
    const url = stringValue(resource?.url) ?? stringValue(activity.content?.url);
    if (!url && (activity.confidence ?? 0) < 0.8) return true;
  }
  return false;
}

function proposedViewsOf(proposal: ContextView | StoredContextView): Array<Record<string, unknown>> {
  const proposed = proposal.content?.proposed_views;
  return Array.isArray(proposed) ? proposed.filter(isRecord) : [];
}

function appendCompileEvent(store: ContextStore, strategy: CompressionStrategy, views: Array<ContextView | StoredContextView>, payload: Record<string, unknown>) {
  store.appendRuntimeEvent({
    event_type: "view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "view",
    plugin_id: strategy.id,
    related_views: views.map(view => view.id).filter(Boolean) as string[],
    payload: { view_type: strategy.output_view_type, strategy: strategy.id, mode: strategy.mode, ...payload },
  });
}

function isNonMaterialWorkflowKind(kind: string): boolean {
  return /^(defer|deferred|gather|wait|manual_review|candidate|unknown|none)/i.test(kind)
    || /collect_more_evidence|more_evidence|not_enough|insufficient/i.test(kind);
}

function llmMetadata(strategy: CompressionStrategy, generatedAt: string, llm: LlmCompressionResponse): Record<string, unknown> {
  return {
    generated_at: generatedAt,
    strategy_id: strategy.id,
    prompt_id: strategy.prompt_id,
    trigger: strategy.trigger,
    cost: strategy.cost,
    llm: {
      model: llm.model,
      base_url: llm.base_url,
    },
  };
}

function compactViews(views: Array<ContextView | StoredContextView | undefined>): Array<ContextView | StoredContextView> {
  return uniqueViews(views.filter((view): view is ContextView | StoredContextView => Boolean(view)));
}

function uniqueViews(views: ContextView[]): ContextView[];
function uniqueViews<T extends ContextView | StoredContextView>(views: T[]): T[];
function uniqueViews<T extends ContextView | StoredContextView>(views: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const view of views) {
    const key = view.id ?? `${view.view_type}:${view.title ?? ""}:${JSON.stringify(view.content ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(view);
  }
  return result;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeScore(value: unknown): number | undefined {
  const raw = numberValue(value) ?? (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined);
  if (raw === undefined) return undefined;
  if (raw > 1 && raw <= 10) return clamp(raw / 10);
  if (raw > 10 && raw <= 100) return clamp(raw / 100);
  return clamp(raw);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => stringValue(item)).filter((item): item is string => Boolean(item));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

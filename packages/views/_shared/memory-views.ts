import { createHash } from "node:crypto";
import { ContextStore } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";

export const ACTIVITY_VIEW_COMPILER_ID = "builtin.activity-view";
export const PROPOSAL_VIEW_COMPILER_ID = "builtin.proposal-view";
export const RESOURCE_VIEW_COMPILER_ID = "builtin.resource-view";
export const INTENT_VIEW_COMPILER_ID = "builtin.intent-view";
export const WORKFLOW_VIEW_COMPILER_ID = "builtin.workflow-view";
export const MEMORY_VIEW_COMPILER_ID = "builtin.memory-view";

export type CompileActivityViewsOptions = {
  minutes?: number;
  limit?: number;
  write?: boolean;
  evidenceViews?: Array<ContextView | StoredContextView>;
  mergeGapMinutes?: number;
};

export type CompileProposalViewsOptions = {
  limit?: number;
  write?: boolean;
  activityViews?: Array<ContextView | StoredContextView>;
};

export type CompileResourceViewsOptions = {
  limit?: number;
  write?: boolean;
  proposalViews?: Array<ContextView | StoredContextView>;
};

export type CompileIntentViewsOptions = {
  limit?: number;
  write?: boolean;
  proposalViews?: Array<ContextView | StoredContextView>;
};

export type CompileWorkflowViewsOptions = {
  limit?: number;
  write?: boolean;
  intentViews?: Array<ContextView | StoredContextView>;
  resourceViews?: Array<ContextView | StoredContextView>;
};

export type CompileMemoryViewsOptions = {
  limit?: number;
  write?: boolean;
  workflowViews?: Array<ContextView | StoredContextView>;
  minOccurrences?: number;
};

export type CompileViewResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  source_views_used: number;
};

export function compileActivityViews(options: CompileActivityViewsOptions = {}, store = new ContextStore()): CompileViewResult {
  const generatedAt = new Date().toISOString();
  const minutes = options.minutes ?? 240;
  const limit = options.limit ?? 500;
  const evidenceViews = (options.evidenceViews ?? store.listViews({
    view_types: ["evidence"],
    active_only: true,
    limit: Math.max(limit * 2, limit + 50),
    timeWindow: { minutes },
  }))
    .filter(view => view.view_type === "evidence")
    .filter(view => typeof view.content?.kind === "string")
    .slice(0, limit);
  const views = buildActivityViewsFromEvidence(evidenceViews, generatedAt, options.mergeGapMinutes ?? 3);
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      plugin_id: ACTIVITY_VIEW_COMPILER_ID,
      related_views: stored.map(view => view.id).filter(Boolean) as string[],
      payload: {
        view_type: "activity",
        evidence_views_used: evidenceViews.length,
        views_compiled: stored.length,
      },
    });
  }

  return {
    ok: true,
    compiler_id: ACTIVITY_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    source_views_used: evidenceViews.length,
  };
}

export function compileProposalViews(options: CompileProposalViewsOptions = {}, store = new ContextStore()): CompileViewResult {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? 100;
  const activityViews = (options.activityViews ?? store.listViews({
    view_types: ["activity"],
    active_only: true,
    limit,
  }))
    .filter(view => view.view_type === "activity")
    .slice(0, limit);
  const views = activityViews
    .map(view => buildProposalView(view, generatedAt))
    .filter((view): view is ContextView => Boolean(view));
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      plugin_id: PROPOSAL_VIEW_COMPILER_ID,
      related_views: stored.map(view => view.id).filter(Boolean) as string[],
      payload: {
        view_type: "proposal",
        activity_views_used: activityViews.length,
        views_compiled: stored.length,
      },
    });
  }

  return {
    ok: true,
    compiler_id: PROPOSAL_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    source_views_used: activityViews.length,
  };
}

export function compileResourceViews(options: CompileResourceViewsOptions = {}, store = new ContextStore()): CompileViewResult {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? 100;
  const proposalViews = (options.proposalViews ?? store.listViews({
    view_types: ["proposal"],
    active_only: true,
    limit,
  }))
    .filter(view => view.view_type === "proposal")
    .slice(0, limit);
  const views = proposalViews.flatMap(proposal => buildResourceViewsFromProposal(proposal, generatedAt, store));
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) appendCompileEvent(store, RESOURCE_VIEW_COMPILER_ID, "resource", stored, { proposal_views_used: proposalViews.length, views_compiled: stored.length });

  return {
    ok: true,
    compiler_id: RESOURCE_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    source_views_used: proposalViews.length,
  };
}

export function compileIntentViews(options: CompileIntentViewsOptions = {}, store = new ContextStore()): CompileViewResult {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? 100;
  const proposalViews = (options.proposalViews ?? store.listViews({
    view_types: ["proposal"],
    active_only: true,
    limit,
  }))
    .filter(view => view.view_type === "proposal")
    .slice(0, limit);
  const views = proposalViews.flatMap(proposal => buildIntentViewsFromProposal(proposal, generatedAt, store));
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) appendCompileEvent(store, INTENT_VIEW_COMPILER_ID, "intent", stored, { proposal_views_used: proposalViews.length, views_compiled: stored.length });

  return {
    ok: true,
    compiler_id: INTENT_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    source_views_used: proposalViews.length,
  };
}

export function compileWorkflowViews(options: CompileWorkflowViewsOptions = {}, store = new ContextStore()): CompileViewResult {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? 100;
  const intentViews = (options.intentViews ?? store.listViews({
    view_types: ["intent"],
    active_only: true,
    limit,
  }))
    .filter(view => view.view_type === "intent")
    .slice(0, limit);
  const resourceViews = (options.resourceViews ?? store.listViews({
    view_types: ["resource"],
    active_only: true,
    limit: Math.max(limit * 2, limit + 20),
  })).filter(view => view.view_type === "resource");
  const views = intentViews.flatMap(intent => buildWorkflowViewsFromIntent(intent, resourceViews, generatedAt, store));
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) appendCompileEvent(store, WORKFLOW_VIEW_COMPILER_ID, "workflow", stored, { intent_views_used: intentViews.length, resource_views_used: resourceViews.length, views_compiled: stored.length });

  return {
    ok: true,
    compiler_id: WORKFLOW_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    source_views_used: intentViews.length + resourceViews.length,
  };
}

export function compileMemoryViews(options: CompileMemoryViewsOptions = {}, store = new ContextStore()): CompileViewResult {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? 100;
  const minOccurrences = options.minOccurrences ?? 2;
  const workflowViews = (options.workflowViews ?? store.listViews({
    view_types: ["workflow"],
    active_only: true,
    limit,
  }))
    .filter(view => view.view_type === "workflow")
    .slice(0, limit);
  const views = buildMemoryViewsFromWorkflows(workflowViews, generatedAt, minOccurrences);
  const stored = (options.write ?? true) ? views.map(view => store.upsertView(view)) : views;

  if (options.write ?? true) appendCompileEvent(store, MEMORY_VIEW_COMPILER_ID, "memory", stored, { workflow_views_used: workflowViews.length, min_occurrences: minOccurrences, views_compiled: stored.length });

  return {
    ok: true,
    compiler_id: MEMORY_VIEW_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    source_views_used: workflowViews.length,
  };
}

export function buildMemoryView(input: {
  id?: string;
  title: string;
  kind: string;
  claim: string;
  applies_to?: string[];
  future_use?: string[];
  source_views?: string[];
  confidence?: number;
  stability?: ContextView["stability"];
}): ContextView {
  return {
    id: input.id ?? `memory:${input.kind}:${stableKey(`${input.title}|${input.claim}|${(input.source_views ?? []).join("|")}`)}`,
    view_type: "memory",
    title: input.title,
    summary: input.claim,
    status: "candidate",
    source_views: input.source_views ?? [],
    compiler: { id: MEMORY_VIEW_COMPILER_ID, version: "1", mode: "hybrid" },
    purpose: "Durable knowledge that changes future behavior for agents and applications.",
    content: {
      kind: input.kind,
      claim: input.claim,
      applies_to: input.applies_to ?? [],
      future_use: input.future_use ?? [],
    },
    confidence: input.confidence ?? 0.7,
    stability: input.stability ?? "project",
    lossiness: "high",
    privacy: { level: "private", retention: "normal", allow_embedding: true, allow_llm_summary: true, allow_external_llm: false },
  };
}

function buildResourceViewsFromProposal(proposal: ContextView | StoredContextView, generatedAt: string, store: ContextStore): ContextView[] {
  const activity = sourceActivityOf(proposal, store);
  if (!activity) return [];
  const proposals = proposedViewsOf(proposal)
    .filter(item => stringValue(item.view_type) === "resource")
    .filter(item => stringValue(item.decision) === "materialize_now");
  return proposals.map(item => buildResourceView(proposal, activity, item, generatedAt)).filter((view): view is ContextView => Boolean(view));
}

function buildResourceView(proposal: ContextView | StoredContextView, activity: ContextView | StoredContextView, item: Record<string, unknown>, generatedAt: string): ContextView | undefined {
  const resource = isRecord(activity.content?.resource) ? activity.content.resource : undefined;
  const url = stringValue(resource?.url);
  if (!url) return undefined;
  const title = stringValue(resource?.title) ?? activity.title ?? url;
  const domain = stringValue(resource?.domain) ?? stringValue(activity.content?.domain);
  const kind = stringValue(item.kind) ?? (learningDomain(domain) ? "learning_material" : "web_resource");
  const start = stringValue(activity.content?.start) ?? activity.scope?.time_range?.start;
  const end = stringValue(activity.content?.end) ?? activity.scope?.time_range?.end;
  const observedDuration = boundedDurationMinutes(start, end, numberValue(activity.content?.duration_minutes));
  const sourceViews = unique([proposal.id, activity.id].filter(isString));

  return {
    id: `resource:${kind}:${stableKey(normalizeResourceKey(url))}`,
    view_type: "resource",
    title,
    summary: `ResourceView(${kind}) from ActivityView ${activity.id}.`,
    status: "candidate",
    source_records: activity.source_records ?? proposal.source_records ?? [],
    source_views: sourceViews,
    compiler: { id: RESOURCE_VIEW_COMPILER_ID, version: "1", mode: "deterministic" },
    purpose: "Materialize a reusable resource node from observed activity.",
    scope: {
      ...activity.scope,
      domain,
      plugin_id: RESOURCE_VIEW_COMPILER_ID,
      time_range: { start, end },
    },
    content: {
      kind,
      resource: {
        type: stringValue(resource?.type) ?? "url",
        url,
        title,
        domain,
      },
      observed_activity: {
        start,
        end,
        duration_minutes: observedDuration,
        action: stringValue(activity.content?.action),
      },
      evidence_summary: isRecord(activity.content?.evidence_summary) ? activity.content.evidence_summary : undefined,
      use_cases: ["future_retrieval", "answer_questions", "workflow_context"],
      proposal: {
        decision: stringValue(item.decision),
        reason: stringValue(item.reason),
        priority: numberValue(item.priority),
      },
    },
    confidence: Math.min(0.96, average([numberValue(item.confidence) ?? 0.7, activity.confidence ?? 0.7])),
    stability: "project",
    lossiness: "low",
    privacy: activity.privacy ?? proposal.privacy ?? { level: "private", retention: "normal", allow_external_llm: false },
    metadata: { generated_at: generatedAt, proposal_view_id: proposal.id, activity_view_id: activity.id },
  };
}

function buildIntentViewsFromProposal(proposal: ContextView | StoredContextView, generatedAt: string, store: ContextStore): ContextView[] {
  const activity = sourceActivityOf(proposal, store);
  if (!activity) return [];
  const proposals = proposedViewsOf(proposal)
    .filter(item => stringValue(item.view_type) === "intent")
    .filter(item => ["materialize_now", "defer_or_agent"].includes(stringValue(item.decision) ?? ""));
  return proposals.map(item => buildIntentView(proposal, activity, item, generatedAt)).filter((view): view is ContextView => Boolean(view));
}

function buildIntentView(proposal: ContextView | StoredContextView, activity: ContextView | StoredContextView, item: Record<string, unknown>, generatedAt: string): ContextView | undefined {
  const activityKind = stringValue(activity.content?.kind);
  const duration = numberValue(activity.content?.duration_minutes) ?? 0;
  const resource = isRecord(activity.content?.resource) ? activity.content.resource : undefined;
  const title = stringValue(resource?.title) ?? activity.title ?? "Activity";
  const domain = stringValue(resource?.domain) ?? stringValue(activity.content?.domain);
  const hypothesis = intentHypothesis(activity, domain, title);
  const start = stringValue(activity.content?.start) ?? activity.scope?.time_range?.start;
  const end = stringValue(activity.content?.end) ?? activity.scope?.time_range?.end;
  const workflowKind = learningDomain(domain) ? "learning_session" : activityKind === "coding" ? "coding_session" : "research_session";

  return {
    id: `intent:candidate:${stableKey(`${activity.id ?? ""}|${hypothesis}|${proposal.id ?? ""}`)}`,
    view_type: "intent",
    title: `Possible intent: ${title}`,
    summary: hypothesis,
    status: "candidate",
    source_records: activity.source_records ?? proposal.source_records ?? [],
    source_views: unique([proposal.id, activity.id].filter(isString)),
    compiler: { id: INTENT_VIEW_COMPILER_ID, version: "1", mode: "hybrid" },
    purpose: "Represent a hypothesis about the user's goal without mutating the observed evidence.",
    scope: {
      ...activity.scope,
      domain,
      plugin_id: INTENT_VIEW_COMPILER_ID,
      time_range: { start, end },
    },
    content: {
      kind: stringValue(item.kind) ?? "candidate",
      hypothesis,
      supporting_signals: supportingSignalsForIntent(activity, title, duration, domain),
      counter_signals: [
        "No explicit user confirmation was captured.",
        "Intent is inferred from activity and may be wrong.",
      ],
      suggested_workflow_kind: workflowKind,
      proposed_by: proposal.id,
    },
    confidence: Math.min(0.9, average([numberValue(item.confidence) ?? 0.55, activity.confidence ?? 0.65])),
    stability: "session",
    lossiness: "high",
    privacy: activity.privacy ?? proposal.privacy ?? { level: "private", retention: "normal", allow_external_llm: false },
    metadata: { generated_at: generatedAt, proposal_view_id: proposal.id, activity_view_id: activity.id },
  };
}

function buildWorkflowViewsFromIntent(intent: ContextView | StoredContextView, resourceViews: Array<ContextView | StoredContextView>, generatedAt: string, store: ContextStore): ContextView[] {
  const activity = sourceActivityOf(intent, store);
  if (!activity) return [];
  const activityIds = activityViewIdsOf(intent);
  const resources = resourceViews.filter(view => activityIds.some(id => view.source_views?.includes(id)));
  const workflow = buildWorkflowView(intent, activity, resources, generatedAt);
  return workflow ? [workflow] : [];
}

function buildWorkflowView(intent: ContextView | StoredContextView, activity: ContextView | StoredContextView, resources: Array<ContextView | StoredContextView>, generatedAt: string): ContextView | undefined {
  const kind = stringValue(intent.content?.suggested_workflow_kind) ?? "research_session";
  const start = stringValue(activity.content?.start) ?? activity.scope?.time_range?.start;
  const end = stringValue(activity.content?.end) ?? activity.scope?.time_range?.end;
  const topicCandidates = topicCandidatesForWorkflow(intent, activity, resources);
  const title = workflowTitle(kind, topicCandidates, activity);
  const sourceViews = unique([intent.id, ...resources.map(view => view.id), activity.id].filter(isString));

  return {
    id: `workflow:${kind}:${stableKey(`${sourceViews.join("|")}|${start ?? ""}|${end ?? ""}`)}`,
    view_type: "workflow",
    title,
    summary: `${title} composed from IntentView, ResourceView, and ActivityView nodes.`,
    status: "candidate",
    source_records: unique([...(activity.source_records ?? []), ...(intent.source_records ?? []), ...resources.flatMap(view => view.source_records ?? [])]),
    source_views: sourceViews,
    compiler: { id: WORKFLOW_VIEW_COMPILER_ID, version: "1", mode: "hybrid" },
    purpose: "Compose activity and intent into a reusable task/session structure.",
    scope: {
      ...activity.scope,
      plugin_id: WORKFLOW_VIEW_COMPILER_ID,
      time_range: { start, end },
    },
    content: {
      kind,
      phases: phasesForWorkflow(activity, resources),
      topic_candidates: topicCandidates,
      open_questions: openQuestionsForWorkflow(kind, intent),
      activity: {
        kind: stringValue(activity.content?.kind),
        start,
        end,
        duration_minutes: numberValue(activity.content?.duration_minutes),
        action: stringValue(activity.content?.action),
      },
      resources: resources.map(view => view.content?.resource).filter(isRecord),
      intent: {
        hypothesis: stringValue(intent.content?.hypothesis),
        confidence: intent.confidence,
      },
    },
    confidence: Math.min(0.9, average([intent.confidence ?? 0.6, activity.confidence ?? 0.65, ...resources.map(view => view.confidence ?? 0.7)])),
    stability: "project",
    lossiness: "high",
    privacy: activity.privacy ?? intent.privacy ?? { level: "private", retention: "normal", allow_external_llm: false },
    metadata: { generated_at: generatedAt, intent_view_id: intent.id, resource_view_ids: resources.map(view => view.id).filter(isString) },
  };
}

function buildMemoryViewsFromWorkflows(workflowViews: Array<ContextView | StoredContextView>, generatedAt: string, minOccurrences: number): ContextView[] {
  const learning = workflowViews.filter(view => stringValue(view.content?.kind) === "learning_session");
  const groups = new Map<string, Array<ContextView | StoredContextView>>();
  for (const view of learning) {
    for (const topic of topicCandidatesOf(view)) {
      const key = normalizedTopic(topic);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), view]);
      break;
    }
  }

  const views: ContextView[] = [];
  for (const [topic, group] of groups) {
    const uniqueGroup = uniqueById(group);
    if (uniqueGroup.length < minOccurrences) continue;
    views.push(buildRepeatedLearningMemory(topic, uniqueGroup, generatedAt));
  }
  return views;
}

function buildRepeatedLearningMemory(topic: string, workflows: Array<ContextView | StoredContextView>, generatedAt: string): ContextView {
  const sourceViews = workflows.map(view => view.id).filter(isString);
  const displayTopic = bestTopicLabel(topic, workflows);
  return {
    id: `memory:learning_interest:${stableKey(`${topic}|${sourceViews.join("|")}`)}`,
    view_type: "memory",
    title: `Learning interest: ${displayTopic}`,
    summary: `Repeated WorkflowViews suggest an active learning interest in ${displayTopic}.`,
    status: "candidate",
    source_records: unique(workflows.flatMap(view => view.source_records ?? [])),
    source_views: sourceViews,
    compiler: { id: MEMORY_VIEW_COMPILER_ID, version: "1", mode: "hybrid" },
    purpose: "Store durable behavior-changing learning interests only after repeated workflow evidence.",
    content: {
      kind: "learning_interest",
      claim: `The user repeatedly spends focused sessions on ${displayTopic}.`,
      applies_to: ["learning", "retrieval", "agent_context"],
      future_use: [
        `Surface related ${displayTopic} resources when answering memory/workflow questions.`,
        "Prefer higher-level WorkflowViews over raw OCR when summarizing this topic.",
      ],
      evidence: {
        workflow_count: workflows.length,
        workflow_titles: workflows.map(view => view.title).filter(isString),
      },
    },
    confidence: Math.min(0.9, average(workflows.map(view => view.confidence ?? 0.7)) + 0.08),
    stability: "long_term",
    lossiness: "high",
    privacy: { level: "private", retention: "archive", allow_embedding: true, allow_llm_summary: true, allow_external_llm: false },
    metadata: { generated_at: generatedAt, promotion_rule: "repeated_workflow_topic", occurrence_count: workflows.length },
  };
}

function buildActivityViewsFromEvidence(evidenceViews: Array<ContextView | StoredContextView>, generatedAt: string, mergeGapMinutes: number): ContextView[] {
  const sorted = [...evidenceViews].sort((a, b) => Date.parse(observedAt(a)) - Date.parse(observedAt(b)));
  const groups: Array<Array<ContextView | StoredContextView>> = [];
  const active = new Map<string, Array<ContextView | StoredContextView>>();

  const flush = (key: string) => {
    const group = active.get(key);
    if (group?.length) groups.push(group);
    active.delete(key);
  };

  for (const view of sorted) {
    const key = activityGroupKey(view);
    if (!key) continue;
    const existing = active.get(key);
    if (!existing?.length) {
      active.set(key, [view]);
      continue;
    }
    const last = existing.at(-1)!;
    const gap = Date.parse(observedAt(view)) - Date.parse(observedAt(last));
    if (Number.isFinite(gap) && gap <= mergeGapMinutes * 60_000) existing.push(view);
    else {
      flush(key);
      active.set(key, [view]);
    }
  }
  for (const key of [...active.keys()]) flush(key);

  return groups.map(group => groupToActivityView(group, generatedAt));
}

function groupToActivityView(group: Array<ContextView | StoredContextView>, generatedAt: string): ContextView {
  const sorted = [...group].sort((a, b) => Date.parse(observedAt(a)) - Date.parse(observedAt(b)));
  const first = sorted[0];
  const last = sorted.at(-1) ?? first;
  const start = observedAt(first);
  const end = observedAt(last);
  const kind = activityKindForGroup(sorted);
  const resource = resourceOf(sorted);
  const app = top(sorted.map(view => subjectOf(view).app).filter(isString), 1)[0];
  const domain = top(sorted.map(view => subjectOf(view).domain).filter(isString), 1)[0];
  const project = top(sorted.map(view => subjectOf(view).project).filter(isString), 1)[0];
  const sourceViews = sorted.map(view => view.id).filter(isString);
  const sourceRecords = unique(sorted.flatMap(view => view.source_records ?? []));
  const fallbackTitle = [app, domain, project].filter(Boolean).join(" - ") || "Activity";
  const title = stringValue(resource?.title) ?? fallbackTitle;

  return {
    id: `activity:${kind}:${stableKey(`${sourceViews.join("|")}|${start}|${end}`)}`,
    view_type: "activity",
    title,
    summary: `${kind} from ${start} to ${end} using ${sourceViews.length} EvidenceViews.`,
    status: "candidate",
    source_records: sourceRecords,
    source_views: sourceViews,
    compiler: { id: ACTIVITY_VIEW_COMPILER_ID, version: "1", mode: "deterministic" },
    purpose: "Compress normalized EvidenceViews over time into what the user was doing.",
    scope: {
      app,
      domain,
      project,
      plugin_id: ACTIVITY_VIEW_COMPILER_ID,
      time_range: { start, end },
    },
    content: {
      kind,
      start,
      end,
      duration_minutes: durationMinutes(start, end, sorted),
      app,
      domain,
      project,
      resource,
      action: actionFor(kind),
      evidence_summary: summarizeEvidence(sorted),
    },
    confidence: confidenceForGroup(sorted, kind),
    stability: kind === "app_focus" ? "session" : "project",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: true, allow_llm_summary: true, allow_external_llm: false },
    metadata: { generated_at: generatedAt, evidence_view_count: sourceViews.length },
  };
}

function buildProposalView(activity: ContextView | StoredContextView, generatedAt: string): ContextView | undefined {
  const kind = stringValue(activity.content?.kind);
  const proposed: Array<Record<string, unknown>> = [];
  const resource = isRecord(activity.content?.resource) ? activity.content.resource : undefined;
  const domain = stringValue(resource?.domain) ?? stringValue(activity.content?.domain);
  const duration = numberValue(activity.content?.duration_minutes) ?? 0;

  if (kind === "resource_consumption" && resource) {
    const summary = isRecord(activity.content?.evidence_summary) ? activity.content.evidence_summary : {};
    const metrics = isRecord(summary.metrics) ? summary.metrics : {};
    const activeSeconds = numberValue(metrics.active_seconds_max) ?? numberValue(metrics.active_seconds_sum);
    const scrollEvents = numberValue(metrics.scroll_events_sum) ?? 0;
    const selectionCount = numberValue(metrics.selection_count_sum) ?? 0;
    const selectedTextLength = numberValue(metrics.selected_text_length_sum) ?? 0;
    const hasEngagement = activeSeconds === undefined
      ? duration >= 5
      : activeSeconds >= 15 || scrollEvents > 0 || selectionCount > 0 || selectedTextLength > 0;
    proposed.push({
      view_type: "resource",
      kind: learningDomain(domain) ? "learning_material" : "web_resource",
      priority: learningDomain(domain) ? 0.9 : 0.7,
      confidence: 0.85,
      cost: "low",
      decision: "materialize_now",
      reason: "continuous page activity with URL evidence",
    });
    proposed.push({
      view_type: "intent",
      kind: "candidate",
      priority: hasEngagement && duration >= 5 ? 0.72 : 0.35,
      confidence: hasEngagement && duration >= 5 ? 0.68 : 0.35,
      cost: "medium",
      decision: hasEngagement && duration >= 5 ? "defer_or_agent" : "defer",
      reason: hasEngagement ? "resource consumption may indicate a learning or research goal" : "page dwell without active browser engagement is weak evidence for intent",
    });
    proposed.push({
      view_type: "workflow",
      kind: learningDomain(domain) ? "learning_session" : "research_session",
      priority: hasEngagement && duration >= 10 ? 0.62 : 0.35,
      confidence: hasEngagement && duration >= 10 ? 0.58 : 0.35,
      cost: "medium",
      decision: hasEngagement && duration >= 10 ? "defer_or_agent" : "defer",
      reason: hasEngagement ? "workflow needs supporting notes, searches, chat, or repeated activity" : "workflow needs active engagement beyond passive page dwell",
    });
  }

  if (!proposed.length) return undefined;
  const start = stringValue(activity.content?.start) ?? activity.scope?.time_range?.start;
  const end = stringValue(activity.content?.end) ?? activity.scope?.time_range?.end;
  return {
    id: `proposal:view_proposal:${stableKey(`${activity.id}|${proposed.map(item => `${item.view_type}:${item.kind}`).join("|")}`)}`,
    view_type: "proposal",
    title: `View proposal: ${activity.title ?? kind ?? "activity"}`,
    summary: `ProposalView suggesting ${proposed.length} next View(s) from ActivityView ${activity.id}.`,
    status: "candidate",
    source_records: activity.source_records ?? [],
    source_views: activity.id ? [activity.id] : [],
    compiler: { id: PROPOSAL_VIEW_COMPILER_ID, version: "1", mode: "hybrid" },
    purpose: "Decide what Views should be materialized next from existing Views.",
    scope: {
      ...activity.scope,
      plugin_id: PROPOSAL_VIEW_COMPILER_ID,
      time_range: { start, end },
    },
    content: {
      kind: "view_proposal",
      hypothesis: proposalHypothesis(activity),
      scope: {
        start,
        end,
        apps: compactArray([stringValue(activity.content?.app)]),
        domains: compactArray([domain]),
      },
      proposed_views: proposed,
    },
    confidence: average(proposed.map(item => numberValue(item.confidence) ?? 0.5)),
    stability: "session",
    lossiness: "high",
    privacy: activity.privacy ?? { level: "private", retention: "normal", allow_external_llm: false },
    metadata: { generated_at: generatedAt, activity_kind: kind },
  };
}

function appendCompileEvent(store: ContextStore, compilerId: string, viewType: string, views: Array<ContextView | StoredContextView>, payload: Record<string, unknown>) {
  store.appendRuntimeEvent({
    event_type: "view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "view",
    plugin_id: compilerId,
    related_views: views.map(view => view.id).filter(Boolean) as string[],
    payload: { view_type: viewType, ...payload },
  });
}

function activityGroupKey(view: ContextView | StoredContextView): string | undefined {
  const kind = stringValue(view.content?.kind);
  const subject = subjectOf(view);
  if (kind === "page" && subject.url) return `page:${subject.url}`;
  if (kind === "focus") return `focus:${subject.app ?? ""}:${subject.window ?? ""}:${subject.url ?? ""}`;
  if (kind === "project" && subject.project) return `project:${subject.project}`;
  if (kind === "screen" || kind === "input" || kind === "selection") return `segment:${subject.app ?? ""}:${subject.domain ?? ""}:${subject.project ?? ""}`;
  return undefined;
}

function activityKindForGroup(group: Array<ContextView | StoredContextView>): string {
  const kinds = new Set(group.map(view => stringValue(view.content?.kind)));
  if (kinds.has("page")) return "resource_consumption";
  if (kinds.has("focus")) return "app_focus";
  if (kinds.has("project")) return "coding";
  return "segment";
}

function resourceOf(group: Array<ContextView | StoredContextView>): Record<string, unknown> | undefined {
  const page = group.find(view => stringValue(view.content?.kind) === "page" || stringValue(view.content?.kind) === "resource");
  if (!page) return undefined;
  const subject = subjectOf(page);
  if (!subject.url) return undefined;
  return {
    type: "url",
    url: subject.url,
    title: subject.title ?? page.title,
    domain: subject.domain,
  };
}

function summarizeEvidence(group: Array<ContextView | StoredContextView>): Record<string, unknown> {
  return {
    evidence_views: group.length,
    kinds: count(group.map(view => stringValue(view.content?.kind)).filter(isString)),
    origins: count(group.map(view => {
      const origin = isRecord(view.content?.origin) ? view.content.origin : {};
      return stringValue(origin.schema);
    }).filter(isString)),
    frame_ids: unique(group.flatMap(view => {
      const signals = isRecord(view.content?.signals) ? view.content.signals : {};
      return Array.isArray(signals.frame_ids) ? signals.frame_ids.map(String) : [];
    })).slice(0, 20),
    metrics: metricSummary(group),
  };
}

function metricSummary(group: Array<ContextView | StoredContextView>): Record<string, number> | undefined {
  const values = new Map<string, number[]>();
  for (const view of group) {
    const signals = isRecord(view.content?.signals) ? view.content.signals : {};
    const metrics = isRecord(signals.metrics) ? signals.metrics : {};
    for (const [key, value] of Object.entries(metrics)) {
      const numeric = numberValue(value);
      if (numeric === undefined) continue;
      values.set(key, [...(values.get(key) ?? []), numeric]);
    }
  }
  const out: Record<string, number> = {};
  for (const [key, nums] of values) {
    out[`${key}_sum`] = Number(nums.reduce((sum, value) => sum + value, 0).toFixed(2));
    out[`${key}_max`] = Number(Math.max(...nums).toFixed(2));
  }
  return Object.keys(out).length ? out : undefined;
}

function confidenceForGroup(group: Array<ContextView | StoredContextView>, kind: string): number {
  const base = average(group.map(view => typeof view.confidence === "number" ? view.confidence : 0.65));
  const bonus = kind === "resource_consumption" && group.length > 1 ? 0.04 : 0;
  return Math.min(0.98, Number((base + bonus).toFixed(2)));
}

function durationMinutes(start: string, end: string, group: Array<ContextView | StoredContextView>): number {
  const explicitSeconds = group
    .map(view => {
      const signals = isRecord(view.content?.signals) ? view.content.signals : {};
      return numberValue(signals.duration_seconds);
    })
    .filter((value): value is number => value !== undefined);
  const explicit = explicitSeconds.length ? Math.max(...explicitSeconds) / 60 : 0;
  const range = (Date.parse(end) - Date.parse(start)) / 60_000;
  if (Number.isFinite(range) && range > 0 && group.length > 1) return Number(range.toFixed(2));
  return Number(Math.max(explicit, Number.isFinite(range) ? range : 0).toFixed(2));
}

function boundedDurationMinutes(start?: string, end?: string, fallback?: number): number | undefined {
  const range = start && end ? (Date.parse(end) - Date.parse(start)) / 60_000 : undefined;
  if (range !== undefined && Number.isFinite(range) && range > 0) return Number(range.toFixed(2));
  return fallback !== undefined ? Number(fallback.toFixed(2)) : undefined;
}

function actionFor(kind: string): string {
  if (kind === "resource_consumption") return "watching_or_reading";
  if (kind === "app_focus") return "using_app";
  if (kind === "coding") return "working_in_project";
  return "working_or_browsing";
}

function proposalHypothesis(activity: ContextView | StoredContextView): string {
  const kind = stringValue(activity.content?.kind) ?? "activity";
  if (kind === "resource_consumption") return "This activity may be worth turning into a ResourceView, IntentView, or WorkflowView.";
  if (kind === "app_focus") return "This focus interval may support intent inference if combined with stronger evidence.";
  return "This activity may be useful as supporting context for a higher-level View.";
}

function learningDomain(domain?: string): boolean {
  if (!domain) return false;
  return /youtube\.com|coursera\.org|edx\.org|arxiv\.org|github\.com|docs\.|wikipedia\.org/i.test(domain);
}

function observedAt(view: ContextView | StoredContextView): string {
  const contentObserved = stringValue(view.content?.observed_at);
  return contentObserved ?? view.scope?.time_range?.start ?? ("created_at" in view ? view.created_at : new Date().toISOString());
}

function subjectOf(view: ContextView | StoredContextView): Record<string, string | undefined> {
  if (isRecord(view.content?.subject)) {
    return {
      app: stringValue(view.content.subject.app),
      title: stringValue(view.content.subject.title),
      window: stringValue(view.content.subject.window),
      url: stringValue(view.content.subject.url),
      domain: stringValue(view.content.subject.domain),
      path: stringValue(view.content.subject.path),
      project: stringValue(view.content.subject.project),
    };
  }
  return {
    app: stringValue(view.content?.app),
    title: stringValue(view.content?.title) ?? view.title,
    url: stringValue(view.content?.url),
    domain: stringValue(view.content?.domain),
    path: stringValue(view.content?.path),
    project: stringValue(view.content?.project),
  };
}

function sourceActivityOf(view: ContextView | StoredContextView, store: ContextStore): StoredContextView | undefined {
  const id = activityViewIdsOf(view)[0];
  return id ? store.getView(id) : undefined;
}

function activityViewIdsOf(view: ContextView | StoredContextView): string[] {
  return (view.source_views ?? []).filter(id => id.startsWith("activity:"));
}

function proposedViewsOf(proposal: ContextView | StoredContextView): Array<Record<string, unknown>> {
  const proposed = proposal.content?.proposed_views;
  return Array.isArray(proposed) ? proposed.filter(isRecord) : [];
}

function intentHypothesis(activity: ContextView | StoredContextView, domain: string | undefined, title: string): string {
  if (learningDomain(domain)) return `User may be studying or researching ${title}.`;
  if (stringValue(activity.content?.kind) === "coding") return `User may be working on project code related to ${title}.`;
  return `User may be trying to make progress on ${title}.`;
}

function supportingSignalsForIntent(activity: ContextView | StoredContextView, title: string, duration: number, domain: string | undefined): string[] {
  const signals = [
    `${duration || "some"} minutes of ${stringValue(activity.content?.action) ?? "activity"} around ${title}.`,
  ];
  if (domain) signals.push(`Domain observed: ${domain}.`);
  const summary = isRecord(activity.content?.evidence_summary) ? activity.content.evidence_summary : {};
  const evidenceViews = numberValue(summary.evidence_views);
  if (evidenceViews) signals.push(`${evidenceViews} EvidenceViews support this ActivityView.`);
  return signals;
}

function topicCandidatesForWorkflow(intent: ContextView | StoredContextView, activity: ContextView | StoredContextView, resources: Array<ContextView | StoredContextView>): string[] {
  const resourceTitles = resources.map(view => {
    const resource = isRecord(view.content?.resource) ? view.content.resource : {};
    return stringValue(resource.title);
  }).filter(isString);
  const activityResource = isRecord(activity.content?.resource) ? activity.content.resource : {};
  const domain = stringValue(activityResource.domain) ?? stringValue(activity.content?.domain);
  const title = stringValue(activityResource.title) ?? activity.title;
  const hypothesis = stringValue(intent.content?.hypothesis);
  return unique([...resourceTitles, title, domain, ...keywordsFromText(hypothesis)].filter(isString)).slice(0, 8);
}

function phasesForWorkflow(activity: ContextView | StoredContextView, resources: Array<ContextView | StoredContextView>): string[] {
  const phases = [];
  const action = stringValue(activity.content?.action);
  if (action === "watching_or_reading") phases.push("watched_or_read resource");
  else if (action === "working_in_project") phases.push("worked in project");
  else if (action) phases.push(action);
  if (resources.length) phases.push("materialized resource context");
  phases.push("formed intent hypothesis");
  return phases;
}

function openQuestionsForWorkflow(kind: string, intent: ContextView | StoredContextView): string[] {
  const questions = ["Should this workflow become durable memory?"];
  if (kind === "learning_session") questions.push("Which concepts from this learning session should be retained?");
  const counter = intent.content?.counter_signals;
  if (Array.isArray(counter) && counter.length) questions.push("What explicit user signal would confirm the inferred intent?");
  return questions;
}

function workflowTitle(kind: string, topics: string[], activity: ContextView | StoredContextView): string {
  const prefix = kind === "learning_session" ? "Learning session" : kind === "coding_session" ? "Coding session" : "Research session";
  return `${prefix}: ${topics[0] ?? activity.title ?? "activity"}`;
}

function topicCandidatesOf(workflow: ContextView | StoredContextView): string[] {
  const topics = workflow.content?.topic_candidates;
  return Array.isArray(topics) ? topics.filter(isString) : [];
}

function normalizedTopic(topic: string): string {
  return topic.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim().slice(0, 80);
}

function bestTopicLabel(topic: string, workflows: Array<ContextView | StoredContextView>): string {
  for (const workflow of workflows) {
    const match = topicCandidatesOf(workflow).find(candidate => normalizedTopic(candidate) === topic);
    if (match) return match;
  }
  return topic;
}

function keywordsFromText(text?: string): string[] {
  if (!text) return [];
  const matches = text.match(/[A-Za-z][A-Za-z0-9-]{4,}/g) ?? [];
  return unique(matches.map(value => value.toLowerCase())).slice(0, 4);
}

function uniqueById<T extends ContextView | StoredContextView>(views: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const view of views) {
    const key = view.id ?? stableKey(JSON.stringify(view));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(view);
  }
  return out;
}

function count(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function top(values: string[], limit: number): string[] {
  return Object.entries(count(values)).sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}

function compactArray(values: Array<string | undefined>): string[] {
  return values.filter(isString);
}

function normalizeResourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

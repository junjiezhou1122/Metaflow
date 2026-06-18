import { createHash } from "node:crypto";
import type { ContextStore, RuntimeEvent, StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const VIEW_PROMOTION_ENGINE_PROCESSOR_ID = "processor.view_promotion_engine";
export const VIEW_PROMOTION_CANDIDATES_VIEW_TYPE = "view.promotion_candidates";

export type ViewPromotionEngineOptions = {
  windowMinutes?: number;
  recordLimit?: number;
  viewLimit?: number;
  eventLimit?: number;
  now?: Date;
};

type PromotionCandidate = {
  id: string;
  action: "create_view" | "update_view" | "combine_views" | "retire_view" | "create_processor";
  target_view_type?: string;
  target_processor_id?: string;
  source_view_ids?: string[];
  source_record_ids?: string[];
  evidence_event_ids?: string[];
  priority: "low" | "medium" | "high";
  reason: string;
  expected_future_task: string;
  expected_search_reduction: string;
  suggested_cli?: string;
};

type EvidenceWindow = {
  records: StoredContextRecord[];
  views: StoredContextView[];
  events: ReturnType<ContextStore["listRuntimeEvents"]>;
};

export function createViewPromotionEngineProcessor(options: ViewPromotionEngineOptions = {}): ProcessorDefinition {
  return {
    id: VIEW_PROMOTION_ENGINE_PROCESSOR_ID,
    title: "View Promotion Engine",
    version: "0.1.0",
    description: "Discovers task-specific ViewGraph evolution opportunities from recent observations, Views, and runtime outcomes.",
    consumes: {
      observations: ["observation.*", "feedback.*"],
      views: ["*"],
    },
    produces: { views: [VIEW_PROMOTION_CANDIDATES_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
    handler: viewPromotionEngineHandler(options),
  };
}

export function viewPromotionEngineHandler(options: ViewPromotionEngineOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const windowMinutes = options.windowMinutes ?? 12 * 60;
    const evidence = collectEvidenceWindow(context.store, { ...options, windowMinutes, now });
    const candidates = dedupeCandidates([
      ...taskClusterCandidates(evidence),
      ...viewCombinationCandidates(evidence),
      ...retirementCandidates(evidence, now),
      ...processorGapCandidates(evidence),
    ]);
    const view = buildPromotionCandidatesView(evidence, candidates, now, windowMinutes);
    return {
      views: [view],
      diagnostics: {
        records_scanned: evidence.records.length,
        views_scanned: evidence.views.length,
        events_scanned: evidence.events.length,
        candidate_count: candidates.length,
        algorithm: "view-promotion-engine-v1",
      },
    };
  };
}

function collectEvidenceWindow(
  store: ContextStore,
  options: Required<Pick<ViewPromotionEngineOptions, "windowMinutes" | "now">> & ViewPromotionEngineOptions,
): EvidenceWindow {
  const timeWindow = {
    start_time: new Date(options.now.getTime() - options.windowMinutes * 60_000).toISOString(),
    end_time: options.now.toISOString(),
    minutes: options.windowMinutes,
  };
  return {
    records: store.recent(options.recordLimit ?? 240, undefined, timeWindow)
      .filter(record => record.privacy?.retention !== "do_not_store" && record.privacy?.level !== "secret"),
    views: store.listViews({ active_only: false, limit: options.viewLimit ?? 160, timeWindow })
      .filter(view => view.privacy?.retention !== "do_not_store" && view.privacy?.level !== "secret"),
    events: store.listRuntimeEvents({ limit: options.eventLimit ?? 160, timeWindow }),
  };
}

function taskClusterCandidates(evidence: EvidenceWindow): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];
  const routeRecords = evidence.records.filter(record => record.schema.name === "observation.route_candidate");
  const routeGroups = new Map<string, StoredContextRecord[]>();
  for (const record of routeRecords) {
    for (const route of arrayRecords(record.payload?.candidate_routes)) {
      const key = stringValue(route.route_key);
      if (!key) continue;
      const group = routeGroups.get(key) ?? [];
      group.push(record);
      routeGroups.set(key, group);
    }
  }
  for (const [routeKey, records] of routeGroups) {
    if (records.length < 3) continue;
    const targetViewType = routeKey.startsWith("project:") ? "project.current" : routeKey.startsWith("topic:") ? "research.brief" : "work.focus_set";
    if (hasFreshView(evidence.views, targetViewType, routeKey)) continue;
    candidates.push({
      id: candidateId("create_view", targetViewType, routeKey),
      action: "create_view",
      target_view_type: targetViewType,
      source_record_ids: records.map(record => record.id).slice(0, 12),
      priority: records.length >= 6 ? "high" : "medium",
      reason: `Repeated route cluster ${routeKey} appeared ${records.length} times without a fresh matching ${targetViewType} View.`,
      expected_future_task: routeKey.startsWith("project:") ? "Resume project work without reconstructing active context." : "Restart the recurring topic from a compressed brief.",
      expected_search_reduction: "Avoid scanning raw observations for the same route cluster.",
      suggested_cli: `pnpm mf --json processor run ${VIEW_PROMOTION_ENGINE_PROCESSOR_ID} --record ${records[0]?.id}`,
    });
  }
  return candidates;
}

function viewCombinationCandidates(evidence: EvidenceWindow): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];
  const activeTypes = new Set(evidence.views.filter(view => activeView(view)).map(view => view.view_type));
  if (activeTypes.has("work.focus_set") && activeTypes.has("project.current") && !activeTypes.has("memory.daily")) {
    candidates.push({
      id: candidateId("combine_views", "memory.daily", [...activeTypes].sort().join("|")),
      action: "combine_views",
      target_view_type: "memory.daily",
      source_view_ids: evidence.views.filter(view => view.view_type === "work.focus_set" || view.view_type === "project.current").map(view => view.id).slice(0, 8),
      priority: "medium",
      reason: "Recent work focus and project context exist, but no active daily memory View is present.",
      expected_future_task: "Restore today's project state and decisions without re-reading raw conversations.",
      expected_search_reduction: "Compress project/focus Views into one durable daily state.",
      suggested_cli: "pnpm mf --json memory daily sync",
    });
  }
  const failedEvents = evidence.events.filter(event => event.status === "failed" || /failed|denied/.test(event.event_type));
  if (failedEvents.length >= 2 && !activeTypes.has("research.failure")) {
    candidates.push({
      id: candidateId("create_view", "research.failure", failedEvents.map(event => event.event_type).join("|")),
      action: "create_view",
      target_view_type: "research.failure",
      evidence_event_ids: failedEvents.map(event => event.id).slice(0, 10),
      priority: "high",
      reason: `Observed ${failedEvents.length} failed or denied runtime events without a failure View.`,
      expected_future_task: "Avoid repeating failed agent/browser/tool paths.",
      expected_search_reduction: "Start debugging from a failure coordinate system instead of event logs.",
    });
  }
  return candidates;
}

function retirementCandidates(evidence: EvidenceWindow, now: Date): PromotionCandidate[] {
  return evidence.views
    .filter(view => activeView(view))
    .filter(view => staleView(view, now))
    .slice(0, 12)
    .map(view => ({
      id: candidateId("retire_view", view.view_type, view.id),
      action: "retire_view" as const,
      target_view_type: view.view_type,
      source_view_ids: [view.id],
      priority: view.stability === "ephemeral" ? "medium" as const : "low" as const,
      reason: `${view.view_type} has not been updated recently and may no longer reduce future search.`,
      expected_future_task: "Keep active ViewGraph small enough for agents to choose the right Views.",
      expected_search_reduction: "Reduce stale View clutter in state and app surfaces.",
      suggested_cli: `pnpm mf --json view delete ${view.id} --reason "stale promotion candidate"`,
    }));
}

function processorGapCandidates(evidence: EvidenceWindow): PromotionCandidate[] {
  const produced = new Set(evidence.views.map(view => view.view_type));
  const candidates: PromotionCandidate[] = [];
  const feedback = evidence.records.filter(record => record.schema.name.startsWith("feedback."));
  if (feedback.length >= 2 && !produced.has("memory.preferences") && !produced.has("memory.profile")) {
    candidates.push({
      id: candidateId("create_processor", "processor.memory_profile_update", feedback.map(record => record.schema.name).join("|")),
      action: "create_processor",
      target_processor_id: "processor.memory_profile_update",
      target_view_type: "memory.profile",
      source_record_ids: feedback.map(record => record.id).slice(0, 10),
      priority: "medium",
      reason: "Repeated feedback observations exist, but no preference/profile memory View has been produced in this window.",
      expected_future_task: "Adapt future agent behavior to user edits, dismissals, and accepted outputs.",
      expected_search_reduction: "Avoid rediscovering collaboration preferences from raw feedback.",
    });
  }
  const failures = evidence.events.filter(event => event.status === "failed" || /failed|denied/.test(event.event_type));
  if (failures.length >= 2 && !produced.has("research.failure")) {
    candidates.push({
      id: candidateId("create_processor", "processor.failure_miner", failures.map(event => event.event_type).join("|")),
      action: "create_processor",
      target_processor_id: "processor.failure_miner",
      target_view_type: "research.failure",
      evidence_event_ids: failures.map(event => event.id).slice(0, 10),
      priority: "high",
      reason: "Failure evidence is recurring, but no processor is producing a task-specific failure View.",
      expected_future_task: "Debug agents and browser automations without repeating known failures.",
      expected_search_reduction: "Compress failure events into reusable causal/failure memory.",
    });
  }
  return candidates;
}

function buildPromotionCandidatesView(
  evidence: EvidenceWindow,
  candidates: PromotionCandidate[],
  now: Date,
  windowMinutes: number,
): ViewDraft {
  const sourceRecords = unique(candidates.flatMap(candidate => candidate.source_record_ids ?? [])).slice(0, 40);
  const sourceViews = unique(candidates.flatMap(candidate => candidate.source_view_ids ?? [])).slice(0, 40);
  return {
    id: `view:promotion-candidates:${stableKey(`${now.toISOString()}:${sourceRecords.join("|")}:${sourceViews.join("|")}:${candidates.map(candidate => candidate.id).join("|")}`)}`,
    type: VIEW_PROMOTION_CANDIDATES_VIEW_TYPE,
    title: `View promotion candidates (${candidates.length})`,
    summary: candidates.length
      ? `${candidates.length} ViewGraph evolution candidates from recent task-discovery evidence.`
      : "No ViewGraph evolution candidates detected in the current window.",
    status: "candidate",
    source_records: sourceRecords,
    source_views: sourceViews,
    purpose: "Task-discovery and View Promotion Engine output for adaptive memory evolution.",
    content: {
      generated_at: now.toISOString(),
      window_minutes: windowMinutes,
      candidate_count: candidates.length,
      candidates,
      counts: {
        by_action: countBy(candidates, candidate => candidate.action),
        by_priority: countBy(candidates, candidate => candidate.priority),
      },
      scanned: {
        records: evidence.records.length,
        views: evidence.views.length,
        events: evidence.events.length,
      },
    },
    stability: "session",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_external_llm: false, allow_external_reader: false },
    metadata: {
      task_discovery: true,
      view_promotion_engine: true,
      algorithm: "view-promotion-engine-v1",
    },
  };
}

function hasFreshView(views: StoredContextView[], viewType: string, routeKey: string): boolean {
  return views.some(view => {
    if (view.view_type !== viewType || !activeView(view)) return false;
    const haystack = JSON.stringify([view.scope, view.title, view.summary, view.content]).toLowerCase();
    return haystack.includes(routeKey.toLowerCase()) || haystack.includes(routeKey.replace(/^[^:]+:/, "").toLowerCase());
  });
}

function staleView(view: StoredContextView, now: Date): boolean {
  const ageMs = now.getTime() - Date.parse(view.updated_at);
  const hour = 60 * 60 * 1000;
  if (view.stability === "ephemeral") return ageMs > hour;
  if (view.stability === "session") return ageMs > 24 * hour;
  return false;
}

function activeView(view: StoredContextView): boolean {
  return view.status !== "archived" && view.status !== "rejected";
}

function dedupeCandidates(candidates: PromotionCandidate[]): PromotionCandidate[] {
  const byId = new Map<string, PromotionCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.id);
    if (!current || priorityRank(candidate.priority) > priorityRank(current.priority)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.action.localeCompare(b.action));
}

function priorityRank(priority: PromotionCandidate["priority"]): number {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function candidateId(action: string, target: string, evidence: string): string {
  return `${action}:${target}:${stableKey(evidence)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}


import { createHash } from "node:crypto";
import {
  chatCompletion,
  ContextStore,
  parseJsonObject,
  type ContextView,
  type LlmOptions,
  type StoredContextRecord,
  type StoredContextView,
} from "@info/core";

export const SCHEDULED_AI_BATCH_PROCESSOR_ID = "processor.scheduled_ai_batch";
export const SCHEDULED_AI_BATCH_VIEW_TYPE = "work.ai_batch_suggestions";

export type ScheduledAiBatchMode = "on_demand" | "scheduled";

export type ScheduledAiBatchOptions = {
  mode?: ScheduledAiBatchMode;
  minutes?: number;
  limit?: number;
  write?: boolean;
  now?: Date;
  records?: StoredContextRecord[];
  focusSetViews?: StoredContextView[];
  llm?: LlmOptions;
  use_llm?: boolean;
  batch_id?: string;
};

export type WorkBatchItemKind = "main_work" | "interruption";

export type WorkBatchItem = {
  item_id: string;
  kind: WorkBatchItemKind;
  label: string;
  confidence: number;
  reasons: string[];
  source_record_ids: string[];
  route_keys: string[];
  suggested_action: string;
};

export type ScheduledAiBatchResult = {
  ok: true;
  mode: ScheduledAiBatchMode;
  generated_at: string;
  dry_run: boolean;
  view: ContextView | StoredContextView;
  views_written: string[];
  records_scanned: number;
  route_candidates_used: number;
  focus_sets_used: number;
  main_work: WorkBatchItem[];
  interruptions: WorkBatchItem[];
  suggestions: string[];
  diagnostics: Record<string, unknown>;
};

type BatchCandidate = {
  source_record_id: string;
  record: StoredContextRecord;
  route_keys: string[];
  route_scores: Array<{ route_key: string; lane_kind?: string; score: number; rule_hits: string[] }>;
};

type LlmClassification = {
  main_work_ids?: string[];
  interruption_ids?: string[];
  suggestions?: string[];
  confidence_by_id?: Record<string, number>;
  reason_by_id?: Record<string, string>;
};

export async function runScheduledAiBatch(
  options: ScheduledAiBatchOptions = {},
  store = new ContextStore(),
): Promise<ScheduledAiBatchResult> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const minutes = options.minutes ?? 90;
  const limit = options.limit ?? 160;
  const write = options.write ?? true;
  const mode = options.mode ?? "on_demand";
  const records = collectBatchRecords(options, store, now, minutes, limit);
  const focusSets = collectFocusSets(options, store, minutes);
  const routeCandidates = records.filter(record => record.schema.name === "observation.route_candidate").slice(0, limit);
  const rawObservations = records.filter(record => record.schema.name !== "observation.route_candidate");
  const candidates = buildBatchCandidates(rawObservations, routeCandidates);
  const focusRouteKeys = activeFocusRouteKeys(focusSets);
  const deterministic = classifyDeterministically(candidates, focusRouteKeys);
  const llmAttempted = Boolean(options.use_llm ?? options.llm);
  const llm = llmAttempted
    ? await classifyWithLlm(candidates, focusSets, options.llm)
    : { ok: false as const, skipped: true, error: "llm_not_configured" };
  const classification = llm.ok ? mergeLlmClassification(deterministic, llm.classification) : deterministic;
  const suggestions = buildSuggestions(classification.main_work, classification.interruptions, llm.ok ? llm.classification.suggestions : undefined);
  const batchId = options.batch_id ?? stableBatchId(generatedAt, records, focusSets);
  const view = buildBatchView({
    batchId,
    generatedAt,
    mode,
    minutes,
    records,
    routeCandidates,
    focusSets,
    mainWork: classification.main_work,
    interruptions: classification.interruptions,
    suggestions,
    llm: {
      attempted: llmAttempted,
      ok: llm.ok,
      error: llm.ok ? undefined : llm.error,
      model: llm.ok ? llm.model : undefined,
      base_url: llm.ok ? llm.base_url : undefined,
    },
  });
  const stored = write ? store.upsertView(view) : view;
  const storedId = stored.id ?? view.id ?? `${SCHEDULED_AI_BATCH_VIEW_TYPE}:${batchId}`;
  if (write) {
    store.appendRuntimeEvent({
      event_type: "scheduled_ai_batch.completed",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: storedId,
      plugin_id: SCHEDULED_AI_BATCH_PROCESSOR_ID,
      related_records: view.source_records,
      related_views: view.source_views,
      payload: {
        mode,
        batch_id: batchId,
        records_scanned: records.length,
        route_candidates_used: routeCandidates.length,
        focus_sets_used: focusSets.length,
        main_work_count: classification.main_work.length,
        interruption_count: classification.interruptions.length,
        llm_attempted: llmAttempted,
        llm_ok: llm.ok,
      },
    });
  }

  return {
    ok: true,
    mode,
    generated_at: generatedAt,
    dry_run: !write,
    view: stored,
    views_written: write ? [storedId] : [],
    records_scanned: records.length,
    route_candidates_used: routeCandidates.length,
    focus_sets_used: focusSets.length,
    main_work: classification.main_work,
    interruptions: classification.interruptions,
    suggestions,
    diagnostics: {
      algorithm: "scheduled-ai-batch-hybrid-v1",
      deterministic_fallback: !llm.ok,
      llm_attempted: llmAttempted,
      llm_ok: llm.ok,
      llm_error: llm.ok ? undefined : llm.error,
      candidate_count: candidates.length,
      focus_route_keys: [...focusRouteKeys],
      view_id: storedId,
    },
  };
}

function collectBatchRecords(
  options: ScheduledAiBatchOptions,
  store: ContextStore,
  now: Date,
  minutes: number,
  limit: number,
): StoredContextRecord[] {
  const records = options.records ?? store.recent(Math.max(limit * 2, 120), undefined, {
    start_time: new Date(now.getTime() - minutes * 60_000).toISOString(),
    end_time: now.toISOString(),
    minutes,
  });
  return records
    .filter(record => record.privacy?.retention !== "do_not_store" && record.privacy?.level !== "secret")
    .slice(0, Math.max(limit * 2, limit));
}

function collectFocusSets(options: ScheduledAiBatchOptions, store: ContextStore, minutes: number): StoredContextView[] {
  return (options.focusSetViews ?? store.listViews({
    view_types: ["work.focus_set"],
    active_only: true,
    limit: 5,
    timeWindow: { minutes: Math.max(minutes, 240) },
  })).slice(0, 5);
}

function buildBatchCandidates(rawObservations: StoredContextRecord[], routeCandidates: StoredContextRecord[]): BatchCandidate[] {
  const routesBySource = new Map<string, StoredContextRecord[]>();
  for (const routeCandidate of routeCandidates) {
    const sourceIds = [
      stringValue(routeCandidate.payload?.source_observation_id),
      ...(routeCandidate.relations?.derived_from ?? []),
    ].filter((id): id is string => Boolean(id));
    for (const id of sourceIds) {
      const existing = routesBySource.get(id) ?? [];
      existing.push(routeCandidate);
      routesBySource.set(id, existing);
    }
  }
  return rawObservations
    .map(record => {
      const routeScores = (routesBySource.get(record.id) ?? []).flatMap(routeCandidate =>
        arrayRecords(routeCandidate.payload?.candidate_routes).map(route => ({
          route_key: stringValue(route.route_key) ?? "",
          lane_kind: stringValue(route.lane_kind),
          score: numberValue(route.score) ?? 0,
          rule_hits: arrayStrings(route.rule_hits),
        })).filter(route => route.route_key),
      );
      return {
        source_record_id: record.id,
        record,
        route_keys: unique(routeScores.map(route => route.route_key)),
        route_scores: routeScores,
      };
    })
    .filter(candidate => candidate.route_scores.length || candidate.record.content?.title || candidate.record.content?.text);
}

function activeFocusRouteKeys(focusSets: StoredContextView[]): Set<string> {
  const keys = new Set<string>();
  for (const focusSet of focusSets) {
    for (const lane of arrayRecords(focusSet.content?.active_lanes)) {
      const key = stringValue(lane.lane_key);
      const kind = stringValue(lane.lane_kind);
      if (key && kind !== "communication" && kind !== "app" && kind !== "browser") keys.add(key);
    }
  }
  return keys;
}

function classifyDeterministically(candidates: BatchCandidate[], focusRouteKeys: Set<string>): { main_work: WorkBatchItem[]; interruptions: WorkBatchItem[] } {
  const main: WorkBatchItem[] = [];
  const interruptions: WorkBatchItem[] = [];
  for (const candidate of candidates) {
    const best = candidate.route_scores.slice().sort((a, b) => b.score - a.score)[0];
    const matchingFocus = candidate.route_keys.filter(key => focusRouteKeys.has(key));
    const communication = candidate.route_scores.some(route => route.lane_kind === "communication" || route.route_key.startsWith("communication:"));
    const generalAppOnly = candidate.route_scores.length > 0 && candidate.route_scores.every(route => route.lane_kind === "app" || route.lane_kind === "browser");
    const mainScore = Math.max(
      matchingFocus.length ? 0.8 : 0,
      best?.lane_kind === "project" ? (best.score >= 0.45 ? 0.68 : 0.5) : 0,
      best?.lane_kind === "topic" && matchingFocus.length ? 0.6 : 0,
    );
    const interruptionScore = Math.max(
      communication ? 0.76 : 0,
      generalAppOnly && !matchingFocus.length ? 0.56 : 0,
      !candidate.route_scores.length ? 0.4 : 0,
    );
    const kind: WorkBatchItemKind = mainScore >= interruptionScore ? "main_work" : "interruption";
    const confidence = clamp(Math.max(mainScore, interruptionScore, best?.score ?? 0.35));
    const item: WorkBatchItem = {
      item_id: candidate.source_record_id,
      kind,
      label: labelForCandidate(candidate),
      confidence,
      reasons: reasonsForCandidate(candidate, matchingFocus, communication, kind),
      source_record_ids: [candidate.source_record_id],
      route_keys: candidate.route_keys,
      suggested_action: kind === "main_work" ? "keep_in_focus" : "defer_or_summarize",
    };
    if (kind === "main_work") main.push(item);
    else interruptions.push(item);
  }
  return {
    main_work: main.sort((a, b) => b.confidence - a.confidence).slice(0, 16),
    interruptions: interruptions.sort((a, b) => b.confidence - a.confidence).slice(0, 16),
  };
}

async function classifyWithLlm(
  candidates: BatchCandidate[],
  focusSets: StoredContextView[],
  llm?: LlmOptions,
): Promise<
  | { ok: true; classification: LlmClassification; model: string; base_url: string }
  | { ok: false; skipped?: boolean; error: string }
> {
  if (!llm) return { ok: false, skipped: true, error: "llm_not_configured" };
  const response = await chatCompletion([
    {
      role: "system",
      content: "Classify recent user activity into main work versus interruptions. Return only JSON.",
    },
    {
      role: "user",
      content: JSON.stringify({
        expected_schema: {
          main_work_ids: ["record id"],
          interruption_ids: ["record id"],
          suggestions: ["short action"],
          confidence_by_id: { "record id": 0.8 },
          reason_by_id: { "record id": "short reason" },
        },
        focus_sets: focusSets.map(view => ({ id: view.id, title: view.title, active_lanes: view.content?.active_lanes })),
        candidates: candidates.slice(0, 60).map(candidate => ({
          id: candidate.source_record_id,
          schema: candidate.record.schema.name,
          title: candidate.record.content?.title,
          text: candidate.record.content?.text?.slice(0, 500),
          scope: candidate.record.scope,
          route_keys: candidate.route_keys,
          route_scores: candidate.route_scores,
        })),
      }),
    },
  ], {
    ...llm,
    temperature: llm.temperature ?? 0.1,
    max_tokens: llm.max_tokens ?? 900,
  });
  if (!response.ok || !response.content) return { ok: false, error: response.error ?? "llm_failed" };
  const parsed = parseJsonObject(response.content);
  if (!parsed) return { ok: false, error: "llm_invalid_json" };
  return {
    ok: true,
    classification: {
      main_work_ids: arrayStrings(parsed.main_work_ids),
      interruption_ids: arrayStrings(parsed.interruption_ids),
      suggestions: arrayStrings(parsed.suggestions),
      confidence_by_id: recordOfNumbers(parsed.confidence_by_id),
      reason_by_id: recordOfStrings(parsed.reason_by_id),
    },
    model: response.model,
    base_url: response.base_url,
  };
}

function mergeLlmClassification(
  deterministic: { main_work: WorkBatchItem[]; interruptions: WorkBatchItem[] },
  llm: LlmClassification,
): { main_work: WorkBatchItem[]; interruptions: WorkBatchItem[] } {
  const all = new Map([...deterministic.main_work, ...deterministic.interruptions].map(item => [item.item_id, item]));
  const mainIds = new Set(llm.main_work_ids ?? []);
  const interruptionIds = new Set(llm.interruption_ids ?? []);
  const main: WorkBatchItem[] = [];
  const interruptions: WorkBatchItem[] = [];
  for (const item of all.values()) {
    const llmReason = llm.reason_by_id?.[item.item_id];
    const confidence = clamp(llm.confidence_by_id?.[item.item_id] ?? item.confidence);
    if (mainIds.has(item.item_id) && !interruptionIds.has(item.item_id)) {
      main.push({ ...item, kind: "main_work", confidence, reasons: llmReason ? [llmReason, ...item.reasons] : item.reasons, suggested_action: "keep_in_focus" });
    } else if (interruptionIds.has(item.item_id) && !mainIds.has(item.item_id)) {
      interruptions.push({ ...item, kind: "interruption", confidence, reasons: llmReason ? [llmReason, ...item.reasons] : item.reasons, suggested_action: "defer_or_summarize" });
    } else if (item.kind === "main_work") {
      main.push(item);
    } else {
      interruptions.push(item);
    }
  }
  return {
    main_work: main.sort((a, b) => b.confidence - a.confidence).slice(0, 16),
    interruptions: interruptions.sort((a, b) => b.confidence - a.confidence).slice(0, 16),
  };
}

function buildSuggestions(mainWork: WorkBatchItem[], interruptions: WorkBatchItem[], llmSuggestions: string[] = []): string[] {
  return unique([
    ...llmSuggestions,
    mainWork[0] ? `Keep focus on ${mainWork[0].label}.` : "No clear main work lane found.",
    interruptions.length ? `Defer ${interruptions.length} interruption${interruptions.length === 1 ? "" : "s"} unless explicitly requested.` : "No major interruptions detected.",
  ]).slice(0, 8);
}

function buildBatchView(input: {
  batchId: string;
  generatedAt: string;
  mode: ScheduledAiBatchMode;
  minutes: number;
  records: StoredContextRecord[];
  routeCandidates: StoredContextRecord[];
  focusSets: StoredContextView[];
  mainWork: WorkBatchItem[];
  interruptions: WorkBatchItem[];
  suggestions: string[];
  llm: Record<string, unknown>;
}): ContextView {
  const start = new Date(Date.parse(input.generatedAt) - input.minutes * 60_000).toISOString();
  const sourceRecords = unique([
    ...input.records.map(record => record.id),
    ...input.routeCandidates.map(record => record.id),
    ...input.mainWork.flatMap(item => item.source_record_ids),
    ...input.interruptions.flatMap(item => item.source_record_ids),
  ]).slice(0, 120);
  const sourceViews = input.focusSets.map(view => view.id);
  const mainLabel = input.mainWork[0]?.label;
  return {
    id: `${SCHEDULED_AI_BATCH_VIEW_TYPE}:${input.batchId}`,
    view_type: SCHEDULED_AI_BATCH_VIEW_TYPE,
    title: mainLabel ? `AI batch: ${mainLabel}` : "AI batch: no main work",
    summary: `${input.mainWork.length} main work item(s), ${input.interruptions.length} interruption(s).`,
    status: input.mainWork.length || input.interruptions.length ? "candidate" : "archived",
    source_records: sourceRecords,
    source_views: sourceViews,
    compiler: { id: SCHEDULED_AI_BATCH_PROCESSOR_ID, version: "0.0.1", mode: input.llm.ok ? "hybrid" : "deterministic" },
    purpose: "Scheduled/on-demand AI batch classification of recent activity into main work and interruptions.",
    scope: { time_range: { start, end: input.generatedAt }, project: projectFromItems(input.mainWork) },
    content: {
      mode: input.mode,
      generated_at: input.generatedAt,
      main_work: input.mainWork,
      interruptions: input.interruptions,
      suggestions: input.suggestions,
      counts: {
        records_scanned: input.records.length,
        route_candidates_used: input.routeCandidates.length,
        focus_sets_used: input.focusSets.length,
      },
    },
    confidence: input.mainWork[0]?.confidence ?? input.interruptions[0]?.confidence ?? 0.25,
    stability: "session",
    lossiness: input.llm.ok ? "medium" : "low",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    validity: { valid_from: start, stale_after: new Date(Date.parse(input.generatedAt) + 30 * 60_000).toISOString() },
    metadata: {
      algorithm: "scheduled-ai-batch-hybrid-v1",
      batch_id: input.batchId,
      llm: input.llm,
    },
  };
}

function labelForCandidate(candidate: BatchCandidate): string {
  return candidate.record.content?.title
    ?? candidate.record.scope?.project
    ?? candidate.route_keys[0]?.replace(/^(project|topic|domain|app|repo|communication):/, "")
    ?? candidate.record.schema.name;
}

function reasonsForCandidate(candidate: BatchCandidate, matchingFocus: string[], communication: boolean, kind: WorkBatchItemKind): string[] {
  const reasons = [];
  if (matchingFocus.length) reasons.push(`matches active focus: ${matchingFocus.slice(0, 3).join(", ")}`);
  if (communication) reasons.push("communication activity");
  if (candidate.route_scores.some(route => route.lane_kind === "project")) reasons.push("project route candidate");
  if (!reasons.length) reasons.push(kind === "main_work" ? "highest route score" : "outside active focus");
  return reasons;
}

function stableBatchId(generatedAt: string, records: StoredContextRecord[], views: StoredContextView[]): string {
  const bucket = generatedAt.slice(0, 16);
  return createHash("sha1")
    .update(JSON.stringify({
      bucket,
      records: records.map(record => record.id).sort(),
      views: views.map(view => view.id).sort(),
    }))
    .digest("hex")
    .slice(0, 16);
}

function projectFromItems(items: WorkBatchItem[]): string | undefined {
  const route = items.flatMap(item => item.route_keys).find(key => key.startsWith("project:"));
  return route?.replace(/^project:/, "").split("/").filter(Boolean).at(-1);
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(recordValue(item))) : [];
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordOfNumbers(value: unknown): Record<string, number> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

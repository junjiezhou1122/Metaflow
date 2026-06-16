import { createHash } from "node:crypto";
import { ContextStore, type ContextView, type StoredContextRecord, type StoredContextView } from "@info/core";

export const WORK_FOCUS_SET_VIEW_TYPE = "work.focus_set";
export const WORK_FOCUS_SET_COMPILER_ID = "processor.work_router_batch";

export type CompileWorkFocusSetOptions = {
  minutes?: number;
  limit?: number;
  write?: boolean;
  records?: StoredContextRecord[];
  now?: Date;
  llm?: unknown;
};

export type WorkFocusLane = {
  lane_key: string;
  lane_kind: string;
  label: string;
  attention_share: number;
  confidence: number;
  source_records: string[];
  candidate_route_ids: string[];
  route_scores: Array<{ route_key: string; score: number; rule_hits: string[] }>;
  evidence: Record<string, unknown>;
  last_seen_at?: string;
};

export type CompileWorkFocusSetResult = {
  ok: true;
  generated_at: string;
  view: ContextView | StoredContextView;
  active_lanes: WorkFocusLane[];
  records_scanned: number;
  route_candidates_used: number;
  diagnostics: Record<string, unknown>;
};

type LaneAccumulator = {
  lane_key: string;
  lane_kind: string;
  score: number;
  source_records: Set<string>;
  candidate_route_ids: Set<string>;
  route_scores: Array<{ route_key: string; score: number; rule_hits: string[] }>;
  evidence: Record<string, unknown>;
  last_seen_at?: string;
};

export function compileWorkFocusSet(options: CompileWorkFocusSetOptions = {}, store = new ContextStore()): CompileWorkFocusSetResult {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const minutes = options.minutes ?? 90;
  const candidateLimit = options.records ? options.limit ?? options.records.length : Math.max((options.limit ?? 160) * 2, 120);
  const allRecords = (options.records ?? store.recent(candidateLimit, undefined, {
    start_time: new Date(now.getTime() - minutes * 60_000).toISOString(),
    end_time: generatedAt,
    minutes,
  })).filter(record => record.privacy?.retention !== "do_not_store" && record.privacy?.level !== "secret");
  const routeCandidates = allRecords
    .filter(record => record.schema.name === "observation.route_candidate")
    .slice(0, options.limit ?? 160);
  const lanes = buildFocusLanes(routeCandidates, allRecords);
  const activeLanes = normalizeAttention(lanes);
  const sourceRecords = unique(activeLanes.flatMap(lane => lane.source_records)).slice(0, 80);
  const view: ContextView = {
    id: `view:work_focus_set:${stableKey(generatedAt.slice(0, 16))}`,
    view_type: WORK_FOCUS_SET_VIEW_TYPE,
    title: activeLanes.length ? `Work focus: ${activeLanes.slice(0, 3).map(lane => lane.label).join(", ")}` : "Work focus: none",
    summary: activeLanes.length
      ? `${activeLanes.length} active work lanes. Top lane: ${activeLanes[0]?.label} (${Math.round((activeLanes[0]?.attention_share ?? 0) * 100)}%).`
      : "No active work lanes found in the recent route candidate window.",
    status: activeLanes.length ? "candidate" : "archived",
    source_records: sourceRecords,
    compiler: { id: WORK_FOCUS_SET_COMPILER_ID, version: "0.0.1", mode: options.llm ? "hybrid" : "deterministic" },
    purpose: "Batch-consolidated current work lanes used to gate project, research, communication, and memory views.",
    scope: {
      time_range: {
        start: new Date(now.getTime() - minutes * 60_000).toISOString(),
        end: generatedAt,
      },
      project: firstProject(activeLanes),
    },
    content: {
      active_lanes: activeLanes,
      lane_count: activeLanes.length,
      route_candidate_count: routeCandidates.length,
      generated_at: generatedAt,
      consolidation: options.llm ? "hybrid-ready" : "deterministic",
    },
    confidence: activeLanes[0]?.confidence ?? 0.1,
    stability: "session",
    lossiness: "medium",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    validity: { valid_from: new Date(now.getTime() - minutes * 60_000).toISOString(), stale_after: new Date(now.getTime() + 15 * 60_000).toISOString() },
    metadata: {
      generated_at: generatedAt,
      algorithm: "work-focus-set-rules-v1",
      llm_ready: true,
      records_scanned: allRecords.length,
      route_candidates_used: routeCandidates.length,
    },
  };

  const stored = options.write ?? true ? store.upsertView(view) : view;
  if (options.write ?? true) {
    store.appendRuntimeEvent({
      event_type: "view_compiled",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: stored.id,
      plugin_id: WORK_FOCUS_SET_COMPILER_ID,
      related_records: sourceRecords,
      payload: { view_type: WORK_FOCUS_SET_VIEW_TYPE, lane_count: activeLanes.length, route_candidates_used: routeCandidates.length },
    });
  }

  return {
    ok: true,
    generated_at: generatedAt,
    view: stored,
    active_lanes: activeLanes,
    records_scanned: allRecords.length,
    route_candidates_used: routeCandidates.length,
    diagnostics: { algorithm: "work-focus-set-rules-v1", llm_ready: true },
  };
}

export function buildFocusLanes(routeCandidates: StoredContextRecord[], allRecords: StoredContextRecord[] = []): WorkFocusLane[] {
  const byLane = new Map<string, LaneAccumulator>();
  const recordsById = new Map(allRecords.map(record => [record.id, record]));

  for (const candidate of routeCandidates) {
    const sourceIds = [stringValue(candidate.payload?.source_observation_id), ...(candidate.relations?.derived_from ?? [])].filter((id): id is string => Boolean(id));
    const features = recordValue(candidate.payload?.features);
    for (const route of arrayRecords(candidate.payload?.candidate_routes)) {
      const routeKey = stringValue(route.route_key);
      if (!routeKey) continue;
      const laneKind = stringValue(route.lane_kind) ?? laneKindFromKey(routeKey);
      const score = numberValue(route.score) ?? 0;
      if (score < 0.12) continue;
      const lane = byLane.get(routeKey) ?? {
        lane_key: routeKey,
        lane_kind: laneKind,
        score: 0,
        source_records: new Set<string>(),
        candidate_route_ids: new Set<string>(),
        route_scores: [],
        evidence: {},
      };
      const ageWeight = recencyWeight(candidate.time?.observed_at ?? candidate.created_at);
      const laneWeight = laneKind === "project" ? 1.15 : laneKind === "communication" ? 0.55 : 1;
      lane.score += score * ageWeight * laneWeight;
      lane.candidate_route_ids.add(candidate.id);
      for (const id of sourceIds) lane.source_records.add(id);
      lane.route_scores.push({ route_key: routeKey, score, rule_hits: arrayStrings(route.rule_hits) });
      lane.evidence = mergeEvidence(lane.evidence, recordValue(route.evidence_fields), features);
      lane.last_seen_at = maxIso(lane.last_seen_at, candidate.time?.observed_at ?? candidate.created_at);
      byLane.set(routeKey, lane);
    }
  }

  return [...byLane.values()]
    .map(lane => laneToOutput(lane, recordsById))
    .filter(lane => lane.confidence >= 0.1)
    .sort((a, b) => b.attention_share - a.attention_share || b.confidence - a.confidence)
    .slice(0, 8);
}

function normalizeAttention(lanes: WorkFocusLane[]): WorkFocusLane[] {
  const total = lanes.reduce((sum, lane) => sum + lane.attention_share, 0);
  if (total <= 0) return lanes;
  return lanes.map(lane => ({
    ...lane,
    attention_share: Number((lane.attention_share / total).toFixed(3)),
  })).sort((a, b) => b.attention_share - a.attention_share);
}

function laneToOutput(lane: LaneAccumulator, recordsById: Map<string, StoredContextRecord>): WorkFocusLane {
  const evidence = compactRecord(lane.evidence);
  const label = labelForLane(lane.lane_key, evidence);
  const sourceRecords = [...lane.source_records];
  const sourceTitles = sourceRecords.map(id => recordsById.get(id)?.content?.title).filter((value): value is string => Boolean(value)).slice(0, 8);
  return {
    lane_key: lane.lane_key,
    lane_kind: lane.lane_kind,
    label,
    attention_share: Number(lane.score.toFixed(3)),
    confidence: Math.min(1, Number((lane.score / Math.max(1, lane.candidate_route_ids.size)).toFixed(3))),
    source_records: sourceRecords,
    candidate_route_ids: [...lane.candidate_route_ids],
    route_scores: lane.route_scores.slice(0, 12),
    evidence: { ...evidence, source_titles: sourceTitles },
    last_seen_at: lane.last_seen_at,
  };
}

function mergeEvidence(target: Record<string, unknown>, routeEvidence?: Record<string, unknown>, features?: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const source of [routeEvidence, features]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) out[key] = unique([...(Array.isArray(out[key]) ? out[key] as unknown[] : []), ...value]).slice(0, 20);
      else if (out[key] === undefined) out[key] = value;
    }
  }
  return out;
}

function laneKindFromKey(key: string): string {
  if (key.startsWith("project:") || key.startsWith("repo:")) return "project";
  if (key.startsWith("topic:")) return "topic";
  if (key.startsWith("communication:")) return "communication";
  if (key.startsWith("domain:")) return "browser";
  if (key.startsWith("app:")) return "app";
  return "unknown";
}

function labelForLane(key: string, evidence: Record<string, unknown>): string {
  if (key.startsWith("project:")) return stringValue(evidence.project) ?? key.replace(/^project:/, "").split("/").filter(Boolean).at(-1) ?? key;
  if (key.startsWith("repo:")) return key.replace(/^repo:/, "");
  if (key.startsWith("topic:")) return key.replace(/^topic:/, "");
  if (key === "communication:messages") return "Messages";
  if (key.startsWith("domain:")) return key.replace(/^domain:/, "");
  if (key.startsWith("app:")) return key.replace(/^app:/, "");
  return key;
}

function firstProject(lanes: WorkFocusLane[]): string | undefined {
  return lanes.find(lane => lane.lane_kind === "project")?.label;
}

function recencyWeight(iso?: string): number {
  if (!iso) return 0.8;
  const ageMinutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(ageMinutes)) return 0.8;
  if (ageMinutes <= 10) return 1;
  if (ageMinutes <= 60) return 0.85;
  if (ageMinutes <= 180) return 0.65;
  return 0.4;
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function stableKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

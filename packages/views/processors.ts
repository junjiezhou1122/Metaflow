import { ContextStore } from "@info/core";
import type { LlmOptions, StoredContextRecord, StoredContextView, StoredRuntimeEvent } from "@info/core";
import { compileEvidenceViews } from "./evidence/index.js";
import { compileActivityViews } from "./activity/index.js";
import { compileAudioViews } from "./audio/index.js";
import { compileVisualFrameViews } from "./visual-frame/index.js";
import { compileActivityBlockViews } from "./activity-block/index.js";
import { compileProposalViews } from "./proposal/index.js";
import { compileResourceViews } from "./resource/index.js";
import { compileIntentViews, compileIntentViewsWithLlm } from "./intent/index.js";
import { compileWorkflowViews, compileWorkflowViewsWithLlm } from "./workflow/index.js";
import { compileMemoryViews, compileMemoryViewsWithLlm } from "./memory/index.js";
import { compileObservationTimeline } from "./timeline/timeline.js";
import { compileWorkThreadView } from "./timeline/work-thread-view.js";
import { compileActivityTimeline } from "./timeline/activity-timeline.js";
import { compileProjectTimeline } from "./timeline/project-timeline.js";
import { compileWorkFocusSet } from "./work-router/index.js";
import { compileProjectCurrent } from "./project/index.js";

export const VIEW_PROCESSOR_FUNCTIONS = {
  evidence: "view::evidence_compile",
  activity: "view::activity_compile",
  audio: "view::audio_compile",
  visualFrame: "view::visual_frame_compile",
  activityBlock: "view::activity_block_compile",
  proposal: "view::proposal_compile",
  resource: "view::resource_compile",
  intent: "view::intent_compile",
  workflow: "view::workflow_compile",
  memory: "view::memory_compile",
  workThread: "view::work_thread_compile",
  workFocusSet: "view::work_focus_set_compile",
  projectCurrent: "view::project_current_compile",
  observationTimeline: "view::timeline_observations_compile",
  activityTimeline: "view::timeline_activity_compile",
  projectTimeline: "view::project_timeline_compile",
} as const;

export type ViewProcessorInput = {
  write?: boolean;
  minutes?: number;
  limit?: number;
  llm?: LlmOptions;
  vision_llm?: LlmOptions;
  visual_frame_limit?: number;
  visual_frame_concurrency?: number;
  visual_frame_sample_seconds?: number;
  work_thread_minutes?: number;
  activity_timeline_minutes?: number;
  project_timeline_minutes?: number;
  project_path?: string;
  project?: string;
  plugin_id?: string;
  source_record_ids?: string[];
  source_view_ids?: string[];
  records?: StoredContextRecord[];
  runtime_events?: StoredRuntimeEvent[];
  source_views?: StoredContextView[];
  event_limit?: number;
  bucket_minutes?: number;
  include_runtime_events?: boolean;
  include_low_level_screenpipe?: boolean;
  dedupe?: boolean;
  bucket_item_limit?: number | false;
  summarize_heartbeats?: boolean;
  source_filter?: "screenpipe" | "browser" | "runtime" | "all";
  merge_continuous?: boolean;
  merge_gap_minutes?: number;
  cascade?: boolean;
  cascade_depth?: number;
  max_depth?: number;
};

export type ViewProcessorContext = {
  store: ContextStore;
};

export type ViewProcessorResult = {
  ok: true;
  function_id: string;
  view_type: string;
  generated_at: string;
  views_written: string[];
  views: StoredContextView[];
  diagnostics: Record<string, unknown>;
};

export type ViewProcessorDefinition = {
  function_id: string;
  view_type: string;
  input_topics: string[];
  output_topic: string;
  process: (input: ViewProcessorInput, context: ViewProcessorContext) => Promise<ViewProcessorResult>;
};

export function createViewProcessorDefinitions(): ViewProcessorDefinition[] {
  return [
    processor(VIEW_PROCESSOR_FUNCTIONS.evidence, "evidence", ["info.observation.ingested", "info.view.requested"], compileEvidenceProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.activity, "activity", ["info.view.evidence.written", "info.view.requested"], compileActivityProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.audio, "audio", ["info.view.evidence.written", "info.view.requested"], compileAudioProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.visualFrame, "visual_frame", ["info.view.evidence.written", "info.view.requested"], compileVisualFrameProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.activityBlock, "activity_block", ["info.view.activity.written", "info.view.audio.written", "info.view.visual_frame.written", "info.view.requested"], compileActivityBlockProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.proposal, "proposal", ["info.view.activity.written", "info.view.activity_block.written", "info.view.requested"], compileProposalProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.resource, "resource", ["info.view.proposal.written", "info.view.requested"], compileResourceProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.intent, "intent", ["info.view.proposal.written", "info.view.activity_block.written", "info.view.requested"], compileIntentProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.workflow, "workflow", ["info.view.intent.written", "info.view.resource.written", "info.view.activity_block.written", "info.view.requested"], compileWorkflowProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.memory, "memory", ["info.view.workflow.written", "info.view.requested"], compileMemoryProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.workThread, "work_thread", ["info.observation.ingested", "info.schedule.tick", "info.view.requested"], compileWorkThreadProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.workFocusSet, "work.focus_set", ["info.observation.route_candidate.written", "info.schedule.tick", "info.view.requested"], compileWorkFocusSetProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.projectCurrent, "project.current", ["info.view.work.focus_set.written", "info.schedule.tick", "info.view.requested"], compileProjectCurrentProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.observationTimeline, "timeline.observations", ["info.observation.ingested", "info.schedule.tick", "info.view.requested"], compileObservationTimelineProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.activityTimeline, "timeline.activity", ["info.observation.ingested", "info.runtime.event.written", "info.schedule.tick", "info.view.requested"], compileActivityTimelineProcessor),
    processor(VIEW_PROCESSOR_FUNCTIONS.projectTimeline, "project_timeline", ["info.view.work_thread.written", "info.schedule.tick", "info.view.requested"], compileProjectTimelineProcessor),
  ];
}

async function compileEvidenceProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const records = recordsById(context.store, input.source_record_ids);
  const result = compileEvidenceViews({
    minutes: input.minutes ?? 240,
    limit: input.limit ?? 500,
    write: input.write ?? true,
    records: records.length ? records : undefined,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.evidence, "evidence", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    records_scanned: result.records_scanned,
    records_used: result.records_used,
  });
}

async function compileActivityProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const evidenceViews = viewsByIdOrType(context.store, input.source_view_ids, ["evidence"], input.limit);
  const result = compileActivityViews({
    minutes: input.minutes ?? 240,
    limit: input.limit ?? 500,
    write: input.write ?? true,
    evidenceViews: evidenceViews.length ? evidenceViews : undefined,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.activity, "activity", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    source_views_used: result.source_views_used,
  });
}

async function compileAudioProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const evidenceViews = viewsByIdOrType(context.store, input.source_view_ids, ["evidence"], input.limit);
  const result = await compileAudioViews({
    write: input.write ?? true,
    limit: input.limit,
    llm: input.llm,
    evidenceViews: evidenceViews.length ? evidenceViews : undefined,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.audio, "audio", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    ...result.diagnostics,
  });
}

async function compileVisualFrameProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const evidenceViews = viewsByIdOrType(context.store, input.source_view_ids, ["evidence"], input.visual_frame_limit ?? input.limit);
  const result = await compileVisualFrameViews({
    write: input.write ?? true,
    limit: input.visual_frame_limit ?? input.limit,
    concurrency: input.visual_frame_concurrency,
    sampleIntervalSeconds: input.visual_frame_sample_seconds,
    llm: input.vision_llm,
    evidenceViews: evidenceViews.length ? evidenceViews : undefined,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.visualFrame, "visual_frame", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    ...result.diagnostics,
  });
}

async function compileActivityBlockProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const sourceViews = viewsById(context.store, input.source_view_ids);
  const result = await compileActivityBlockViews({
    write: input.write ?? true,
    limit: input.limit,
    minutes: input.minutes,
    llm: input.llm,
    visualFrameViews: pickViews(sourceViews, "visual_frame"),
    audioViews: pickViews(sourceViews, "audio"),
    activityViews: pickViews(sourceViews, "activity"),
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.activityBlock, "activity_block", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    ...result.diagnostics,
  });
}

async function compileProposalProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const activityViews = viewsByIdOrType(context.store, input.source_view_ids, ["activity"], input.limit);
  const result = compileProposalViews({
    write: input.write ?? true,
    limit: input.limit,
    activityViews: activityViews.length ? activityViews : undefined,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.proposal, "proposal", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    source_views_used: result.source_views_used,
  });
}

async function compileResourceProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const proposalViews = viewsByIdOrType(context.store, input.source_view_ids, ["proposal"], input.limit);
  const result = compileResourceViews({
    write: input.write ?? true,
    limit: input.limit,
    proposalViews: proposalViews.length ? proposalViews : undefined,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.resource, "resource", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    source_views_used: result.source_views_used,
  });
}

async function compileIntentProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const sourceViews = viewsById(context.store, input.source_view_ids);
  const proposalViews = pickViewList(sourceViews, "proposal");
  const activityBlockViews = pickViewList(sourceViews, "activity_block");
  const result = input.llm
    ? await compileIntentViewsWithLlm({
      write: input.write ?? true,
      limit: input.limit,
      proposalViews: proposalViews.length ? proposalViews : undefined,
      activityBlockViews: activityBlockViews.length ? activityBlockViews : undefined,
      llm: input.llm,
    }, context.store)
    : compileIntentViews({
      write: input.write ?? true,
      limit: input.limit,
      proposalViews: proposalViews.length ? proposalViews : undefined,
    }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.intent, "intent", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    source_views_used: "source_views_used" in result ? result.source_views_used : undefined,
    diagnostics: "diagnostics" in result ? result.diagnostics : undefined,
  });
}

async function compileWorkflowProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const sourceViews = viewsById(context.store, input.source_view_ids);
  const intentViews = pickViewList(sourceViews, "intent");
  const resourceViews = pickViewList(sourceViews, "resource");
  const activityBlockViews = pickViewList(sourceViews, "activity_block");
  const result = input.llm
    ? await compileWorkflowViewsWithLlm({
      write: input.write ?? true,
      limit: input.limit,
      intentViews: intentViews.length ? intentViews : undefined,
      resourceViews: resourceViews.length ? resourceViews : undefined,
      activityBlockViews: activityBlockViews.length ? activityBlockViews : undefined,
      llm: input.llm,
    }, context.store)
    : compileWorkflowViews({
      write: input.write ?? true,
      limit: input.limit,
      intentViews: intentViews.length ? intentViews : undefined,
      resourceViews: resourceViews.length ? resourceViews : undefined,
    }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.workflow, "workflow", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    source_views_used: "source_views_used" in result ? result.source_views_used : undefined,
    diagnostics: "diagnostics" in result ? result.diagnostics : undefined,
  });
}

async function compileMemoryProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const workflowViews = viewsByIdOrType(context.store, input.source_view_ids, ["workflow"], input.limit);
  const result = input.llm
    ? await compileMemoryViewsWithLlm({
      write: input.write ?? true,
      limit: input.limit,
      workflowViews: workflowViews.length ? workflowViews : undefined,
      llm: input.llm,
    }, context.store)
    : compileMemoryViews({
      write: input.write ?? true,
      limit: input.limit,
      workflowViews: workflowViews.length ? workflowViews : undefined,
    }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.memory, "memory", result.generated_at, storedViews(result.views), {
    compiler_id: result.compiler_id,
    source_views_used: "source_views_used" in result ? result.source_views_used : undefined,
    diagnostics: "diagnostics" in result ? result.diagnostics : undefined,
  });
}

async function compileWorkThreadProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const result = compileWorkThreadView({
    minutes: input.work_thread_minutes ?? input.minutes ?? 180,
    limit: input.limit ?? 180,
    write: input.write ?? true,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.workThread, "work_thread", result.generated_at, storedViews([result.view]), {
    compiler_id: result.compiler_id,
    records_scanned: result.records_scanned,
    records_used: result.records_used,
    candidate_threads: result.candidate_threads.length,
    active_thread_id: result.active_thread?.thread_id,
  });
}

async function compileWorkFocusSetProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const result = compileWorkFocusSet({
    minutes: input.minutes ?? 90,
    limit: input.limit ?? 160,
    write: input.write ?? true,
    records: input.records ?? (input.source_record_ids?.length ? recordsById(context.store, input.source_record_ids) : undefined),
    llm: input.llm,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.workFocusSet, "work.focus_set", result.generated_at, storedViews([result.view]), {
    records_scanned: result.records_scanned,
    route_candidates_used: result.route_candidates_used,
    lane_count: result.active_lanes.length,
  });
}

async function compileProjectCurrentProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const sourceViews = viewsById(context.store, input.source_view_ids);
  const result = compileProjectCurrent({
    write: input.write ?? true,
    limit: input.limit,
    focusSetViews: pickViewList(sourceViews, "work.focus_set").length ? pickViewList(sourceViews, "work.focus_set") : undefined,
    records: input.records ?? (input.source_record_ids?.length ? recordsById(context.store, input.source_record_ids) : undefined),
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.projectCurrent, "project.current", result.generated_at, storedViews(result.views), {
    project_count: result.views.length,
    ...result.diagnostics,
  });
}

async function compileObservationTimelineProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const result = compileObservationTimeline({
    minutes: input.minutes ?? 24 * 60,
    limit: input.limit ?? 200,
    write: input.write ?? true,
    records: input.records ?? (input.source_record_ids?.length ? recordsById(context.store, input.source_record_ids) : undefined),
    pluginId: input.plugin_id,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.observationTimeline, "timeline.observations", new Date().toISOString(), storedViews([result.view]), {
    records_used: result.records_used,
    buckets: result.buckets.length,
  });
}

async function compileActivityTimelineProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const result = compileActivityTimeline({
    minutes: input.activity_timeline_minutes ?? input.minutes ?? 240,
    limit: input.limit ?? 400,
    eventLimit: input.event_limit ?? 120,
    bucketMinutes: input.bucket_minutes,
    write: input.write ?? true,
    includeRuntimeEvents: input.include_runtime_events,
    includeLowLevelScreenpipe: input.include_low_level_screenpipe,
    dedupe: input.dedupe,
    bucketItemLimit: input.bucket_item_limit,
    summarizeHeartbeats: input.summarize_heartbeats,
    sourceFilter: input.source_filter,
    mergeContinuous: input.merge_continuous,
    mergeGapMinutes: input.merge_gap_minutes,
    records: input.records,
    runtimeEvents: input.runtime_events,
    pluginId: input.plugin_id,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.activityTimeline, "timeline.activity", new Date().toISOString(), storedViews([result.view]), {
    compiler_id: result.compiler_id,
    records_used: result.records_used,
    events_used: result.events_used,
    buckets: result.buckets.length,
  });
}

async function compileProjectTimelineProcessor(input: ViewProcessorInput, context: ViewProcessorContext) {
  const result = compileProjectTimeline({
    projectPath: input.project_path,
    project: input.project,
    minutes: input.project_timeline_minutes ?? input.minutes ?? 2 * 24 * 60,
    limit: input.limit ?? 500,
    eventLimit: input.event_limit ?? 120,
    bucketMinutes: input.bucket_minutes,
    write: input.write ?? true,
    records: input.records,
    runtimeEvents: input.runtime_events,
    workThreadViews: input.source_views,
    includeStoredWorkThreads: input.source_views ? false : undefined,
    pluginId: input.plugin_id,
  }, context.store);
  return viewResult(VIEW_PROCESSOR_FUNCTIONS.projectTimeline, "project_timeline", new Date().toISOString(), storedViews([result.view]), {
    compiler_id: result.compiler_id,
    project: result.project,
    project_path: input.project_path,
    records_used: result.records_used,
    buckets: result.buckets.length,
    work_threads: result.work_threads.length,
  });
}

function processor(
  functionId: string,
  viewType: string,
  inputTopics: string[],
  process: ViewProcessorDefinition["process"],
): ViewProcessorDefinition {
  return {
    function_id: functionId,
    view_type: viewType,
    input_topics: inputTopics,
    output_topic: `info.view.${viewType}.written`,
    process,
  };
}

function viewResult(
  functionId: string,
  viewType: string,
  generatedAt: string,
  views: StoredContextView[],
  diagnostics: Record<string, unknown>,
): ViewProcessorResult {
  return {
    ok: true,
    function_id: functionId,
    view_type: viewType,
    generated_at: generatedAt,
    views_written: views.map(view => view.id),
    views,
    diagnostics,
  };
}

function recordsById(store: ContextStore, ids: string[] | undefined): StoredContextRecord[] {
  return (ids ?? []).map(id => store.getRecord(id)).filter((record): record is StoredContextRecord => Boolean(record));
}

function viewsById(store: ContextStore, ids: string[] | undefined): StoredContextView[] {
  return (ids ?? []).map(id => store.getView(id)).filter((view): view is StoredContextView => Boolean(view));
}

function viewsByIdOrType(store: ContextStore, ids: string[] | undefined, viewTypes: string[], limit = 100): StoredContextView[] {
  const byId = viewsById(store, ids).filter(view => viewTypes.includes(view.view_type));
  if (byId.length) return byId;
  return store.listViews({ view_types: viewTypes, active_only: true, limit });
}

function pickViews(views: StoredContextView[], viewType: string): StoredContextView[] | undefined {
  const selected = views.filter(view => view.view_type === viewType);
  return selected.length ? selected : undefined;
}

function pickViewList(views: StoredContextView[], viewType: string): StoredContextView[] {
  return views.filter(view => view.view_type === viewType);
}

function storedViews(views: Array<{ id?: string }>): StoredContextView[] {
  return views.filter((view): view is StoredContextView => typeof view.id === "string" && Boolean(view.id));
}

import type { IiiCascadeInput, IiiCascadeResult, IiiCascadeStep, IiiRuntimeClient, ViewWorkerDefinition, ViewWorkerInput, ViewWorkerResult } from "./types.js";
import { III_PROCESSOR_FUNCTIONS } from "./processor-workers.js";
import { III_PROGRAM_FUNCTIONS } from "./program-workers.js";
import { VIEW_WORKER_FUNCTIONS, createViewWorkerDefinitions } from "./view-workers.js";

export const III_CASCADE_FUNCTIONS = {
  recordIngested: "context::record_ingested",
  viewWritten: "view::cascade_written",
  scheduleTick: "runtime::schedule_tick",
} as const;

const DEFAULT_MAX_DEPTH = 4;

export function createCascadeFunctionDefinitions(definitions = createViewWorkerDefinitions()) {
  return [
    {
      function_id: III_CASCADE_FUNCTIONS.recordIngested,
      async handler(input: IiiCascadeInput, iii: IiiRuntimeClient) {
        return cascadeFromRecords(input, iii, definitions);
      },
      triggers: ["info.observation.ingested"],
    },
    {
      function_id: III_CASCADE_FUNCTIONS.viewWritten,
      async handler(input: IiiCascadeInput, iii: IiiRuntimeClient) {
        return cascadeFromViews(input, iii, definitions);
      },
      triggers: ["info.view.written"],
    },
    {
      function_id: III_CASCADE_FUNCTIONS.scheduleTick,
      async handler(input: IiiCascadeInput, iii: IiiRuntimeClient) {
        return cascadeScheduleTick(input, iii, definitions);
      },
      triggers: ["info.schedule.tick"],
    },
  ];
}

export async function cascadeFromRecords(input: IiiCascadeInput, iii: IiiRuntimeClient, definitions = createViewWorkerDefinitions()): Promise<IiiCascadeResult> {
  const recordIds = uniqueStrings([input.record_id, ...(input.record_ids ?? []), ...(input.source_record_ids ?? [])]);
  const maxDepth = cascadeMaxDepth(input);
  const steps: IiiCascadeStep[] = [];
  const viewsWritten: string[] = [];

  const initial = [
    III_PROGRAM_FUNCTIONS.processRecord,
    III_PROCESSOR_FUNCTIONS.youtubeLearning,
    VIEW_WORKER_FUNCTIONS.evidence,
    VIEW_WORKER_FUNCTIONS.workThread,
    VIEW_WORKER_FUNCTIONS.activityTimeline,
  ];
  for (const functionId of initial) {
    const step = await runWorker(functionId, {
      ...input,
      source_record_ids: recordIds,
      cascade_depth: 1,
      max_depth: maxDepth,
    }, iii, definitions, 1);
    steps.push(step);
    viewsWritten.push(...viewsWrittenByStep(step));
  }

  if (maxDepth > 1) {
    const nested = await cascadeFromViews({
      ...input,
      source_view_ids: viewsWritten,
      view_ids: viewsWritten,
      cascade_depth: 2,
      max_depth: maxDepth,
    }, iii, definitions);
    steps.push(...nested.steps);
    viewsWritten.push(...nested.views_written);
  }

  return cascadeResult(recordIds, [], steps, viewsWritten);
}

export async function cascadeFromViews(input: IiiCascadeInput, iii: IiiRuntimeClient, definitions = createViewWorkerDefinitions()): Promise<IiiCascadeResult> {
  const rootViewIds = uniqueStrings([input.view_id, ...(input.view_ids ?? []), ...(input.source_view_ids ?? [])]);
  const maxDepth = cascadeMaxDepth(input);
  const startDepth = Math.max(1, input.cascade_depth ?? 1);
  let depth = startDepth;
  let frontier = rootViewIds;
  const seen = new Set<string>();
  const steps: IiiCascadeStep[] = [];
  const viewsWritten: string[] = [];

  while (frontier.length && depth <= maxDepth) {
    const frontierTypes = viewTypesForFrontier(input, frontier, depth === startDepth);
    const nextFunctions = [III_PROGRAM_FUNCTIONS.processView, ...downstreamFunctions(frontierTypes, definitions)];
    const nextFrontier: string[] = [];

    for (const functionId of nextFunctions) {
      const workerInputs = functionId === III_PROGRAM_FUNCTIONS.processView
        ? frontier.map(viewId => [viewId])
        : [frontier];
      for (const sourceViewIds of workerInputs) {
        const step = await runWorker(functionId, {
          ...input,
          source_view_ids: sourceViewIds,
          cascade_depth: depth,
          max_depth: maxDepth,
        }, iii, definitions, depth);
        steps.push(step);
        const written = viewsWrittenByStep(step);
        nextFrontier.push(...written.filter(id => !seen.has(id)));
        viewsWritten.push(...written);
        for (const id of written) seen.add(id);
      }
    }

    frontier = uniqueStrings(nextFrontier);
    depth += 1;
  }

  return cascadeResult([], rootViewIds, steps, viewsWritten);
}

export async function cascadeScheduleTick(input: IiiCascadeInput, iii: IiiRuntimeClient, definitions = createViewWorkerDefinitions()): Promise<IiiCascadeResult> {
  const maxDepth = cascadeMaxDepth(input);
  const steps: IiiCascadeStep[] = [];
  const viewsWritten: string[] = [];
  const scheduled = [
    VIEW_WORKER_FUNCTIONS.workThread,
    VIEW_WORKER_FUNCTIONS.activityTimeline,
    VIEW_WORKER_FUNCTIONS.projectTimeline,
  ];

  for (const functionId of scheduled) {
    const step = await runWorker(functionId, { ...input, cascade_depth: 1, max_depth: maxDepth }, iii, definitions, 1);
    steps.push(step);
    viewsWritten.push(...(step.result?.views_written ?? []));
  }

  return cascadeResult([], [], steps, viewsWritten);
}

async function runWorker(
  functionId: string,
  input: ViewWorkerInput,
  iii: IiiRuntimeClient,
  definitions: ViewWorkerDefinition[],
  depth: number,
): Promise<IiiCascadeStep> {
  const definition = definitions.find(item => item.function_id === functionId);
  const knownProgramType = functionId === III_PROGRAM_FUNCTIONS.processRecord ? "program.record" : functionId === III_PROGRAM_FUNCTIONS.processView ? "program.view" : undefined;
  const knownProcessorType = functionId.startsWith("processor::") ? "processor" : undefined;
  if (!definition && !knownProgramType && !knownProcessorType) return { function_id: functionId, view_type: "unknown", depth, input, skipped: "definition not found" };
  if (!iii.trigger) return { function_id: functionId, view_type: definition?.view_type ?? knownProgramType ?? "unknown", depth, input, skipped: "iii trigger unavailable" };
  const payload = functionId === III_PROGRAM_FUNCTIONS.processView
    ? { ...input, view_id: input.source_view_ids?.[0] }
    : input;
  const result = await iii.trigger({ function_id: functionId, payload });
  return {
    function_id: functionId,
    view_type: definition?.view_type ?? knownProgramType ?? knownProcessorType ?? "unknown",
    depth,
    input,
    result: isViewWorkerResult(result) ? result : undefined,
    raw_result: isViewWorkerResult(result) ? undefined : result,
    skipped: isViewWorkerResult(result) || isProgramWorkerResult(result) || isProcessorWorkerResult(result) ? undefined : "trigger did not return a known worker result",
  };
}

function downstreamFunctions(viewTypes: string[], definitions: ViewWorkerDefinition[]): string[] {
  const topics = viewTypes.map(type => `info.view.${type}.written`);
  return definitions
    .filter(definition => definition.input_topics.some(topic => topics.includes(topic)))
    .map(definition => definition.function_id);
}

function viewTypesForFrontier(input: IiiCascadeInput, frontier: string[], useExplicitType: boolean): string[] {
  if (useExplicitType && input.view_type) return [input.view_type];
  const explicit = useExplicitType && (input.source_view_ids?.length === 1 || input.view_ids?.length === 1 || input.view_id) ? input.view_type : undefined;
  if (explicit) return [explicit];
  const fromIds = frontier.map(viewTypeFromId).filter((type): type is string => Boolean(type));
  return uniqueStrings(fromIds);
}

function viewTypeFromId(id: string): string | undefined {
  if (id.startsWith("evidence:")) return "evidence";
  if (id.startsWith("activity:")) return "activity";
  if (id.startsWith("audio:")) return "audio";
  if (id.startsWith("visual_frame:")) return "visual_frame";
  if (id.startsWith("activity_block:")) return "activity_block";
  if (id.startsWith("proposal:")) return "proposal";
  if (id.startsWith("resource:")) return "resource";
  if (id.startsWith("intent:")) return "intent";
  if (id.startsWith("workflow:")) return "workflow";
  if (id.startsWith("memory:")) return "memory";
  if (id.includes("work_thread")) return "work_thread";
  if (id.includes("timeline")) return "timeline.activity";
  return undefined;
}

function cascadeMaxDepth(input: IiiCascadeInput): number {
  return Math.min(8, Math.max(1, input.max_depth ?? input.cascade_depth ?? DEFAULT_MAX_DEPTH));
}

function cascadeResult(rootRecords: string[], rootViews: string[], steps: IiiCascadeStep[], viewsWritten: string[]): IiiCascadeResult {
  return {
    ok: true,
    mode: "iii_cascade",
    generated_at: new Date().toISOString(),
    root_records: rootRecords,
    root_views: rootViews,
    steps,
    views_written: uniqueStrings(viewsWritten),
  };
}

function isViewWorkerResult(value: unknown): value is ViewWorkerResult {
  return Boolean(value)
    && typeof value === "object"
    && (value as { ok?: unknown }).ok === true
    && Array.isArray((value as { views_written?: unknown }).views_written)
    && typeof (value as { function_id?: unknown }).function_id === "string";
}

function isProgramWorkerResult(value: unknown): value is { result?: { runs?: Array<{ written_views?: string[] }> } } {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { function_id?: unknown }).function_id === "string"
    && Boolean((value as { result?: unknown }).result);
}

function viewsWrittenByStep(step: IiiCascadeStep): string[] {
  if (step.result) return step.result.views_written;
  const raw = step.raw_result;
  if (isProcessorWorkerResult(raw)) return raw.views_written;
  if (!isProgramWorkerResult(raw)) return [];
  const runs = raw.result?.runs ?? [];
  return uniqueStrings(runs.flatMap(run => run.written_views ?? []));
}

function isProcessorWorkerResult(value: unknown): value is { views_written: string[] } {
  return Boolean(value)
    && typeof value === "object"
    && (value as { ok?: unknown }).ok === true
    && typeof (value as { function_id?: unknown }).function_id === "string"
    && Array.isArray((value as { views_written?: unknown }).views_written)
    && Array.isArray((value as { runs?: unknown }).runs);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value)))];
}

import type { ContextView } from "@info/core";
import { compileWorkFocusSet, WORK_FOCUS_SET_COMPILER_ID, WORK_FOCUS_SET_VIEW_TYPE } from "@info/views";
import type { ProcessorDefinition, ProcessorHandler } from "../types.js";

export { WORK_FOCUS_SET_COMPILER_ID, WORK_FOCUS_SET_VIEW_TYPE };

export type WorkRouterBatchProcessorOptions = {
  now?: Date;
  minutes?: number;
  limit?: number;
};

export function createWorkRouterBatchProcessor(options: WorkRouterBatchProcessorOptions = {}): ProcessorDefinition {
  return {
    id: WORK_FOCUS_SET_COMPILER_ID,
    title: "Work Router Batch",
    version: "0.0.1",
    description: "Batch-consolidates recent route candidates into a work focus set view.",
    consumes: {
      observations: ["observation.route_candidate", "observation.*"],
      views: ["state.surface"],
    },
    produces: { views: [WORK_FOCUS_SET_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
    handler: workRouterBatchHandler(options),
  };
}

export function workRouterBatchHandler(options: WorkRouterBatchProcessorOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const result = compileWorkFocusSet({ ...options, write: false }, context.store);
    const { view_type: _viewType, ...rest } = result.view as ContextView;
    return {
      views: [{
        ...rest,
        type: WORK_FOCUS_SET_VIEW_TYPE,
        metadata: {
          ...rest.metadata,
          records_scanned: result.records_scanned,
          route_candidates_used: result.route_candidates_used,
        },
      }],
      diagnostics: result.diagnostics,
    };
  };
}

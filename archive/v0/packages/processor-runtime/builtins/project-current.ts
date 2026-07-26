import type { ContextView } from "@info/core";
import { compileProjectCurrent, PROJECT_CURRENT_COMPILER_ID, PROJECT_CURRENT_VIEW_TYPE } from "@info/views";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export { PROJECT_CURRENT_COMPILER_ID, PROJECT_CURRENT_VIEW_TYPE };

export type ProjectCurrentProcessorOptions = {
  limit?: number;
  minConfidence?: number;
  now?: Date;
};

export function createProjectCurrentProcessor(options: ProjectCurrentProcessorOptions = {}): ProcessorDefinition {
  return {
    id: PROJECT_CURRENT_COMPILER_ID,
    title: "Project Current",
    version: "0.0.1",
    description: "Compiles project.current views from work.focus_set lanes and supporting observations.",
    consumes: {
      observations: ["observation.codex.message", "observation.claude.message", "observation.browser_page_snapshot", "observation.local_project"],
      views: ["work.focus_set"],
    },
    produces: { views: [PROJECT_CURRENT_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
    handler: projectCurrentHandler(options),
  };
}

export function projectCurrentHandler(options: ProjectCurrentProcessorOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const result = compileProjectCurrent(
      { write: false, limit: options.limit, minConfidence: options.minConfidence, now: options.now },
      context.store,
    );
    const views: ViewDraft[] = result.views.map((view) => {
      const { view_type: viewType, ...rest } = view as ContextView;
      return { type: viewType, ...rest };
    });
    return { views };
  };
}

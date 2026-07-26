import {
  createViewProcessorDefinitions,
  VIEW_PROCESSOR_FUNCTIONS,
  type ViewProcessorDefinition,
} from "@info/views/processors.js";
import type { ViewWorkerContext, ViewWorkerDefinition } from "./types.js";

export const VIEW_WORKER_FUNCTIONS = VIEW_PROCESSOR_FUNCTIONS;

export function createViewWorkerDefinitions(): ViewWorkerDefinition[] {
  return createViewProcessorDefinitions().map(viewWorkerDefinition);
}

function viewWorkerDefinition(definition: ViewProcessorDefinition): ViewWorkerDefinition {
  return {
    function_id: definition.function_id,
    view_type: definition.view_type,
    input_topics: definition.input_topics,
    output_topic: definition.output_topic,
    handler: (input, context: ViewWorkerContext) => definition.process(input, { store: context.store }),
  };
}

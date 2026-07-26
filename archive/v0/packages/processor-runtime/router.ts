import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorRegistry } from "./registry.js";
import type { ProcessorDefinition } from "./types.js";

export function routeObservation(
  registry: ProcessorRegistry,
  observation: StoredContextRecord,
): ProcessorDefinition[] {
  return registry.matchingObservation(observation.schema.name);
}

export function routeView(
  registry: ProcessorRegistry,
  view: StoredContextView,
): ProcessorDefinition[] {
  return registry.matchingView(view.view_type);
}

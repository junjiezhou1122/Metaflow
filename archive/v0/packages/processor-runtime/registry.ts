import type { ProcessorDefinition, ProcessorPattern } from "./types.js";

export type ProcessorRegistry = {
  list(): ProcessorDefinition[];
  get(id: string): ProcessorDefinition | undefined;
  matchingObservation(schemaName: string): ProcessorDefinition[];
  matchingView(viewType: string): ProcessorDefinition[];
};

export function createProcessorRegistry(processors: ProcessorDefinition[] = []): ProcessorRegistry {
  const byId = new Map<string, ProcessorDefinition>();
  for (const processor of processors) {
    if (byId.has(processor.id)) throw new Error(`Duplicate processor id: ${processor.id}`);
    byId.set(processor.id, processor);
  }

  return {
    list: () => [...byId.values()],
    get: (id: string) => byId.get(id),
    matchingObservation: (schemaName: string) =>
      [...byId.values()].filter(processor => matchesAny(processor.consumes.observations, schemaName)),
    matchingView: (viewType: string) =>
      [...byId.values()].filter(processor => matchesAny(processor.consumes.views, viewType)),
  };
}

export function matchesAny(patterns: ProcessorPattern[] | undefined, value: string): boolean {
  return Boolean(patterns?.some(pattern => matchesPattern(pattern, value)));
}

export function matchesPattern(pattern: ProcessorPattern, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return value.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

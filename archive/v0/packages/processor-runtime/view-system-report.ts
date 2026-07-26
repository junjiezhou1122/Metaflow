import type { ViewRegistry } from "@info/view-system";
import type { ProcessorDefinition, ProcessorRuntimeKind } from "./types.js";

export type ProcessorViewReportEntry = {
  id: string;
  consumes: {
    observations: string[];
    views: string[];
  };
  produces: {
    views: string[];
  };
  runtime: ProcessorRuntimeKind;
  policy: {
    speed?: ProcessorDefinition["policy"] extends infer P ? P extends { speed?: infer S } ? S : never : never;
    autonomy?: ProcessorDefinition["policy"] extends infer P ? P extends { autonomy?: infer A } ? A : never : never;
    privacy?: ProcessorDefinition["policy"] extends infer P ? P extends { privacy?: infer R } ? R : never : never;
  };
  warnings: string[];
};

export type ProcessorViewReport = {
  processors: ProcessorViewReportEntry[];
  warnings: string[];
};

export function buildProcessorViewReport(
  processors: ProcessorDefinition[],
  registry: ViewRegistry,
): ProcessorViewReport {
  const entries = processors.map(processor => processorViewReportEntry(processor, registry));
  return {
    processors: entries,
    warnings: entries.flatMap(entry => entry.warnings.map(warning => `${entry.id}: ${warning}`)),
  };
}

export function processorViewReportEntry(
  processor: ProcessorDefinition,
  registry: ViewRegistry,
): ProcessorViewReportEntry {
  const producedViews = processor.produces.views ?? [];
  const warnings = producedViews
    .filter(viewType => !registry.has(viewType))
    .map(viewType => `produces unregistered view ${viewType}`);

  return {
    id: processor.id,
    consumes: {
      observations: [...(processor.consumes.observations ?? [])],
      views: [...(processor.consumes.views ?? [])],
    },
    produces: {
      views: [...producedViews],
    },
    runtime: processor.runtime.kind,
    policy: {
      speed: processor.policy?.speed,
      autonomy: processor.policy?.autonomy,
      privacy: processor.policy?.privacy,
    },
    warnings,
  };
}

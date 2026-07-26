import type { ContextStore } from "@info/core";
import { createCurrentPageRouterProcessor } from "./builtins/current-page-router.js";
import { createDurableMemoryMinerProcessor } from "./builtins/durable-memory-miner.js";
import { createMemoryDailyUpdateProcessor } from "./builtins/memory-daily-update.js";
import { createMemoryProfileUpdateProcessor } from "./builtins/memory-profile-update.js";
import { createProjectCurrentProcessor } from "./builtins/project-current.js";
import { createProjectDecisionExtractorProcessor } from "./builtins/project-decision-extractor.js";
import { createProjectInboxProcessor } from "./builtins/project-inbox.js";
import { createProjectTasksProcessor } from "./builtins/project-tasks.js";
import { createRouteCandidateProcessor } from "./builtins/route-candidate.js";
import { createScreenpipeSurfaceProcessor } from "./builtins/screenpipe-surface-processor.js";
import { createSurfaceStateProcessor } from "./builtins/surface-state.js";
import { createViewPromotionEngineProcessor } from "./builtins/view-promotion-engine.js";
import { createWorkRouterBatchProcessor } from "./builtins/work-router-batch.js";
import type { ProcessorDefinition, ProcessorRuntimeConfig } from "./types.js";

const DYNAMIC_PROCESSOR_STATE_KEY = "processor.dynamic_specs";

export type DynamicProcessorSpecInput = {
  id: string;
  title?: string;
  version?: string;
  description?: string;
  consumes: ProcessorDefinition["consumes"];
  produces: ProcessorDefinition["produces"];
  runtime: ProcessorRuntimeConfig;
  policy?: ProcessorDefinition["policy"];
};

export function builtInProcessors(): ProcessorDefinition[] {
  return [
    createSurfaceStateProcessor(),
    createRouteCandidateProcessor(),
    createCurrentPageRouterProcessor(),
    createScreenpipeSurfaceProcessor(),
    createViewPromotionEngineProcessor(),
    createWorkRouterBatchProcessor(),
    createProjectCurrentProcessor(),
    createMemoryDailyUpdateProcessor(),
    createDurableMemoryMinerProcessor(),
    createMemoryProfileUpdateProcessor(),
    createProjectInboxProcessor(),
    createProjectTasksProcessor(),
    createProjectDecisionExtractorProcessor(),
  ];
}

export function processorCatalog(store?: ContextStore): ProcessorDefinition[] {
  const processors = [...builtInProcessors()];
  if (!store) return processors;
  const byId = new Map(processors.map(processor => [processor.id, processor]));
  for (const processor of dynamicProcessors(store)) byId.set(processor.id, processor);
  return [...byId.values()];
}

export function dynamicProcessors(store: ContextStore): ProcessorDefinition[] {
  const specs = dynamicProcessorSpecs(store);
  return specs.map(spec => ({ ...spec }));
}

export function dynamicProcessorSpecs(store: ContextStore): DynamicProcessorSpecInput[] {
  const value = store.getRuntimeState(DYNAMIC_PROCESSOR_STATE_KEY)?.value;
  const specs = Array.isArray(value?.processors) ? value.processors : [];
  return specs.map((spec, index) => normalizeDynamicProcessorSpec(spec, `processors[${index}]`));
}

export function upsertDynamicProcessorSpec(store: ContextStore, input: unknown): DynamicProcessorSpecInput {
  const spec = normalizeDynamicProcessorSpec(input, "processor");
  const current = dynamicProcessorSpecs(store);
  const next = [...current.filter(item => item.id !== spec.id), spec].sort((a, b) => a.id.localeCompare(b.id));
  store.setRuntimeState(DYNAMIC_PROCESSOR_STATE_KEY, { processors: next });
  return spec;
}

function normalizeDynamicProcessorSpec(raw: unknown, label: string): DynamicProcessorSpecInput {
  if (!isRecord(raw)) throw new Error(`${label} must be a JSON object`);
  const id = stringValue(raw.id);
  if (!id) throw new Error(`${label}.id is required`);
  const runtime = normalizeRuntime(raw.runtime, `${label}.runtime`);
  return {
    id,
    title: stringValue(raw.title),
    version: stringValue(raw.version),
    description: stringValue(raw.description),
    consumes: normalizeConsumption(raw.consumes),
    produces: normalizeProduction(raw.produces),
    runtime,
    policy: normalizePolicy(raw.policy),
  };
}

function normalizeConsumption(raw: unknown): ProcessorDefinition["consumes"] {
  return {
    observations: stringArray(isRecord(raw) ? raw.observations : undefined),
    views: stringArray(isRecord(raw) ? raw.views : undefined),
  };
}

function normalizeProduction(raw: unknown): ProcessorDefinition["produces"] {
  return {
    views: stringArray(isRecord(raw) ? raw.views : undefined),
    observations: stringArray(isRecord(raw) ? raw.observations : undefined),
    events: stringArray(isRecord(raw) ? raw.events : undefined),
  };
}

function normalizeRuntime(raw: unknown, label: string): ProcessorRuntimeConfig {
  if (!isRecord(raw)) throw new Error(`${label} must be a JSON object`);
  if (raw.kind === "http") {
    const url = stringValue(raw.url);
    if (!url) throw new Error(`${label}.url is required for http processors`);
    return { kind: "http", url, method: raw.method === "POST" ? "POST" : undefined };
  }
  if (raw.kind === "cli") {
    const command = stringValue(raw.command);
    if (!command) throw new Error(`${label}.command is required for cli processors`);
    return { kind: "cli", command, args: stringArray(raw.args) };
  }
  if (raw.kind === "agent_task") {
    return {
      kind: "agent_task",
      agent: stringValue(raw.agent),
      task_template: stringValue(raw.task_template),
    };
  }
  if (raw.kind === "llm") {
    return {
      kind: "llm",
      provider: stringValue(raw.provider),
      model: stringValue(raw.model),
      prompt_id: stringValue(raw.prompt_id),
    };
  }
  if (raw.kind === "local") return { kind: "local" };
  throw new Error(`${label}.kind must be one of http, cli, agent_task, llm, or local`);
}

function normalizePolicy(raw: unknown): ProcessorDefinition["policy"] | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    speed: enumValue(raw.speed, ["reflex", "glance", "think", "work", "background"]),
    autonomy: enumValue(raw.autonomy, ["manual", "suggest", "draft", "sandbox_auto", "full_auto"]),
    privacy: enumValue(raw.privacy, ["inherit", "private", "workspace", "public"]),
  };
}

function enumValue<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { defaultCapabilityDefinitions, defaultProgramDefinitions } from "@info/programs/registry.js";
import { createRouteCandidateProcessor, createSurfaceStateProcessor } from "@info/processor-runtime";
import { createYouTubeLearningProcessor } from "@info/views";
import type { Capability, Program } from "@info/programs/types.js";
import { createContextFunctionDefinitions } from "./context-functions.js";
import { createRuntimeWorkerDefinitions, III_RUNTIME_FUNCTIONS } from "./runtime-workers.js";
import type { ContextStore } from "@info/core";
import type { IiiRuntimeClient, InfoWorkerDefinition, InfoWorkerInputSpec } from "./types.js";
import { createViewWorkerDefinitions } from "./view-workers.js";
import { III_PROGRAM_FUNCTIONS } from "./program-workers.js";

export const III_WORKER_FUNCTIONS = {
  catalog: "worker::catalog",
} as const;

export function createInfoWorkerCatalog(store?: ContextStore, iii?: IiiRuntimeClient): InfoWorkerDefinition[] {
  return [
    ...contextWorkers(store, iii),
    ...processorRuntimeWorkers(),
    ...createViewWorkerDefinitions().map(definition => ({
      id: definition.function_id,
      title: titleFromId(definition.view_type),
      kind: "view_compiler" as const,
      processor: { function_id: definition.function_id },
      subscribes: { topics: definition.input_topics },
      produces: { views: [definition.view_type], topics: [definition.output_topic] },
      policy: { speed: "background" as const, autonomy: "manual" as const },
    })),
    {
      id: III_PROGRAM_FUNCTIONS.processRecord,
      title: "Process Observation",
      kind: "router",
      processor: { function_id: III_PROGRAM_FUNCTIONS.processRecord },
      subscribes: { topics: ["info.observation.ingested"], observations: ["observation.*"] },
      produces: { events: ["program_runtime.*"], views: ["*"] },
      policy: { speed: "glance", autonomy: "suggest" },
    },
    {
      id: III_PROGRAM_FUNCTIONS.processView,
      title: "Process View",
      kind: "router",
      processor: { function_id: III_PROGRAM_FUNCTIONS.processView },
      subscribes: { topics: ["info.view.written"], views: ["*"] },
      produces: { events: ["program_runtime.*"], views: ["*"] },
      policy: { speed: "glance", autonomy: "suggest" },
    },
    ...defaultProgramDefinitions().map(programWorker),
    ...defaultCapabilityDefinitions().map(capabilityWorker),
    ...runtimeWorkers(store, iii),
  ];
}

function processorRuntimeWorkers(): InfoWorkerDefinition[] {
  return [createSurfaceStateProcessor(), createRouteCandidateProcessor(), createYouTubeLearningProcessor()].map(processor => ({
    id: processorFunctionId(processor.id),
    title: processor.title ?? titleFromId(processor.id),
    kind: "processor",
    processor: { function_id: processorFunctionId(processor.id) },
    subscribes: {
      topics: [`info.processor.${processor.id.replace(/^processor\./, "")}.requested`, "info.observation.ingested"],
      observations: processor.consumes.observations,
      views: processor.consumes.views,
    },
    produces: {
      observations: processor.produces.observations,
      views: processor.produces.views,
      events: ["processor.run.*", "processor.view_written"],
    },
    policy: {
      speed: processor.policy?.speed ?? "glance",
      autonomy: processor.policy?.autonomy ?? "suggest",
    },
  }));
}

export function createWorkerCatalogFunctionDefinitions(store?: ContextStore, iii?: IiiRuntimeClient) {
  return [
    {
      function_id: III_WORKER_FUNCTIONS.catalog,
      triggers: ["info.worker.catalog.requested"],
      async handler() {
        const workers = createInfoWorkerCatalog(store, iii);
        return {
          ok: true,
          function_id: III_WORKER_FUNCTIONS.catalog,
          workers,
          count: workers.length,
        };
      },
    },
  ];
}

function contextWorkers(store?: ContextStore, iii?: IiiRuntimeClient): InfoWorkerDefinition[] {
  if (!store || !iii) {
    return [{
      id: "context::ingest",
      title: "Ingest Observation",
      kind: "ingest",
      processor: { function_id: "context::ingest" },
      subscribes: { topics: ["info.context.ingest.requested"], observations: ["observation.*", "feedback.*"] },
      produces: { observations: ["observation.*", "feedback.*"], events: ["record_ingested", "record_deduped"] },
      policy: { speed: "reflex", autonomy: "manual" },
    }];
  }
  return createContextFunctionDefinitions(store, iii).map(definition => ({
    id: definition.function_id,
    title: definition.function_id === "context::ingest" ? "Ingest Observation" : titleFromId(definition.function_id),
    kind: definition.function_id === "context::ingest" ? "ingest" : "context",
    processor: { function_id: definition.function_id },
    subscribes: {
      topics: definition.triggers,
      observations: definition.function_id === "context::ingest" ? ["observation.*", "feedback.*"] : undefined,
    },
    produces: {
      observations: definition.function_id === "context::ingest" ? ["observation.*", "feedback.*"] : undefined,
      events: definition.function_id === "context::ingest" ? ["record_ingested", "record_deduped"] : undefined,
    },
    policy: { speed: "reflex", autonomy: "manual" },
  }));
}

function runtimeWorkers(store?: ContextStore, iii?: IiiRuntimeClient): InfoWorkerDefinition[] {
  const fallback = [{
    function_id: III_RUNTIME_FUNCTIONS.tick,
    triggers: ["info.schedule.tick", "info.runtime.tick.requested"],
  }];
  const definitions = store && iii?.trigger ? createRuntimeWorkerDefinitions(store, iii as IiiRuntimeClient & { trigger: NonNullable<IiiRuntimeClient["trigger"]> }) : fallback;
  return definitions.map(definition => ({
    id: definition.function_id,
    title: "Runtime Tick",
    kind: "runtime",
    processor: { function_id: definition.function_id },
    subscribes: { topics: definition.triggers },
    produces: { events: ["runtime_tick"], views: ["evidence", "activity", "work_thread", "timeline.activity", "memory"] },
    policy: { speed: "background", autonomy: "manual" },
  }));
}

function programWorker(program: Program): InfoWorkerDefinition {
  return {
    id: programFunctionId(program.id),
    title: program.title,
    kind: "program",
    processor: { function_id: programFunctionId(program.id) },
    subscribes: inputSpecForProgram(program),
    produces: { views: program.produces ?? [], events: ["program.run.*"] },
    policy: { speed: program.default_speed ?? "glance", autonomy: program.default_autonomy ?? "suggest" },
    program_id: program.id,
  };
}

function capabilityWorker(capability: Capability): InfoWorkerDefinition {
  return {
    id: capability.id === "capability.agent_task.submit" ? III_PROGRAM_FUNCTIONS.agentTaskSubmit : capabilityFunctionId(capability.id),
    title: capability.title,
    kind: "capability",
    processor: { function_id: capability.id === "capability.agent_task.submit" ? III_PROGRAM_FUNCTIONS.agentTaskSubmit : capabilityFunctionId(capability.id) },
    subscribes: { topics: [`info.capability.${capability.id}.requested`] },
    produces: { views: capability.produces ?? [], events: ["capability.run.*"] },
    policy: { speed: capability.default_speed ?? "work", autonomy: capability.default_autonomy ?? "manual" },
    capability_id: capability.id,
  };
}

function inputSpecForProgram(program: Program): InfoWorkerInputSpec {
  if (program.id === "program.writing_ambient") {
    return {
      topics: [`info.program.${program.id}.requested`],
      observations: [
        "observation.editor.text_changed",
        "observation.editor.text_inserted",
        "observation.browser_text_selected",
        "observation.browser_text_copied",
      ],
    };
  }
  if (program.id === "program.browser_ambient") {
    return {
      topics: [`info.program.${program.id}.requested`],
      observations: [
        "observation.browser_page_saved",
        "observation.browser_page_snapshot",
        "observation.browser_text_selected",
        "observation.browser_text_copied",
        "observation.browser_ambient_requested",
      ],
      filters: { source: "browser" },
    };
  }
  if (program.id === "program.proactive_research") {
    return {
      topics: [`info.program.${program.id}.requested`],
      views: ["thread.active_work", "project.current_context", "brief.project_next_state", "brief.research"],
    };
  }
  if (program.learns_from?.length) {
    return {
      topics: [`info.program.${program.id}.requested`],
      observations: program.learns_from,
    };
  }
  return {
    topics: [`info.program.${program.id}.requested`],
    observations: ["observation.*"],
    views: ["*"],
  };
}

function programFunctionId(programId: string): string {
  return `program::${programId.replace(/^program\./, "").replaceAll(".", "_")}`;
}

function capabilityFunctionId(capabilityId: string): string {
  return `capability::${capabilityId.replace(/^capability\./, "").replaceAll(".", "_")}`;
}

function processorFunctionId(processorId: string): string {
  return `processor::${processorId.replace(/^processor\./, "").replaceAll(".", "_")}`;
}

function titleFromId(id: string): string {
  return id
    .replace(/::/g, " ")
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, char => char.toUpperCase());
}

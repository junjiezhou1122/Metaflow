import { pathToFileURL } from "node:url";
import { registerWorker } from "iii-sdk";
import { ContextStore } from "@info/core";
import { createCascadeFunctionDefinitions } from "./cascade.js";
import { createContextFunctionDefinitions } from "./context-functions.js";
import { registerProgramWorkers } from "./program-workers.js";
import { createProcessorWorkerDefinitions } from "./processor-workers.js";
import { registerRuntimeWorkers } from "./runtime-workers.js";
import { createViewWorkerDefinitions } from "./view-workers.js";
import { createWorkerCatalogFunctionDefinitions } from "./workers.js";
import type { IiiCascadeInput, IiiRuntimeClient, InfoIiiRuntimeOptions, ViewWorkerInput } from "./types.js";

const DEFAULT_ENGINE_URL = process.env.III_ENGINE_URL ?? "ws://localhost:49134";
const DEFAULT_WORKER_NAME = "info-view-runtime";

export async function registerInfoIiiRuntime(iii: IiiRuntimeClient, options: InfoIiiRuntimeOptions = {}) {
  const store = options.store ?? new ContextStore();
  const definitions = createViewWorkerDefinitions();
  const cascadeDefinitions = createCascadeFunctionDefinitions(definitions);
  const contextDefinitions = createContextFunctionDefinitions(store, iii);
  const programDefinitions = await registerProgramWorkers(iii, store);
  const processorDefinitions = createProcessorWorkerDefinitions(store);
  const runtimeDefinitions = await registerRuntimeWorkers(iii, store);
  const workerCatalogDefinitions = createWorkerCatalogFunctionDefinitions(store, iii);

  for (const definition of definitions) {
    await iii.registerFunction(definition.function_id, async (input: unknown) => {
      return definition.handler(normalizeViewWorkerInput(input), { store, iii });
    }, {
      metadata: {
        view_type: definition.view_type,
        input_topics: definition.input_topics,
        output_topic: definition.output_topic,
        runtime: "@info/iii-runtime",
      },
    });

    if (iii.registerTrigger) {
      for (const topic of definition.input_topics) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: {
            runtime: "@info/iii-runtime",
            view_type: definition.view_type,
          },
        });
      }
    }
  }

  for (const definition of cascadeDefinitions) {
    await iii.registerFunction(definition.function_id, async (input: unknown) => {
      return definition.handler(normalizeCascadeInput(input), iii);
    }, {
      metadata: {
        runtime: "@info/iii-runtime",
        kind: "cascade",
        triggers: definition.triggers,
      },
    });

    if (iii.registerTrigger) {
      for (const topic of definition.triggers) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: {
            runtime: "@info/iii-runtime",
            kind: "cascade",
          },
        });
      }
    }
  }

  for (const definition of contextDefinitions) {
    await iii.registerFunction(definition.function_id, async (input: unknown) => definition.handler(input), {
      metadata: {
        runtime: "@info/iii-runtime",
        kind: "context",
        triggers: definition.triggers,
      },
    });

    if (iii.registerTrigger) {
      for (const topic of definition.triggers) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: {
            runtime: "@info/iii-runtime",
            kind: "context",
          },
        });
      }
    }
  }

  for (const definition of workerCatalogDefinitions) {
    await iii.registerFunction(definition.function_id, async () => definition.handler(), {
      metadata: {
        runtime: "@info/iii-runtime",
        kind: "worker_catalog",
        triggers: definition.triggers,
      },
    });

    if (iii.registerTrigger) {
      for (const topic of definition.triggers) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: {
            runtime: "@info/iii-runtime",
            kind: "worker_catalog",
          },
        });
      }
    }
  }

  for (const definition of processorDefinitions) {
    await iii.registerFunction(definition.function_id, async (input: unknown) => definition.handler(input), {
      metadata: {
        runtime: "@info/iii-runtime",
        kind: "processor",
        triggers: definition.triggers,
      },
    });

    if (iii.registerTrigger) {
      for (const topic of definition.triggers) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: {
            runtime: "@info/iii-runtime",
            kind: "processor",
          },
        });
      }
    }
  }

  return {
    ok: true as const,
    worker_name: options.workerName ?? DEFAULT_WORKER_NAME,
    functions_registered: [
      ...definitions.map(definition => definition.function_id),
      ...cascadeDefinitions.map(definition => definition.function_id),
      ...contextDefinitions.map(definition => definition.function_id),
      ...programDefinitions.map(definition => definition.function_id),
      ...processorDefinitions.map(definition => definition.function_id),
      ...runtimeDefinitions.map(definition => definition.function_id),
      ...workerCatalogDefinitions.map(definition => definition.function_id),
    ],
    triggers_registered: [
      ...definitions.flatMap(definition => definition.input_topics.map(topic => ({ function_id: definition.function_id, topic }))),
      ...cascadeDefinitions.flatMap(definition => definition.triggers.map(topic => ({ function_id: definition.function_id, topic }))),
      ...contextDefinitions.flatMap(definition => definition.triggers.map(topic => ({ function_id: definition.function_id, topic }))),
      ...programDefinitions.flatMap(definition => definition.triggers.map(topic => ({ function_id: definition.function_id, topic }))),
      ...processorDefinitions.flatMap(definition => definition.triggers.map(topic => ({ function_id: definition.function_id, topic }))),
      ...runtimeDefinitions.flatMap(definition => definition.triggers.map(topic => ({ function_id: definition.function_id, topic }))),
      ...workerCatalogDefinitions.flatMap(definition => definition.triggers.map(topic => ({ function_id: definition.function_id, topic }))),
    ],
  };
}

export async function startInfoIiiRuntime(options: InfoIiiRuntimeOptions = {}) {
  const engineUrl = options.engineUrl ?? DEFAULT_ENGINE_URL;
  const workerName = options.workerName ?? DEFAULT_WORKER_NAME;
  const iii = await registerWorker(engineUrl, { workerName });
  const registered = await registerInfoIiiRuntime(iii, { ...options, workerName });
  console.log(`[${workerName}] connected to ${engineUrl}`);
  console.log(`[${workerName}] registered ${registered.functions_registered.length} view functions`);
  return { iii, registered };
}

function normalizeViewWorkerInput(input: unknown): ViewWorkerInput {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const body = record.body && typeof record.body === "object" ? record.body as Record<string, unknown> : undefined;
  const payload = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : undefined;
  return { ...record, ...(payload ?? {}), ...(body ?? {}) } as ViewWorkerInput;
}

function normalizeCascadeInput(input: unknown): IiiCascadeInput {
  return normalizeViewWorkerInput(input) as IiiCascadeInput;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startInfoIiiRuntime().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

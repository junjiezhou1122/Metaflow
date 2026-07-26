import type { ContextStore } from "@info/core";
import { runtimeTick, type RuntimeTickRequest } from "@info/runtime/runtime.js";
import type { IiiRuntimeClient } from "./types.js";

type TriggeringIiiClient = IiiRuntimeClient & {
  trigger(input: { function_id: string; payload?: unknown; action?: unknown }): Promise<unknown> | unknown;
};

export const III_RUNTIME_FUNCTIONS = {
  tick: "runtime::tick",
} as const;

export function createRuntimeWorkerDefinitions(store: ContextStore, iii: TriggeringIiiClient) {
  return [
    {
      function_id: III_RUNTIME_FUNCTIONS.tick,
      triggers: ["info.schedule.tick", "info.runtime.tick.requested"],
      async handler(input: RuntimeTickRequest) {
        const result = await runtimeTick(input ?? {}, store, { iii });
        return {
          function_id: III_RUNTIME_FUNCTIONS.tick,
          result,
        };
      },
    },
  ];
}

export async function registerRuntimeWorkers(iii: IiiRuntimeClient, store: ContextStore) {
  if (!iii.trigger) throw new Error("iii runtime client must support trigger() for runtime workers");
  const definitions = createRuntimeWorkerDefinitions(store, iii as TriggeringIiiClient);
  for (const definition of definitions) {
    await iii.registerFunction(definition.function_id, async (input: unknown) => definition.handler((input ?? {}) as RuntimeTickRequest), {
      metadata: {
        runtime: "@info/iii-runtime",
        kind: "runtime",
        triggers: definition.triggers,
      },
    });
    if (iii.registerTrigger) {
      for (const topic of definition.triggers) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: { runtime: "@info/iii-runtime", kind: "runtime" },
        });
      }
    }
  }
  return definitions;
}

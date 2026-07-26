import { createDefaultProgramRuntime, defaultCapabilityDefinitions, defaultProgramDefinitions } from "@info/programs/registry.js";
import { activeContextView, filterViewsForPlugin, type ContextStore, type StoredContextView } from "@info/core";
import type { AutonomyProfile, Capability, ContextSignal, Program, SpeedTier } from "@info/programs/types.js";
import { signalFromRecord, signalFromView } from "@info/programs/signals.js";
import type { IiiRuntimeClient } from "./types.js";

export const III_PROGRAM_FUNCTIONS = {
  processRecord: "program::process_record",
  processView: "program::process_view",
  agentTaskSubmit: "capability::agent_task_submit",
} as const;

export type ProgramWorkerInput = {
  record_id?: string;
  view_id?: string;
  context_plugin_id?: string;
  plugin_id?: string;
  max_programs?: number;
  program_id?: string;
  dry_run?: boolean;
  signal?: ContextSignal;
  autonomy?: AutonomyProfile;
  speed?: SpeedTier;
  payload?: Record<string, unknown>;
};

export function createProgramWorkerDefinitions(store: ContextStore, iii?: IiiRuntimeClient) {
  const programs = defaultProgramDefinitions();
  const capabilities = defaultCapabilityDefinitions();
  return [
    {
      function_id: III_PROGRAM_FUNCTIONS.processRecord,
      triggers: ["info.observation.ingested"],
      async handler(input: ProgramWorkerInput) {
        const recordId = input.record_id;
        const record = recordId ? store.getRecord(recordId) : undefined;
        if (!record) return skippedProgramResult(III_PROGRAM_FUNCTIONS.processRecord, "record not found", input);
        return {
          function_id: III_PROGRAM_FUNCTIONS.processRecord,
          object_kind: "record",
          object_id: record.id,
          result: await processSignalViaProgramWorkers(iii, store, signalFromRecord(record), programs, {
            context_plugin_id: input.context_plugin_id ?? input.plugin_id,
            max_programs: input.max_programs,
            program_id: input.program_id,
            dry_run: input.dry_run,
            autonomy: input.autonomy,
            speed: input.speed,
          }),
        };
      },
    },
    {
      function_id: III_PROGRAM_FUNCTIONS.processView,
      triggers: ["info.view.written"],
      async handler(input: ProgramWorkerInput) {
        const viewId = input.view_id;
        const view = viewId ? store.getView(viewId) : undefined;
        if (!view) return skippedProgramResult(III_PROGRAM_FUNCTIONS.processView, "view not found", input);
        return {
          function_id: III_PROGRAM_FUNCTIONS.processView,
          object_kind: "view",
          object_id: view.id,
          result: await processSignalViaProgramWorkers(iii, store, signalFromView(view), programs, {
            context_plugin_id: input.context_plugin_id ?? input.plugin_id,
            max_programs: input.max_programs,
            program_id: input.program_id,
            dry_run: input.dry_run,
            autonomy: input.autonomy,
            speed: input.speed,
          }),
        };
      },
    },
    {
      function_id: III_PROGRAM_FUNCTIONS.agentTaskSubmit,
      triggers: ["info.capability.agent_task.requested"],
      async handler(input: ProgramWorkerInput) {
        return runCapabilityWorker("capability.agent_task.submit", store, III_PROGRAM_FUNCTIONS.agentTaskSubmit, input);
      },
    },
    ...programs.map(program => createSingleProgramWorker(program, store, iii)),
    ...capabilities
      .filter(capability => capability.id !== "capability.agent_task.submit")
      .map(capability => createCapabilityWorker(capability, store)),
  ];
}

export async function registerProgramWorkers(iii: IiiRuntimeClient, store: ContextStore) {
  const definitions = createProgramWorkerDefinitions(store, iii);
  for (const definition of definitions) {
    await iii.registerFunction(definition.function_id, async (input: unknown) => definition.handler(input as ProgramWorkerInput), {
      metadata: {
        runtime: "@info/iii-runtime",
        kind: "program",
        triggers: definition.triggers,
      },
    });
    if (iii.registerTrigger) {
      for (const topic of definition.triggers) {
        await iii.registerTrigger({
          type: "subscribe",
          function_id: definition.function_id,
          config: { topic },
          metadata: { runtime: "@info/iii-runtime", kind: "program" },
        });
      }
    }
  }
  return definitions;
}

async function processSignalViaProgramWorkers(iii: IiiRuntimeClient | undefined, store: ContextStore, signal: ContextSignal, programs: Program[], input: {
  context_plugin_id?: string;
  max_programs?: number;
  program_id?: string;
  dry_run?: boolean;
  autonomy?: AutonomyProfile;
  speed?: SpeedTier;
}) {
  if (!iii?.trigger) throw new Error("iii runtime client must support trigger() for program fan-out");
  const routing = input.program_id ? { missing: [] } : routingShortcutForSignal(store, signal, new Set(programs.map(program => program.id)));
  for (const missing of routing.missing) {
    store.appendRuntimeEvent({
      event_type: "program_runtime.routing_target_missing",
      actor: "system",
      status: "failed",
      subject_type: signal.object_kind === "view" ? "view" : "record",
      subject_id: signal.object_id,
      plugin_id: missing.program_id,
      related_views: [missing.view.id],
      payload: { signal, program_id: missing.program_id, routing_shortcut_view_id: missing.view.id },
    });
  }
  const routed = routing.selected;
  const candidates = input.program_id
    ? programs.filter(program => program.id === input.program_id).slice(0, input.max_programs ?? programs.length)
    : routed?.program_id
      ? programs.filter(program => program.id === routed.program_id).slice(0, input.max_programs ?? programs.length)
      : programs.slice(0, input.max_programs ?? programs.length);
  const results = [];
  for (const program of candidates) {
    const response = await iii.trigger({
      function_id: programFunctionId(program.id),
      payload: {
        signal,
        context_plugin_id: input.context_plugin_id,
        dry_run: input.dry_run,
        autonomy: input.autonomy,
        speed: input.speed,
      },
    }) as { result?: any };
    results.push(response.result ?? response);
  }
  return {
    ok: true as const,
    generated_at: new Date().toISOString(),
    signal,
    decisions: results.flatMap(result => Array.isArray(result.decisions) ? result.decisions : []),
    runs: results.flatMap(result => Array.isArray(result.runs) ? result.runs : []),
    diagnostics: {
      runtime: "@info/iii-runtime",
      mode: "program_worker_fanout",
      selected_program_ids: candidates.map(program => program.id),
      program_count: programs.length,
      candidate_program_count: candidates.length,
      requested_capability_ids: [...new Set(results.flatMap(result => Array.isArray(result.diagnostics?.requested_capability_ids) ? result.diagnostics.requested_capability_ids : []))],
      attention_influences: results.flatMap(result => Array.isArray(result.diagnostics?.attention_influences) ? result.diagnostics.attention_influences : []),
      child_diagnostics: results.map(result => result.diagnostics).filter(Boolean),
      dry_run: Boolean(input.dry_run),
      program_id: input.program_id,
      routing_shortcut_view_id: routed?.view.id,
      routing_shortcut_program_id: routed?.program_id,
      routing_missing_target_count: routing.missing.length,
      routing_missing_target_view_ids: routing.missing.map(missing => missing.view.id),
      routing_missing_target_program_ids: routing.missing.map(missing => missing.program_id),
    },
  };
}

function createSingleProgramWorker(program: Program, store: ContextStore, iii?: IiiRuntimeClient) {
  return {
    function_id: programFunctionId(program.id),
    triggers: [`info.program.${program.id}.requested`],
    async handler(input: ProgramWorkerInput) {
      if (!input.signal) return skippedProgramResult(programFunctionId(program.id), "signal missing", input);
      const runtime = createDefaultProgramRuntime(store, {
        capabilityInvoker: iii?.trigger
          ? async (capabilityId, capabilityInput) => {
            const response = await iii.trigger!({
              function_id: capabilityFunctionId(capabilityId),
              payload: {
                signal: capabilityInput.signal,
                program_id: capabilityInput.program?.id,
                context_plugin_id: capabilityInput.context_plugin_id,
                speed: capabilityInput.speed,
                autonomy: capabilityInput.autonomy,
                dry_run: capabilityInput.dry_run,
                payload: capabilityInput.payload,
              },
            }) as { result?: any };
            return response.result ?? response;
          }
          : undefined,
      });
      return {
        function_id: programFunctionId(program.id),
        object_kind: input.signal.object_kind,
        object_id: input.signal.object_id,
        result: await runtime.processSignal(input.signal, {
          context_plugin_id: input.context_plugin_id ?? input.plugin_id,
          max_programs: 1,
          program_id: program.id,
          dry_run: input.dry_run,
          autonomy: input.autonomy,
          speed: input.speed,
        }),
      };
    },
  };
}

function createCapabilityWorker(capability: Capability, store: ContextStore) {
  const functionId = capabilityFunctionId(capability.id);
  return {
    function_id: functionId,
    triggers: [`info.capability.${capability.id}.requested`],
    async handler(input: ProgramWorkerInput) {
      return runCapabilityWorker(capability.id, store, functionId, input);
    },
  };
}

async function runCapabilityWorker(capabilityId: string, store: ContextStore, functionId: string, input: ProgramWorkerInput) {
  if (!input.signal) return skippedProgramResult(functionId, "signal missing", input);
  const runtime = createDefaultProgramRuntime(store);
  const program = input.program_id ? defaultProgramDefinitions().find(program => program.id === input.program_id) : undefined;
  const result = await runtime.runCapability(capabilityId, {
    signal: input.signal,
    autonomy: input.autonomy,
    speed: input.speed,
    program,
    context_plugin_id: input.context_plugin_id ?? input.plugin_id,
    dry_run: input.dry_run,
    payload: input.payload,
  });
  return {
    function_id: functionId,
    object_kind: input.signal.object_kind,
    object_id: input.signal.object_id,
    result,
  };
}

function programFunctionId(programId: string): string {
  return `program::${programId.replace(/^program\./, "").replaceAll(".", "_")}`;
}

function capabilityFunctionId(capabilityId: string): string {
  return `capability::${capabilityId.replace(/^capability\./, "").replaceAll(".", "_")}`;
}

function routingShortcutForSignal(store: ContextStore, signal: ContextSignal, availableProgramIds: Set<string>): { selected?: { program_id: string; view: StoredContextView }; missing: Array<{ program_id: string; view: StoredContextView }> } {
  const shortcuts = filterViewsForPlugin(store.listViews({ view_types: ["routing.shortcut"], limit: 200 }), store);
  const missing: Array<{ program_id: string; view: StoredContextView }> = [];
  for (const item of shortcuts
    .filter(activeContextView)
    .filter(view => (view.confidence ?? 0) >= 0.5)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map(view => ({ view, program_id: programIdFromShortcut(view), match: view.content?.match }))
    .filter((item): item is { view: StoredContextView; program_id: string; match: unknown } => Boolean(item.program_id))
    .filter(item => shortcutMatches(item.match, signal))) {
    if (availableProgramIds.has(item.program_id)) return { selected: { program_id: item.program_id, view: item.view }, missing };
    missing.push({ program_id: item.program_id, view: item.view });
  }
  return { missing };
}

function programIdFromShortcut(view: StoredContextView): string | undefined {
  const value = view.content?.program_id ?? view.scope?.plugin_id;
  return typeof value === "string" && value.startsWith("program.") ? value : undefined;
}

function shortcutMatches(match: unknown, signal: ContextSignal): boolean {
  if (!match || typeof match !== "object") return false;
  const expected = match as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    const actual = (signal as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      if (!value.includes(actual)) return false;
    } else if (value !== actual) {
      return false;
    }
  }
  return true;
}

function skippedProgramResult(functionId: string, reason: string, input: ProgramWorkerInput) {
  return {
    function_id: functionId,
    skipped: reason,
    input,
    result: {
      ok: true,
      generated_at: new Date().toISOString(),
      signal: {
        object_kind: "observation",
        object_type: "missing",
        object_id: input.record_id ?? input.view_id ?? "missing",
      },
      decisions: [],
      runs: [],
      diagnostics: { skipped: reason },
    },
  };
}

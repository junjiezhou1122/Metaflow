import { ProcessorRuntime, createSurfaceStateProcessor, type ProcessorDefinition } from "@info/processor-runtime";
import type { ContextStore, StoredContextRecord } from "@info/core";
import { createYouTubeLearningProcessor } from "@info/views";

export const III_PROCESSOR_FUNCTIONS = {
  surfaceState: "processor::surface_state",
  youtubeLearning: "processor::youtube_learning",
} as const;

export type ProcessorWorkerDefinition = {
  function_id: string;
  triggers: string[];
  handler: (input: unknown) => Promise<unknown>;
};

export function createProcessorWorkerDefinitions(store: ContextStore): ProcessorWorkerDefinition[] {
  return [
    processorWorker(store, III_PROCESSOR_FUNCTIONS.surfaceState, createSurfaceStateProcessor()),
    processorWorker(store, III_PROCESSOR_FUNCTIONS.youtubeLearning, createYouTubeLearningProcessor()),
  ];
}

function processorWorker(
  store: ContextStore,
  functionId: string,
  processor: ProcessorDefinition,
): ProcessorWorkerDefinition {
  return {
    function_id: functionId,
    triggers: [`info.processor.${processor.id.replace(/^processor\./, "")}.requested`, "info.observation.ingested"],
    handler: async (input: unknown) => {
      const record = resolveRecord(input, store);
      if (!record) {
        return {
          ok: false,
          function_id: functionId,
          error: "No source observation found. Pass record_id or record.",
        };
      }
      const runtime = new ProcessorRuntime({
        store,
        processors: [processor],
      });
      const result = await runtime.processObservation(record, normalizePayload(input));
      return {
        ...result,
        function_id: functionId,
      };
    },
  };
}

function resolveRecord(input: unknown, store: ContextStore): StoredContextRecord | undefined {
  const payload = normalizePayload(input);
  const record = payload.record;
  if (isStoredContextRecord(record)) return record;
  const recordId = stringValue(payload.record_id) ?? stringValue(payload.id) ?? stringValue(payload.object_id);
  return recordId ? store.getRecord(recordId) : undefined;
}

function normalizePayload(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const body = record.body && typeof record.body === "object" ? record.body as Record<string, unknown> : undefined;
  const payload = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : undefined;
  return { ...record, ...(payload ?? {}), ...(body ?? {}) };
}

function isStoredContextRecord(value: unknown): value is StoredContextRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredContextRecord>;
  return typeof record.id === "string"
    && typeof record.schema?.name === "string"
    && typeof record.source?.type === "string"
    && typeof record.created_at === "string"
    && typeof record.updated_at === "string";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

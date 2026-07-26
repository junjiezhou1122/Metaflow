import { ContextRecordSchema } from "@info/core";
import type { ContextRecord, ContextStore, StoredContextRecord } from "@info/core";
import { III_CASCADE_FUNCTIONS } from "./cascade.js";
import type { IiiCascadeResult, IiiRuntimeClient, ViewWorkerInput } from "./types.js";

export const III_CONTEXT_FUNCTIONS = {
  ingest: "context::ingest",
} as const;

export type ContextIngestInput = ViewWorkerInput & {
  record?: ContextRecord;
  context_plugin_id?: string;
  plugin_id?: string;
};

export type ContextIngestResult = {
  ok: true;
  function_id: typeof III_CONTEXT_FUNCTIONS.ingest;
  id?: string;
  record?: StoredContextRecord;
  stored: boolean;
  deduped: boolean;
  duplicate_of?: string;
  cascade?: IiiCascadeResult;
};

export function createContextFunctionDefinitions(store: ContextStore, iii: IiiRuntimeClient) {
  return [
    {
      function_id: III_CONTEXT_FUNCTIONS.ingest,
      async handler(input: unknown): Promise<ContextIngestResult> {
        return ingestContextRecord(normalizeContextIngestInput(input), store, iii);
      },
      triggers: ["info.context.ingest.requested"],
    },
  ];
}

export async function ingestContextRecord(input: ContextIngestInput, store: ContextStore, iii?: IiiRuntimeClient): Promise<ContextIngestResult> {
  const parsed = ContextRecordSchema.safeParse(input.record ?? input);
  if (!parsed.success) {
    throw new Error(`invalid context record: ${JSON.stringify(parsed.error.flatten())}`);
  }

  const recordInput = store.withConnectorDefaults(parsed.data);
  if (recordInput.privacy?.retention === "do_not_store") {
    return {
      ok: true,
      function_id: III_CONTEXT_FUNCTIONS.ingest,
      stored: false,
      deduped: false,
    };
  }

  const ingest = store.insertRecordWithDedupe(recordInput);
  const record = ingest.record;
  if (!record) throw new Error("context ingest failed");

  store.appendRuntimeEvent({
    event_type: ingest.deduped ? "record_deduped" : "record_ingested",
    actor: record.source.type === "browser" || record.source.type === "screenpipe" ? "connector" : "system",
    status: "completed",
    subject_type: "record",
    subject_id: record.id,
    payload: {
      runtime: "@info/iii-runtime",
      schema: record.schema.name,
      source: record.source,
      title: record.content?.title,
      duplicate_of: ingest.duplicate_of,
      reason: ingest.reason,
    },
  });

  const shouldCascade = input.cascade !== false && !ingest.deduped && Boolean(iii?.trigger);
  const cascade = shouldCascade
    ? await iii!.trigger!({
      function_id: III_CASCADE_FUNCTIONS.recordIngested,
      payload: {
        ...input,
        record_id: record.id,
        source_record_ids: [record.id],
        cascade_depth: input.cascade_depth ?? 1,
      },
    }) as IiiCascadeResult
    : undefined;

  return {
    ok: true,
    function_id: III_CONTEXT_FUNCTIONS.ingest,
    id: record.id,
    record,
    stored: true,
    deduped: Boolean(ingest.deduped),
    duplicate_of: ingest.duplicate_of,
    cascade,
  };
}

function normalizeContextIngestInput(input: unknown): ContextIngestInput {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const body = record.body && typeof record.body === "object" ? record.body as Record<string, unknown> : undefined;
  const payload = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : undefined;
  return { ...record, ...(payload ?? {}), ...(body ?? {}) } as ContextIngestInput;
}

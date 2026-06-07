import { ContextStore } from "@info/core";
import { classifyCodingContext, CONTENT_CLASSIFIER_ID } from "./content-classifier.js";

export type PipelineTickOptions = {
  limit?: number;
  minutes?: number;
  dryRun?: boolean;
};

export type PipelineTickResult = {
  ok: boolean;
  plugin_id: string;
  scanned: number;
  produced: number;
  skipped_existing: number;
  dry_run: boolean;
  outputs: Array<{ input_id: string; output_id?: string; kind?: string; confidence?: number; skipped?: string }>;
};

export function runPipelineTick(options: PipelineTickOptions = {}, store = new ContextStore()): PipelineTickResult {
  const limit = options.limit ?? 50;
  const records = store.recent(limit, undefined, options.minutes ? { minutes: options.minutes } : undefined);
  const existing = existingClassifications(store, Math.max(limit * 6, 200));
  const outputs: PipelineTickResult["outputs"] = [];
  let produced = 0;
  let skipped_existing = 0;

  for (const record of records) {
    const output = classifyCodingContext(record);
    if (!output?.id) continue;
    if (existing.has(output.id) || store.getView(output.id)) {
      skipped_existing += 1;
      outputs.push({ input_id: record.id, output_id: output.id, skipped: "existing" });
      continue;
    }
    if (!options.dryRun) {
      store.appendRuntimeEvent({
        event_type: "plugin_run_started",
        actor: "plugin",
        status: "started",
        subject_type: "record",
        subject_id: record.id,
        plugin_id: CONTENT_CLASSIFIER_ID,
        related_records: [record.id],
        payload: { output_view_type: output.view_type, output_id: output.id },
      });
      const stored = store.upsertView(output);
      store.appendRuntimeEvent({
        event_type: "plugin_run_completed",
        actor: "plugin",
        status: "completed",
        subject_type: "view",
        subject_id: stored.id,
        plugin_id: CONTENT_CLASSIFIER_ID,
        related_records: [record.id],
        related_views: [stored.id],
        payload: {
          input_id: record.id,
          output_id: stored.id,
          output_view_type: stored.view_type,
          content_kind: stored.content?.content_kind,
          domain_area: stored.content?.domain_area,
          confidence: stored.confidence,
        },
      });
      existing.add(stored.id);
    }
    produced += 1;
    outputs.push({ input_id: record.id, output_id: output.id, kind: String(output.content?.content_kind ?? "unknown"), confidence: Number(output.content?.confidence ?? 0) });
  }

  const result: PipelineTickResult = {
    ok: true,
    plugin_id: CONTENT_CLASSIFIER_ID,
    scanned: records.length,
    produced,
    skipped_existing,
    dry_run: Boolean(options.dryRun),
    outputs,
  };
  if (!options.dryRun) {
    store.appendRuntimeEvent({
      event_type: "pipeline_tick_completed",
      actor: "system",
      status: "completed",
      subject_type: "runtime",
      plugin_id: CONTENT_CLASSIFIER_ID,
      payload: result,
    });
  }
  return result;
}

function existingClassifications(store: ContextStore, limit: number): Set<string> {
  const ids = new Set<string>();
  for (const view of store.listViews({ view_types: ["analysis.content_classification"], limit })) {
    if (view.compiler?.id === CONTENT_CLASSIFIER_ID) ids.add(view.id);
  }
  for (const record of store.recent(limit)) {
    if (record.schema.name === "derived.content_classification" && record.source.connector === CONTENT_CLASSIFIER_ID) ids.add(record.id);
  }
  return ids;
}

import type { ContextRecord, StoredContextRecord } from "@info/core";
import { ContextStore } from "@info/core";

export type FeedbackInput = {
  type: string;
  application_id: string;
  plugin_id?: string;
  view_id?: string;
  record_id?: string;
  value?: unknown;
  reason?: string;
  payload?: Record<string, unknown>;
  privacy?: ContextRecord["privacy"];
};

export type FeedbackResult = {
  ok: true;
  record: StoredContextRecord;
};

export function ingestFeedback(input: FeedbackInput, store = new ContextStore()): FeedbackResult {
  const relatedRecords = input.record_id ? [input.record_id] : [];
  const relatedViews = input.view_id ? [input.view_id] : [];
  const targetView = input.view_id ? store.getView(input.view_id) : undefined;
  const targetRecord = input.record_id ? store.getRecord(input.record_id) : undefined;
  const record = store.insertRecord({
    schema: { name: feedbackSchemaName(input.type), version: 1 },
    source: { type: "application", connector: input.application_id },
    content: {
      title: `Feedback: ${input.type}`,
      text: input.reason,
    },
    scope: input.plugin_id ? { plugin_id: input.plugin_id } : undefined,
    acquisition: {
      mode: "manual",
      actor: "user",
      reason: input.reason,
    },
    relations: {
      related_to: [...relatedViews, ...relatedRecords],
    },
    privacy: input.privacy ?? { level: "private", retention: "normal" },
    payload: {
      ...input.payload,
      value: input.value,
      application_id: input.application_id,
      view_id: input.view_id,
      record_id: input.record_id,
      ...(targetView ? { target_view_type: targetView.view_type } : {}),
      ...(targetRecord ? { target_record_schema: targetRecord.schema.name } : {}),
    },
  });

  store.appendRuntimeEvent({
    event_type: "feedback.received",
    actor: "user",
    status: "completed",
    subject_type: "record",
    subject_id: record.id,
    plugin_id: input.plugin_id,
    related_records: relatedRecords,
    related_views: relatedViews,
    payload: { feedback_type: input.type, application_id: input.application_id, value: input.value },
  });

  return { ok: true, record };
}

function feedbackSchemaName(type: string): string {
  const normalized = type.trim().replace(/^feedback\./, "").replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return `feedback.${normalized}`;
}

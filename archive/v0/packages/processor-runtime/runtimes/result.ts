import type { ObservationDraft, ProcessorHandlerResult, ViewDraft } from "../types.js";

export function parseProcessorHandlerResult(raw: unknown, label: string): ProcessorHandlerResult {
  if (!isRecord(raw)) throw new Error(`${label} must return a JSON object`);
  const views = Array.isArray(raw.views) ? raw.views.map((item, index) => parseViewDraft(item, `${label}.views[${index}]`)) : undefined;
  const observations = Array.isArray(raw.observations) ? raw.observations.map((item, index) => parseObservationDraft(item, `${label}.observations[${index}]`)) : undefined;
  const diagnostics = isRecord(raw.diagnostics) ? raw.diagnostics : undefined;
  return { views, observations, diagnostics };
}

function parseViewDraft(raw: unknown, label: string): ViewDraft {
  if (!isRecord(raw)) throw new Error(`${label} must be a JSON object`);
  if (typeof raw.type !== "string" || !raw.type.trim()) throw new Error(`${label}.type is required`);
  return raw as ViewDraft;
}

function parseObservationDraft(raw: unknown, label: string): ObservationDraft {
  if (!isRecord(raw)) throw new Error(`${label} must be a JSON object`);
  const schema = raw.schema;
  const source = raw.source;
  if (!isRecord(schema) || typeof schema.name !== "string" || typeof schema.version !== "number") {
    throw new Error(`${label}.schema.name and schema.version are required`);
  }
  if (!isRecord(source) || typeof source.type !== "string") {
    throw new Error(`${label}.source.type is required`);
  }
  return raw as ObservationDraft;
}

export function processorRuntimePayload(input: unknown, processor: unknown): Record<string, unknown> {
  return { input, processor };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

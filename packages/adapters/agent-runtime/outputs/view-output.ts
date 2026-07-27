import type { AgentSchemaValue, AgentTaskOutput } from "../types.js";

export function parseAgentTaskOutput(stdout: string): AgentTaskOutput {
  const parsed = JSON.parse(stdout) as unknown;
  const envelope = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  if (envelope?.is_error || /API Error:/i.test(String(envelope?.result ?? ""))) {
    throw new Error(String(envelope?.result ?? "agent runtime returned an error"));
  }

  const candidate = typeof envelope?.result === "string"
    ? JSON.parse(stripJsonCodeFence(envelope.result))
    : parsed;
  return normalizeAgentTaskOutput(candidate);
}

export function parseAgentSchemaValue(stdout: string): AgentSchemaValue {
  const parsed = JSON.parse(stdout) as unknown;
  const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  if (envelope?.is_error || /API Error:/i.test(String(envelope?.result ?? ""))) {
    throw new Error(String(envelope?.result ?? "agent runtime returned an error"));
  }
  const hasResultEnvelope = envelope !== undefined && Object.hasOwn(envelope, "result");
  const candidate = hasResultEnvelope && typeof envelope.result === "string"
    ? JSON.parse(stripJsonCodeFence(envelope.result)) as unknown
    : parsed;
  return normalizeAgentSchemaValue(candidate);
}

export function normalizeAgentSchemaValue(value: unknown): AgentSchemaValue {
  assertJsonCompatible(value, "$", new Set());
  return value;
}

export function normalizeAgentTaskOutput(value: unknown): AgentTaskOutput {
  if (!value || typeof value !== "object") throw new Error("agent runtime returned non-object output");
  const candidate = value as Record<string, unknown>;
  const unsupportedField = ["next_actions", "tasks", "tool_plans", "file_diffs", "diffs"].find(field => Object.hasOwn(candidate, field));
  if (unsupportedField) throw new Error(`unsupported agent output field: ${unsupportedField}`);
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) throw new Error("agent runtime output missing non-empty summary");
  return {
    summary: candidate.summary.trim(),
    analysis: candidate.analysis === undefined ? undefined : String(candidate.analysis),
    key_points: Array.isArray(candidate.key_points) ? candidate.key_points.map(String).slice(0, 12) : undefined,
    confidence: typeof candidate.confidence === "number" ? Math.max(0, Math.min(1, candidate.confidence)) : 0.5,
    views: normalizeAgentTaskOutputViews(candidate.views),
    raw: candidate,
  };
}

function normalizeAgentTaskOutputViews(value: unknown): AgentTaskOutput["views"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("agent runtime output views must be an array");
  return value.slice(0, 8).map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`agent runtime output view ${index} must be an object`);
    const candidate = item as Record<string, unknown>;
    const unsupportedField = ["next_actions", "tasks", "tool_plans", "file_diffs", "diffs"].find(field => Object.hasOwn(candidate, field));
    if (unsupportedField) throw new Error(`unsupported agent output view field: ${unsupportedField}`);
    const viewType = typeof candidate.view_type === "string" ? candidate.view_type.trim() : "";
    if (!viewType) throw new Error(`agent runtime output view ${index} missing view_type`);
    const viewTypeError = validateViewType(viewType);
    if (viewTypeError) throw new Error(viewTypeError);
    const content = candidate.content && typeof candidate.content === "object" && !Array.isArray(candidate.content)
      ? candidate.content as Record<string, unknown>
      : undefined;
    return {
      view_type: viewType,
      title: typeof candidate.title === "string" ? candidate.title.slice(0, 180) : undefined,
      summary: typeof candidate.summary === "string" ? candidate.summary.trim().slice(0, 1000) : undefined,
      purpose: typeof candidate.purpose === "string" ? candidate.purpose.slice(0, 500) : undefined,
      content,
      confidence: typeof candidate.confidence === "number" ? Math.max(0, Math.min(1, candidate.confidence)) : undefined,
      metadata: candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? candidate.metadata as Record<string, unknown>
        : undefined,
    };
  });
}

function validateViewType(viewType: string): string | undefined {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(viewType)) return `invalid agent output View type: ${viewType}`;
  if (/^(observation|feedback|episode|derived)\./.test(viewType)) return `agent output View type must not use record-like prefix: ${viewType}`;
  return undefined;
}

function assertJsonCompatible(value: unknown, path: string, ancestors: Set<object>): asserts value is AgentSchemaValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`Agent schema_value at ${path} must be JSON-compatible`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Agent schema_value at ${path} must be JSON-compatible`);
  }
  if (ancestors.has(value)) throw new TypeError(`Agent schema_value at ${path} must be JSON-compatible`);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Agent schema_value at ${path} must be JSON-compatible`);
    }
    if (Reflect.ownKeys(value).some(key => typeof key === "symbol" || !Object.prototype.propertyIsEnumerable.call(value, key))) {
      throw new TypeError(`Agent schema_value at ${path} must be JSON-compatible`);
    }
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new TypeError(`Agent schema_value at ${path} must be JSON-compatible`);
    }
    for (let index = 0; index < value.length; index += 1) {
      assertJsonCompatible(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonCompatible(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export function stripJsonCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

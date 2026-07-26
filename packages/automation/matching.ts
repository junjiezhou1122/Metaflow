import {
  TriggerOccurrenceSchema,
  type AutomationDefinition,
  type ExactViewRef,
  type TriggerDefinition,
  type TriggerOccurrence,
  type TriggerPredicate,
  type TriggerSignal,
} from "./contracts.js";
import type { JsonValue } from "@info/view";

export type TriggerMatchResult =
  | { matched: true; reason: string }
  | { matched: false; reason: string };

export class TriggerNotMatchedError extends Error {
  constructor(readonly reason: string) {
    super(`Trigger did not match: ${reason}`);
    this.name = "TriggerNotMatchedError";
  }
}

export function matchTrigger(trigger: TriggerDefinition, signal: TriggerSignal): TriggerMatchResult {
  if (trigger.kind !== signal.kind) return { matched: false, reason: `kind mismatch: ${signal.kind}` };
  if (trigger.source !== signal.source) return { matched: false, reason: `source mismatch: ${signal.source}` };
  if (trigger.event !== signal.event) return { matched: false, reason: `event mismatch: ${signal.event}` };

  if (trigger.kind === "accumulation") {
    const count = signal.payload.count;
    if (typeof count !== "number" || !Number.isFinite(count)) {
      return { matched: false, reason: "accumulation signal requires numeric payload.count" };
    }
    if (count < trigger.threshold) {
      return { matched: false, reason: `accumulation threshold not reached: ${count} < ${trigger.threshold}` };
    }
  }

  const predicate = "predicate" in trigger ? trigger.predicate : undefined;
  if (predicate && !evaluatePredicate(predicate, signal.payload)) {
    return { matched: false, reason: "predicate did not match" };
  }

  return { matched: true, reason: predicate ? "source, event, and predicate matched" : "source and event matched" };
}

export function createTriggerOccurrence(input: {
  automation: ExactViewRef;
  definition: AutomationDefinition;
  signal: TriggerSignal;
  match?: Extract<TriggerMatchResult, { matched: true }>;
}): TriggerOccurrence {
  const result = input.match ?? matchTrigger(input.definition.trigger, input.signal);
  if (!result.matched) throw new TriggerNotMatchedError(result.reason);

  return TriggerOccurrenceSchema.parse({
    id: [
      "automation-occurrence",
      input.automation.view_id,
      input.automation.revision,
      input.definition.trigger.id,
      input.signal.id,
    ].join(":"),
    automation: input.automation,
    trigger_id: input.definition.trigger.id,
    trigger_kind: input.definition.trigger.kind,
    source: input.signal.source,
    occurred_at: input.signal.occurred_at,
    idempotency_key: [
      input.automation.view_id,
      input.automation.revision,
      input.definition.trigger.id,
      input.signal.idempotency_key,
    ].join(":"),
    evidence: input.signal.evidence,
    ...(input.signal.runtime_override ? { runtime_override: input.signal.runtime_override } : {}),
    ...(input.signal.cascade ? { cascade: input.signal.cascade } : {}),
    payload: input.signal.payload,
    match: { matched: true, reason: result.reason },
  });
}

export function evaluatePredicate(predicate: TriggerPredicate, payload: Record<string, JsonValue>): boolean {
  switch (predicate.type) {
    case "all":
      return predicate.predicates.every(item => evaluatePredicate(item, payload));
    case "any":
      return predicate.predicates.some(item => evaluatePredicate(item, payload));
    case "not":
      return !evaluatePredicate(predicate.predicate, payload);
    case "field":
      return evaluateFieldPredicate(predicate, valueAtPath(payload, predicate.path));
  }
}

function evaluateFieldPredicate(
  predicate: Extract<TriggerPredicate, { type: "field" }>,
  actual: JsonValue | undefined,
): boolean {
  switch (predicate.operator) {
    case "exists":
      return actual !== undefined;
    case "eq":
      return equalJson(actual, predicate.value);
    case "not_eq":
      return !equalJson(actual, predicate.value);
    case "contains":
      if (typeof actual === "string" && typeof predicate.value === "string") return actual.includes(predicate.value);
      if (Array.isArray(actual)) return actual.some(item => equalJson(item, predicate.value));
      return false;
    case "starts_with":
      return typeof actual === "string" && typeof predicate.value === "string" && actual.startsWith(predicate.value);
    case "ends_with":
      return typeof actual === "string" && typeof predicate.value === "string" && actual.endsWith(predicate.value);
    case "matches":
      return typeof actual === "string" && typeof predicate.value === "string" && new RegExp(predicate.value).test(actual);
    case "gte":
      return typeof actual === "number" && typeof predicate.value === "number" && actual >= predicate.value;
    case "lte":
      return typeof actual === "number" && typeof predicate.value === "number" && actual <= predicate.value;
  }
}

function valueAtPath(payload: Record<string, JsonValue>, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = payload;
  for (const part of path.split(".")) {
    if (!current || Array.isArray(current) || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function equalJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => equalJson(item, right[index]));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equalJson(left[key], right[key]));
  }
  return false;
}

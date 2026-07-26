import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TriggerSignalSchema,
  type AutomationInvocationAttempt,
  type AutomationInvocationPredicateMatch,
} from "@info/automation";
import {
  ExecutionAttemptSchema,
  ExecutionRunSchema,
  type OperatorExecutionInvocation,
  type OperatorExecutionResult,
} from "@info/execution";
import { OperatorSnapshotSchema, type OperatorSnapshot } from "@info/transformation";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  TimestampSchema,
  ViewSchema,
  canonicalJson,
  type ExactViewRef,
  type JsonObject,
} from "@info/view";

export const III_SDK_VERSION = "0.19.2";
export const III_ENGINE_VERSION = "0.19.2";
export const III_AUTOMATION_FUNCTION_ID = "metaflow::automation::invoke::v1";
export const III_AUTOMATION_CONTRACT = "metaflow.automation.invoke.v1";
export const III_OPERATOR_CONTRACT = "metaflow.operator.execute.v1";
export const III_OPERATOR_CANCEL_CONTRACT = "metaflow.operator.cancel.v1";

export const IiiQueueConfigurationSchema = z.object({
  version: z.literal(1),
  name: z.literal("metaflow-automation-v1"),
  type: z.literal("standard"),
  concurrency: z.number().int().positive(),
  max_retries: z.number().int().nonnegative(),
  backoff_ms: z.number().int().positive(),
  poll_interval_ms: z.number().int().positive(),
  dlq: z.object({
    enabled: z.literal(true),
    inspection_function_id: z.literal("engine::queue::dlq_messages"),
  }).strict(),
}).strict();

export const METAFLOW_AUTOMATION_QUEUE = IiiQueueConfigurationSchema.parse({
  version: 1,
  name: "metaflow-automation-v1",
  type: "standard",
  concurrency: 4,
  max_retries: 3,
  backoff_ms: 1_000,
  poll_interval_ms: 100,
  dlq: {
    enabled: true,
    inspection_function_id: "engine::queue::dlq_messages",
  },
});

const AutomationPredicateMatchSchema = z.object({
  automation: ExactViewRefSchema,
  trigger_id: IdentifierSchema,
  signal_id: IdentifierSchema,
  predicate_digest: z.string().regex(/^[a-f0-9]{64}$/),
  matched: z.literal(true),
  reason: z.string().trim().min(1).max(20_000),
}).strict();

const AutomationAttemptSchema = z.object({
  id: IdentifierSchema,
  parent_attempt_id: IdentifierSchema.optional(),
  reason: z.enum(["retry", "alternative_context", "alternative_agent", "alternative_delivery"]),
}).strict();

export const IiiAutomationInvocationEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  contract: z.literal(III_AUTOMATION_CONTRACT),
  message_id: IdentifierSchema,
  correlation_id: z.string().trim().min(1).max(2_000),
  enqueued_at: TimestampSchema,
  queue: z.object({
    name: z.literal(METAFLOW_AUTOMATION_QUEUE.name),
    config_version: z.literal(METAFLOW_AUTOMATION_QUEUE.version),
  }).strict(),
  automation: ExactViewRefSchema,
  signal: TriggerSignalSchema,
  predicate_match: AutomationPredicateMatchSchema.optional(),
  attempt: AutomationAttemptSchema.optional(),
}).strict();

const OperatorInvocationSchema = z.object({
  run: ExecutionRunSchema,
  attempt: ExecutionAttemptSchema,
  inputs: z.array(z.object({
    role: IdentifierSchema,
    views: z.array(ViewSchema),
  }).strict()),
}).strict();

export const IiiOperatorInvocationEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  contract: z.literal(III_OPERATOR_CONTRACT),
  message_id: IdentifierSchema,
  operator: OperatorSnapshotSchema,
  invocation: OperatorInvocationSchema,
}).strict();

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const IiiOperatorExecutionResultSchema: z.ZodType<OperatorExecutionResult> = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    candidate: JsonValueSchema,
    cost_usd: z.number().finite().nonnegative().optional(),
    usage: JsonObjectSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    error: z.object({
      code: IdentifierSchema,
      message: z.string().trim().min(1),
      details: JsonObjectSchema.optional(),
    }).strict(),
    cost_usd: z.number().finite().nonnegative().optional(),
  }).strict(),
  z.object({
    status: z.literal("cancelled"),
    reason: z.string().trim().min(1).optional(),
    cost_usd: z.number().finite().nonnegative().optional(),
  }).strict(),
]);

export const IiiOperatorCancelRequestSchema = z.object({
  schema_version: z.literal(1),
  contract: z.literal(III_OPERATOR_CANCEL_CONTRACT),
  operator: OperatorSnapshotSchema,
  attempt_id: IdentifierSchema,
}).strict();

export const IiiOperatorCancelResponseSchema = z.object({
  accepted: z.literal(true),
  attempt_id: IdentifierSchema,
}).strict();

export const IiiAutomationHandlerResponseSchema = z.object({
  accepted: z.literal(true),
  status: z.enum(["ignored", "duplicate", "skipped", "succeeded", "failed"]),
  correlation_id: z.string().trim().min(1).max(2_000).optional(),
  run_id: IdentifierSchema.optional(),
}).strict();

export const IiiEnqueueReceiptSchema = z.object({
  messageReceiptId: IdentifierSchema,
}).strict();

export const IiiEngineWorkersResponseSchema = z.object({
  workers: z.array(z.object({
    name: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
    id: z.string(),
    runtime: z.string().nullable().optional(),
    status: z.string(),
  }).passthrough()),
}).strict();

export const IiiQueueTopicStatsSchema = z.object({
  depth: z.number().int().nonnegative(),
  consumer_count: z.number().int().nonnegative(),
  dlq_depth: z.number().int().nonnegative(),
  config: JsonValueSchema.nullable().optional(),
}).strict();

export const IiiFunctionDetailSchema = z.object({
  function_id: IdentifierSchema,
  worker_name: IdentifierSchema,
  description: z.string().optional(),
  request_schema: JsonValueSchema.optional(),
  response_schema: JsonValueSchema.optional(),
  metadata: JsonValueSchema.optional(),
  registered_triggers: z.array(JsonValueSchema),
}).strict();

export const IiiDeadLetterMessageSchema = z.object({
  id: IdentifierSchema,
  payload: JsonValueSchema,
  error: z.string(),
  failed_at: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  size_bytes: z.number().int().nonnegative(),
}).strict();

export const IiiDeadLetterMessagesSchema = z.array(IiiDeadLetterMessageSchema);

export const IiiRuntimeEventTypeSchema = z.enum([
  "iii.worker.registration_started",
  "iii.worker.compatibility_verified",
  "iii.worker.function_registered",
  "iii.worker.registered",
  "iii.worker.disconnected",
  "iii.worker.shutdown_started",
  "iii.worker.shutdown_completed",
  "iii.queue.enqueue_started",
  "iii.queue.enqueued",
  "iii.queue.received",
  "iii.queue.completed",
  "iii.queue.duplicate",
  "iii.queue.retryable_failure",
  "iii.queue.cancelled",
  "iii.queue.dlq_observed",
  "iii.queue.dlq_terminalized",
  "iii.queue.dlq_inspection_failed",
  "iii.operator.received",
  "iii.operator.event",
  "iii.operator.completed",
  "iii.operator.failed",
  "iii.operator.cancelled",
]);

export const IiiRuntimeEventSchema = z.object({
  schema_version: z.literal(1),
  id: IdentifierSchema,
  type: IiiRuntimeEventTypeSchema,
  occurred_at: TimestampSchema,
  worker: IdentifierSchema,
  queue: IdentifierSchema.optional(),
  function_id: IdentifierSchema.optional(),
  message_id: IdentifierSchema.optional(),
  receipt_id: IdentifierSchema.optional(),
  correlation_id: z.string().trim().min(1).max(2_000).optional(),
  automation: ExactViewRefSchema.optional(),
  signal_id: IdentifierSchema.optional(),
  run_id: IdentifierSchema.optional(),
  attempt_id: IdentifierSchema.optional(),
  cascade_attempt_id: IdentifierSchema.optional(),
  payload: JsonObjectSchema.default({}),
}).strict();

export type IiiQueueConfiguration = z.infer<typeof IiiQueueConfigurationSchema>;
export type IiiAutomationInvocationEnvelope = z.infer<typeof IiiAutomationInvocationEnvelopeSchema>;
export type IiiOperatorInvocationEnvelope = z.infer<typeof IiiOperatorInvocationEnvelopeSchema>;
export type IiiDeadLetterMessage = z.infer<typeof IiiDeadLetterMessageSchema>;
export type IiiRuntimeEvent = z.infer<typeof IiiRuntimeEventSchema>;

export interface IiiRuntimeEventSink {
  emit(event: IiiRuntimeEvent): void | Promise<void>;
}

export function automationMessageId(input: {
  automation: ExactViewRef;
  signal_id: string;
  predicate_match?: AutomationInvocationPredicateMatch;
  attempt?: AutomationInvocationAttempt;
  cascade_attempt_id?: string;
}): string {
  return `iii-message:${digest({
    automation: input.automation,
    signal_id: input.signal_id,
    predicate_digest: input.predicate_match?.predicate_digest ?? null,
    attempt_id: input.attempt?.id ?? null,
    cascade_attempt_id: input.cascade_attempt_id ?? null,
  })}`;
}

export function automationCorrelationId(automation: ExactViewRef, triggerId: string, signalId: string): string {
  return ["automation-occurrence", automation.view_id, automation.revision, triggerId, signalId].join(":");
}

export function operatorKey(operator: OperatorSnapshot): string {
  return `${operator.id}@${operator.revision}`;
}

export function iiiOperatorFunctionId(operator: OperatorSnapshot): string {
  const readable = operator.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "operator";
  return `metaflow::operator::${readable}::r${operator.revision}::${digest(operator).slice(0, 16)}::v1`;
}

export function iiiOperatorCancelFunctionId(operator: OperatorSnapshot): string {
  return `${iiiOperatorFunctionId(operator)}::cancel`;
}

export function operatorInvocationEnvelope(
  invocation: OperatorExecutionInvocation,
): IiiOperatorInvocationEnvelope {
  return IiiOperatorInvocationEnvelopeSchema.parse({
    schema_version: 1,
    contract: III_OPERATOR_CONTRACT,
    message_id: `iii-operator:${digest({ run_id: invocation.run.id, attempt_id: invocation.attempt.id })}`,
    operator: invocation.run.frozen.transformation.operator,
    invocation,
  });
}

export function assertCompatibleQueueConfiguration(input: unknown): IiiQueueConfiguration {
  const parsed = IiiQueueConfigurationSchema.parse(input);
  if (canonicalJson(parsed) !== canonicalJson(METAFLOW_AUTOMATION_QUEUE)) {
    throw new IiiRuntimeError(
      `III queue configuration is incompatible with v${METAFLOW_AUTOMATION_QUEUE.version}`,
      "queue_config_incompatible",
    );
  }
  return parsed;
}

export type IiiRuntimeErrorCode =
  | "sdk_version_incompatible"
  | "engine_version_incompatible"
  | "function_contract_incompatible"
  | "queue_config_incompatible"
  | "signal_payload_not_descriptor_safe"
  | "registration_failed"
  | "enqueue_failed"
  | "invocation_cancelled"
  | "automation_resolution_failed"
  | "automation_occurrence_incomplete"
  | "operator_mismatch"
  | "dlq_inspection_failed"
  | "trace_persistence_failed";

export class IiiRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: IiiRuntimeErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IiiRuntimeError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

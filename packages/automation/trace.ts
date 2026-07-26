import { z } from "zod";
import { ExactViewRefSchema, JsonValueSchema } from "@info/view";
import { ExactTransformationRefSchema } from "@info/transformation";

export const AutomationTraceEventTypeSchema = z.enum([
  "automation.occurrence_ignored",
  "automation.occurrence_received",
  "automation.occurrence_reserved",
  "automation.occurrence_deduped",
  "automation.occurrence_rejected",
  "automation.attempt_linked",
  "automation.context_resolved",
  "automation.context_failed",
  "automation.run_started",
  "automation.run_progress",
  "automation.agent_event",
  "automation.result_committed",
  "automation.execution_failed",
  "automation.delivery_attempted",
  "automation.delivery_succeeded",
  "automation.delivery_expired",
  "automation.delivery_suppressed",
  "automation.delivery_unavailable",
  "automation.delivery_failed",
  "automation.feedback_recorded",
  "automation.occurrence_completed",
  "automation.runtime_failed",
]);

export const AutomationFailureStageSchema = z.enum([
  "occurrence",
  "context",
  "authorization",
  "execution",
  "validation",
  "commit",
  "delivery",
  "finalization",
  "trace",
]);

export const AutomationFailureSchema = z.object({
  stage: AutomationFailureStageSchema,
  code: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(20_000),
  failure_view: ExactViewRefSchema.optional(),
  diagnostics: z.record(JsonValueSchema).optional(),
}).strict();

export const AutomationAgentEventTypeSchema = z.enum([
  "agent.runtime_selected",
  "agent.runtime_event",
  "agent.progress",
  "agent.permission_requested",
  "agent.completed",
  "agent.cancelled",
  "agent.failed",
]);

export const AutomationTargetTraceEventSchema = z.object({
  type: AutomationAgentEventTypeSchema,
  occurred_at: z.string().datetime({ offset: true }),
  invocation_id: z.string().trim().min(1).max(2_000),
  run_id: z.string().trim().min(1).max(1_000),
  transformation: ExactTransformationRefSchema,
  runtime: z.string().trim().min(1).max(240),
  attempt_id: z.string().trim().min(1).max(2_000).optional(),
  parent_attempt_id: z.string().trim().min(1).max(2_000).optional(),
  payload: z.record(JsonValueSchema).optional(),
  failure: AutomationFailureSchema.optional(),
}).strict();

const AutomationAgentBridgeEventSchema = AutomationTargetTraceEventSchema.extend({
  correlation_id: z.string().trim().min(1).max(2_000),
}).strict();

export const AutomationTraceEventSchema = z.object({
  schema_version: z.literal(1).default(1),
  type: AutomationTraceEventTypeSchema,
  source: z.enum(["automation", "agent", "delivery", "feedback"]).default("automation"),
  occurred_at: z.string().datetime({ offset: true }),
  correlation_id: z.string().trim().min(1).max(2_000),
  automation: ExactViewRefSchema,
  occurrence_id: z.string().trim().min(1).max(2_000).optional(),
  run_id: z.string().trim().min(1).max(1_000).optional(),
  attempt_id: z.string().trim().min(1).max(2_000).optional(),
  parent_attempt_id: z.string().trim().min(1).max(2_000).optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  failure: AutomationFailureSchema.optional(),
  payload: z.record(JsonValueSchema).default({}),
}).strict().superRefine((event, context) => {
  if (event.parent_attempt_id && !event.attempt_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "parent_attempt_id requires attempt_id",
      path: ["attempt_id"],
    });
  }
  if (event.type.endsWith("_failed") && !event.failure) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${event.type} requires a structured failure`,
      path: ["failure"],
    });
  }
});

export type AutomationTraceEvent = z.output<typeof AutomationTraceEventSchema>;
export type AutomationTraceEventInput = z.input<typeof AutomationTraceEventSchema>;
export type AutomationTraceEventType = z.infer<typeof AutomationTraceEventTypeSchema>;
export type AutomationFailure = z.infer<typeof AutomationFailureSchema>;
export type AutomationTargetTraceEvent = z.infer<typeof AutomationTargetTraceEventSchema>;

export type AutomationTraceRecord = AutomationTraceEvent & {
  sequence: number;
  recorded_at: string;
};

export interface AutomationEventSink {
  emit(event: AutomationTraceEventInput): void | Promise<void>;
}

export interface AutomationTraceStore extends AutomationEventSink {
  query(input: {
    correlation_id: string;
    after_sequence?: number;
    limit?: number;
  }): Promise<AutomationTraceRecord[]>;
}

export class InMemoryAutomationTraceStore implements AutomationTraceStore {
  private readonly records: AutomationTraceRecord[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async emit(input: AutomationTraceEventInput): Promise<void> {
    const event = AutomationTraceEventSchema.parse(input);
    this.records.push({
      ...event,
      sequence: this.records.length + 1,
      recorded_at: this.now().toISOString(),
    });
  }

  async query(input: {
    correlation_id: string;
    after_sequence?: number;
    limit?: number;
  }): Promise<AutomationTraceRecord[]> {
    const limit = input.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Automation trace query limit must be an integer between 1 and 10000");
    }
    return this.records
      .filter(record => record.correlation_id === input.correlation_id)
      .filter(record => record.sequence > (input.after_sequence ?? 0))
      .slice(0, limit);
  }
}

export function parseAutomationTraceEvent(input: unknown): AutomationTraceEvent {
  return AutomationTraceEventSchema.parse(input);
}

export function createAutomationAgentTraceBridge(input: {
  correlation_id: string;
  trace(event: AutomationTargetTraceEvent): Promise<void>;
}): { emit(event: unknown): Promise<void> } {
  return {
    async emit(event: unknown) {
      const parsed = AutomationAgentBridgeEventSchema.parse(event);
      if (parsed.correlation_id !== input.correlation_id) {
        throw new Error(
          `Agent trace correlation mismatch: ${parsed.correlation_id} != ${input.correlation_id}`,
        );
      }
      const { correlation_id: _correlationId, ...targetEvent } = parsed;
      await input.trace(targetEvent);
    },
  };
}

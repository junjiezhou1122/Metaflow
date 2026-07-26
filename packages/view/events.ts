import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  TimestampSchema,
} from "./schema.js";
import { ReactiveCascadeContextSchema } from "./cascade.js";

export const ViewCommitOriginSchema = z.object({
  kind: z.enum(["capture", "execution", "operation", "migration", "system"]),
  id: IdentifierSchema,
}).strict();

export const CommittedViewSummarySchema = z.object({
  ref: ExactViewRefSchema,
  role: z.enum(["raw", "derived"]),
  schema: z.object({
    name: IdentifierSchema,
    version: z.number().int().positive(),
    mode: z.enum(["freeform", "strict"]),
  }).strict(),
  retention: z.enum(["normal", "archive"]),
}).strict();

export const ViewCommittedEventSchema = z.object({
  event_id: IdentifierSchema,
  event_type: z.literal("view.committed"),
  event_version: z.literal(1),
  batch_id: IdentifierSchema,
  transaction_id: IdentifierSchema,
  committed_at: TimestampSchema,
  origin: ViewCommitOriginSchema,
  cascade: ReactiveCascadeContextSchema.optional(),
  views: z.array(CommittedViewSummarySchema).min(1),
}).strict().superRefine((event, context) => {
  const refs = event.views.map(item => `${item.ref.view_id}@${item.ref.revision}`);
  if (new Set(refs).size !== refs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["views"],
      message: "ViewCommitted event cannot contain duplicate exact View revisions",
    });
  }
});

export type ViewCommitOrigin = z.infer<typeof ViewCommitOriginSchema>;
export type CommittedViewSummary = z.infer<typeof CommittedViewSummarySchema>;
export type ViewCommittedEvent = z.infer<typeof ViewCommittedEventSchema>;

export const ViewCommitContextSchema = z.object({
  batch_id: IdentifierSchema.optional(),
  committed_at: TimestampSchema.optional(),
  origin: ViewCommitOriginSchema,
  cascade: ReactiveCascadeContextSchema.optional(),
}).strict();

export const ViewCommittedOutboxFailureSchema = z.object({
  code: IdentifierSchema,
  message: z.string().trim().min(1).max(2_000),
}).strict();

export const ViewCommittedOutboxStatusSchema = z.enum([
  "pending",
  "leased",
  "acknowledged",
  "poison",
]);

export const ViewCommittedOutboxEntrySchema = z.object({
  sequence: z.number().int().positive(),
  event: ViewCommittedEventSchema,
  status: ViewCommittedOutboxStatusSchema,
  delivery_attempts: z.number().int().nonnegative(),
  available_at: TimestampSchema,
  leased_by: IdentifierSchema.optional(),
  lease_expires_at: TimestampSchema.optional(),
  acknowledged_at: TimestampSchema.optional(),
  poisoned_at: TimestampSchema.optional(),
  last_error: ViewCommittedOutboxFailureSchema.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.status === "leased" && (!entry.leased_by || !entry.lease_expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "leased outbox entries require a lease owner and expiry",
    });
  }
  if (entry.status !== "leased" && (entry.leased_by || entry.lease_expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "only leased outbox entries may retain lease metadata",
    });
  }
  if (entry.status === "acknowledged" && !entry.acknowledged_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acknowledged_at"],
      message: "acknowledged outbox entries require acknowledged_at",
    });
  }
  if (entry.status !== "acknowledged" && entry.acknowledged_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acknowledged_at"],
      message: "only acknowledged outbox entries may retain acknowledged_at",
    });
  }
  if (entry.status === "poison" && (!entry.poisoned_at || !entry.last_error)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["poisoned_at"],
      message: "poison outbox entries require failure evidence",
    });
  }
  if (entry.status !== "poison" && entry.poisoned_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["poisoned_at"],
      message: "only poison outbox entries may retain poisoned_at",
    });
  }
});

export const LeaseViewCommittedEventsInputSchema = z.object({
  consumer_id: IdentifierSchema,
  leased_at: TimestampSchema,
  lease_duration_ms: z.number().int().positive().max(86_400_000),
  limit: z.number().int().positive().max(1_000),
}).strict();

export const AcknowledgeViewCommittedEventInputSchema = z.object({
  event_id: IdentifierSchema,
  consumer_id: IdentifierSchema,
  acknowledged_at: TimestampSchema,
}).strict();

export const FailViewCommittedEventInputSchema = z.object({
  event_id: IdentifierSchema,
  consumer_id: IdentifierSchema,
  failed_at: TimestampSchema,
  failure: ViewCommittedOutboxFailureSchema,
  retry_at: TimestampSchema.optional(),
}).strict();

export const ReplayViewCommittedEventInputSchema = z.object({
  event_id: IdentifierSchema,
  requested_at: TimestampSchema,
}).strict();

export const ListViewCommittedEventsInputSchema = z.object({
  statuses: z.array(ViewCommittedOutboxStatusSchema).min(1).optional(),
  limit: z.number().int().positive().max(10_000).default(100),
}).strict();

export type ViewCommitContext = z.infer<typeof ViewCommitContextSchema>;
export type ViewCommittedOutboxFailure = z.infer<typeof ViewCommittedOutboxFailureSchema>;
export type ViewCommittedOutboxStatus = z.infer<typeof ViewCommittedOutboxStatusSchema>;
export type ViewCommittedOutboxEntry = z.infer<typeof ViewCommittedOutboxEntrySchema>;
export type LeaseViewCommittedEventsInput = z.infer<typeof LeaseViewCommittedEventsInputSchema>;
export type AcknowledgeViewCommittedEventInput = z.infer<typeof AcknowledgeViewCommittedEventInputSchema>;
export type FailViewCommittedEventInput = z.infer<typeof FailViewCommittedEventInputSchema>;
export type ReplayViewCommittedEventInput = z.infer<typeof ReplayViewCommittedEventInputSchema>;
export type ListViewCommittedEventsInput = z.input<typeof ListViewCommittedEventsInputSchema>;

export class ViewCommittedEventValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.ZodIssue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewCommittedEventValidationError";
  }
}

export interface ViewCommittedEventPublisher {
  publish(event: ViewCommittedEvent): Promise<void>;
}

export interface ViewCommittedEventConsumer {
  handle(event: ViewCommittedEvent): Promise<void>;
}

export interface ViewCommittedOutbox {
  leaseEvents(input: LeaseViewCommittedEventsInput): Promise<ViewCommittedOutboxEntry[]>;
  acknowledgeEvent(input: AcknowledgeViewCommittedEventInput): Promise<ViewCommittedOutboxEntry>;
  failEvent(input: FailViewCommittedEventInput): Promise<ViewCommittedOutboxEntry>;
  replayEvent(input: ReplayViewCommittedEventInput): Promise<ViewCommittedOutboxEntry>;
  getEvent(eventId: string): Promise<ViewCommittedOutboxEntry | undefined>;
  listEvents(input?: ListViewCommittedEventsInput): Promise<ViewCommittedOutboxEntry[]>;
}

export type ViewCommittedOutboxErrorCode =
  | "invalid_request"
  | "not_found"
  | "lease_conflict"
  | "replay_forbidden"
  | "corrupt_event"
  | "storage_failure";

export class ViewCommittedOutboxError extends Error {
  constructor(
    message: string,
    readonly code: ViewCommittedOutboxErrorCode,
    readonly details: {
      operation: string;
      event_id?: string;
      consumer_id?: string;
      sequence?: number;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewCommittedOutboxError";
  }
}

export type DispatchViewCommittedEventsReport = {
  leased: number;
  acknowledged: string[];
  retried: string[];
  poisoned: string[];
};

export class ViewCommittedDispatchError extends Error {
  constructor(
    readonly report: DispatchViewCommittedEventsReport,
    options?: ErrorOptions,
  ) {
    super("one or more ViewCommitted events failed publication", options);
    this.name = "ViewCommittedDispatchError";
  }
}

export class ViewCommittedOutboxDispatcher {
  private readonly now: () => string;

  constructor(private readonly options: {
    outbox: ViewCommittedOutbox;
    publisher: ViewCommittedEventPublisher;
    consumer_id: string;
    lease_duration_ms?: number;
    max_delivery_attempts?: number;
    retry_delay_ms?: number;
    now?: () => string;
  }) {
    if (!IdentifierSchema.safeParse(options.consumer_id).success) {
      throw new ViewCommittedOutboxError("consumer_id is invalid", "invalid_request", {
        operation: "outbox_dispatcher_initialize",
      });
    }
    if (!Number.isInteger(options.lease_duration_ms ?? 30_000)
      || (options.lease_duration_ms ?? 30_000) < 1
      || (options.lease_duration_ms ?? 30_000) > 86_400_000) {
      throw new ViewCommittedOutboxError("lease_duration_ms must be an integer between 1 and 86400000", "invalid_request", {
        operation: "outbox_dispatcher_initialize",
        consumer_id: options.consumer_id,
      });
    }
    if (!Number.isInteger(options.max_delivery_attempts ?? 3) || (options.max_delivery_attempts ?? 3) < 1) {
      throw new ViewCommittedOutboxError("max_delivery_attempts must be a positive integer", "invalid_request", {
        operation: "outbox_dispatcher_initialize",
        consumer_id: options.consumer_id,
      });
    }
    if (!Number.isInteger(options.retry_delay_ms ?? 1_000) || (options.retry_delay_ms ?? 1_000) < 0) {
      throw new ViewCommittedOutboxError("retry_delay_ms must be a non-negative integer", "invalid_request", {
        operation: "outbox_dispatcher_initialize",
        consumer_id: options.consumer_id,
      });
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async dispatch(input: { limit?: number } = {}): Promise<DispatchViewCommittedEventsReport> {
    const leasedAt = TimestampSchema.parse(this.now());
    const entries = await this.options.outbox.leaseEvents({
      consumer_id: this.options.consumer_id,
      leased_at: leasedAt,
      lease_duration_ms: this.options.lease_duration_ms ?? 30_000,
      limit: input.limit ?? 100,
    });
    const report: DispatchViewCommittedEventsReport = {
      leased: entries.length,
      acknowledged: [],
      retried: [],
      poisoned: [],
    };
    const failures: unknown[] = [];
    for (const entry of entries) {
      try {
        await publishViewCommittedEvent(this.options.publisher, entry.event);
        await this.options.outbox.acknowledgeEvent({
          event_id: entry.event.event_id,
          consumer_id: this.options.consumer_id,
          acknowledged_at: TimestampSchema.parse(this.now()),
        });
        report.acknowledged.push(entry.event.event_id);
      } catch (error) {
        const failedAt = TimestampSchema.parse(this.now());
        const exhausted = entry.delivery_attempts >= (this.options.max_delivery_attempts ?? 3);
        const retryAt = exhausted
          ? undefined
          : new Date(Date.parse(failedAt) + (this.options.retry_delay_ms ?? 1_000)).toISOString();
        try {
          await this.options.outbox.failEvent({
            event_id: entry.event.event_id,
            consumer_id: this.options.consumer_id,
            failed_at: failedAt,
            failure: publisherFailure(error),
            ...(retryAt ? { retry_at: retryAt } : {}),
          });
          (exhausted ? report.poisoned : report.retried).push(entry.event.event_id);
        } catch (recordError) {
          failures.push(new AggregateError([error, recordError], `publication and failure recording failed for ${entry.event.event_id}`));
          continue;
        }
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new ViewCommittedDispatchError(report, { cause: new AggregateError(failures) });
    }
    return report;
  }
}

export function parseViewCommittedEvent(input: unknown): ViewCommittedEvent {
  const parsed = ViewCommittedEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new ViewCommittedEventValidationError(
      "invalid ViewCommitted event",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function publishViewCommittedEvent(
  publisher: ViewCommittedEventPublisher,
  input: unknown,
): Promise<ViewCommittedEvent> {
  const event = parseViewCommittedEvent(input);
  await publisher.publish(event);
  return event;
}

function publisherFailure(error: unknown): ViewCommittedOutboxFailure {
  const message = error instanceof Error ? error.message : String(error);
  return ViewCommittedOutboxFailureSchema.parse({
    code: "publisher_failure",
    message: message.trim().slice(0, 2_000) || "publisher failed without a message",
  });
}

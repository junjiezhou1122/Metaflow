import { z } from "zod";
import {
  ExactViewRefSchema,
  JsonValueSchema,
  ReactiveCascadeContextSchema,
  parseView,
  type ExactViewRef,
  type JsonValue,
  type View,
} from "@info/view";
import { ExactTransformationRefSchema } from "@info/transformation";

const IdentifierSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().datetime({ offset: true });

export type TriggerPredicate =
  | {
      type: "field";
      path: string;
      operator: "eq" | "not_eq" | "contains" | "starts_with" | "ends_with" | "matches" | "exists" | "gte" | "lte";
      value?: JsonValue;
    }
  | { type: "all"; predicates: TriggerPredicate[] }
  | { type: "any"; predicates: TriggerPredicate[] }
  | { type: "not"; predicate: TriggerPredicate };

const FieldPredicateSchema = z.object({
  type: z.literal("field"),
  path: z.string().trim().min(1).max(500),
  operator: z.enum(["eq", "not_eq", "contains", "starts_with", "ends_with", "matches", "exists", "gte", "lte"]),
  value: JsonValueSchema.optional(),
}).strict().superRefine((predicate, context) => {
  if (predicate.operator !== "exists" && predicate.value === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${predicate.operator} requires a value`,
      path: ["value"],
    });
  }
  if (predicate.operator === "matches" && typeof predicate.value === "string") {
    try {
      new RegExp(predicate.value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        path: ["value"],
      });
    }
  }
  if ((predicate.operator === "gte" || predicate.operator === "lte") && typeof predicate.value !== "number") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${predicate.operator} requires a numeric value`,
      path: ["value"],
    });
  }
});

export const TriggerPredicateSchema: z.ZodType<TriggerPredicate> = z.lazy(() => z.union([
  FieldPredicateSchema,
  z.object({
    type: z.literal("all"),
    predicates: z.array(TriggerPredicateSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal("any"),
    predicates: z.array(TriggerPredicateSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal("not"),
    predicate: TriggerPredicateSchema,
  }).strict(),
]));

const TriggerBaseShape = {
  id: IdentifierSchema,
  source: IdentifierSchema,
  event: IdentifierSchema,
} as const;

const UserTriggerSchema = z.object({
  ...TriggerBaseShape,
  kind: z.literal("user"),
  predicate: TriggerPredicateSchema.optional(),
}).strict();

const EventTriggerSchema = z.object({
  ...TriggerBaseShape,
  kind: z.literal("event"),
  predicate: TriggerPredicateSchema.optional(),
}).strict();

const ScheduleTriggerSchema = z.object({
  ...TriggerBaseShape,
  kind: z.literal("schedule"),
  schedule: z.object({
    format: z.literal("cron"),
    expression: z.string().trim().min(1).max(500),
    timezone: z.string().trim().min(1).refine(isTimeZone, "invalid IANA timezone"),
    misfire: z.object({
      policy: z.literal("catch_up"),
      max_periods: z.number().int().positive().max(366).default(7),
    }).strict().default({ policy: "catch_up", max_periods: 7 }),
  }).strict(),
}).strict();

const AccumulationTriggerSchema = z.object({
  ...TriggerBaseShape,
  kind: z.literal("accumulation"),
  window_ms: z.number().int().positive(),
  threshold: z.number().int().positive(),
  predicate: TriggerPredicateSchema.optional(),
}).strict();

export const TriggerDefinitionSchema = z.union([
  UserTriggerSchema,
  EventTriggerSchema,
  ScheduleTriggerSchema,
  AccumulationTriggerSchema,
]);

export const AutomationContextSourceSchema = z.union([
  z.object({
    kind: z.literal("trigger_evidence"),
    schema_name: IdentifierSchema.optional(),
    source: IdentifierSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("view_ref"),
    ref: ExactViewRefSchema,
  }).strict(),
  z.object({
    kind: z.literal("view_query"),
    schema_name: IdentifierSchema.optional(),
    schema_names: z.array(IdentifierSchema).min(1).max(100).optional(),
    role: z.enum(["raw", "derived"]).optional(),
    text: z.string().trim().min(1).optional(),
    time_range: z.object({
      kind: z.literal("occurrence_period"),
      basis: z.enum(["observed_at", "created_at"]),
    }).strict().optional(),
    limit: z.number().int().positive().max(100).default(1),
  }).strict().superRefine((value, context) => {
    if (value.schema_name !== undefined && value.schema_names !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "view_query schema_name and schema_names are mutually exclusive",
        path: ["schema_names"],
      });
    }
    if (
      value.schema_name === undefined
      && value.schema_names === undefined
      && value.role === undefined
      && value.text === undefined
      && value.time_range === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "view_query requires a schema, role, text, or time_range filter",
      });
    }
  }),
]);

export const AutomationContextBindingSchema = z.object({
  role: IdentifierSchema,
  required: z.boolean().default(true),
  sources: z.array(AutomationContextSourceSchema).min(1),
}).strict();

const TargetSchema = z.discriminatedUnion("kind", [
  ExactTransformationRefSchema.extend({
    kind: z.literal("transformation"),
  }).strict(),
  z.object({
    kind: z.literal("operation"),
    name: IdentifierSchema,
    version: z.number().int().positive(),
  }).strict(),
]);

const DeliverySchema = z.object({
  surface: IdentifierSchema,
  urgency: z.enum(["glance", "interrupt", "background"]),
  replacement: z.enum(["replace", "keep_existing"]).default("replace"),
  show_progress: z.boolean().default(false),
  expires_after_ms: z.number().int().positive().optional(),
  actions: z.array(z.enum(["accept", "dismiss", "later", "cancel", "retry", "correct"])).default([]),
}).strict();

const AutomationLimitsSchema = z.object({
  dedupe_window_ms: z.number().int().nonnegative().default(0),
  cooldown_ms: z.number().int().nonnegative().default(0),
  max_concurrency: z.number().int().positive().default(1),
  timeout_ms: z.number().int().positive().optional(),
}).strict();

export const AutomationDefinitionSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(true),
  trigger: TriggerDefinitionSchema,
  target: TargetSchema,
  input_mapping: z.array(AutomationContextBindingSchema).default([]),
  delivery: z.array(DeliverySchema).default([]),
  limits: AutomationLimitsSchema.default({}),
}).strict();

export const SchedulePeriodSchema = z.object({
  start: TimestampSchema,
  end: TimestampSchema,
}).strict().superRefine((period, context) => {
  if (Date.parse(period.start) >= Date.parse(period.end)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "schedule period start must be before end",
      path: ["end"],
    });
  }
});

export const ScheduleTriggerPayloadSchema = z.object({
  schedule: z.object({
    expression: z.string().trim().min(1).max(500),
    timezone: z.string().trim().min(1).refine(isTimeZone, "invalid IANA timezone"),
  }).strict(),
  period: SchedulePeriodSchema,
  dispatch: z.object({
    mode: z.enum(["scheduled", "manual_replay"]),
    state: z.enum(["on_time", "delayed", "missed", "manual_replay"]),
    detected_at: TimestampSchema,
  }).strict(),
  replay: z.object({
    id: IdentifierSchema,
    reason: z.string().trim().min(1).max(2_000),
    parent_signal_id: IdentifierSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((payload, context) => {
  const manual = payload.dispatch.mode === "manual_replay";
  if (manual !== (payload.replay !== undefined) || manual !== (payload.dispatch.state === "manual_replay")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "manual replay dispatch requires replay identity and manual_replay state",
      path: ["replay"],
    });
  }
});

export const TriggerSignalSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["user", "event", "schedule", "accumulation"]),
  source: IdentifierSchema,
  event: IdentifierSchema,
  occurred_at: TimestampSchema,
  idempotency_key: z.string().trim().min(1).max(1000),
  evidence: z.array(ExactViewRefSchema).default([]),
  runtime_override: z.object({
    runtime: IdentifierSchema,
    requested_by: z.literal("user"),
    requested_name: IdentifierSchema.optional(),
  }).strict().optional(),
  cascade: ReactiveCascadeContextSchema.optional(),
  payload: z.record(JsonValueSchema).default({}),
}).strict().superRefine((signal, context) => {
  if (signal.kind !== "schedule") return;
  const parsed = ScheduleTriggerPayloadSchema.safeParse(signal.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    }
  }
});

export const TriggerOccurrenceSchema = z.object({
  id: z.string().trim().min(1).max(2000),
  automation: ExactViewRefSchema,
  trigger_id: IdentifierSchema,
  trigger_kind: z.enum(["user", "event", "schedule", "accumulation"]),
  source: IdentifierSchema,
  occurred_at: TimestampSchema,
  idempotency_key: z.string().trim().min(1).max(2000),
  evidence: z.array(ExactViewRefSchema),
  runtime_override: z.object({
    runtime: IdentifierSchema,
    requested_by: z.literal("user"),
    requested_name: IdentifierSchema.optional(),
  }).strict().optional(),
  cascade: ReactiveCascadeContextSchema.optional(),
  payload: z.record(JsonValueSchema),
  match: z.object({
    matched: z.literal(true),
    reason: z.string().trim().min(1),
  }).strict(),
}).strict().superRefine((occurrence, context) => {
  if (occurrence.trigger_kind !== "schedule") return;
  const parsed = ScheduleTriggerPayloadSchema.safeParse(occurrence.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    }
  }
});

export type TriggerDefinition = z.infer<typeof TriggerDefinitionSchema>;
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;
export type TriggerSignal = z.infer<typeof TriggerSignalSchema>;
export type TriggerOccurrence = z.infer<typeof TriggerOccurrenceSchema>;
export type SchedulePeriod = z.infer<typeof SchedulePeriodSchema>;
export type ScheduleTriggerPayload = z.infer<typeof ScheduleTriggerPayloadSchema>;
export type AutomationContextSource = z.infer<typeof AutomationContextSourceSchema>;
export type AutomationContextBinding = z.infer<typeof AutomationContextBindingSchema>;
export type { ExactViewRef };

export type ParsedAutomationView = {
  view: View;
  definition: AutomationDefinition;
};

export class AutomationValidationError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[], options?: ErrorOptions) {
    super(message, options);
    this.name = "AutomationValidationError";
    this.issues = issues;
  }
}

export function parseAutomationDefinition(input: unknown): AutomationDefinition {
  const parsed = AutomationDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new AutomationValidationError("invalid Automation definition", parsed.error.issues);
  return parsed.data;
}

export function parseAutomationView(input: unknown): ParsedAutomationView {
  const view = parseView(input);
  if (view.role !== "derived") {
    throw new AutomationValidationError("Automation View must be derived", [customIssue(["role"], "expected derived role")]);
  }
  if (view.schema.name !== "metaflow.automation" || view.schema.version !== 1 || view.schema.mode !== "strict") {
    throw new AutomationValidationError("unsupported Automation View Schema", [
      customIssue(["schema"], "expected strict metaflow.automation version 1"),
    ]);
  }
  if (view.representation.form !== "inline" || view.representation.kind !== "automation") {
    throw new AutomationValidationError("invalid Automation View Representation", [
      customIssue(["representation"], "expected inline automation Representation"),
    ]);
  }
  return { view, definition: parseAutomationDefinition(view.representation.value) };
}

export function parseTriggerSignal(input: unknown): TriggerSignal {
  const parsed = TriggerSignalSchema.safeParse(input);
  if (!parsed.success) throw new AutomationValidationError("invalid Trigger signal", parsed.error.issues);
  return parsed.data;
}

function customIssue(path: Array<string | number>, message: string): z.ZodIssue {
  return { code: z.ZodIssueCode.custom, path, message };
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

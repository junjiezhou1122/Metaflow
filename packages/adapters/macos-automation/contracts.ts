import { z } from "zod";
import { JsonValueSchema, ViewPolicySchema } from "@info/view";

const IdentifierSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().datetime({ offset: true });

export const MacVoiceCaptureEventSchema = z.object({
  version: z.literal(1),
  event_id: IdentifierSchema,
  session_id: IdentifierSchema,
  source: z.object({
    connector: z.literal("metaflow-mac"),
    connection_id: IdentifierSchema,
  }).strict(),
  shortcut: z.object({
    phase: z.literal("released"),
    key_code: z.number().int().nonnegative(),
    modifiers: z.array(z.enum(["option", "control", "command", "shift"])).min(1),
    pressed_at: TimestampSchema,
    released_at: TimestampSchema,
  }).strict().superRefine((value, context) => {
    if (Date.parse(value.released_at) <= Date.parse(value.pressed_at)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "released_at must be after pressed_at", path: ["released_at"] });
    }
  }),
  speech: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("recognized"),
      transcript: z.string().trim().min(1).max(40_000),
      locale: IdentifierSchema,
      started_at: TimestampSchema,
      ended_at: TimestampSchema,
      confidence: z.number().min(0).max(1).optional(),
    }).strict(),
    z.object({
      status: z.literal("failed"),
      code: IdentifierSchema,
      message: z.string().trim().min(1).max(2_000),
      started_at: TimestampSchema.optional(),
      ended_at: TimestampSchema,
    }).strict(),
  ]),
  accessibility: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("trusted"),
      app_name: IdentifierSchema,
      bundle_identifier: IdentifierSchema,
      process_id: z.number().int().positive(),
      window_title: z.string().max(2_000).optional(),
      role: z.string().max(500).optional(),
      subrole: z.string().max(500).optional(),
      selected_text: z.string().max(40_000).optional(),
      focused_value: z.string().max(40_000).optional(),
      field_description: z.string().max(2_000).optional(),
    }).strict(),
    z.object({
      status: z.literal("denied"),
      code: z.literal("accessibility_permission_denied"),
      message: z.string().trim().min(1).max(2_000),
    }).strict(),
  ]),
  requested_agent: IdentifierSchema.optional(),
  captured_at: TimestampSchema,
  privacy: ViewPolicySchema,
  metadata: z.record(JsonValueSchema).default({}),
}).strict();

export const BrowserDomSnapshotSchema = z.object({
  request_id: IdentifierSchema,
  status: z.literal("captured"),
  captured_at: TimestampSchema,
  tab_id: z.number().int().nonnegative(),
  window_id: z.number().int().nonnegative(),
  url: z.string().url(),
  title: z.string().max(2_000),
  text: z.string().min(1).max(2_000_000),
  selected_text: z.string().max(100_000).optional(),
  dom: z.record(JsonValueSchema).default({}),
  metadata: z.record(JsonValueSchema).default({}),
}).strict();

export type MacVoiceCaptureEvent = z.infer<typeof MacVoiceCaptureEventSchema>;
export type BrowserDomSnapshot = z.infer<typeof BrowserDomSnapshotSchema>;

export class MacAutomationAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_macos_event"
      | "accessibility_denied"
      | "asr_failed"
      | "automation_catalog_failed"
      | "capture_failed"
      | "browser_context_failed"
      | "unknown_agent"
      | "automation_invocation_failed",
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MacAutomationAdapterError";
  }
}

export function parseMacVoiceCaptureEvent(input: unknown): MacVoiceCaptureEvent {
  const parsed = MacVoiceCaptureEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new MacAutomationAdapterError("invalid macOS voice capture event", "invalid_macos_event", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

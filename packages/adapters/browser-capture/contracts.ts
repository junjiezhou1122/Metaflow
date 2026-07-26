import { z } from "zod";
import { JsonValueSchema, ViewPolicySchema, type ExactViewRef } from "@info/view";
import type { CaptureCheckpoint } from "@info/capture";
import {
  BrowserCaptureEventSchema,
  type BrowserCaptureEvent,
} from "./wire.js";

export * from "./wire.js";

const IdentifierSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().datetime({ offset: true });
const JsonObjectSchema = z.record(JsonValueSchema);

export const BrowserAutomationEvidenceSchema = z.object({
  version: z.literal(1),
  event_id: IdentifierSchema,
  navigation_id: IdentifierSchema,
  tab_id: z.number().int().nonnegative(),
  window_id: z.number().int().nonnegative().optional(),
  occurred_at: TimestampSchema,
  captured_at: TimestampSchema,
  reason: z.enum(["dwell", "selection", "dom", "manual"]),
  url: z.string().url(),
  title: z.string().trim().min(1).max(500),
  domain: IdentifierSchema,
  dwell_ms: z.number().int().nonnegative(),
  scroll_depth: z.number().finite().min(0).max(1),
  scroll_events: z.number().int().nonnegative(),
  selection_count: z.number().int().nonnegative(),
  dom: JsonObjectSchema,
  page: z.object({
    text: z.string().trim().min(1).max(1_000_000),
    selected_text: z.string().trim().min(1).max(200_000).optional(),
    metadata: JsonObjectSchema.default({}),
    text_quality: JsonObjectSchema.default({}),
  }).strict(),
  source: z.object({
    connector: z.literal("chrome-extension"),
    connection_id: IdentifierSchema,
  }).strict(),
  policy: ViewPolicySchema,
}).strict();

export type BrowserAutomationEvidence = z.infer<typeof BrowserAutomationEvidenceSchema>;

export type BrowserCapturedView = {
  role: "page" | "navigation" | "selection" | "media" | "interaction" | "save";
  ref: ExactViewRef;
  created: boolean;
};

export type BrowserCaptureSubmission = {
  status: "stored" | "skipped";
  event_id: string;
  batch_id: string;
  captured_views: BrowserCapturedView[];
  skipped: Array<{ role: BrowserCapturedView["role"]; reason: "do_not_store" }>;
  checkpoint: CaptureCheckpoint;
  replayed: boolean;
  transaction_id: string;
};

export class BrowserCaptureAdapterError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_browser_capture_event" | "browser_capture_protocol_error",
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserCaptureAdapterError";
  }
}

export function parseBrowserCaptureEvent(input: unknown): BrowserCaptureEvent {
  const parsed = BrowserCaptureEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new BrowserCaptureAdapterError(
      "invalid Browser Capture event",
      "invalid_browser_capture_event",
      { issues: parsed.error.issues },
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

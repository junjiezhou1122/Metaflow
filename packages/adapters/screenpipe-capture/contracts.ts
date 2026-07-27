import { z } from "zod";
import { SecretReferenceSchema } from "@info/capture";
import { JsonValueSchema } from "@info/view";
import {
  ScreenpipeActivityQuerySchema,
  ScreenpipeActivitySummarySchema,
  ScreenpipeAudioContentSchema,
  ScreenpipeElementSchema,
  ScreenpipeInputContentSchema,
  ScreenpipeOcrContentSchema,
  ScreenpipeUiContentSchema,
} from "@info/screenpipe-contracts";
export { ScreenpipeActivityQuerySchema, ScreenpipeElementSchema } from "@info/screenpipe-contracts";

const TimestampSchema = z.string().datetime({ offset: true });
const NullableStringSchema = z.string().nullable();
const NullableNumberSchema = z.number().nullable();

export const SCREENPIPE_API_CONTRACT_VERSION = "1.0.0";
export const SCREENPIPE_ENGINE_VERSION_FAMILY = { major: 0, minor: 4 } as const;
export const SCREENPIPE_SEARCH_OVERLAP_MS = 60_000;
export const SCREENPIPE_MAX_OVERLAP_IDENTITIES = 10_000;
export const SCREENPIPE_MAX_OVERLAP_PAGES = 200;

export const ScreenpipeHealthResponseSchema = z.object({
  status: z.string().min(1),
  status_code: z.number().int(),
  last_frame_timestamp: TimestampSchema.nullable(),
  last_audio_timestamp: TimestampSchema.nullable(),
  frame_status: z.string().min(1),
  audio_status: z.string().min(1),
  message: z.string(),
  verbose_instructions: NullableStringSchema,
  device_status_details: NullableStringSchema,
  capture_status: JsonValueSchema.optional(),
  monitors: z.array(z.string()).optional(),
  pipeline: JsonValueSchema.optional(),
  audio_pipeline: JsonValueSchema.optional(),
  accessibility: JsonValueSchema.optional(),
  ui_recorder: JsonValueSchema.optional(),
  recording_coverage: JsonValueSchema.optional(),
  pool_stats: JsonValueSchema.optional(),
  write_queue_degraded: z.boolean().optional(),
  write_queue_consecutive_fatal: z.number().int().nonnegative().optional(),
  write_queue_consecutive_contention: z.number().int().nonnegative().optional(),
  write_pool_reopens: z.number().int().nonnegative().optional(),
  persistent_failure_signals: z.number().int().nonnegative().optional(),
  vision_db_write_stalled: z.boolean(),
  audio_db_write_stalled: z.boolean(),
  drm_content_paused: z.boolean(),
  schedule_paused: z.boolean(),
  hostname: NullableStringSchema.optional(),
  version: NullableStringSchema,
}).strict();

export const ScreenpipeContentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("OCR"), content: ScreenpipeOcrContentSchema }).strict(),
  z.object({ type: z.literal("Audio"), content: ScreenpipeAudioContentSchema }).strict(),
  z.object({ type: z.literal("UI"), content: ScreenpipeUiContentSchema }).strict(),
  z.object({ type: z.literal("Input"), content: ScreenpipeInputContentSchema }).strict(),
]);

const PaginationSchema = z.object({
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();

export const ScreenpipeSearchResponseSchema = z.object({
  data: z.array(ScreenpipeContentItemSchema),
  pagination: PaginationSchema,
  cloud: JsonValueSchema.optional(),
  related: z.record(z.array(z.string())).optional(),
}).strict();

export const ScreenpipeElementsResponseSchema = z.object({
  data: z.array(ScreenpipeElementSchema),
  pagination: PaginationSchema,
}).strict();

export const ScreenpipeActivitySummaryResponseSchema = ScreenpipeActivitySummarySchema;

export const ScreenpipeSearchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  content_types: z.array(z.enum(["ocr", "audio", "input", "accessibility"]))
    .min(1)
    .default(["ocr", "audio", "input", "accessibility"]),
  start_time: TimestampSchema.optional(),
  end_time: TimestampSchema.optional(),
  app_name: z.string().trim().min(1).optional(),
  window_name: z.string().trim().min(1).optional(),
  browser_url: z.string().trim().min(1).optional(),
  focused: z.boolean().optional(),
  limit: z.number().int().positive().max(200).default(50),
  max_content_length: z.number().int().positive().max(1_000_000).default(100_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.content_types).size !== value.content_types.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content_types"], message: "content_types must be unique" });
  }
  if (value.start_time && value.end_time && Date.parse(value.start_time) > Date.parse(value.end_time)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_time"], message: "end_time must not precede start_time" });
  }
});

export const ScreenpipeElementsQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  frame_id: z.number().int().optional(),
  source: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  start_time: TimestampSchema.optional(),
  end_time: TimestampSchema.optional(),
  app_name: z.string().trim().min(1).optional(),
  on_screen: z.boolean().optional(),
  limit: z.number().int().positive().max(200).default(50),
}).strict().superRefine((value, context) => {
  if (value.start_time && value.end_time && Date.parse(value.start_time) > Date.parse(value.end_time)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_time"], message: "end_time must not precede start_time" });
  }
});

export const ScreenpipeOpenParametersSchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("search"), query: ScreenpipeSearchQuerySchema }).strict(),
  z.object({ resource: z.literal("elements"), query: ScreenpipeElementsQuerySchema }).strict(),
  z.object({ resource: z.literal("activity"), query: ScreenpipeActivityQuerySchema }).strict(),
]);

const ScreenpipeAuthenticationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({
    mode: z.literal("bearer"),
    secret_ref: SecretReferenceSchema,
  }).strict(),
]);

export const ScreenpipeConnectionConfigurationSchema = z.object({
  api_contract_version: z.literal(SCREENPIPE_API_CONTRACT_VERSION),
  required_capabilities: z.array(z.string().trim().min(1)),
  authentication: ScreenpipeAuthenticationSchema,
}).strict();

const ScreenpipeSeenIdentitySchema = z.object({
  observed_at: TimestampSchema,
  item_key: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

const ScreenpipeSearchWatermarkSchema = z.object({
  observed_at: TimestampSchema,
  query_fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  seen: z.array(ScreenpipeSeenIdentitySchema).max(SCREENPIPE_MAX_OVERLAP_IDENTITIES),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  let previous = "";
  value.seen.forEach((item, index) => {
    if (identities.has(item.item_key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["seen", index, "item_key"], message: "seen item keys must be unique" });
    }
    identities.add(item.item_key);
    const orderKey = `${item.observed_at}\u0000${item.item_key}`;
    if (previous && orderKey < previous) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["seen", index], message: "seen identities must be sorted" });
    }
    previous = orderKey;
  });
});

export const ScreenpipeCursorSchema = z.object({
  screenpipe: z.object({
    search_watermarks: z.object({
      ocr: ScreenpipeSearchWatermarkSchema.optional(),
      audio: ScreenpipeSearchWatermarkSchema.optional(),
      input: ScreenpipeSearchWatermarkSchema.optional(),
      accessibility: ScreenpipeSearchWatermarkSchema.optional(),
    }).strict().optional(),
    elements_offset: z.number().int().nonnegative().optional(),
    last_activity_digest: z.string().optional(),
  }).strict(),
}).strict();

export type ScreenpipeHealthResponse = z.infer<typeof ScreenpipeHealthResponseSchema>;
export type ScreenpipeContentItem = z.infer<typeof ScreenpipeContentItemSchema>;
export type ScreenpipeElement = z.infer<typeof ScreenpipeElementSchema>;
export type ScreenpipeActivitySummaryResponse = z.infer<typeof ScreenpipeActivitySummaryResponseSchema>;
export type ScreenpipeOpenParameters = z.infer<typeof ScreenpipeOpenParametersSchema>;

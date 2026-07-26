import { z } from "zod";
import { SecretReferenceSchema } from "@info/capture";
import { JsonValueSchema } from "@info/view";

const TimestampSchema = z.string().datetime({ offset: true });
const NullableStringSchema = z.string().nullable();
const NullableNumberSchema = z.number().nullable();
const JsonObjectSchema = z.record(JsonValueSchema);

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

const OcrContentSchema = z.object({
  frame_id: z.number().int(),
  text: z.string(),
  timestamp: TimestampSchema,
  file_path: z.string(),
  offset_index: z.number().int(),
  app_name: z.string(),
  window_name: z.string(),
  tags: z.array(z.string()),
  frame: z.null(),
  frame_name: NullableStringSchema,
  browser_url: NullableStringSchema,
  focused: z.boolean().nullable(),
  device_name: z.string(),
  text_source: NullableStringSchema,
}).strict();

const AudioContentSchema = z.object({
  chunk_id: z.number().int(),
  transcription: z.string(),
  text: z.string(),
  timestamp: TimestampSchema,
  file_path: z.string(),
  offset_index: z.number().int(),
  tags: z.array(z.string()),
  device_name: z.string(),
  device_type: z.enum(["Input", "Output"]),
  speaker: z.object({
    id: z.number().int(),
    name: z.string(),
    metadata: z.string(),
  }).strict().nullable(),
  speaker_label: NullableStringSchema,
  speaker_source: NullableStringSchema,
  speaker_confidence: NullableNumberSchema,
  speaker_provisional: z.boolean(),
  start_time: NullableNumberSchema,
  end_time: NullableNumberSchema,
  source: z.string().optional(),
  meeting_id: z.number().int().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
}).strict();

const UiContentSchema = z.object({
  id: z.number().int(),
  text: z.string(),
  timestamp: TimestampSchema,
  app_name: z.string(),
  window_name: z.string(),
  initial_traversal_at: TimestampSchema.nullable(),
  file_path: z.string(),
  offset_index: z.number().int(),
  frame_name: NullableStringSchema,
  browser_url: NullableStringSchema,
}).strict();

const InputContentSchema = z.object({
  id: z.number().int(),
  timestamp: TimestampSchema,
  event_type: z.string().min(1),
  app_name: NullableStringSchema,
  window_title: NullableStringSchema,
  browser_url: NullableStringSchema,
  text_content: NullableStringSchema,
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  key_code: z.number().int().nullable(),
  modifiers: z.number().int().nullable(),
  element_role: NullableStringSchema,
  element_name: NullableStringSchema,
  frame_id: z.number().int().optional(),
}).strict();

export const ScreenpipeContentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("OCR"), content: OcrContentSchema }).strict(),
  z.object({ type: z.literal("Audio"), content: AudioContentSchema }).strict(),
  z.object({ type: z.literal("UI"), content: UiContentSchema }).strict(),
  z.object({ type: z.literal("Input"), content: InputContentSchema }).strict(),
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

const ElementBoundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
}).strict();

const ElementStateSchema = z.object({
  disabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  selected: z.boolean().optional(),
  expanded: z.boolean().optional(),
}).strict();

export const ScreenpipeElementSchema = z.object({
  id: z.number().int(),
  frame_id: z.number().int(),
  source: z.string().min(1),
  role: z.string().min(1),
  text: NullableStringSchema,
  parent_id: z.number().int().nullable(),
  depth: z.number().int(),
  bounds: ElementBoundsSchema.nullable(),
  confidence: NullableNumberSchema,
  sort_order: z.number().int(),
  on_screen: z.boolean().optional(),
  state: ElementStateSchema.optional(),
}).strict();

export const ScreenpipeElementsResponseSchema = z.object({
  data: z.array(ScreenpipeElementSchema),
  pagination: PaginationSchema,
}).strict();

export const ScreenpipeActivitySummaryResponseSchema = z.object({
  apps: z.array(JsonValueSchema).optional(),
  windows: z.array(JsonValueSchema).optional(),
  key_texts: z.array(JsonValueSchema).optional(),
  edited_files: z.array(JsonValueSchema),
  audio_summary: JsonValueSchema,
  total_frames: z.number().int(),
  total_active_minutes: z.number(),
  time_range: z.object({ start: z.string(), end: z.string() }).strict(),
  data_status: z.string(),
  query_status: z.string(),
  recording: JsonValueSchema.optional(),
  memories: z.array(JsonValueSchema).optional(),
  snippets: z.array(JsonValueSchema).optional(),
  guidance: JsonValueSchema.optional(),
}).strict();

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

export const ScreenpipeActivityQuerySchema = z.object({
  start_time: TimestampSchema,
  end_time: TimestampSchema,
  app_name: z.string().trim().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.start_time) >= Date.parse(value.end_time)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["end_time"], message: "end_time must be after start_time" });
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

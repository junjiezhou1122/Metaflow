import { z } from "zod";
import { JsonValueSchema, TimestampSchema } from "@info/view";

const NullableStringSchema = z.string().nullable();
const NullableNumberSchema = z.number().nullable();

export const ScreenpipeOcrContentSchema = z.object({
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

export const ScreenpipeAudioContentSchema = z.object({
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

export const ScreenpipeUiContentSchema = z.object({
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

export const ScreenpipeInputContentSchema = z.object({
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

export const ScreenpipeElementSchema = z.object({
  id: z.number().int(),
  frame_id: z.number().int(),
  source: z.string().min(1),
  role: z.string().min(1),
  text: NullableStringSchema,
  parent_id: z.number().int().nullable(),
  depth: z.number().int(),
  bounds: z.object({
    left: z.number(),
    top: z.number(),
    width: z.number(),
    height: z.number(),
  }).strict().nullable(),
  confidence: NullableNumberSchema,
  sort_order: z.number().int(),
  on_screen: z.boolean().optional(),
  state: z.object({
    disabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    selected: z.boolean().optional(),
    expanded: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const ScreenpipeActivityQuerySchema = z.object({
  start_time: TimestampSchema,
  end_time: TimestampSchema,
  app_name: z.string().trim().min(1).optional(),
}).strict().refine(value => Date.parse(value.start_time) < Date.parse(value.end_time), {
  message: "end_time must be after start_time",
  path: ["end_time"],
});

export const ScreenpipeActivitySummarySchema = z.object({
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

function sourceValueSchema<ItemType extends string, Content extends z.ZodTypeAny>(
  itemType: ItemType,
  content: Content,
) {
  return z.object({
    provider: z.literal("screenpipe"),
    api_contract_version: z.literal("1.0.0"),
    item_type: z.literal(itemType),
    content,
  }).strict();
}

export const ScreenpipeSourceValueSchema = z.discriminatedUnion("item_type", [
  sourceValueSchema("OCR", ScreenpipeOcrContentSchema),
  sourceValueSchema("Audio", ScreenpipeAudioContentSchema),
  sourceValueSchema("UI", ScreenpipeUiContentSchema),
  sourceValueSchema("Input", ScreenpipeInputContentSchema),
  sourceValueSchema("Element", ScreenpipeElementSchema),
  z.object({
    provider: z.literal("screenpipe"),
    api_contract_version: z.literal("1.0.0"),
    item_type: z.literal("ActivitySummary"),
    query: ScreenpipeActivityQuerySchema,
    content: ScreenpipeActivitySummarySchema,
  }).strict(),
]);

import { z } from "zod";
import { IdentifierSchema, JsonValueSchema, TimestampSchema, type ViewSchemaRef } from "@info/view";
export { ScreenpipeSourceValueSchema } from "@info/screenpipe-contracts";

export const SCREENPIPE_TIMELINE_FUNCTION = {
  kind: "function",
  function_id: "screenpipe.timeline.compress",
  version: 1,
} as const;

export const SCREENPIPE_AUDIO_FUNCTION = {
  kind: "function",
  function_id: "screenpipe.audio.compose",
  version: 1,
} as const;

export const ScreenpipeDerivedPeriodSchema = z.object({
  start: TimestampSchema,
  end: TimestampSchema,
  timezone: IdentifierSchema,
}).strict().refine(value => Date.parse(value.start) < Date.parse(value.end), {
  message: "Screenpipe derived period end must follow start",
  path: ["end"],
});

export const ScreenpipeDerivedConfigurationSchema = z.object({
  output_view_id: IdentifierSchema,
  expected_revision: z.number().int().nonnegative(),
  period: ScreenpipeDerivedPeriodSchema,
}).strict();

const exactRefJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["view_id", "revision"],
  properties: {
    view_id: { type: "string", minLength: 1, maxLength: 240 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

const timestampJsonSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
} as const;

const periodJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "timezone"],
  properties: {
    start: timestampJsonSchema,
    end: timestampJsonSchema,
    timezone: { type: "string", minLength: 1, maxLength: 240 },
  },
} as const;

const sourcesJsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 500,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["relation", "view"],
    properties: {
      relation: { const: "derived_from" },
      view: exactRefJsonSchema,
    },
  },
} as const;

export const SCREENPIPE_TIMELINE_SCHEMA: ViewSchemaRef = {
  name: "metaflow.screenpipe.timeline",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: JsonValueSchema.parse({
    type: "object",
    additionalProperties: false,
    required: ["contract_version", "period", "sources", "entries", "stats"],
    properties: {
      contract_version: { const: 1 },
      period: periodJsonSchema,
      sources: sourcesJsonSchema,
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["at", "modality", "source", "label"],
          properties: {
            at: timestampJsonSchema,
            modality: { enum: ["screen", "audio", "input", "accessibility", "element", "activity"] },
            source: exactRefJsonSchema,
            label: { type: "string", minLength: 1, maxLength: 500 },
            text: { type: "string", minLength: 1, maxLength: 500 },
            app: { type: "string", minLength: 1, maxLength: 500 },
            window: { type: "string", minLength: 1, maxLength: 500 },
            url: { type: "string", minLength: 1, maxLength: 2_000 },
          },
        },
      },
      stats: {
        type: "object",
        additionalProperties: false,
        required: ["source_count", "counts_by_modality"],
        properties: {
          source_count: { type: "integer", minimum: 1, maximum: 500 },
          counts_by_modality: { type: "object", additionalProperties: { type: "integer", minimum: 1 } },
        },
      },
    },
  }),
  relation_projection: {
    version: 1,
    entries_path: "/sources",
    ref_path: "/view",
    discriminator_path: "/relation",
    mappings: [{ discriminator: "derived_from", relation_type: "derived_from", metadata: {} }],
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/entries/*/text", category: "text" },
      { path: "/representation/value/entries/*/app", category: "title" },
      { path: "/representation/value/entries/*/window", category: "title" },
      { path: "/representation/value/entries/*/url", category: "url" },
      { path: "/representation/value/entries/*/at", category: "timestamp" },
    ],
  },
};

export const SCREENPIPE_AUDIO_SCHEMA: ViewSchemaRef = {
  name: "metaflow.screenpipe.audio",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: JsonValueSchema.parse({
    type: "object",
    additionalProperties: false,
    required: ["contract_version", "period", "sources", "segments", "transcript", "stats"],
    properties: {
      contract_version: { const: 1 },
      period: periodJsonSchema,
      sources: sourcesJsonSchema,
      segments: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["at", "source", "text", "device_type"],
          properties: {
            at: timestampJsonSchema,
            source: exactRefJsonSchema,
            text: { type: "string", minLength: 1, maxLength: 20_000 },
            device_type: { enum: ["Input", "Output"] },
            device_name: { type: "string", minLength: 1, maxLength: 500 },
            speaker: { type: "string", minLength: 1, maxLength: 500 },
            start_seconds: { type: "number", minimum: 0 },
            end_seconds: { type: "number", minimum: 0 },
          },
        },
      },
      transcript: { type: "string", maxLength: 500000 },
      stats: {
        type: "object",
        additionalProperties: false,
        required: ["source_count", "segment_count", "input_segments", "output_segments"],
        properties: {
          source_count: { type: "integer", minimum: 1, maximum: 500 },
          segment_count: { type: "integer", minimum: 0, maximum: 500 },
          input_segments: { type: "integer", minimum: 0, maximum: 500 },
          output_segments: { type: "integer", minimum: 0, maximum: 500 },
        },
      },
    },
  }),
  relation_projection: {
    version: 1,
    entries_path: "/sources",
    ref_path: "/view",
    discriminator_path: "/relation",
    mappings: [{ discriminator: "derived_from", relation_type: "derived_from", metadata: {} }],
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/transcript", category: "text" },
      { path: "/representation/value/segments/*/speaker", category: "title" },
      { path: "/representation/value/segments/*/at", category: "timestamp" },
    ],
  },
};

import { JsonValueSchema, type ViewSchemaRef } from "@info/view";
import { defineViewPackage } from "@info/view-package";
import { SCREENPIPE_TIMELINE_WEB_RENDERER } from "./wire.js";

export const SCREENPIPE_TIMELINE_QUERY_PROFILE = {
  id: "screenpipe.timeline.entries",
  version: 1,
} as const;

export const SCREENPIPE_TIMELINE_INDEX_SCHEMA: ViewSchemaRef = {
  name: "metaflow.screenpipe.timeline-index",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: JsonValueSchema.parse({
    type: "object",
    additionalProperties: false,
    required: ["contract_version", "connection_id", "timezone", "modalities"],
    properties: {
      contract_version: { const: 1 },
      connection_id: { type: "string", minLength: 1, maxLength: 240 },
      timezone: { type: "string", minLength: 1, maxLength: 240 },
      modalities: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        items: { enum: ["screen", "audio", "input", "accessibility", "element", "activity"] },
      },
    },
  }),
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/purpose", category: "text" },
      { path: "/representation/value/connection_id", category: "provenance" },
    ],
  },
};

export const SCREENPIPE_TIMELINE_QUERY_PARAMETERS_JSON_SCHEMA = JsonValueSchema.parse({
  type: "object",
  additionalProperties: false,
  required: ["period"],
  properties: {
    period: {
      type: "object",
      additionalProperties: false,
      required: ["start", "end", "timezone"],
      properties: {
        start: { type: "string", format: "date-time" },
        end: { type: "string", format: "date-time" },
        timezone: { type: "string", minLength: 1, maxLength: 240 },
      },
    },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        modalities: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { enum: ["screen", "audio", "input", "accessibility", "element", "activity"] },
        },
        apps: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } },
        text: { type: "string", minLength: 1, maxLength: 500 },
        has_image: { type: "boolean" },
        focused: { type: "boolean" },
      },
    },
    order: { enum: ["ascending", "descending"] },
  },
});

export const SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS = {
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: SCREENPIPE_TIMELINE_QUERY_PARAMETERS_JSON_SCHEMA,
  pagination: { kind: "cursor", max_page_size: 100 },
} as const;

const schemaKey = { name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name, version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version };

export const screenpipeTimelineViewPackage = defineViewPackage({
  manifest_version: 1,
  id: "view-package.screenpipe-timeline",
  version: 1,
  name: "Screenpipe Timeline",
  description: "A typed live collection definition over independently authorized Screenpipe Raw Views.",
  schemas: [SCREENPIPE_TIMELINE_INDEX_SCHEMA],
  representations: [{
    id: "representation.screenpipe.timeline-index",
    schema: schemaKey,
    forms: ["inline"],
    kinds: ["screenpipe_timeline_index"],
    media_types: ["application/json"],
  }],
  materializations: [{
    id: "materialization.screenpipe.timeline-index.json",
    schema: schemaKey,
    formats: ["json"],
    media_types: ["application/json"],
    locations: ["inline", "content_addressed"],
  }],
  renderers: [SCREENPIPE_TIMELINE_WEB_RENDERER],
  methods: [
    {
      id: "inspect",
      description: "Read this exact Timeline collection definition.",
      schema: schemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.get" },
    },
    {
      id: "entries",
      description: "Page authorized Timeline entries with typed date and source-specific filters.",
      schema: schemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.query" },
      parameters: SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
    },
    {
      id: "refresh",
      description: "Run the active Screenpipe Source Connection before refreshing this Timeline.",
      schema: schemaKey,
      effect: "read",
      target: { kind: "operation", operation: "capture.connection.run" },
      parameters: {
        dialect: "https://json-schema.org/draft/2020-12/schema",
        json_schema: JsonValueSchema.parse({
          type: "object",
          additionalProperties: false,
          required: ["connection_id", "expected_generation", "idempotency_key", "delivery", "parameters"],
          properties: {
            connection_id: { type: "string", minLength: 1, maxLength: 240 },
            expected_generation: { type: "integer", minimum: 1 },
            idempotency_key: { type: "string", minLength: 1, maxLength: 240 },
            delivery: { const: "pull" },
            parameters: { type: "object" },
          },
        }),
      },
    },
  ],
  evolutions: [],
});

export const screenpipeTimelineFixtures = [{
  id: "fixture.screenpipe.timeline-index",
  schema: schemaKey,
  representation: {
    form: "inline" as const,
    kind: "screenpipe_timeline_index",
    media_type: "application/json",
    value: {
      contract_version: 1,
      connection_id: "screenpipe:fixture",
      timezone: "Asia/Shanghai",
      modalities: ["screen", "audio", "input", "accessibility"],
    },
    metadata: {},
  },
  relations: [],
}];

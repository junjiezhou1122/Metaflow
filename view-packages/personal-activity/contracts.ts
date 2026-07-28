export const PERSONAL_AUDIO_SCHEMA = { name: "personal.audio.semantic", version: 1 } as const;
export const PERSONAL_TIMELINE_SCHEMA = { name: "personal.timeline.activity", version: 1 } as const;
export const PERSONAL_DAILY_SUMMARY_SCHEMA = { name: "personal.summary.daily", version: 1 } as const;

export const PERSONAL_AUDIO_REPRESENTATION = "personal_audio";
export const PERSONAL_TIMELINE_REPRESENTATION = "personal_timeline";
export const PERSONAL_DAILY_SUMMARY_REPRESENTATION = "personal_daily_summary";

export const PERSONAL_AUDIO_RENDERER = { id: "renderer.personal.audio", version: 1, abi_version: 1 } as const;
export const PERSONAL_TIMELINE_RENDERER = { id: "renderer.personal.timeline", version: 1, abi_version: 1 } as const;
export const PERSONAL_DAILY_SUMMARY_RENDERER = { id: "renderer.personal.daily-summary", version: 1, abi_version: 1 } as const;

export const PERSONAL_AUDIO_TRANSFORMATION = { transformation_id: "transformation.personal.audio.semantic", revision: 1 } as const;
export const PERSONAL_TIMELINE_TRANSFORMATION = { transformation_id: "transformation.personal.timeline.activity", revision: 1 } as const;
export const PERSONAL_DAILY_SUMMARY_TRANSFORMATION = { transformation_id: "transformation.personal.summary.daily", revision: 1 } as const;

export const PERSONAL_TIMELINE_FUNCTION = { kind: "function", function_id: "personal.activity.timeline", version: 1 } as const;
export const PERSONAL_DAILY_SUMMARY_FUNCTION = { kind: "function", function_id: "personal.summary.daily", version: 1 } as const;

const exactRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["view_id", "revision"],
  properties: {
    view_id: { type: "string", minLength: 1, maxLength: 240 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

const timestampSchema = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
} as const;

export const personalAudioSchema = {
  ...PERSONAL_AUDIO_SCHEMA,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "started_at", "ended_at", "transcript", "segments", "summary", "topics", "decisions", "action_items"],
    properties: {
      version: { const: 1 },
      started_at: timestampSchema,
      ended_at: timestampSchema,
      transcript: { type: "string", minLength: 1, maxLength: 100_000 },
      segments: {
        type: "array",
        minItems: 1,
        maxItems: 2_000,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["start_ms", "end_ms", "speaker", "text"],
          properties: {
            start_ms: { type: "integer", minimum: 0 },
            end_ms: { type: "integer", minimum: 0 },
            speaker: { type: "string", minLength: 1, maxLength: 120 },
            text: { type: "string", minLength: 1, maxLength: 10_000 },
          },
        },
      },
      summary: { type: "string", minLength: 1, maxLength: 4_000 },
      topics: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 240 } },
      decisions: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      action_items: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
    },
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/summary", category: "text" },
      { path: "/transcript", category: "text" },
    ],
  },
} as const;

export const personalTimelineSchema = {
  ...PERSONAL_TIMELINE_SCHEMA,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "date", "timezone", "started_at", "ended_at", "blocks", "signals"],
    properties: {
      version: { const: 1 },
      date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      timezone: { type: "string", minLength: 1, maxLength: 120 },
      started_at: timestampSchema,
      ended_at: timestampSchema,
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: 288,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["started_at", "ended_at", "title", "summary", "entries"],
          properties: {
            started_at: timestampSchema,
            ended_at: timestampSchema,
            title: { type: "string", minLength: 1, maxLength: 500 },
            summary: { type: "string", minLength: 1, maxLength: 4_000 },
            entries: {
              type: "array",
              minItems: 1,
              maxItems: 500,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["source_ref", "occurred_at", "kind", "title", "detail"],
                properties: {
                  source_ref: exactRefSchema,
                  occurred_at: timestampSchema,
                  kind: { enum: ["audio", "browser", "application", "project", "other"] },
                  title: { type: "string", minLength: 1, maxLength: 500 },
                  detail: { type: "string", minLength: 1, maxLength: 4_000 },
                },
              },
            },
          },
        },
      },
      signals: {
        type: "object",
        additionalProperties: false,
        required: ["top_topics", "decisions", "unfinished_threads"],
        properties: {
          top_topics: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 240 } },
          decisions: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
          unfinished_threads: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
        },
      },
    },
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/date", category: "title" },
      { path: "/signals", category: "text" },
    ],
  },
} as const;

export const personalDailySummarySchema = {
  ...PERSONAL_DAILY_SUMMARY_SCHEMA,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "date", "headline", "overview", "themes", "decisions", "unfinished_threads", "tomorrow", "source_timeline"],
    properties: {
      version: { const: 1 },
      date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      headline: { type: "string", minLength: 1, maxLength: 500 },
      overview: { type: "string", minLength: 1, maxLength: 8_000 },
      themes: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "narrative", "highlights"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 500 },
            narrative: { type: "string", minLength: 1, maxLength: 8_000 },
            highlights: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 2_000 } },
          },
        },
      },
      decisions: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      unfinished_threads: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      tomorrow: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      source_timeline: exactRefSchema,
    },
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/headline", category: "title" },
      { path: "/overview", category: "text" },
      { path: "/themes", category: "text" },
    ],
  },
} as const;

export const personalActivityManifest = {
  manifest_version: 1,
  id: "view-package.personal-activity",
  version: 1,
  name: "Personal Activity",
  description: "Semantic audio, chronological activity, and readable daily synthesis Views connected through exact provenance.",
  schemas: [personalAudioSchema, personalTimelineSchema, personalDailySummarySchema],
  representations: [
    { id: "representation.personal.audio", schema: PERSONAL_AUDIO_SCHEMA, forms: ["inline"], kinds: [PERSONAL_AUDIO_REPRESENTATION], media_types: ["application/json"] },
    { id: "representation.personal.timeline", schema: PERSONAL_TIMELINE_SCHEMA, forms: ["inline"], kinds: [PERSONAL_TIMELINE_REPRESENTATION], media_types: ["application/json"] },
    { id: "representation.personal.daily-summary", schema: PERSONAL_DAILY_SUMMARY_SCHEMA, forms: ["inline"], kinds: [PERSONAL_DAILY_SUMMARY_REPRESENTATION], media_types: ["application/json"] },
  ],
  materializations: [
    { id: "materialization.personal.audio.json", schema: PERSONAL_AUDIO_SCHEMA, formats: ["json"], media_types: ["application/json"], locations: ["inline", "content_addressed"] },
    { id: "materialization.personal.timeline.json", schema: PERSONAL_TIMELINE_SCHEMA, formats: ["json"], media_types: ["application/json"], locations: ["inline", "content_addressed"] },
    { id: "materialization.personal.daily-summary.json", schema: PERSONAL_DAILY_SUMMARY_SCHEMA, formats: ["json"], media_types: ["application/json"], locations: ["inline", "content_addressed"] },
  ],
  renderers: [
    { ...PERSONAL_AUDIO_RENDERER, schema: PERSONAL_AUDIO_SCHEMA, surfaces: ["web", "generic"], representation_kinds: [PERSONAL_AUDIO_REPRESENTATION], media_types: ["application/json"], priority: 100 },
    { ...PERSONAL_TIMELINE_RENDERER, schema: PERSONAL_TIMELINE_SCHEMA, surfaces: ["web", "generic"], representation_kinds: [PERSONAL_TIMELINE_REPRESENTATION], media_types: ["application/json"], priority: 100 },
    { ...PERSONAL_DAILY_SUMMARY_RENDERER, schema: PERSONAL_DAILY_SUMMARY_SCHEMA, surfaces: ["web", "generic"], representation_kinds: [PERSONAL_DAILY_SUMMARY_REPRESENTATION], media_types: ["application/json"], priority: 100 },
  ],
  processors: [
    {
      id: "processor.personal.audio.semantic",
      version: 1,
      inputs: [{ role: "audio_evidence", schemas: [{ name: "capture.screenpipe.audio", version: 1 }], required: true }],
      output_schema: PERSONAL_AUDIO_SCHEMA,
      transformation: PERSONAL_AUDIO_TRANSFORMATION,
      priority: 100,
    },
    {
      id: "processor.personal.timeline.activity",
      version: 1,
      inputs: [
        { role: "activity_views", schemas: [PERSONAL_AUDIO_SCHEMA], required: true },
        { role: "base_timeline", schemas: [PERSONAL_TIMELINE_SCHEMA], required: false },
      ],
      output_schema: PERSONAL_TIMELINE_SCHEMA,
      transformation: PERSONAL_TIMELINE_TRANSFORMATION,
      priority: 100,
    },
    {
      id: "processor.personal.summary.daily",
      version: 1,
      inputs: [
        { role: "timeline", schemas: [PERSONAL_TIMELINE_SCHEMA], required: true },
        { role: "base_summary", schemas: [PERSONAL_DAILY_SUMMARY_SCHEMA], required: false },
      ],
      output_schema: PERSONAL_DAILY_SUMMARY_SCHEMA,
      transformation: PERSONAL_DAILY_SUMMARY_TRANSFORMATION,
      priority: 100,
    },
  ],
  methods: [
    { id: "inspect_audio", description: "Read one exact semantic Audio View.", schema: PERSONAL_AUDIO_SCHEMA, effect: "read", target: { kind: "operation", operation: "view.get" } },
    { id: "inspect_timeline", description: "Read one exact Activity Timeline View.", schema: PERSONAL_TIMELINE_SCHEMA, effect: "read", target: { kind: "operation", operation: "view.get" } },
    { id: "inspect_daily_summary", description: "Read one exact Daily Summary View.", schema: PERSONAL_DAILY_SUMMARY_SCHEMA, effect: "read", target: { kind: "operation", operation: "view.get" } },
  ],
  evolutions: [],
} as const;

export const personalActivityFixtures = [
  {
    id: "fixture.personal.audio.design-conversation",
    schema: PERSONAL_AUDIO_SCHEMA,
    representation: {
      form: "inline",
      kind: PERSONAL_AUDIO_REPRESENTATION,
      media_type: "application/json",
      value: {
        version: 1,
        started_at: "2026-07-27T09:10:00.000Z",
        ended_at: "2026-07-27T09:18:30.000Z",
        transcript: "Graph 只是 View 的导航。每一种 View 都应该呈现自己真正的内容。",
        segments: [
          { start_ms: 0, end_ms: 4_200, speaker: "Junjie", text: "Graph 只是 View 的导航。" },
          { start_ms: 4_200, end_ms: 9_100, speaker: "Junjie", text: "每一种 View 都应该呈现自己真正的内容。" },
        ],
        summary: "明确 Graph 与产品 View Renderer 的职责。",
        topics: ["View architecture", "Renderer"],
        decisions: ["Graph remains navigation rather than content"],
        action_items: ["Implement dedicated Audio, Timeline, and Daily Summary renderers"],
      },
      metadata: {},
    },
    relations: [],
  },
  {
    id: "fixture.personal.timeline.2026-07-27",
    schema: PERSONAL_TIMELINE_SCHEMA,
    representation: {
      form: "inline",
      kind: PERSONAL_TIMELINE_REPRESENTATION,
      media_type: "application/json",
      value: {
        version: 1,
        date: "2026-07-27",
        timezone: "Asia/Shanghai",
        started_at: "2026-07-27T00:00:00.000+08:00",
        ended_at: "2026-07-28T00:00:00.000+08:00",
        blocks: [{
          started_at: "2026-07-27T09:00:00.000+08:00",
          ended_at: "2026-07-27T10:00:00.000+08:00",
          title: "Product View architecture",
          summary: "Aligned the View model around meaningful content and dedicated renderers.",
          entries: [
            {
              source_ref: { view_id: "view:personal:audio:design-conversation", revision: 1 },
              occurred_at: "2026-07-27T09:10:00.000+08:00",
              kind: "audio",
              title: "View architecture conversation",
              detail: "Graph is navigation; each View owns its content experience.",
            },
            {
              source_ref: { view_id: "view:personal:audio:implementation-focus", revision: 1 },
              occurred_at: "2026-07-27T09:35:00.000+08:00",
              kind: "audio",
              title: "Implementation scope decision",
              detail: "Focus only on real product Views before expanding other capabilities.",
            },
          ],
        }],
        signals: {
          top_topics: ["View architecture", "Renderer"],
          decisions: ["Implement product Views before expanding Graph features"],
          unfinished_threads: ["Connect real capture data after the product slice"],
        },
      },
      metadata: {},
    },
    relations: [],
  },
  {
    id: "fixture.personal.summary.2026-07-27",
    schema: PERSONAL_DAILY_SUMMARY_SCHEMA,
    representation: {
      form: "inline",
      kind: PERSONAL_DAILY_SUMMARY_REPRESENTATION,
      media_type: "application/json",
      value: {
        version: 1,
        date: "2026-07-27",
        headline: "The View became an information product",
        overview: "Today the architecture moved away from generic records and toward Views that people can actually read and use.",
        themes: [{
          title: "View content first",
          narrative: "Audio, Timeline, and Daily Summary now form one recursive chain. The Graph stays available as provenance and navigation without replacing the content itself.",
          highlights: ["Defined strict product schemas", "Kept exact source revisions", "Assigned a dedicated renderer to every View family"],
        }],
        decisions: ["Focus only on the product View vertical slice"],
        unfinished_threads: ["Feed the same schemas from real Capture and Execution output"],
        tomorrow: ["Exercise the View chain with personal activity evidence"],
        source_timeline: { view_id: "view:personal:timeline:2026-07-27", revision: 1 },
      },
      metadata: {},
    },
    relations: [],
  },
  {
    id: "fixture.personal.audio.implementation-focus",
    schema: PERSONAL_AUDIO_SCHEMA,
    representation: {
      form: "inline",
      kind: PERSONAL_AUDIO_REPRESENTATION,
      media_type: "application/json",
      value: {
        version: 1,
        started_at: "2026-07-27T09:35:00.000Z",
        ended_at: "2026-07-27T09:40:00.000Z",
        transcript: "现在只聚焦实现真正的 View。先让 Audio、Timeline 和 Daily Summary 可以被使用。",
        segments: [
          { start_ms: 0, end_ms: 3_400, speaker: "Junjie", text: "现在只聚焦实现真正的 View。" },
          { start_ms: 3_400, end_ms: 8_600, speaker: "Junjie", text: "先让 Audio、Timeline 和 Daily Summary 可以被使用。" },
        ],
        summary: "将实现范围收敛到三个真实产品 View。",
        topics: ["Product scope", "View vertical slice"],
        decisions: ["Defer unrelated product capabilities"],
        action_items: ["Verify all three View renderers end to end"],
      },
      metadata: {},
    },
    relations: [],
  },
] as const;

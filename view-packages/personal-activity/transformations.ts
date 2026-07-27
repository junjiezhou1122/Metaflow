import { parseTransformation } from "@info/transformation";
import {
  PERSONAL_AUDIO_SCHEMA,
  PERSONAL_DAILY_SUMMARY_FUNCTION,
  PERSONAL_DAILY_SUMMARY_SCHEMA,
  PERSONAL_TIMELINE_FUNCTION,
  PERSONAL_TIMELINE_SCHEMA,
  personalDailySummarySchema,
  personalTimelineSchema,
} from "./contracts.js";

const CREATED_AT = "2026-07-27T00:00:00.000Z";

export const personalTimelineTransformation = parseTransformation({
  id: "transformation.personal.timeline.activity",
  revision: 1,
  name: "Form an Activity Timeline",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Combine the frozen exact Audio Views into one chronological Activity Timeline for their local day. Preserve every exact source revision and never infer evidence that is not present in the inputs.",
    parameters: {},
  },
  operator: {
    id: "operator.personal.timeline.activity",
    revision: 1,
    reference: PERSONAL_TIMELINE_FUNCTION,
    configuration: {
      timezone: "Asia/Shanghai",
      output_view_prefix: "view:personal:timeline",
    },
    required_capabilities: [],
  },
  inputs: [
    {
      role: "activity_views",
      required: true,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.personal.audio.same-day",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: [PERSONAL_AUDIO_SCHEMA.name],
            roles: ["raw", "derived"],
            revision_scope: "latest",
            order: "oldest",
            limit: 1_000,
            where: {},
          },
        },
      }],
    },
    {
      role: "base_timeline",
      required: false,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.personal.timeline.base",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: [PERSONAL_TIMELINE_SCHEMA.name],
            roles: ["derived"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: {},
          },
        },
      }],
    },
  ],
  output: {
    schema: personalTimelineSchema,
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.personal.timeline.view-access",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  budget: {
    id: "budget.personal.timeline",
    revision: 1,
    limits: { timeout_ms: 10_000, max_attempts: 1 },
    extensions: {},
  },
  created_at: CREATED_AT,
  metadata: {
    view_package: "view-package.personal-activity@1",
    processor: "processor.personal.timeline.activity@1",
    operation_shape: "merge",
  },
});

export const personalDailySummaryTransformation = parseTransformation({
  id: "transformation.personal.summary.daily",
  revision: 1,
  name: "Form a Daily Summary",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Compress one frozen exact Activity Timeline into a readable Daily Summary. Preserve its exact timeline revision, decisions, unfinished threads, and the evidence-backed themes of the day.",
    parameters: {},
  },
  operator: {
    id: "operator.personal.summary.daily",
    revision: 1,
    reference: PERSONAL_DAILY_SUMMARY_FUNCTION,
    configuration: { output_view_prefix: "view:personal:summary" },
    required_capabilities: [],
  },
  inputs: [
    {
      role: "timeline",
      required: true,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.personal.timeline.current-day",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: [PERSONAL_TIMELINE_SCHEMA.name],
            roles: ["derived"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: {},
          },
        },
      }],
    },
    {
      role: "base_summary",
      required: false,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.personal.summary.base",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: [PERSONAL_DAILY_SUMMARY_SCHEMA.name],
            roles: ["derived"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: {},
          },
        },
      }],
    },
  ],
  output: {
    schema: personalDailySummarySchema,
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.personal.summary.view-access",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  budget: {
    id: "budget.personal.summary",
    revision: 1,
    limits: { timeout_ms: 10_000, max_attempts: 1 },
    extensions: {},
  },
  created_at: CREATED_AT,
  metadata: {
    view_package: "view-package.personal-activity@1",
    processor: "processor.personal.summary.daily@1",
    operation_shape: "compress",
  },
});

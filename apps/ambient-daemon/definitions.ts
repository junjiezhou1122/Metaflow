import { parseAutomationDefinition } from "@info/automation";
import {
  MARKDOWN_FRAGMENT_SET_SCHEMA,
  MARKDOWN_PARSER_FUNCTION,
  MARKDOWN_PARSER_REF,
} from "@info/markdown-parser-adapter";
import { parseTransformation } from "@info/transformation";
import { parseViewDraft } from "@info/view";

const createdAt = "2026-07-26T00:00:00.000Z";

export const githubSummaryTransformation = parseTransformation({
  id: "transformation.github.repository_summary",
  revision: 1,
  name: "GitHub repository summary",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Summarize the current GitHub repository page. Explain what the project does, who it is for, how to start, and the most important caveats. Use only the frozen page and selection evidence.",
    parameters: {},
  },
  operator: {
    id: "operator.agent.github_summary",
    revision: 1,
    reference: { kind: "agent", adapter: "agent-execution", profile: "browser-summary" },
    configuration: {
      runtime_override: "acp_stdio",
      execution_mode: "invoke",
      autonomy: "suggest",
      allow_network: false,
      allow_write: false,
    },
    required_capabilities: [],
  },
  inputs: [
    {
      role: "current_page",
      required: true,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.browser.current_page",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: ["capture.browser.page_snapshot"],
            roles: ["raw"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: {},
          },
        },
      }],
    },
    {
      role: "current_selection",
      required: false,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.browser.current_selection",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: ["capture.browser.selection"],
            roles: ["raw"],
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
    schema: { name: "summary.github.repository", version: 1, mode: "freeform" },
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.github_summary.view_access",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  budget: {
    id: "budget.github_summary",
    revision: 1,
    limits: {
      timeout_ms: 60_000,
      max_attempts: 1,
      max_cost_usd: 0.25,
      max_input_tokens: 20_000,
      max_output_tokens: 2_000,
    },
    extensions: {},
  },
  created_at: createdAt,
  metadata: { application: "ambient.browser.github_summary" },
});

export const obsidianMarkdownParserTransformation = parseTransformation({
  id: "transformation.parser.markdown",
  revision: 1,
  name: "Parse Obsidian Markdown into search fragments",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Project one exact captured Obsidian Markdown View into deterministic bounded search fragments.",
    parameters: {},
  },
  operator: {
    id: "operator.parser.markdown",
    revision: 1,
    reference: MARKDOWN_PARSER_FUNCTION,
    configuration: {
      parser: MARKDOWN_PARSER_REF,
      limits: {
        max_input_bytes: 8_000_000,
        max_fragments: 4_096,
        max_fragment_bytes: 1_000_000,
      },
    },
    required_capabilities: [],
  },
  inputs: [{
    role: "source",
    required: true,
    sources: [{
      kind: "selector",
      selector: {
        id: "selector.obsidian.markdown_document",
        revision: 1,
        query: {
          scope: "matching",
          schema_names: ["capture.obsidian.document"],
          roles: ["raw"],
          revision_scope: "latest",
          order: "newest",
          limit: 1,
          where: {},
        },
      },
    }],
  }],
  output: {
    schema: MARKDOWN_FRAGMENT_SET_SCHEMA,
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.parser.markdown.view_access",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  budget: {
    id: "budget.parser.markdown",
    revision: 1,
    limits: { timeout_ms: 10_000, max_attempts: 1 },
    extensions: {},
  },
  created_at: createdAt,
  metadata: {
    processor_kind: "parser",
    parser_id: MARKDOWN_PARSER_REF.parser_id,
    parser_version: MARKDOWN_PARSER_REF.version,
    parser_abi_version: MARKDOWN_PARSER_REF.abi_version,
  },
});

export const githubSummaryAutomationDefinition = parseAutomationDefinition({
  version: 1,
  enabled: true,
  trigger: {
    id: "github-repository-summary",
    kind: "event",
    source: "chrome-extension",
    event: "browser.page_state",
    predicate: {
      type: "all",
      predicates: [
        { type: "field", path: "url", operator: "matches", value: "^https://github\\.com/[^/]+/[^/]+" },
        { type: "field", path: "dom.github_repository", operator: "eq", value: true },
        {
          type: "any",
          predicates: [
            { type: "field", path: "reason", operator: "eq", value: "manual" },
            {
              type: "all",
              predicates: [
                { type: "field", path: "dwell_ms", operator: "gte", value: 30_000 },
                { type: "field", path: "scroll_depth", operator: "gte", value: 0.5 },
                { type: "field", path: "scroll_events", operator: "gte", value: 3 },
              ],
            },
          ],
        },
      ],
    },
  },
  target: {
    kind: "transformation",
    transformation_id: githubSummaryTransformation.id,
    revision: githubSummaryTransformation.revision,
  },
  input_mapping: [
    {
      role: "current_page",
      required: true,
      sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "chrome-extension" }],
    },
    {
      role: "current_selection",
      required: false,
      sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.selection", source: "chrome-extension" }],
    },
  ],
  delivery: [{
    surface: "browser",
    urgency: "glance",
    replacement: "keep_existing",
    show_progress: false,
    expires_after_ms: 15 * 60_000,
    actions: ["accept", "dismiss", "later"],
  }],
  limits: {
    dedupe_window_ms: 90_000,
    cooldown_ms: 90_000,
    max_concurrency: 1,
    timeout_ms: 60_000,
  },
});

export const githubSummaryAutomationDraft = parseViewDraft({
  id: "automation.browser.github_repository_summary",
  name: "Summarize GitHub repositories",
  purpose: "Offer one fast repository summary after an explicit request or sustained reading",
  schema: {
    name: "metaflow.automation",
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: { type: "object" },
  },
  role: "derived",
  time: { created_at: createdAt },
  representation: {
    form: "inline",
    kind: "automation",
    media_type: "application/json",
    value: githubSummaryAutomationDefinition,
  },
  materialization: {
    primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
  },
  provenance: { inputs: [], actor: "metaflow:ambient-daemon" },
  policy: {
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    labels: ["ambient", "browser"],
  },
  metadata: { target: `${githubSummaryTransformation.id}@${githubSummaryTransformation.revision}` },
});

export const macVoiceAssistTransformation = parseTransformation({
  id: "transformation.macos.voice_assist",
  revision: 1,
  name: "macOS voice assistance",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Answer the user's spoken request using only the frozen utterance, current macOS Accessibility snapshot, and optional Browser DOM. Be concise and immediately useful. Never claim unavailable context.",
    parameters: {},
  },
  operator: {
    id: "operator.agent.macos_voice_assist",
    revision: 1,
    reference: { kind: "agent", adapter: "agent-execution", profile: "ambient-voice" },
    configuration: {
      execution_mode: "invoke",
      autonomy: "suggest",
      allow_network: false,
      allow_write: false,
    },
    required_capabilities: [],
  },
  inputs: [
    {
      role: "voice_utterance",
      required: true,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.macos.voice_utterance",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: ["capture.macos.voice_utterance"],
            roles: ["raw"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: {},
          },
        },
      }],
    },
    {
      role: "current_app",
      required: true,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.macos.current_app",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: ["capture.macos.accessibility_snapshot"],
            roles: ["raw"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: {},
          },
        },
      }],
    },
    {
      role: "current_page",
      required: false,
      sources: [{
        kind: "selector",
        selector: {
          id: "selector.macos.browser_page",
          revision: 1,
          query: {
            scope: "matching",
            schema_names: ["capture.browser.page_opened"],
            roles: ["raw"],
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
    schema: { name: "response.ambient.voice", version: 1, mode: "freeform" },
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.macos_voice_assist.view_access",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  budget: {
    id: "budget.macos_voice_assist",
    revision: 1,
    limits: {
      timeout_ms: 60_000,
      max_attempts: 1,
      max_cost_usd: 0.25,
      max_input_tokens: 20_000,
      max_output_tokens: 2_000,
    },
    extensions: {},
  },
  created_at: createdAt,
  metadata: { application: "ambient.macos.voice_assist" },
});

function macVoiceAssistAutomationDefinitionForSource(
  source: "metaflow-mac" | "metaflow-mac-companion",
) {
  return parseAutomationDefinition({
    version: 1,
    enabled: true,
    trigger: {
      id: "macos-push-to-talk",
      kind: "user",
      source,
      event: "push_to_talk.release",
    },
    target: {
      kind: "transformation",
      transformation_id: macVoiceAssistTransformation.id,
      revision: macVoiceAssistTransformation.revision,
    },
    input_mapping: [
      {
        role: "voice_utterance",
        required: true,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.macos.voice_utterance", source }],
      },
      {
        role: "current_app",
        required: true,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.macos.accessibility_snapshot", source }],
      },
      {
        role: "current_page",
        required: false,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.page_opened", source: "chrome-acp" }],
      },
    ],
    delivery: [{
      surface: "macos",
      urgency: "glance",
      replacement: "replace",
      show_progress: true,
      expires_after_ms: 5 * 60_000,
      actions: ["accept", "dismiss", "cancel", "correct"],
    }],
    limits: {
      dedupe_window_ms: 0,
      cooldown_ms: 0,
      max_concurrency: 1,
      timeout_ms: 60_000,
    },
  });
}

export const macVoiceAssistAutomationDefinition = macVoiceAssistAutomationDefinitionForSource("metaflow-mac");
export const legacyMacVoiceAssistAutomationDefinition = macVoiceAssistAutomationDefinitionForSource("metaflow-mac-companion");

function macVoiceAssistAutomationDraftForDefinition(
  definition: typeof macVoiceAssistAutomationDefinition,
) {
  return parseViewDraft({
    id: "automation.macos.voice_assist",
    name: "Ask from the current macOS context",
    purpose: "Use one explicit global push-to-talk gesture to ask the configured or named Agent with exact foreground context",
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    role: "derived",
    time: { created_at: createdAt },
    representation: {
      form: "inline",
      kind: "automation",
      media_type: "application/json",
      value: definition,
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: { inputs: [], actor: "metaflow:ambient-daemon" },
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      labels: ["ambient", "macos", "voice"],
    },
    metadata: { target: `${macVoiceAssistTransformation.id}@${macVoiceAssistTransformation.revision}` },
  });
}

export const macVoiceAssistAutomationDraft = macVoiceAssistAutomationDraftForDefinition(macVoiceAssistAutomationDefinition);
export const legacyMacVoiceAssistAutomationDraft = macVoiceAssistAutomationDraftForDefinition(legacyMacVoiceAssistAutomationDefinition);

export const dailySummaryInputSchemas = [
  "capture.browser.page_snapshot",
  "capture.browser.selection",
  "capture.macos.accessibility_snapshot",
  "capture.macos.voice_utterance",
  "capture.screenpipe.activity",
] as const;

export const dailySummaryTransformation = parseTransformation({
  id: "transformation.ambient.daily_summary",
  revision: 1,
  name: "Daily activity summary",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Summarize the frozen activity Views from exactly one scheduled period. Organize the result by meaningful work themes, decisions, and unfinished threads. Do not infer activity outside the supplied Views or period.",
    parameters: {},
  },
  operator: {
    id: "operator.agent.daily_summary",
    revision: 1,
    reference: { kind: "agent", adapter: "agent-execution", profile: "daily-summary" },
    configuration: {
      runtime_override: "acp_stdio",
      execution_mode: "invoke",
      autonomy: "suggest",
      allow_network: false,
      allow_write: false,
    },
    required_capabilities: [],
  },
  inputs: [{
    role: "period_activity",
    required: true,
    sources: [{
      kind: "selector",
      selector: {
        id: "selector.ambient.daily_activity",
        revision: 1,
        query: {
          scope: "matching",
          schema_names: [...dailySummaryInputSchemas],
          roles: ["raw"],
          revision_scope: "latest",
          order: "newest",
          limit: 100,
          where: {},
        },
      },
    }],
  }],
  output: {
    schema: { name: "summary.ambient.daily", version: 1, mode: "freeform" },
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.daily_summary.view_access",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  budget: {
    id: "budget.daily_summary",
    revision: 1,
    limits: {
      timeout_ms: 120_000,
      max_attempts: 1,
      max_cost_usd: 0.5,
      max_input_tokens: 32_000,
      max_output_tokens: 3_000,
    },
    extensions: {},
  },
  created_at: createdAt,
  metadata: { application: "ambient.daily_summary" },
});

export const dailySummaryAutomationDefinition = parseAutomationDefinition({
  version: 1,
  enabled: true,
  trigger: {
    id: "daily-summary",
    kind: "schedule",
    source: "metaflow-scheduler",
    event: "schedule.period_due",
    schedule: {
      format: "cron",
      expression: "0 0 * * *",
      timezone: "Asia/Shanghai",
      misfire: { policy: "catch_up", max_periods: 7 },
    },
  },
  target: {
    kind: "transformation",
    transformation_id: dailySummaryTransformation.id,
    revision: dailySummaryTransformation.revision,
  },
  input_mapping: [{
    role: "period_activity",
    required: true,
    sources: [{
      kind: "view_query",
      schema_names: [...dailySummaryInputSchemas],
      role: "raw",
      time_range: { kind: "occurrence_period", basis: "observed_at" },
      limit: 100,
    }],
  }],
  delivery: [{
    surface: "inbox",
    urgency: "background",
    replacement: "keep_existing",
    show_progress: false,
    actions: ["accept", "dismiss", "retry", "correct"],
  }],
  limits: {
    dedupe_window_ms: 0,
    cooldown_ms: 0,
    max_concurrency: 1,
    timeout_ms: 120_000,
  },
});

export const dailySummaryAutomationDraft = parseViewDraft({
  id: "automation.ambient.daily_summary",
  name: "Summarize each local day",
  purpose: "Summarize one exact timezone-aware activity period through the ordinary Transformation and Execution path",
  schema: {
    name: "metaflow.automation",
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: { type: "object" },
  },
  role: "derived",
  time: { created_at: createdAt },
  representation: {
    form: "inline",
    kind: "automation",
    media_type: "application/json",
    value: dailySummaryAutomationDefinition,
  },
  materialization: {
    primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
  },
  provenance: { inputs: [], actor: "metaflow:ambient-daemon" },
  policy: {
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    labels: ["ambient", "schedule", "daily-summary"],
  },
  metadata: { target: `${dailySummaryTransformation.id}@${dailySummaryTransformation.revision}` },
});

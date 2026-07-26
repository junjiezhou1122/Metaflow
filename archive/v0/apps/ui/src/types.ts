export type TimelineItem = {
  id: string;
  kind: "activity" | "activity_episode" | "heartbeat_summary" | "runtime_event";
  source: string;
  schema?: string;
  event_type?: string;
  title: string;
  subtitle?: string;
  url?: string;
  path?: string;
  app?: string;
  domain?: string;
  project?: string;
  text?: string;
  observed_at: string;
  importance: number;
  record_ids?: string[];
  event_ids?: string[];
  stats?: Record<string, unknown>;
};

export type TimelineBucket = {
  label: string;
  start: string;
  end: string;
  count: number;
  top_sources: string[];
  top_apps: string[];
  top_domains: string[];
  top_projects: string[];
  summary: string;
  items: TimelineItem[];
};

export type ActivityTimelineResponse = {
  ok: true;
  compiler_id: string;
  records_used: number;
  events_used: number;
  buckets: TimelineBucket[];
  plugin_id?: string;
  view: {
    id: string;
    view_type: string;
    title: string;
    summary: string;
    content?: {
      minutes?: number;
      bucket_minutes?: number;
      signals?: {
        top_sources?: string[];
        top_apps?: string[];
        top_domains?: string[];
        top_projects?: string[];
        item_kinds?: string[];
      };
    };
    metadata?: Record<string, unknown>;
    updated_at?: string;
  };
};

export type ActivityTimelineWatermarkResponse = {
  ok: true;
  record_count: number;
  latest_observed_at?: string;
  latest_record_created_at?: string;
  latest_record_id?: string;
  event_count?: number;
  latest_event_created_at?: string;
  latest_event_id?: string;
  watermark: string;
};

export type RuntimeTickResponse = {
  ok?: boolean;
  written_records?: string[];
  compiled_views?: unknown[];
  diagnostics?: {
    background_tasks?: {
      processed?: number;
      skipped?: number;
      written_views?: string[];
      tasks?: Array<{
        task_view_id?: string;
        task_view_type?: string;
        status?: "completed" | "failed" | "skipped";
        reason?: string;
        runtime?: string;
        output_view_type?: string;
        written_views?: string[];
      }>;
    };
    toolsmith_artifacts?: {
      processed?: number;
      skipped?: number;
      artifacts?: Array<{
        source_view_id?: string;
        source_view_type?: string;
        status?: "completed" | "skipped";
        reason?: string;
        record_id?: string;
        artifact_id?: string;
        artifact_view_id?: string;
        uri?: string;
      }>;
    };
    screenpipe_activity?: {
      ok?: boolean;
      count?: number;
      error?: string;
      windows?: Array<{
        app_name?: string;
        window_name?: string;
        browser_url?: string;
        minutes?: number;
        frame_count?: number;
      }>;
    };
    screenpipe?: { ok?: boolean; count?: number; error?: string };
    screenpipe_input_events?: { ok?: boolean; count?: number; error?: string };
    screenpipe_workspace_signals?: { ok?: boolean; count?: number; error?: string };
  };
};

export type LlmRuntimeSettings = {
  base_url?: string;
  api_key?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  omit_max_tokens?: boolean;
  allow_external?: boolean;
};

export type RuntimeSettings = {
  compile_views?: boolean;
  ai_view_compression?: boolean;
  visual_view_compression?: boolean;
  ai_paused?: boolean;
  visual_paused?: boolean;
  view_compile_interval_seconds?: number;
  visual_frame_limit?: number;
  visual_frame_concurrency?: number;
  visual_frame_sample_seconds?: number;
  llm?: LlmRuntimeSettings;
  vision_llm?: LlmRuntimeSettings;
};

export type RuntimeSettingsResponse = {
  ok: true;
  settings: RuntimeSettings;
};

export type AudioTranscriptItem = {
  id: string;
  observed_at?: string;
  text?: string;
  speaker_label?: string;
  device_name?: string;
  chunk_id?: string | number;
  start_time?: number;
  end_time?: number;
  source?: string;
};

export type AudioTranscriptResponse = {
  ok: true;
  count: number;
  transcripts: AudioTranscriptItem[];
  query?: Record<string, string>;
};

export type FeedbackResponse = {
  ok: true;
  record?: {
    id: string;
    schema?: { name?: string };
  };
  processing?: unknown;
};

export type ContextViewSummary = {
  id: string;
  view_type: string;
  title?: string;
  summary?: string;
  status?: string;
  source_records?: string[];
  source_views?: string[];
  source_record_count?: number;
  source_view_count?: number;
  confidence?: number;
  stability?: string;
  lossiness?: string;
  compiler?: { id?: string; version?: string; mode?: string } | string;
  metadata?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  content?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type ViewStatus = "candidate" | "accepted" | "archived" | "rejected";

export type ContextViewInput = {
  id?: string;
  view_type: string;
  title?: string;
  summary?: string;
  status?: ViewStatus;
  source_records?: string[];
  source_views?: string[];
  compiler?: { id: string; version?: string; mode?: "deterministic" | "llm" | "hybrid" };
  purpose?: string;
  scope?: Record<string, unknown>;
  content?: Record<string, unknown>;
  confidence?: number;
  stability?: "ephemeral" | "session" | "project" | "long_term";
  lossiness?: "none" | "low" | "medium" | "high";
  privacy?: Record<string, unknown>;
  validity?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ContextViewUpdateInput = Partial<Omit<ContextViewInput, "id" | "view_type">> & {
  view_type?: string;
  content_patch?: Record<string, unknown>;
  metadata_patch?: Record<string, unknown>;
};

export type ViewFamilySummary = {
  family: string;
  count: number;
  kinds: string[];
  latest?: ContextViewSummary;
  definition?: ViewFamilyDefinition;
};

export type ViewFamiliesResponse = {
  ok: true;
  views: ContextViewSummary[];
  families: ViewFamilySummary[];
  catalog?: ViewCatalogResponse;
};

export type ViewFamilyDefinition = {
  view_type: string;
  label: string;
  purpose: string;
  category: string;
  producers: string[];
  consumes?: {
    observations?: string[];
    views?: string[];
  };
  producer_ids?: string[];
  default_page_size?: number;
  manual_create?: boolean;
  lifecycle?: "ephemeral" | "session" | "project" | "long_term";
  tags?: string[];
  aliases?: string[];
  alias_of?: string;
  graph_operations?: string[];
};

export type ViewCatalogResponse = {
  ok: true;
  order: string[];
  families: ViewFamilyDefinition[];
  manual_create: ViewFamilyDefinition[];
};

export type ViewListResponse = {
  ok: true;
  views: ContextViewSummary[];
  next_cursor?: string;
  subscription?: { returned_count?: number };
};

export type MemoryCandidateContent = {
  memory_kind: "preference" | "workflow_pattern" | "skill_gap" | "agent_collaboration_style" | "project_memory" | "agent_case";
  target_view_type: string;
  claim: string;
  confidence: number;
  evidence_count: number;
  proposed_scope?: Record<string, unknown>;
  promotion_policy: {
    min_confidence: number;
    min_evidence_count: number;
    allow_manual_promote: boolean;
    require_privacy_check: boolean;
  };
  gate_status?: "candidate" | "promoted" | "held" | "rejected";
  durable_view_id?: string;
  rejection_reason?: string;
};

export type MemoryGateDecision =
  | { action: "promote"; candidate_id: string; target_view_type: string; confidence: number }
  | { action: "merge"; candidate_id: string; target_view_id: string; confidence: number }
  | { action: "hold"; candidate_id: string; reason: string }
  | { action: "reject"; candidate_id: string; reason: string };

export type ProjectCurrentContent = {
  focus?: string;
  recent_context?: Record<string, unknown>[];
  decisions?: string[];
  open_questions?: string[];
  next_actions?: string[];
  active_files?: string[];
  active_sessions?: string[];
  supporting_sources?: Record<string, unknown>[];
  lane?: Record<string, unknown>;
  generated_at?: string;
};

export type ProjectCurrentView = ContextViewSummary & {
  content?: ProjectCurrentContent;
};

export type WorkFocusLane = {
  lane_key: string;
  lane_kind: string;
  label: string;
  attention_share: number;
  confidence: number;
  source_records: string[];
  candidate_route_ids: string[];
  route_scores: Array<{ route_key: string; score: number; rule_hits: string[] }>;
  evidence: Record<string, unknown>;
  last_seen_at?: string;
};

export type WorkFocusSetContent = {
  active_lanes?: WorkFocusLane[];
  lane_count?: number;
  route_candidate_count?: number;
  generated_at?: string;
  consolidation?: string;
};

export type ProcessorRun = {
  processor_id: string;
  runtime: "local" | "llm" | "agent_task" | "http" | "cli";
  ok: boolean;
  source: {
    kind: "observation" | "view";
    id?: string;
    type?: string;
  };
  view_drafts: number;
  views_written: string[];
  observation_drafts?: number;
  observations_written?: string[];
  diagnostics: Record<string, unknown>;
  error?: string;
};

export type ProcessorDefinitionSummary = {
  id: string;
  title?: string;
  version?: string;
  description?: string;
  runtime: "local" | "llm" | "agent_task" | "http" | "cli";
  runtime_config?: Record<string, unknown>;
  consumes: {
    observations?: string[];
    views?: string[];
  };
  produces: {
    views?: string[];
    observations?: string[];
    events?: string[];
  };
  policy?: {
    speed?: string;
    autonomy?: string;
    privacy?: string;
  };
  compatible?: boolean;
};

export type ProcessorListResponse = {
  ok: true;
  processors: ProcessorDefinitionSummary[];
};

export type ProcessorRunResponse = {
  ok: true;
  result: {
    ok: true;
    generated_at: string;
    source: ProcessorRun["source"];
    processors_matched: string[];
    runs: ProcessorRun[];
    views_written: string[];
    observations_written?: string[];
  };
  views: ContextViewSummary[];
  observations?: ContextRecordSummary[];
};

export type ContextRecordSummary = {
  id: string;
  schema: { name: string; version: number };
  source: { type: string; connector?: string };
  title?: string;
  text?: string;
  url?: string;
  path?: string;
  payload?: Record<string, unknown>;
  content?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  time?: { observed_at?: string; captured_at?: string };
};

export type ProcessorTracesResponse = {
  ok: true;
  events: Array<{
    id: string;
    event_type: string;
    actor: string;
    status: string;
    subject_type: string;
    subject_id: string;
    payload?: Record<string, unknown>;
    created_at: string;
  }>;
};

export type MemoryInboxResponse = {
  ok: true;
  candidates: ContextViewSummary[];
  promoted: ContextViewSummary[];
  rejected: ContextViewSummary[];
};

export type ProactiveSuggestion = {
  id: string;
  view_type: string;
  title: string;
  summary?: string;
  confidence?: number;
  priority?: string;
  created_at?: string;
  updated_at?: string;
};

export type ProactiveInboxResponse = {
  ok: true;
  suggestions: ProactiveSuggestion[];
};

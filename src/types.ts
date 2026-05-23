export type ContextRecord = {
  id?: string;
  schema: {
    name: string;
    version: number;
  };
  source: {
    type: string;
    id?: string;
    connector?: string;
  };
  scope?: {
    user?: string;
    project?: string;
    repo?: string;
    app?: string;
    session?: string;
    domain?: string;
    project_path?: string;
  };
  time?: {
    observed_at?: string;
    captured_at?: string;
  };
  content?: {
    title?: string;
    text?: string;
    url?: string;
    path?: string;
  };
  acquisition?: {
    mode?: "passive" | "manual" | "sync" | "agent" | "derived";
    actor?: "user" | "agent" | "connector" | "system";
    task_id?: string;
    reason?: string;
    query?: string;
  };
  signal?: {
    importance?: number;
    confidence?: number;
    status?: "inbox" | "candidate" | "accepted" | "archived" | "rejected";
  };
  privacy?: {
    level?: "public" | "workspace" | "private" | "secret";
    allow_embedding?: boolean;
    allow_llm_summary?: boolean;
    allow_external_llm?: boolean;
    allow_external_reader?: boolean;
    retention?: "ephemeral" | "normal" | "archive" | "do_not_store";
  };
  relations?: {
    derived_from?: string[];
    supersedes?: string[];
    related_to?: string[];
    thread_memberships?: Array<{
      thread_id: string;
      confidence: number;
      reasons?: string[];
    }>;
  };
  validity?: {
    valid_from?: string;
    valid_until?: string;
    stale_after?: string;
  };
  memory?: {
    kind?: "observation" | "episode" | "fact" | "preference" | "todo" | "decision" | "procedure" | "memory_view";
    stability?: "ephemeral" | "session" | "project" | "long_term";
  };
  payload?: Record<string, unknown>;
};

export type StoredContextRecord = Required<Pick<ContextRecord, "id">> & ContextRecord & {
  created_at: string;
  updated_at: string;
};

export type ContextArtifact = {
  id?: string;
  record_id: string;
  kind: "screenshot" | "image" | "pdf" | "html" | "audio" | "file";
  mime_type?: string;
  uri: string;
  sha256?: string;
  size_bytes?: number;
  metadata?: Record<string, unknown>;
};

export type ContextSchema = {
  name: string;
  version: number;
  description?: string;
  json_schema?: Record<string, unknown>;
  example?: Record<string, unknown>;
};

export type ContextConnector = {
  id: string;
  name: string;
  type: "ambient" | "semantic" | "reasoning" | "execution" | "explicit" | "agent" | "other";
  version?: number;
  description?: string;
  schemas_produced?: Array<{ name: string; version: number }>;
  default_scope?: ContextRecord["scope"];
  default_privacy?: ContextRecord["privacy"];
  permissions?: {
    allow_network?: boolean;
    allow_external_reader?: boolean;
    allow_external_llm?: boolean;
    max_privacy_level?: "public" | "workspace" | "private" | "secret";
  };
  config?: Record<string, unknown>;
};

export type StoredContextConnector = ContextConnector & {
  created_at: string;
  updated_at: string;
};


export type WorkThread = {
  id: string;
  title: string;
  status: "candidate" | "accepted" | "rejected" | "archived";
  confidence?: number;
  evidence_records?: string[];
  keywords?: string[];
  domains?: string[];
  apps?: string[];
  projects?: string[];
  repos?: string[];
  reasons?: string[];
  metadata?: Record<string, unknown>;
};

export type StoredWorkThread = WorkThread & {
  created_at: string;
  updated_at: string;
};

export type RuntimeState = {
  key: string;
  value: Record<string, unknown>;
  updated_at: string;
};

export type ThreadEvidenceRef = {
  ref_type:
    | "context_record"
    | "file"
    | "git"
    | "ai_session"
    | "screenpipe_frame"
    | "screenpipe_audio"
    | "browser_url"
    | "runtime_state";
  uri: string;
  title?: string;
  observed_at?: string;
  reason: string;
  confidence: number;
  role: "primary" | "supporting" | "derived" | "artifact" | "source";
  record_id?: string;
  metadata?: Record<string, unknown>;
};

export type ThreadEvidenceMap = {
  thread_id: string;
  generated_at: string;
  refs: ThreadEvidenceRef[];
  counts: Record<string, number>;
};


export type ContextView = {
  id?: string;
  view_type: string;
  title?: string;
  summary?: string;
  status?: "candidate" | "accepted" | "archived" | "rejected";
  source_records?: string[];
  source_views?: string[];
  compiler?: {
    id: string;
    version?: string;
    mode?: "deterministic" | "llm" | "hybrid";
  };
  purpose?: string;
  scope?: ContextRecord["scope"] & {
    plugin_id?: string;
    time_range?: { start?: string; end?: string };
  };
  content?: Record<string, unknown>;
  confidence?: number;
  stability?: "ephemeral" | "session" | "project" | "long_term";
  lossiness?: "none" | "low" | "medium" | "high";
  privacy?: ContextRecord["privacy"];
  validity?: ContextRecord["validity"];
  metadata?: Record<string, unknown>;
};

export type StoredContextView = ContextView & {
  id: string;
  created_at: string;
  updated_at: string;
};

export type ContextQuery = {
  mode?: "source" | "timeline" | "workspace" | "thread" | "semantic" | "global";
  goal?: string;
  query?: string;
  plugin_id?: string;
  thread_id?: string;
  scope?: ContextRecord["scope"];
  schemas?: string[];
  sources?: string[];
  view_types?: string[];
  include_views?: boolean;
  include_records?: boolean;
  time_window?: ContextPackRequest["time_window"];
  limit?: number;
  token_budget?: number;
};


export type PluginManifest = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  attention_policy?: ContextQuery;
  view_types_produced?: string[];
  actions?: Array<{
    id: string;
    title?: string;
    permission_level: "L0_observe" | "L1_derive" | "L2_suggest" | "L3_draft" | "L4_execute_local" | "L5_external_act";
    description?: string;
  }>;
  permissions?: {
    allowed_sources?: string[];
    allowed_schemas?: string[];
    allowed_view_types?: string[];
    max_privacy_level?: "public" | "workspace" | "private" | "secret";
    allow_external_llm?: boolean;
    allow_write_views?: boolean;
    allow_actions?: boolean;
  };
};

export type ContextBrokerPack = {
  version: 1;
  mode: NonNullable<ContextQuery["mode"]>;
  goal?: string;
  query?: string;
  plugin_id?: string;
  generated_at: string;
  records: StoredContextRecord[];
  views: StoredContextView[];
  markdown: string;
  diagnostics: Record<string, unknown>;
  sources: Array<{ id: string; kind: "record" | "view"; title?: string; uri: string; observed_at?: string; created_at: string }>;
};

export type ContextPackRequest = {
  goal: string;
  scope?: ContextRecord["scope"];
  thread_id?: string;
  limit?: number;
  token_budget?: number;
  time_window?: {
    start_time?: string;
    end_time?: string;
    minutes?: number;
  };
  include_screenpipe?: boolean;
  include_ai_sessions?: boolean;
  ai_sessions?: {
    tools?: Array<"codex" | "claude-code">;
    limit?: number;
    snippets?: boolean;
  };
  screenpipe?: {
    enabled?: boolean;
    url?: string;
    api_key?: string;
    limit?: number;
    content_type?: string;
    q?: string;
    start_time?: string;
    end_time?: string;
    app_name?: string;
    window_name?: string;
    browser_url?: string;
  };
};

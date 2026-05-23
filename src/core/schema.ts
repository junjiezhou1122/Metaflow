import { z } from "zod";

const ScopeSchema = z.object({
  user: z.string().optional(),
  project: z.string().optional(),
  repo: z.string().optional(),
  app: z.string().optional(),
  session: z.string().optional(),
  domain: z.string().optional(),
  project_path: z.string().optional(),
});

const PrivacySchema = z.object({
  level: z.enum(["public", "workspace", "private", "secret"]).optional(),
  allow_embedding: z.boolean().optional(),
  allow_llm_summary: z.boolean().optional(),
  allow_external_llm: z.boolean().optional(),
  allow_external_reader: z.boolean().optional(),
  retention: z.enum(["ephemeral", "normal", "archive", "do_not_store"]).optional(),
});

export const ContextRecordSchema = z.object({
  id: z.string().optional(),
  schema: z.object({
    name: z.string().min(1),
    version: z.number().int().positive(),
  }),
  source: z.object({
    type: z.string().min(1),
    id: z.string().optional(),
    connector: z.string().optional(),
  }),
  scope: ScopeSchema.optional(),
  time: z.object({
    observed_at: z.string().optional(),
    captured_at: z.string().optional(),
  }).optional(),
  content: z.object({
    title: z.string().optional(),
    text: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
  }).optional(),
  acquisition: z.object({
    mode: z.enum(["passive", "manual", "sync", "agent", "derived"]).optional(),
    actor: z.enum(["user", "agent", "connector", "system"]).optional(),
    task_id: z.string().optional(),
    reason: z.string().optional(),
    query: z.string().optional(),
  }).optional(),
  signal: z.object({
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(["inbox", "candidate", "accepted", "archived", "rejected"]).optional(),
  }).optional(),
  privacy: PrivacySchema.optional(),
  relations: z.object({
    derived_from: z.array(z.string()).optional(),
    supersedes: z.array(z.string()).optional(),
    related_to: z.array(z.string()).optional(),
    thread_memberships: z.array(z.object({
      thread_id: z.string().min(1),
      confidence: z.number().min(0).max(1),
      reasons: z.array(z.string()).optional(),
    })).optional(),
  }).optional(),
  validity: z.object({
    valid_from: z.string().optional(),
    valid_until: z.string().optional(),
    stale_after: z.string().optional(),
  }).optional(),
  memory: z.object({
    kind: z.enum(["observation", "episode", "fact", "preference", "todo", "decision", "procedure", "memory_view"]).optional(),
    stability: z.enum(["ephemeral", "session", "project", "long_term"]).optional(),
  }).optional(),
  payload: z.record(z.unknown()).optional(),
});

export const ContextArtifactSchema = z.object({
  id: z.string().optional(),
  record_id: z.string().min(1),
  kind: z.enum(["screenshot", "image", "pdf", "html", "audio", "file"]),
  mime_type: z.string().optional(),
  uri: z.string().min(1),
  sha256: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ContextSchemaSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().optional(),
  json_schema: z.record(z.unknown()).optional(),
  example: z.record(z.unknown()).optional(),
});

export const ContextConnectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["ambient", "semantic", "reasoning", "execution", "explicit", "agent", "other"]),
  version: z.number().int().positive().optional(),
  description: z.string().optional(),
  schemas_produced: z.array(z.object({
    name: z.string().min(1),
    version: z.number().int().positive(),
  })).optional(),
  default_scope: ScopeSchema.optional(),
  default_privacy: PrivacySchema.optional(),
  permissions: z.object({
    allow_network: z.boolean().optional(),
    allow_external_reader: z.boolean().optional(),
    allow_external_llm: z.boolean().optional(),
    max_privacy_level: z.enum(["public", "workspace", "private", "secret"]).optional(),
  }).optional(),
  config: z.record(z.unknown()).optional(),
});



export const WorkThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["candidate", "accepted", "rejected", "archived"]),
  confidence: z.number().min(0).max(1).optional(),
  evidence_records: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  apps: z.array(z.string()).optional(),
  projects: z.array(z.string()).optional(),
  repos: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});


export const ContextViewSchema = z.object({
  id: z.string().optional(),
  view_type: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  status: z.enum(["candidate", "accepted", "archived", "rejected"]).optional(),
  source_records: z.array(z.string()).optional(),
  source_views: z.array(z.string()).optional(),
  compiler: z.object({
    id: z.string().min(1),
    version: z.string().optional(),
    mode: z.enum(["deterministic", "llm", "hybrid"]).optional(),
  }).optional(),
  purpose: z.string().optional(),
  scope: ScopeSchema.extend({
    plugin_id: z.string().optional(),
    time_range: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
  }).optional(),
  content: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  stability: z.enum(["ephemeral", "session", "project", "long_term"]).optional(),
  lossiness: z.enum(["none", "low", "medium", "high"]).optional(),
  privacy: PrivacySchema.optional(),
  validity: z.object({
    valid_from: z.string().optional(),
    valid_until: z.string().optional(),
    stale_after: z.string().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ContextQuerySchema = z.object({
  mode: z.enum(["source", "timeline", "workspace", "thread", "semantic", "global"]).optional(),
  goal: z.string().optional(),
  query: z.string().optional(),
  plugin_id: z.string().optional(),
  thread_id: z.string().optional(),
  scope: ScopeSchema.optional(),
  schemas: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  view_types: z.array(z.string()).optional(),
  include_views: z.boolean().optional(),
  include_records: z.boolean().optional(),
  time_window: z.object({
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    minutes: z.number().positive().optional(),
  }).optional(),
  limit: z.number().int().positive().optional(),
  token_budget: z.number().int().positive().optional(),
});

export const ContextPackRequestSchema = z.object({
  goal: z.string().min(1),
  scope: ScopeSchema.optional(),
  thread_id: z.string().optional(),
  limit: z.number().int().positive().optional(),
  token_budget: z.number().int().positive().optional(),
  time_window: z.object({
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    minutes: z.number().positive().optional(),
  }).optional(),
  include_screenpipe: z.boolean().optional(),
  include_ai_sessions: z.boolean().optional(),
  ai_sessions: z.object({
    tools: z.array(z.enum(["codex", "claude-code"])).optional(),
    limit: z.number().int().positive().optional(),
    snippets: z.boolean().optional(),
  }).optional(),
  screenpipe: z.object({
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    api_key: z.string().optional(),
    limit: z.number().int().positive().optional(),
    content_type: z.string().optional(),
    q: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    app_name: z.string().optional(),
    window_name: z.string().optional(),
    browser_url: z.string().optional(),
  }).optional(),
});

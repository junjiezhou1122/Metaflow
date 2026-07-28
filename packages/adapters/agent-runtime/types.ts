import type {
  AgentCapabilities,
  ContentBlock,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentExecutionMode, AgentOperatorOutputMode } from "@info/execution";

export type AgentRuntimeKind = "acp_stdio" | "cli_json" | "mock";

export type AgentTaskOutputMode = AgentOperatorOutputMode;

export type AgentSchemaValue =
  | null
  | boolean
  | number
  | string
  | AgentSchemaValue[]
  | { [key: string]: AgentSchemaValue };

export type AgentTaskOutput = {
  summary: string;
  analysis?: string;
  key_points?: string[];
  confidence?: number;
  views?: AgentTaskOutputView[];
  raw?: unknown;
};

export type AgentTaskOutputView = {
  view_type: string;
  title?: string;
  summary?: string;
  purpose?: string;
  content?: Record<string, unknown>;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

export type AgentTaskRequest = {
  id: string;
  runtime?: string;
  /** Human-facing request. goal remains for existing callers. */
  prompt?: string;
  goal: string;
  cwd?: string;
  dryRun?: boolean;
  currentContext?: AgentCurrentContext;
  viewTools?: AgentViewToolDescriptor[];
  contextPack?: {
    markdown?: string;
    sources?: unknown[];
    diagnostics?: Record<string, unknown>;
  };
  outputContract: {
    mode?: AgentTaskOutputMode;
    viewType: string;
    title?: string;
    purpose?: string;
    schema?: unknown;
  };
  constraints?: Record<string, unknown>;
  policy?: {
    autonomy?: "suggest" | "act" | "autonomous";
    allowExternalLlm?: boolean;
    allowNetwork?: boolean;
    allowWrite?: boolean;
  };
};

export type AgentConversationRequest = {
  id: string;
  conversationId: string;
  message: string;
  cwd?: string;
  currentContext?: AgentCurrentContext;
  screenImage?: AgentConversationImage;
  backend?: AgentConversationBackend;
};

export type AgentConversationBackend = {
  harness: "pi" | "claude_code_acp";
  provider?: string;
  model?: string;
};

export type AgentConversationImage = {
  mimeType: "image/jpeg" | "image/png";
  data: string;
};

export type AgentConversationResult = {
  ok: boolean;
  reason: string;
  text?: string;
  diagnostics?: Record<string, unknown>;
};

export type AgentConversationEvent =
  | { type: "text_delta"; delta: string }
  | { type: "diagnostic"; event: string; details?: Record<string, unknown> };

export type AgentConversationContext = {
  onEvent?(event: AgentConversationEvent): void | Promise<void>;
  permissions?: AgentPermissionBroker;
  signal?: AbortSignal;
};

export type AgentConversationRuntimeAdapter = {
  id: string;
  converse(request: AgentConversationRequest, context?: AgentConversationContext): Promise<AgentConversationResult>;
  close?(): void | Promise<void>;
};

export type AgentCurrentContext = {
  voice?: {
    transcript?: string;
    language?: string;
    audio_view_ref?: string;
  };
  screen?: {
    title?: string;
    app?: string;
    url?: string;
    text?: string;
    selected_text?: string;
    screenshot_ref?: string;
    view_ref?: string;
  };
  app?: {
    name?: string;
    bundle_id?: string;
    window_title?: string;
    project_path?: string;
  };
  summary?: string;
  raw?: Record<string, unknown>;
};

export type AgentViewToolDescriptor = {
  name: string;
  kind: "cli" | "mcp" | "http" | "native";
  description?: string;
  command?: string;
  args?: string[];
  endpoint?: string;
  server?: string;
};

export type AgentHandoff = {
  prompt: string;
  currentContext: AgentCurrentContext;
  viewTools: AgentViewToolDescriptor[];
  outputContract: AgentTaskRequest["outputContract"];
  cwd?: string;
};

export type AgentRuntimeCapabilities = {
  runtimeId: string;
  kind: AgentRuntimeKind;
  modes?: AgentExecutionMode[];
  supportsDryRun?: boolean;
  supportsCancel?: boolean;
  supportsPermissionRequests?: boolean;
  supportsProgress?: boolean;
  supportsMcpServers?: boolean;
  agentCapabilities?: AgentCapabilities | null;
};

export type AgentRuntimeEvent =
  | { type: "runtime.start"; runtime: string; taskId: string; payload?: Record<string, unknown> }
  | { type: "runtime.initialized"; runtime: string; taskId: string; payload?: Record<string, unknown> }
  | { type: "runtime.session_created"; runtime: string; taskId: string; sessionId: string; payload?: Record<string, unknown> }
  | { type: "runtime.prompt_update"; runtime: string; taskId: string; sessionId?: string; update: SessionNotification }
  | { type: "runtime.permission_requested"; runtime: string; taskId: string; sessionId?: string; request: RequestPermissionRequest }
  | { type: "runtime.prompt_complete"; runtime: string; taskId: string; sessionId?: string; payload?: Record<string, unknown> }
  | { type: "runtime.cancelled"; runtime: string; taskId: string; sessionId?: string; payload?: Record<string, unknown> }
  | { type: "runtime.failed"; runtime: string; taskId: string; sessionId?: string; error: string; payload?: Record<string, unknown> };

export type AgentRuntimeEventSink = {
  emit(event: AgentRuntimeEvent): void | Promise<void>;
};

export type AgentPermissionBroker = {
  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
};

export type AgentRuntimeContext = {
  signal: unknown;
  mcpServers?: AgentMcpServerConfig[];
  permissions?: AgentPermissionBroker;
  events?: AgentRuntimeEventSink;
};

export type AgentTaskResult = {
  ok: boolean;
  reason: string;
  output?: AgentTaskOutput;
  schemaValue?: AgentSchemaValue;
  diagnostics?: Record<string, unknown>;
};

export type AgentRuntimeAdapter = {
  id: string;
  kind: AgentRuntimeKind;
  capabilities(): Promise<AgentRuntimeCapabilities>;
  submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult>;
  cancel?(taskId: string): Promise<void>;
  close?(): void | Promise<void>;
};

export type AgentMcpServerConfig = McpServer;

export type AgentPromptBuildInput = {
  task: AgentTaskRequest;
  signal: unknown;
  contextSources?: unknown[];
};

export type AgentCliJsonRuntimeOptions = {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeoutMs?: number;
  buildArgs(task: AgentTaskRequest, prompt: string): string[];
  dryRunDiagnostics?(task: AgentTaskRequest, prompt: string): Record<string, unknown>;
};

export type AgentAcpStdioRuntimeOptions = {
  id?: string;
  command: string;
  args?: string[];
  cwd?: string;
  clientInfo?: {
    name: string;
    title?: string;
    version: string;
  };
  env?: NodeJS.ProcessEnv;
  lifecycle?: "per_task" | "persistent";
  maxPersistentConversations?: number;
  persistentConversationIdleMs?: number;
};

export type AgentRuntimeSelection = {
  runtime: string;
  adapter?: AgentRuntimeAdapter;
  reason?: string;
};

export { type ContentBlock };

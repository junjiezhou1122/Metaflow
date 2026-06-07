import type {
  AgentCapabilities,
  ContentBlock,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export type AgentRuntimeKind = "acp_stdio" | "cli_json" | "mock";

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
  goal: string;
  cwd?: string;
  dryRun?: boolean;
  contextPack?: {
    markdown?: string;
    sources?: unknown[];
    diagnostics?: Record<string, unknown>;
  };
  outputContract: {
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

export type AgentRuntimeCapabilities = {
  runtimeId: string;
  kind: AgentRuntimeKind;
  supportsDryRun?: boolean;
  supportsCancel?: boolean;
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
  diagnostics?: Record<string, unknown>;
};

export type AgentRuntimeAdapter = {
  id: string;
  kind: AgentRuntimeKind;
  capabilities(): Promise<AgentRuntimeCapabilities>;
  submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult>;
  cancel?(taskId: string): Promise<void>;
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
};

export type AgentRuntimeSelection = {
  runtime: string;
  adapter?: AgentRuntimeAdapter;
  reason?: string;
};

export { type ContentBlock };

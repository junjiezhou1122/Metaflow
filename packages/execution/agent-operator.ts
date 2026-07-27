import type { ExactViewRef, JsonObject, JsonValue, ViewPolicy } from "@info/view";
import type { ExactTransformationRef } from "@info/transformation";

export type AgentExecutionMode = "invoke" | "interactive" | "background";
export type AgentOperatorOutputMode = "agent_task_output" | "schema_value";

export type AgentOperatorInput = {
  role: string;
  views: Array<{
    ref: ExactViewRef;
    policy: ViewPolicy;
  }>;
};

export type AgentOperatorViewTool = {
  name: string;
  kind: "cli" | "mcp" | "http" | "native";
  description?: string;
  command?: string;
  args?: string[];
  endpoint?: string;
  server?: string;
};

export type AgentOperatorInvocation = {
  invocation_id: string;
  run_id: string;
  correlation_id: string;
  transformation: ExactTransformationRef;
  mode: AgentExecutionMode;
  prompt: string;
  runtime_override?: string;
  cwd?: string;
  current_context: JsonObject;
  inputs: AgentOperatorInput[];
  view_tools: AgentOperatorViewTool[];
  output_contract: {
    mode?: AgentOperatorOutputMode;
    view_type: string;
    title?: string;
    purpose?: string;
    schema?: JsonValue;
  };
  policy_snapshot: {
    autonomy: "suggest" | "act" | "autonomous";
    allow_external_model: boolean;
    allow_network: boolean;
    allow_write: boolean;
  };
  timeout_ms?: number;
};

export type AgentOperatorRuntimeDescriptor = {
  runtime: string;
  kind: string;
  modes: AgentExecutionMode[];
  supports_cancel: boolean;
  supports_permissions: boolean;
  supports_progress: boolean;
  supports_mcp_servers: boolean;
};

export type AgentOperatorEventType =
  | "agent.runtime_selected"
  | "agent.runtime_event"
  | "agent.progress"
  | "agent.permission_requested"
  | "agent.completed"
  | "agent.cancelled"
  | "agent.failed";

export type AgentOperatorEvent = {
  type: AgentOperatorEventType;
  occurred_at: string;
  invocation_id: string;
  run_id: string;
  correlation_id: string;
  transformation: ExactTransformationRef;
  runtime: string;
  payload?: Record<string, unknown>;
};

export interface AgentOperatorEventSink {
  emit(event: AgentOperatorEvent): void | Promise<void>;
}

export interface AgentOperatorPermissionPort {
  request(input: {
    invocation: AgentOperatorInvocation;
    runtime: string;
    request: unknown;
  }): Promise<{
    decision:
      | { outcome: "cancelled" }
      | { outcome: "selected"; option_id: string };
  }>;
}

export type AgentOperatorExecutionContext = {
  events?: AgentOperatorEventSink;
  permissions?: AgentOperatorPermissionPort;
};

export type AgentOperatorResult =
  | {
      status: "succeeded";
      runtime: string;
      candidate: unknown;
      diagnostics?: Record<string, unknown>;
    }
  | {
      status: "failed";
      runtime?: string;
      failure: {
        code: "runtime_not_found" | "unsupported_capability" | "runtime_failed";
        message: string;
        diagnostics?: Record<string, unknown>;
      };
    };

export type AgentOperatorCancellationResult =
  | { status: "cancelled"; runtime: string }
  | {
      status: "failed";
      runtime?: string;
      failure: {
        code: "not_running" | "unsupported_capability" | "runtime_failed";
        message: string;
      };
    };

export interface AgentOperatorPort {
  capabilities(): Promise<AgentOperatorRuntimeDescriptor[]>;
  execute(
    invocation: AgentOperatorInvocation,
    context?: AgentOperatorExecutionContext,
  ): Promise<AgentOperatorResult>;
  cancel(
    invocation_id: string,
    context?: AgentOperatorExecutionContext,
  ): Promise<AgentOperatorCancellationResult>;
}

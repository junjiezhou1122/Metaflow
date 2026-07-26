import {
  PiRpcConversationRuntimeAdapter,
  type AgentPermissionBroker,
  type AgentConversationContext,
  type AgentConversationRequest,
  type AgentConversationResult,
  type AgentConversationRuntimeAdapter,
} from "@info/agent-runtime-adapter";

type NativePermissionRequest = Parameters<AgentPermissionBroker["requestPermission"]>[0];
type NativePermissionResponse = Awaited<ReturnType<AgentPermissionBroker["requestPermission"]>>;

export type DirectAssistRuntimeRouterOptions = {
  acp: AgentConversationRuntimeAdapter;
  acpPermissions?: AgentPermissionBroker;
  pi: {
    command: string;
    defaultProvider: string;
    defaultModel: string;
    thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    env?: NodeJS.ProcessEnv;
    tools?: string[];
  };
  maxPiBackends?: number;
};

export class DirectAssistRuntimeRouter implements AgentConversationRuntimeAdapter {
  readonly id = "direct_assist_router";
  private readonly piRuntimes = new Map<string, PiRpcConversationRuntimeAdapter>();

  constructor(private readonly options: DirectAssistRuntimeRouterOptions) {}

  async warmup(conversationId = "metaflow-notch"): Promise<Record<string, unknown>> {
    const runtime = this.piRuntime(this.options.pi.defaultProvider, this.options.pi.defaultModel);
    return await runtime.warmup(conversationId);
  }

  async converse(
    request: AgentConversationRequest,
    context?: AgentConversationContext,
  ): Promise<AgentConversationResult> {
    const backend = request.backend ?? {
      harness: "claude_code_acp" as const,
    };
    if (backend.harness === "claude_code_acp") {
      return await this.options.acp.converse(request, {
        ...context,
        permissions: context?.permissions ?? this.options.acpPermissions,
        async onEvent(event) {
          if (event.type === "diagnostic") {
            console.log(JSON.stringify({
              component: "ambient-direct-assist",
              event: event.event,
              request_id: request.id,
              conversation_id: request.conversationId,
              details: event.details,
            }));
          }
          await context?.onEvent?.(event);
        },
      });
    }
    const provider = backend.provider?.trim() || this.options.pi.defaultProvider;
    const model = backend.model?.trim() || this.options.pi.defaultModel;
    return await this.piRuntime(provider, model).converse(request, context);
  }

  async close(): Promise<void> {
    const runtimes = [...this.piRuntimes.values()];
    this.piRuntimes.clear();
    await Promise.all(runtimes.map(runtime => runtime.close()));
  }

  private piRuntime(provider: string, model: string): PiRpcConversationRuntimeAdapter {
    const key = `${provider}\u0000${model}`;
    const existing = this.piRuntimes.get(key);
    if (existing) return existing;
    const limit = this.options.maxPiBackends ?? 8;
    if (this.piRuntimes.size >= limit) {
      throw new Error(`Pi backend limit reached (${limit}); restart Metaflow before selecting another provider/model`);
    }
    const runtime = new PiRpcConversationRuntimeAdapter({
      id: `pi:${provider}/${model}`,
      command: this.options.pi.command,
      provider,
      model,
      thinking: this.options.pi.thinking,
      env: this.options.pi.env,
      tools: this.options.pi.tools,
    });
    this.piRuntimes.set(key, runtime);
    return runtime;
  }
}

export function createNativeAgentPermissionBroker(
  log: (record: Record<string, unknown>) => void = record => console.log(JSON.stringify(record)),
): AgentPermissionBroker {
  return {
    async requestPermission(request) {
      const response = selectNativeAgentPermission(request);
      log({
        component: "ambient-direct-assist",
        event: "acp.permission_selected",
        session_id: request.sessionId,
        tool_call: request.toolCall,
        offered_options: request.options,
        selected_option_id: response.outcome.outcome === "selected" ? response.outcome.optionId : undefined,
      });
      return response;
    },
  };
}

export function selectNativeAgentPermission(request: NativePermissionRequest): NativePermissionResponse {
  const option = request.options.find(candidate => candidate.kind === "allow_always")
    ?? request.options.find(candidate => candidate.kind === "allow_once");
  if (!option) {
    throw new Error(`ACP tool permission request ${request.toolCall.toolCallId} offered no allow option`);
  }
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

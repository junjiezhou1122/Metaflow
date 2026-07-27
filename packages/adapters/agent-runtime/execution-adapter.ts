import type {
  AgentOperatorCancellationResult,
  AgentOperatorEvent,
  AgentOperatorExecutionContext,
  AgentOperatorInvocation,
  AgentOperatorPort,
  AgentOperatorResult,
  AgentOperatorRuntimeDescriptor,
} from "@info/execution";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type {
  AgentCurrentContext,
  AgentMcpServerConfig,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentTaskRequest,
} from "./types.js";

export type AgentExecutionAdapterOptions = {
  runtimes: AgentRuntimeAdapter[];
  default_runtime: string;
  mcp_servers?: AgentMcpServerConfig[];
  now?: () => Date;
};

type ActiveInvocation = {
  invocation: AgentOperatorInvocation;
  runtime: AgentRuntimeAdapter;
};

export class AgentExecutionAdapter implements AgentOperatorPort {
  private readonly runtimes: Map<string, AgentRuntimeAdapter>;
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly now: () => Date;

  constructor(private readonly options: AgentExecutionAdapterOptions) {
    this.runtimes = new Map(options.runtimes.map(runtime => [runtime.id, runtime]));
    if (this.runtimes.size !== options.runtimes.length) {
      throw new Error("Agent runtime ids must be unique");
    }
    if (!this.runtimes.has(options.default_runtime)) {
      throw new Error(`default Agent runtime is not registered: ${options.default_runtime}`);
    }
    this.now = options.now ?? (() => new Date());
  }

  async capabilities(): Promise<AgentOperatorRuntimeDescriptor[]> {
    return Promise.all([...this.runtimes.values()].map(async runtime => {
      const capabilities = await runtime.capabilities();
      return {
        runtime: runtime.id,
        kind: runtime.kind,
        modes: capabilities.modes ?? ["invoke"],
        supports_cancel: Boolean(capabilities.supportsCancel && runtime.cancel),
        supports_permissions: Boolean(capabilities.supportsPermissionRequests),
        supports_progress: Boolean(capabilities.supportsProgress),
        supports_mcp_servers: Boolean(capabilities.supportsMcpServers),
      };
    }));
  }

  async execute(
    invocation: AgentOperatorInvocation,
    context: AgentOperatorExecutionContext = {},
  ): Promise<AgentOperatorResult> {
    const runtimeId = invocation.runtime_override ?? this.options.default_runtime;
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      return this.fail(invocation, context, undefined, "runtime_not_found", `Agent runtime is not registered: ${runtimeId}`);
    }

    const capabilities = await runtime.capabilities();
    const modes = capabilities.modes ?? ["invoke"];
    if (!modes.includes(invocation.mode)) {
      return this.fail(
        invocation,
        context,
        runtime.id,
        "unsupported_capability",
        `Agent runtime ${runtime.id} does not support ${invocation.mode} mode`,
        { supported_modes: modes },
      );
    }

    await this.emit(context, invocation, runtime.id, "agent.runtime_selected", {
      selection: invocation.runtime_override ? "explicit_override" : "configured_default",
      mode: invocation.mode,
      kind: runtime.kind,
    });

    const task = taskFromInvocation(invocation, runtime.id);
    this.active.set(invocation.invocation_id, { invocation, runtime });
    try {
      const result = await runtime.submit(task, {
        signal: {
          correlation_id: invocation.correlation_id,
          run_id: invocation.run_id,
          transformation: invocation.transformation,
          current_context: invocation.current_context,
        },
        mcpServers: capabilities.supportsMcpServers ? this.options.mcp_servers : undefined,
        permissions: context.permissions ? {
          requestPermission: async request => {
            const decision = await context.permissions!.request({ invocation, runtime: runtime.id, request });
            return permissionResponse(decision.decision);
          },
        } : undefined,
        events: {
          emit: event => this.forwardRuntimeEvent(context, invocation, runtime.id, event),
        },
      });
      const outputMode = task.outputContract.mode ?? "agent_task_output";
      const candidate = outputMode === "schema_value" ? result.schemaValue : result.output;
      if (!result.ok) {
        return this.fail(
          invocation,
          context,
          runtime.id,
          "runtime_failed",
          result.reason || `Agent runtime ${runtime.id} failed without a reason`,
          result.diagnostics,
        );
      }
      if (candidate === undefined) {
        return this.fail(
          invocation,
          context,
          runtime.id,
          "runtime_failed",
          `Agent runtime ${runtime.id} returned no ${outputMode} candidate output`,
          result.diagnostics,
        );
      }
      await this.emit(
        context,
        invocation,
        runtime.id,
        "agent.completed",
        result.diagnostics ? { diagnostics: result.diagnostics } : {},
      );
      return {
        status: "succeeded",
        runtime: runtime.id,
        candidate,
        diagnostics: result.diagnostics,
      };
    } catch (error) {
      return this.fail(invocation, context, runtime.id, "runtime_failed", errorMessage(error));
    } finally {
      this.active.delete(invocation.invocation_id);
    }
  }

  async cancel(
    invocationId: string,
    context: AgentOperatorExecutionContext = {},
  ): Promise<AgentOperatorCancellationResult> {
    const active = this.active.get(invocationId);
    if (!active) {
      return { status: "failed", failure: { code: "not_running", message: `Agent invocation is not running: ${invocationId}` } };
    }
    if (!active.runtime.cancel) {
      return {
        status: "failed",
        runtime: active.runtime.id,
        failure: { code: "unsupported_capability", message: `Agent runtime ${active.runtime.id} does not support cancellation` },
      };
    }
    try {
      await active.runtime.cancel(invocationId);
      await this.emit(context, active.invocation, active.runtime.id, "agent.cancelled");
      return { status: "cancelled", runtime: active.runtime.id };
    } catch (error) {
      return {
        status: "failed",
        runtime: active.runtime.id,
        failure: { code: "runtime_failed", message: errorMessage(error) },
      };
    }
  }

  private async forwardRuntimeEvent(
    context: AgentOperatorExecutionContext,
    invocation: AgentOperatorInvocation,
    runtime: string,
    event: AgentRuntimeEvent,
  ): Promise<void> {
    const type = event.type === "runtime.prompt_update"
      ? "agent.progress"
      : event.type === "runtime.permission_requested"
        ? "agent.permission_requested"
        : event.type === "runtime.cancelled"
          ? "agent.cancelled"
          : event.type === "runtime.failed"
            ? "agent.failed"
            : "agent.runtime_event";
    await this.emit(context, invocation, runtime, type, { runtime_event: event });
  }

  private async fail(
    invocation: AgentOperatorInvocation,
    context: AgentOperatorExecutionContext,
    runtime: string | undefined,
    code: "runtime_not_found" | "unsupported_capability" | "runtime_failed",
    message: string,
    diagnostics?: Record<string, unknown>,
  ): Promise<AgentOperatorResult> {
    await this.emit(context, invocation, runtime ?? invocation.runtime_override ?? this.options.default_runtime, "agent.failed", {
      code,
      message,
      ...(diagnostics ? { diagnostics } : {}),
    });
    return { status: "failed", runtime, failure: { code, message, diagnostics } };
  }

  private async emit(
    context: AgentOperatorExecutionContext,
    invocation: AgentOperatorInvocation,
    runtime: string,
    type: AgentOperatorEvent["type"],
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await context.events?.emit({
      type,
      occurred_at: this.now().toISOString(),
      invocation_id: invocation.invocation_id,
      run_id: invocation.run_id,
      correlation_id: invocation.correlation_id,
      transformation: invocation.transformation,
      runtime,
      payload,
    });
  }
}

function taskFromInvocation(invocation: AgentOperatorInvocation, runtime: string): AgentTaskRequest {
  return {
    id: invocation.invocation_id,
    runtime,
    prompt: invocation.prompt,
    goal: invocation.prompt,
    cwd: invocation.cwd,
    currentContext: invocation.current_context as AgentCurrentContext,
    viewTools: invocation.view_tools.map(tool => ({ ...tool })),
    contextPack: {
      sources: invocation.inputs.map(input => ({
        role: input.role,
        views: input.views.map(view => view.ref),
      })),
      diagnostics: {
        run_id: invocation.run_id,
        correlation_id: invocation.correlation_id,
        transformation: invocation.transformation,
      },
    },
    outputContract: {
      mode: invocation.output_contract.mode ?? "agent_task_output",
      viewType: invocation.output_contract.view_type,
      title: invocation.output_contract.title,
      purpose: invocation.output_contract.purpose,
      schema: invocation.output_contract.schema,
    },
    constraints: {
      execution_mode: invocation.mode,
      exact_input_revisions: true,
    },
    policy: {
      autonomy: invocation.policy_snapshot.autonomy,
      allowExternalLlm: invocation.policy_snapshot.allow_external_model,
      allowNetwork: invocation.policy_snapshot.allow_network,
      allowWrite: invocation.policy_snapshot.allow_write,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionResponse(
  decision: { outcome: "cancelled" } | { outcome: "selected"; option_id: string },
): RequestPermissionResponse {
  return decision.outcome === "cancelled"
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: decision.option_id } };
}

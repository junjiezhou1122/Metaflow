import {
  AuthoringError,
  type AuthoringProposalAgentInput,
  type AuthoringProposalAgentPort,
} from "@info/authoring";
import type { AgentRuntimeAdapter } from "./types.js";

export class AgentRuntimeAuthoringProposalAdapter implements AuthoringProposalAgentPort {
  private readonly runtimes: Map<string, AgentRuntimeAdapter>;
  private readonly localRuntimeIds: Set<string>;

  constructor(
    runtimes: AgentRuntimeAdapter[],
    private readonly defaultRuntime: string,
    options: { local_runtime_ids?: string[] } = {},
  ) {
    this.runtimes = new Map(runtimes.map(runtime => [runtime.id, runtime]));
    if (this.runtimes.size !== runtimes.length) throw new TypeError("Authoring Agent runtime ids must be unique");
    if (!this.runtimes.has(defaultRuntime)) throw new TypeError(`Default authoring Agent runtime is not registered: ${defaultRuntime}`);
    this.localRuntimeIds = new Set(options.local_runtime_ids ?? []);
    if (this.localRuntimeIds.size !== (options.local_runtime_ids?.length ?? 0)) {
      throw new TypeError("Local authoring Agent runtime ids must be unique");
    }
    for (const runtimeId of this.localRuntimeIds) {
      if (!this.runtimes.has(runtimeId)) throw new TypeError(`Local authoring Agent runtime is not registered: ${runtimeId}`);
    }
  }

  async propose(input: AuthoringProposalAgentInput, context: { signal: AbortSignal }): Promise<unknown> {
    const runtimeId = input.runtime ?? this.defaultRuntime;
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new AuthoringError("Requested authoring Agent runtime is not registered", "authoring_runtime_missing", { runtime: runtimeId });
    if (!input.policy.allow_external_model && !this.localRuntimeIds.has(runtimeId)) {
      throw new AuthoringError(
        "Authoring Request policy forbids the selected external-model Agent runtime",
        "authoring_external_model_forbidden",
        { runtime: runtimeId },
      );
    }
    const result = await runtime.submit({
      id: `authoring:${input.request_ref.view_id}:${input.request_ref.revision}`,
      runtime: runtimeId,
      prompt: input.request.prompt,
      goal: input.request.prompt,
      currentContext: {
        raw: {
          metaflow_authoring_request: {
            request_ref: input.request_ref,
            artifact_kind: input.request.artifact_kind,
            source_views: input.request.source_views,
            trace_id: input.request.trace_id,
          },
        },
      },
      outputContract: {
        mode: "schema_value",
        viewType: `metaflow.authoring.${input.request.artifact_kind}.proposal`,
        title: "Approval-gated View authoring proposal",
        purpose: "Return declarative JSON only; Metaflow validates and commits after approval",
        schema: input.output_schema,
      },
      constraints: {
        declarative_only: true,
        executable_code_forbidden: true,
        direct_commit_forbidden: true,
      },
      policy: {
        autonomy: "suggest",
        allowExternalLlm: input.policy.allow_external_model,
        allowNetwork: false,
        allowWrite: false,
      },
    }, { signal: context.signal });
    if (!result.ok) {
      throw new AuthoringError(result.reason, "authoring_agent_failed", { runtime: runtimeId });
    }
    if (result.schemaValue === undefined) {
      throw new AuthoringError("Authoring Agent returned no schema_value", "authoring_agent_output_missing", { runtime: runtimeId });
    }
    return result.schemaValue;
  }
}

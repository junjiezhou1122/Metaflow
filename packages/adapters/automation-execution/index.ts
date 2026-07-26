import { createHash } from "node:crypto";
import type {
  AutomationInteractionCommandPort,
  AutomationTargetExecutionContext,
  AutomationTargetExecutor,
  AutomationTargetRequest,
  AutomationTargetResult,
  AutomationTargetTraceEvent,
  ReactiveCascadeLedger,
  ReactiveCascadeTerminalization,
  ReactiveCascadeTerminalizer,
} from "@info/automation";
import { ReactiveCascadeLimitError } from "@info/automation";
import {
  inheritStrictestViewPolicy,
  parseViewAccessPolicySnapshot,
  type ExecutionResult,
  type ExecutionRuntime,
  type ExecutionTraceEvent,
  type ViewAccessUse,
} from "@info/execution";
import {
  exactTransformationRef,
  parseTransformation,
  type ExactTransformationRef,
  type Transformation,
} from "@info/transformation";
import {
  ReactiveCascadeContextSchema,
  exactViewRef,
  type JsonValue,
  type View,
  type ViewRepository,
} from "@info/view";

export interface TransformationCatalog {
  get(ref: ExactTransformationRef): Promise<Transformation | undefined>;
}

export class InMemoryTransformationCatalog implements TransformationCatalog {
  private readonly transformations = new Map<string, Transformation>();

  constructor(inputs: unknown[]) {
    for (const input of inputs) {
      const transformation = parseTransformation(input);
      const key = transformationKey(exactTransformationRef(transformation));
      if (this.transformations.has(key)) throw new Error(`Duplicate Transformation revision: ${key}`);
      this.transformations.set(key, transformation);
    }
  }

  async get(ref: ExactTransformationRef): Promise<Transformation | undefined> {
    return this.transformations.get(transformationKey(ref));
  }
}

export type AutomationExecutionTargetOptions = {
  transformations: TransformationCatalog;
  execution: Pick<ExecutionRuntime, "execute" | "replay" | "reconcileAbandonedRun">;
  run_id?: (request: AutomationTargetRequest) => string;
  access_use?: (transformation: Transformation) => ViewAccessUse;
  cascades?: ReactiveCascadeLedger;
};

export class AutomationExecutionTarget implements AutomationTargetExecutor {
  private readonly runId: (request: AutomationTargetRequest) => string;
  private readonly accessUse: (transformation: Transformation) => ViewAccessUse;
  private readonly activeByRun = new Map<string, AbortController>();
  private readonly runByCorrelation = new Map<string, string>();

  constructor(private readonly options: AutomationExecutionTargetOptions) {
    this.runId = options.run_id ?? deterministicRunId;
    this.accessUse = options.access_use ?? defaultAccessUse;
  }

  async execute(
    request: AutomationTargetRequest,
    context: AutomationTargetExecutionContext,
  ): Promise<AutomationTargetResult> {
    if (request.target.kind !== "transformation") {
      throw new Error(`Automation Execution target does not support Core Operation ${request.target.name}@${request.target.version}`);
    }
    const targetRef = {
      transformation_id: request.target.transformation_id,
      revision: request.target.revision,
    };
    const transformation = await this.options.transformations.get(targetRef);
    if (!transformation) throw new Error(`Transformation is missing: ${transformationKey(targetRef)}`);
    if (transformationKey(exactTransformationRef(transformation)) !== transformationKey(targetRef)) {
      throw new Error(`Transformation catalog returned the wrong revision for ${transformationKey(targetRef)}`);
    }
    if (!transformation.policy) {
      throw new Error(`Transformation requires a frozen View access policy: ${transformationKey(targetRef)}`);
    }

    const runId = this.runId(request);
    let preExecutionFailure = request.pre_execution_failure;
    let boundCascade: Awaited<ReturnType<ReactiveCascadeLedger["bindOperator"]>> | undefined;
    if (request.cascade?.disposition === "continue") {
      if (!this.options.cascades) {
        throw new Error(`Reactive cascade ledger is required for attempt ${request.cascade.attempt_id}`);
      }
      try {
        boundCascade = await this.options.cascades.bindOperator({
          attempt_id: request.cascade.attempt_id,
          operator: {
            id: transformation.operator.id,
            revision: transformation.operator.revision,
          },
          run_id: runId,
          started_at: new Date().toISOString(),
        });
      } catch (error) {
        if (!(error instanceof ReactiveCascadeLimitError)) throw error;
        preExecutionFailure = {
          code: error.code,
          message: error.message,
          stage: "execution",
          details: { cascade_attempt_id: error.attempt_id, cascade_stage: "admission" },
        };
      }
    }
    const controller = new AbortController();
    if (this.activeByRun.has(runId)) throw new Error(`Automation Execution Run is already active: ${runId}`);
    this.activeByRun.set(runId, controller);
    this.runByCorrelation.set(request.correlation_id, runId);
    const timer = request.timeout_ms === undefined
      ? undefined
      : setTimeout(() => controller.abort(), request.timeout_ms);
    let executionResult: ExecutionResult | undefined;
    try {
      if (boundCascade?.status === "reserved" && boundCascade.run_id) {
        executionResult = await this.options.execution.reconcileAbandonedRun(runId, {
          code: "worker_process_abandoned",
          message: `Operator Worker lease expired before Run ${runId} reached a durable terminal state`,
        });
        return this.completeExecution(request, context, runId, executionResult);
      }
      executionResult = await this.options.execution.execute({
        run_id: runId,
        correlation_id: request.correlation_id,
        transformation,
        access_policy: parseViewAccessPolicySnapshot(transformation.policy),
        access_use: this.accessUse(transformation),
        invocation_inputs: request.context.bindings.map(binding => ({
          role: binding.role,
          views: binding.views.map(exactViewRef),
        })),
        ...(request.runtime_override ? { runtime_override: request.runtime_override } : {}),
        failure_policy: request.policy_snapshot,
        ...(request.cascade ? {
          cascade: request.cascade,
          idempotency_key: `cascade:${request.cascade.attempt_id}`,
          ...(request.cascade.replay ? {
            previous_attempt_id: request.cascade.replay.previous_execution_attempt_id,
          } : {}),
        } : {}),
        ...(preExecutionFailure ? {
          pre_execution_failure: {
            ...preExecutionFailure,
            details: preExecutionFailure.details ?? {},
          },
        } : {}),
      }, { signal: controller.signal });
      return this.completeExecution(request, context, runId, executionResult);
    } catch (error) {
      if (!executionResult && request.cascade?.disposition === "continue" && this.options.cascades) {
        const current = await this.options.cascades.getAttempt(request.cascade.attempt_id);
        if (current?.status === "running") {
          await this.options.cascades.finalize({
            attempt_id: request.cascade.attempt_id,
            status: "failed",
            completed_at: new Date().toISOString(),
            run_id: runId,
            cost_usd: current.cost_usd,
            error_code: "target_execution_failed",
            error_message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.activeByRun.delete(runId);
      if (this.runByCorrelation.get(request.correlation_id) === runId) {
        this.runByCorrelation.delete(request.correlation_id);
      }
    }
  }

  private async completeExecution(
    request: AutomationTargetRequest,
    context: AutomationTargetExecutionContext,
    runId: string,
    result: ExecutionResult,
  ): Promise<AutomationTargetResult> {
    const target = request.target;
    if (target.kind !== "transformation") throw new Error("Execution completion requires a Transformation target");
    await this.forwardAgentEvents(runId, target, context);
    if (result.run.status !== "succeeded") {
      const failure = result.failure;
      const error = result.run.error;
      if (!failure || !result.run.failure_view || !error) {
        throw new Error(`Execution Run ${runId} ended ${result.run.status} without complete Failure View evidence`);
      }
      if (request.cascade?.disposition === "continue") {
        await this.options.cascades!.finalize({
          attempt_id: request.cascade.attempt_id,
          status: "failed",
          completed_at: result.run.completed_at ?? new Date().toISOString(),
          run_id: runId,
          cost_usd: result.run.total_cost_usd,
          error_code: error.code,
          error_message: error.message,
        });
      }
      return {
        status: "failed",
        run_id: runId,
        failure_view: result.run.failure_view,
        failure: {
          stage: error.stage,
          code: error.code,
          message: error.message,
          diagnostics: error.details,
        },
      };
    }
    if (request.cascade?.disposition === "continue") {
      await this.options.cascades!.finalize({
        attempt_id: request.cascade.attempt_id,
        status: "succeeded",
        completed_at: result.run.completed_at ?? new Date().toISOString(),
        run_id: runId,
        cost_usd: result.run.total_cost_usd,
      });
    }
    return {
      status: "succeeded",
      run_id: runId,
      output_views: result.outputs.map(exactViewRef),
    };
  }

  cancel(input: { run_id?: string; correlation_id?: string }): string {
    const runId = input.run_id ?? (input.correlation_id ? this.runByCorrelation.get(input.correlation_id) : undefined);
    if (!runId) throw new Error("Automation cancellation requires an active run_id or correlation_id");
    const controller = this.activeByRun.get(runId);
    if (!controller) throw new Error(`Automation Execution Run is not active: ${runId}`);
    controller.abort();
    return runId;
  }

  private async forwardAgentEvents(
    runId: string,
    transformation: ExactTransformationRef,
    context: AutomationTargetExecutionContext,
  ): Promise<void> {
    const replay = await this.options.execution.replay(runId);
    for (const event of replay.events) {
      if (!isAgentEvent(event.type)) continue;
      const runtime = stringValue(event.payload.runtime);
      const invocationId = stringValue(event.payload.invocation_id) ?? event.attempt_id;
      if (!runtime || !invocationId) {
        throw new Error(`Execution Agent event is missing runtime or invocation id: ${event.type}`);
      }
      await context.trace({
        type: event.type,
        occurred_at: event.occurred_at,
        invocation_id: invocationId,
        run_id: runId,
        transformation,
        runtime,
        ...(event.attempt_id ? { attempt_id: event.attempt_id } : {}),
        payload: event.payload,
        ...(event.type === "agent.failed" ? { failure: agentFailure(event) } : {}),
      });
    }
  }
}

export type AutomationCascadeTerminalizerOptions = {
  transformations: TransformationCatalog;
  execution: Pick<ExecutionRuntime, "execute" | "reconcileAbandonedRun">;
  views: Pick<ViewRepository, "get">;
  run_id?: (input: ReactiveCascadeTerminalization) => string;
  access_use?: (transformation: Transformation) => ViewAccessUse;
};

export class AutomationCascadeTerminalizer implements ReactiveCascadeTerminalizer {
  private readonly runId: (input: ReactiveCascadeTerminalization) => string;
  private readonly accessUse: (transformation: Transformation) => ViewAccessUse;

  constructor(private readonly options: AutomationCascadeTerminalizerOptions) {
    this.runId = options.run_id ?? deterministicCascadeTerminalRunId;
    this.accessUse = options.access_use ?? defaultAccessUse;
  }

  async terminalize(input: ReactiveCascadeTerminalization) {
    const attempt = input.attempt;
    const transformationRef = attempt.context.target.transformation;
    const transformation = await this.options.transformations.get(transformationRef);
    if (!transformation) {
      throw new Error(`Transformation is missing for cascade terminalization: ${transformationKey(transformationRef)}`);
    }
    if (transformationKey(exactTransformationRef(transformation)) !== transformationKey(transformationRef)) {
      throw new Error(`Transformation catalog returned the wrong cascade revision for ${transformationKey(transformationRef)}`);
    }
    if (!transformation.policy) {
      throw new Error(`Cascade terminalization requires a frozen View access policy: ${transformationKey(transformationRef)}`);
    }
    if (attempt.context.target.operator && (
      attempt.context.target.operator.id !== transformation.operator.id
      || attempt.context.target.operator.revision !== transformation.operator.revision
    )) {
      throw new Error(`Cascade terminalization Operator does not match ${transformation.operator.id}@${transformation.operator.revision}`);
    }

    const lineageViews = await this.loadLineage(attempt.context.lineage);
    const failurePolicy = inheritStrictestViewPolicy(lineageViews.map(view => view.policy));
    const runId = attempt.run_id ?? this.runId(input);
    const terminalCascade = ReactiveCascadeContextSchema.parse({
      ...attempt.context,
      disposition: "terminal",
      terminal: {
        code: input.code,
        message: input.message,
        stage: input.stage,
      },
    });
    const result = attempt.run_id
      ? await this.options.execution.reconcileAbandonedRun(runId, {
          code: "worker_process_abandoned",
          message: input.message,
        })
      : await this.options.execution.execute({
          run_id: runId,
          correlation_id: `cascade-terminal:${attempt.context.attempt_id}`,
          transformation,
          access_policy: parseViewAccessPolicySnapshot(transformation.policy),
          access_use: this.accessUse(transformation),
          invocation_inputs: transformation.inputs.map(binding => ({ role: binding.role, views: [] })),
          failure_policy: failurePolicy,
          idempotency_key: `cascade:${attempt.context.attempt_id}`,
          cascade: terminalCascade,
        });
    if (result.run.status === "succeeded") {
      return {
        status: "succeeded" as const,
        run_id: result.run.id,
        output_views: result.outputs.map(exactViewRef),
      };
    }
    if (!result.failure || !result.run.failure_view) {
      throw new Error(`Cascade terminalization Run ${runId} did not produce canonical Failure evidence`);
    }
    return { status: "failed" as const, run_id: result.run.id, failure_view: result.run.failure_view };
  }

  private async loadLineage(refs: ReactiveCascadeTerminalization["attempt"]["context"]["lineage"]): Promise<View[]> {
    const views: View[] = [];
    for (const ref of refs) {
      const view = await this.options.views.get(ref);
      if (!view) throw new Error(`Cascade terminalization lost lineage View ${ref.view_id}@${ref.revision}`);
      views.push(view);
    }
    return views;
  }
}

export class AutomationExecutionCommandHandler implements AutomationInteractionCommandPort {
  constructor(private readonly target: Pick<AutomationExecutionTarget, "cancel">) {}

  async handle(input: Parameters<AutomationInteractionCommandPort["handle"]>[0]) {
    if (input.interaction.action !== "cancel") return { status: "not_applicable" as const };
    const runId = this.target.cancel({
      ...(input.request.run_id ? { run_id: input.request.run_id } : {}),
      correlation_id: input.request.correlation_id,
    });
    return { status: "handled" as const, command_id: `cancel:${runId}:${input.idempotency_key}` };
  }
}

function deterministicRunId(request: AutomationTargetRequest): string {
  const identity = `${request.correlation_id}:${request.target.kind === "transformation"
    ? `${request.target.transformation_id}@${request.target.revision}`
    : `${request.target.name}@${request.target.version}`}`;
  return `run:automation:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function deterministicCascadeTerminalRunId(input: ReactiveCascadeTerminalization): string {
  return `run:cascade-terminal:${createHash("sha256")
    .update(`${input.attempt.context.attempt_id}:${input.attempt.context.target.transformation.transformation_id}@${input.attempt.context.target.transformation.revision}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function defaultAccessUse(transformation: Transformation): ViewAccessUse {
  const kind = transformation.operator.reference.kind;
  return kind === "agent" || kind === "model" || kind === "remote_service"
    ? "external_model"
    : "local_execution";
}

function transformationKey(ref: ExactTransformationRef): string {
  return `${ref.transformation_id}@${ref.revision}`;
}

function isAgentEvent(type: string): type is AutomationTargetTraceEvent["type"] {
  return type === "agent.runtime_selected"
    || type === "agent.runtime_event"
    || type === "agent.progress"
    || type === "agent.permission_requested"
    || type === "agent.completed"
    || type === "agent.cancelled"
    || type === "agent.failed";
}

function agentFailure(event: ExecutionTraceEvent): AutomationTargetTraceEvent["failure"] {
  return {
    stage: "execution",
    code: "agent_failed",
    message: stringValue(event.payload.message) ?? "Agent execution failed",
    diagnostics: event.payload as Record<string, JsonValue>,
  };
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

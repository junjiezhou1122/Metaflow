import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ViewRepositoryError,
  ViewRevisionTransitionError,
  ViewValidationError,
  PrivacyForgetError,
  buildSourceTombstone,
  exactViewRef,
  type JsonObject,
  type PrivacyForgetService,
  type ViewRepository,
} from "@info/view";
import {
  TransformationRepositoryError,
  TransformationRevisionTransitionError,
  type TransformationRepository,
} from "@info/transformation";
import {
  ExecutionRuntimeError,
  FeedbackEvolutionError,
  RepairExecutionError,
  ViewPolicyInheritanceError,
  parseFailureView,
  type ExecutionRepository,
  type ExecutionRuntime,
  type FeedbackEvolutionService,
} from "@info/execution";
import {
  CaptureRuntimeError,
  CaptureValidationError,
  ConnectorProtocolError,
  type CaptureRuntimeRepository,
  type ConnectorRuntime,
} from "@info/capture";
import {
  OPERATION_DESCRIPTIONS,
  OPERATION_NAMES,
  OperationContextSchema,
  OperationEnvelopeSchema,
  OperationErrorSchema,
  OperationInputSchemas,
  OperationNameSchema,
  OperationRequestSchema,
  OperationTraceEventSchema,
  operationData,
  type OperationAuthorizationPort,
  type OperationContext,
  type OperationEnvelope,
  type OperationError,
  type OperationErrorCategory,
  type OperationName,
  type OperationObserver,
} from "./contracts.js";

export type OperationServiceDependencies = {
  views: ViewRepository;
  transformations: TransformationRepository;
  execution: ExecutionRuntime;
  runs: Pick<ExecutionRepository, "getRun" | "getTrace">;
  feedback: Pick<FeedbackEvolutionService, "record">;
  privacy: Pick<PrivacyForgetService, "request" | "execute" | "inspect">;
  capture: Pick<ConnectorRuntime, "submitBatch">;
  capture_traces: Pick<CaptureRuntimeRepository, "getCaptureTrace">;
  authorization: OperationAuthorizationPort;
  observer: OperationObserver;
  now?: () => string;
};

class OperationServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly category: OperationErrorCategory,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OperationServiceError";
  }
}

export class GrantOperationAuthorizer implements OperationAuthorizationPort {
  async authorize(input: Parameters<OperationAuthorizationPort["authorize"]>[0]) {
    const allowed = input.principal.grants.includes("*") || input.principal.grants.includes(input.operation);
    return {
      allowed,
      reason: allowed
        ? `Principal ${input.principal.id} has the required operation grant`
        : `Principal ${input.principal.id} lacks grant ${input.operation}`,
    };
  }
}

export class JsonConsoleOperationObserver implements OperationObserver {
  async record(event: Parameters<OperationObserver["record"]>[0], cause?: unknown): Promise<void> {
    const diagnostic = cause instanceof Error
      ? {
          cause_name: cause.name,
          cause_message_digest: createHash("sha256").update(cause.message).digest("hex"),
        }
      : cause === undefined ? {} : { cause: String(cause) };
    console.info(JSON.stringify({ component: "metaflow-operations", ...event, diagnostic }));
  }
}

export class OperationService {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly now: () => string;

  constructor(private readonly dependencies: OperationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(requestInput: unknown, contextInput: unknown): Promise<OperationEnvelope> {
    const contextResult = OperationContextSchema.safeParse(contextInput);
    if (!contextResult.success) {
      throw new TypeError(`Operation context is invalid: ${contextResult.error.message}`);
    }
    const context = contextResult.data;
    const requestResult = OperationRequestSchema.safeParse(requestInput);
    if (!requestResult.success) {
      return this.fail(context, undefined, zodError("operation_request_invalid", "Operation request is invalid", requestResult.error));
    }
    const request = requestResult.data;
    const operation = request.operation;
    await this.dependencies.observer.record(OperationTraceEventSchema.parse({
      request_id: context.request_id,
      operation,
      actor: context.principal.id,
      type: "operation.started",
      occurred_at: this.now(),
      details: {},
    }));
    try {
      const decision = await this.dependencies.authorization.authorize({ principal: context.principal, operation });
      if (!decision.allowed) {
        throw new OperationServiceError(decision.reason, "operation_forbidden", "forbidden", {
          principal_id: context.principal.id,
          operation,
        });
      }
      const schema = OperationInputSchemas[operation];
      const parsedInput = schema.safeParse(request.input);
      if (!parsedInput.success) {
        throw zodError("operation_input_invalid", `Input for ${operation} is invalid`, parsedInput.error);
      }
      const data = await this.dispatch(operation, parsedInput.data, context);
      const envelope = OperationEnvelopeSchema.parse({
        ok: true,
        request_id: context.request_id,
        operation,
        data: operationData(data),
      });
      await this.dependencies.observer.record(OperationTraceEventSchema.parse({
        request_id: context.request_id,
        operation,
        actor: context.principal.id,
        type: "operation.succeeded",
        occurred_at: this.now(),
        details: {},
      }));
      return envelope;
    } catch (cause) {
      return this.fail(context, operation, operationError(cause), cause);
    }
  }

  private async dispatch(operation: OperationName, input: any, context: OperationContext): Promise<unknown> {
    switch (operation) {
      case "catalog.list":
        return OPERATION_NAMES.map(name => ({ name, description: OPERATION_DESCRIPTIONS[name] }));
      case "capture.ingest":
        return this.dependencies.capture.submitBatch(input.batch);
      case "view.get": {
        const view = await this.dependencies.views.get(input.ref);
        if (!view) throw new OperationServiceError("Exact View revision does not exist", "view_not_found", "not_found", { ref: input.ref });
        return view;
      }
      case "view.search":
        return this.dependencies.views.query(input.query);
      case "view.traverse":
        return this.dependencies.views.traverseRelations(input.query);
      case "view.tombstone": {
        const source = await this.dependencies.views.get(input.source);
        if (!source) {
          throw new OperationServiceError("Source View does not exist", "view_not_found", "not_found", { ref: input.source });
        }
        if (source.policy.owner !== context.principal.id) {
          throw new OperationServiceError(
            "Principal does not own the source View",
            "view_owner_mismatch",
            "forbidden",
            { ref: input.source },
          );
        }
        const draft = buildSourceTombstone(source, { ...input, actor: context.principal.id });
        return this.dependencies.views.commit({
          draft,
          expected_revision: source.revision,
          ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
        }, {
          batch_id: context.request_id,
          committed_at: draft.time.created_at,
          origin: { kind: "operation", id: context.request_id },
        });
      }
      case "transformation.submit":
        return this.dependencies.transformations.commit(input);
      case "transformation.get": {
        const transformation = await this.dependencies.transformations.get(input.ref);
        if (!transformation) {
          throw new OperationServiceError(
            "Exact Transformation revision does not exist",
            "transformation_not_found",
            "not_found",
            { ref: input.ref },
          );
        }
        return transformation;
      }
      case "run.execute": {
        const transformation = await this.dependencies.transformations.get(input.transformation);
        if (!transformation) {
          throw new OperationServiceError(
            "Run requires an existing exact Transformation revision",
            "transformation_not_found",
            "not_found",
            { ref: input.transformation },
          );
        }
        const runId = input.parameters.run_id as string;
        if (this.activeRuns.has(runId)) {
          throw new OperationServiceError("Run is already active", "run_already_active", "conflict", { run_id: runId });
        }
        const controller = new AbortController();
        this.activeRuns.set(runId, controller);
        try {
          return await this.dependencies.execution.execute({ ...input.parameters, transformation }, { signal: controller.signal });
        } finally {
          if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId);
        }
      }
      case "run.inspect":
        await this.requireRun(input.run_id);
        return this.dependencies.execution.replay(input.run_id);
      case "run.cancel": {
        const controller = this.activeRuns.get(input.run_id);
        if (!controller) {
          const existing = await this.requireRun(input.run_id);
          throw new OperationServiceError(
            `Run is not active; current status is ${existing.status}`,
            "run_not_active",
            "conflict",
            { run_id: input.run_id, status: existing.status },
          );
        }
        controller.abort(new Error(`Cancellation requested for ${input.run_id}`));
        return { run_id: input.run_id, status: "cancellation_requested" };
      }
      case "feedback.submit":
        return this.dependencies.feedback.record(input.feedback);
      case "failure.inspect": {
        const view = await this.dependencies.views.get(input.ref);
        if (!view) throw new OperationServiceError("Failure View does not exist", "failure_not_found", "not_found", { ref: input.ref });
        try {
          return { view, evidence: parseFailureView(view) };
        } catch (error) {
          throw new OperationServiceError("View is not valid Failure evidence", "failure_invalid", "invalid_request", { ref: input.ref }, { cause: error });
        }
      }
      case "policy.decision.get": {
        const run = await this.requireRun(input.run_id);
        return run.frozen.authorization;
      }
      case "privacy.forget.request":
        return this.dependencies.privacy.request({ ...input, actor: context.principal.id });
      case "privacy.forget.execute":
        return this.dependencies.privacy.execute({ ...input, actor: context.principal.id });
      case "privacy.forget.inspect":
        return this.dependencies.privacy.inspect(input.request_id, context.principal.id);
      case "trace.read":
        if (input.scope === "run") {
          await this.requireRun(input.run_id);
          return this.dependencies.runs.getTrace(input.run_id);
        }
        return this.dependencies.capture_traces.getCaptureTrace(input.connection_id);
    }
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.runs.getRun(runId);
    if (!run) throw new OperationServiceError("Run does not exist", "run_not_found", "not_found", { run_id: runId });
    return run;
  }

  private async fail(
    context: OperationContext,
    operation: OperationName | undefined,
    error: OperationError,
    cause?: unknown,
  ): Promise<OperationEnvelope> {
    const envelope = OperationEnvelopeSchema.parse({
      ok: false,
      request_id: context.request_id,
      ...(operation ? { operation } : {}),
      error,
    });
    await this.dependencies.observer.record(OperationTraceEventSchema.parse({
      request_id: context.request_id,
      ...(operation ? { operation } : {}),
      actor: context.principal.id,
      type: "operation.failed",
      occurred_at: this.now(),
      details: {},
      error,
    }), cause);
    return envelope;
  }
}

function zodError(code: string, message: string, error: z.ZodError): OperationServiceError {
  return new OperationServiceError(message, code, "invalid_request", {
    issues: flattenZodIssues(error.issues),
  });
}

function flattenZodIssues(issues: z.ZodIssue[], parentPath: string[] = []): JsonObject[] {
  return issues.flatMap(issue => {
    const path = [...parentPath, ...issue.path.map(String)];
    if (issue.code === z.ZodIssueCode.invalid_union) {
      return issue.unionErrors.flatMap(error => flattenZodIssues(error.issues, path));
    }
    return [{ code: issue.code, path, message: issue.message }];
  });
}

function operationError(cause: unknown): OperationError {
  if (cause instanceof OperationServiceError) {
    return OperationErrorSchema.parse({ code: cause.code, message: cause.message, category: cause.category, details: cause.details });
  }
  if (cause instanceof z.ZodError) {
    const error = zodError("domain_validation_failed", "Domain input failed validation", cause);
    return OperationErrorSchema.parse({ code: error.code, message: error.message, category: error.category, details: error.details });
  }
  if (cause instanceof ExecutionRuntimeError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: executionCategory(cause.code),
      details: { stage: cause.stage, ...cause.details },
    });
  }
  if (cause instanceof PrivacyForgetError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: forgetCategory(cause.code),
      details: { stage: cause.stage, ...cause.details },
    });
  }
  if (cause instanceof CaptureRuntimeError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: cause.retryable ? "failed_dependency" : genericCategory(cause.code),
      details: { stage: cause.stage, retryable: cause.retryable, ...cause.details },
    });
  }
  if (
    cause instanceof ViewRepositoryError
    || cause instanceof TransformationRepositoryError
    || cause instanceof FeedbackEvolutionError
    || cause instanceof RepairExecutionError
  ) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: genericCategory(cause.code),
      details: cause.details,
    });
  }
  if (
    cause instanceof ViewValidationError
    || cause instanceof ViewRevisionTransitionError
    || cause instanceof TransformationRevisionTransitionError
    || cause instanceof ViewPolicyInheritanceError
  ) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: "invalid_request",
      details: {},
    });
  }
  if (cause instanceof CaptureValidationError || cause instanceof ConnectorProtocolError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: "invalid_request",
      details: cause instanceof CaptureValidationError ? { issues: cause.issues } : {},
    });
  }
  return OperationErrorSchema.parse({
    code: "operation_internal_error",
    message: "Operation failed unexpectedly; inspect the operation observer for the root cause",
    category: "internal",
    details: {},
  });
}

function executionCategory(code: string): OperationErrorCategory {
  if (code === "authorization_denied" || code === "approval_required") return "forbidden";
  if (code.endsWith("not_found")) return "not_found";
  if (code === "run_already_active" || code === "idempotency_conflict" || code === "stale_base") return "conflict";
  if (code === "operator_failed" || code === "operator_crashed" || code === "commit_failed" || code === "failure_commit_failed") {
    return "failed_dependency";
  }
  return "invalid_request";
}

function genericCategory(code: string): OperationErrorCategory {
  if (code.endsWith("not_found")) return "not_found";
  if (code.includes("conflict") || code === "stale_base") return "conflict";
  if (code === "storage_failure" || code.includes("commit_failed")) return "failed_dependency";
  if (code.includes("denied") || code.includes("approval_required")) return "forbidden";
  return "invalid_request";
}

function forgetCategory(code: string): OperationErrorCategory {
  if (code === "forget_request_not_found" || code === "forget_target_not_found") return "not_found";
  if (code === "forget_owner_mismatch" || code.includes("preauthorization") || code.includes("confirmation")) return "forbidden";
  if (code.includes("cleanup_failed") || code.includes("rebuild_failed") || code.includes("commit_failed")) {
    return "failed_dependency";
  }
  return "invalid_request";
}

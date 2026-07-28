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
  type ViewGraphProjectionSource,
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
  ConnectorPackageError,
  SourceConnectionOnboardingError,
  type CaptureRuntimeRepository,
  type ConnectorRuntime,
  type SourceConnectionOnboardingService,
} from "@info/capture";
import {
  SearchError,
  type SearchService,
  type ViewReadAuthorizationDecision,
  type ViewReadAuthorizationPort,
} from "@info/search";
import {
  AuthoringDecisionValueSchema,
  AuthoringError,
  AuthoringProposalValueSchema,
  type AuthoringService,
} from "@info/authoring";
import {
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
import { OPERATION_CATALOG } from "./catalog.js";
import {
  ViewGraphProjectionOperationError,
  projectAuthorizedViewGraph,
} from "./graph-project.js";
import { ViewQueryError, type ViewQueryRegistry } from "./view-query.js";

export type OperationServiceDependencies = {
  views: ViewRepository;
  graph: ViewGraphProjectionSource;
  search: Pick<SearchService, "search">;
  view_reads: ViewReadAuthorizationPort;
  view_queries?: Pick<ViewQueryRegistry, "query">;
  transformations: TransformationRepository;
  execution: ExecutionRuntime;
  runs: Pick<ExecutionRepository, "getRun" | "getTrace">;
  feedback: Pick<FeedbackEvolutionService, "record" | "apply">;
  privacy: Pick<PrivacyForgetService, "request" | "execute" | "inspect">;
  capture: Pick<ConnectorRuntime, "submitBatch" | "replayDeadLetter">;
  connector_onboarding: SourceConnectionOnboardingService;
  capture_traces: Pick<CaptureRuntimeRepository, "getCaptureTrace" | "listCaptureDeadLetters" | "getCaptureDeadLetter">;
  authoring: Pick<AuthoringService, "request" | "propose" | "inspect" | "approve" | "reject" | "apply">;
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
        return OPERATION_CATALOG;
      case "connector.list":
        return this.dependencies.connector_onboarding.listPackages();
      case "connector.inspect":
        return this.dependencies.connector_onboarding.inspectPackage(input.package);
      case "capture.ingest":
        return this.dependencies.capture.submitBatch(input.batch);
      case "capture.connection.list":
        return (await this.dependencies.connector_onboarding.listConnections())
          .filter(item => item.connection.privacy.owner === context.principal.id);
      case "capture.connection.create":
        if (input.connection.privacy?.owner !== undefined && input.connection.privacy.owner !== context.principal.id) {
          throw new OperationServiceError("Principal cannot create a Source Connection for another owner", "connection_owner_mismatch", "forbidden", {
            owner: input.connection.privacy.owner,
          });
        }
        return this.dependencies.connector_onboarding.create({
          ...input,
          connection: {
            ...input.connection,
            privacy: input.connection.privacy ?? {
              owner: context.principal.id,
              visibility: "private",
              privacy: "private",
              retention: "normal",
              allow_external_model: false,
              allow_embedding: false,
              allow_local_search: true,
              labels: [],
            },
          },
        });
      case "capture.connection.check":
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.connector_onboarding.check(input);
      case "capture.connection.discover":
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.connector_onboarding.discover(input);
      case "capture.connection.activate":
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.connector_onboarding.activate(input);
      case "capture.connection.update":
        await this.requireConnectionOwner(context, input.connection_id);
        if (input.privacy?.owner !== undefined && input.privacy.owner !== context.principal.id) {
          throw new OperationServiceError("Principal cannot transfer Source Connection ownership", "connection_owner_mismatch", "forbidden");
        }
        return this.dependencies.connector_onboarding.update(input);
      case "capture.connection.pause":
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.connector_onboarding.pause(input);
      case "capture.connection.run":
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.connector_onboarding.run(input);
      case "capture.dlq.list":
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.capture_traces.listCaptureDeadLetters(input.connection_id, input.status);
      case "capture.dlq.replay": {
        const deadLetter = await this.dependencies.capture_traces.getCaptureDeadLetter(input.id);
        if (!deadLetter) throw new OperationServiceError("Capture dead letter does not exist", "dead_letter_not_found", "not_found", { id: input.id });
        await this.requireConnectionOwner(context, deadLetter.connection_id);
        return this.dependencies.capture.replayDeadLetter(input.id);
      }
      case "view.get": {
        await this.requireViewRead(context, [input.ref], "read");
        const view = await this.dependencies.views.get(input.ref);
        if (!view) throw new OperationServiceError("Exact View revision does not exist", "view_not_found", "not_found", { ref: input.ref });
        return view;
      }
      case "view.resolve.latest": {
        const ref = await this.dependencies.views.resolveLatest(input.view_id);
        if (!ref) throw new OperationServiceError("View identity does not exist", "view_not_found", "not_found", { view_id: input.view_id });
        await this.requireViewRead(context, [ref], "read");
        return ref;
      }
      case "view.query": {
        await this.requireViewRead(context, [input.request.subject], "query");
        const subject = await this.dependencies.views.get(input.request.subject);
        if (!subject) throw new OperationServiceError("Exact View revision does not exist", "view_not_found", "not_found", { ref: input.request.subject });
        if (!this.dependencies.view_queries) {
          throw new OperationServiceError("View query runtime is not configured", "view_query_unavailable", "failed_dependency");
        }
        return this.dependencies.view_queries.query({
          request: input.request,
          subject,
          principal: { id: context.principal.id },
          authorization: this.dependencies.view_reads,
        });
      }
      case "view.graph.project":
        return projectAuthorizedViewGraph({
          request: input.request,
          principal: { id: context.principal.id },
          authorization: this.dependencies.view_reads,
          source: this.dependencies.graph,
        });
      case "view.search":
        return this.dependencies.search.search({
          request_id: context.request_id,
          principal: { id: context.principal.id },
          request: input.request,
        });
      case "view.search.reindex":
        return this.dependencies.views.reindexSearch(input);
      case "view.traverse": {
        await this.requireViewRead(context, [input.query.ref], "traverse");
        const relations = await this.dependencies.views.traverseRelations(input.query);
        const refs = uniqueRefs(relations.flatMap(relation => [relation.source, relation.target]));
        await this.requireViewRead(context, refs, "traverse");
        return relations;
      }
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
      case "view.authoring.request": {
        await this.requireViewRead(context, input.source_views, "read");
        return this.dependencies.authoring.request(input, context.principal.id);
      }
      case "view.authoring.propose":
        await this.requireViewRead(context, [input.request], "read");
        return this.dependencies.authoring.propose(input, context.principal.id);
      case "view.authoring.inspect":
        await this.requireViewRead(context, [input.ref], "read");
        return this.dependencies.authoring.inspect(input);
      case "view.authoring.approve":
        await this.requireViewRead(context, [input.proposal], "read");
        return this.dependencies.authoring.approve(input, context.principal.id);
      case "view.authoring.reject":
        await this.requireAuthoringProposalChain(context, input.proposal);
        return this.dependencies.authoring.reject(input, context.principal.id);
      case "view.authoring.apply": {
        await this.requireViewRead(context, [input.decision], "read");
        const decision = AuthoringDecisionValueSchema.parse((await this.dependencies.authoring.inspect({ ref: input.decision })).lifecycle);
        await this.requireAuthoringProposalChain(context, decision.proposal);
        return this.dependencies.authoring.apply(input, context.principal.id);
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
      case "feedback.apply":
        await this.requireViewRead(context, [input.feedback], "read");
        return this.dependencies.feedback.apply(input);
      case "failure.inspect": {
        await this.requireViewRead(context, [input.ref], "read");
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
        await this.requireConnectionOwner(context, input.connection_id);
        return this.dependencies.capture_traces.getCaptureTrace(input.connection_id);
    }
  }

  private async requireViewRead(
    context: OperationContext,
    refs: Array<{ view_id: string; revision: number }>,
    purpose: "read" | "query" | "traverse",
  ): Promise<void> {
    if (refs.length === 0) return;
    const decisions = await this.dependencies.view_reads.authorize({
      principal: { id: context.principal.id },
      refs,
      purpose,
    });
    validateReadDecisions(refs, decisions);
    const rejected = decisions.find(decision => decision.status !== "allowed");
    if (!rejected) return;
    if (rejected.status === "missing") {
      throw new OperationServiceError("Exact View revision does not exist", "view_not_found", "not_found", { ref: rejected.ref });
    }
    throw new OperationServiceError("Principal cannot read exact View revision", "view_read_forbidden", "forbidden", {
      ref: rejected.ref,
      reason: rejected.code ?? "view_read_forbidden",
    });
  }

  private async requireRun(runId: string) {
    const run = await this.dependencies.runs.getRun(runId);
    if (!run) throw new OperationServiceError("Run does not exist", "run_not_found", "not_found", { run_id: runId });
    return run;
  }

  private async requireAuthoringProposalChain(
    context: OperationContext,
    proposalRef: { view_id: string; revision: number },
  ) {
    await this.requireViewRead(context, [proposalRef], "read");
    const inspected = await this.dependencies.authoring.inspect({ ref: proposalRef });
    const proposal = AuthoringProposalValueSchema.parse(inspected.lifecycle);
    await this.requireViewRead(context, [proposal.request], "read");
    return proposal;
  }

  private async requireConnectionOwner(context: OperationContext, connectionId: string): Promise<void> {
    const lifecycle = await this.dependencies.connector_onboarding.inspectConnection(connectionId);
    if (lifecycle.connection.privacy.owner !== context.principal.id) {
      throw new OperationServiceError("Principal does not own the Source Connection", "connection_owner_mismatch", "forbidden", {
        connection_id: connectionId,
      });
    }
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
  if (cause instanceof SearchError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: searchCategory(cause.code),
      details: { stage: cause.stage, retryable: cause.retryable },
    });
  }
  if (cause instanceof AuthoringError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: authoringCategory(cause.code),
      details: cause.details,
    });
  }
  if (cause instanceof ViewGraphProjectionOperationError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: "internal",
      details: cause.details,
    });
  }
  if (cause instanceof ViewQueryError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: cause.code.includes("unknown") ? "not_found" : cause.code.includes("cursor_mismatch") ? "conflict" : "invalid_request",
      details: {},
    });
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
  if (cause instanceof ConnectorPackageError || cause instanceof SourceConnectionOnboardingError) {
    return OperationErrorSchema.parse({
      code: cause.code,
      message: cause.message,
      category: genericCategory(cause.code),
      details: cause.details,
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

function authoringCategory(code: string): OperationErrorCategory {
  if (code.endsWith("_not_found") || code === "authoring_view_not_found") return "not_found";
  if (code.includes("owner_mismatch") || code.includes("forbidden")) return "forbidden";
  if (code.includes("conflict") || code.includes("digest_mismatch") || code === "authoring_not_approved") return "conflict";
  if (code.includes("dependency") || code.includes("runtime_missing") || code.startsWith("authoring_package_")) return "failed_dependency";
  return "invalid_request";
}

function validateReadDecisions(
  refs: Array<{ view_id: string; revision: number }>,
  decisions: ViewReadAuthorizationDecision[],
): void {
  const expected = refs.map(refKey).sort();
  const actual = decisions.map(decision => refKey(decision.ref)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual) || new Set(actual).size !== actual.length) {
    throw new OperationServiceError(
      "View read authorizer returned incomplete or duplicate decisions",
      "view_read_authorizer_invalid",
      "internal",
    );
  }
}

function uniqueRefs(refs: Array<{ view_id: string; revision: number }>): Array<{ view_id: string; revision: number }> {
  return [...new Map(refs.map(ref => [refKey(ref), ref])).values()];
}

function refKey(ref: { view_id: string; revision: number }): string {
  return `${ref.view_id}@${ref.revision}`;
}

function searchCategory(code: string): OperationErrorCategory {
  if (code === "view_not_found") return "not_found";
  if (code === "view_read_forbidden" || code === "mode_forbidden") return "forbidden";
  if (code.includes("stale") || code === "cursor_request_mismatch") return "conflict";
  if (code === "observer_failed" || code.endsWith("_failed")) return "failed_dependency";
  return "invalid_request";
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

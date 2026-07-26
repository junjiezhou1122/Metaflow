import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  TimestampSchema,
  ViewPolicySchema,
  canonicalJson,
  exactViewRef,
  parseViewDraft,
  viewRevisionKey,
  type ExactViewRef,
  type JsonObject,
  type View,
  type ViewPolicy,
  type ViewRepository,
} from "@info/view";
import {
  TransformationSchema,
  exactTransformationRef,
  type Transformation,
  type TransformationInputSource,
} from "@info/transformation";
import { failureClassification, parseFailureView, strictSchemaRef } from "./failure.js";
import {
  ExecutionRuntimeOverrideSchema,
  RepairPolicySnapshotSchema,
  type ExecutionResult,
  type RepairPolicySnapshot,
  type StartExecutionInput,
} from "./runtime-contracts.js";
import { ExecutionRuntime } from "./runtime.js";
import { ViewAccessPolicySnapshotSchema, ViewAccessUseSchema } from "./view-access-policy.js";

export const RepairDecisionReasonSchema = z.enum([
  "allowed",
  "causal_cycle",
  "max_depth",
  "repeated_fingerprint",
  "non_retryable_error",
  "error_not_retryable",
]);

export const RepairDecisionRepresentationSchema = z.object({
  version: z.literal(1),
  decision_id: IdentifierSchema,
  status: z.enum(["allowed", "blocked"]),
  reason: RepairDecisionReasonSchema,
  failure: ExactViewRefSchema,
  transformation: z.object({ transformation_id: IdentifierSchema, revision: z.number().int().positive() }).strict(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  failure_class: IdentifierSchema,
  ancestor_failures: z.array(ExactViewRefSchema),
  depth: z.number().int().positive(),
  repeated_fingerprint_count: z.number().int().nonnegative(),
  policy: RepairPolicySnapshotSchema,
  run_id: IdentifierSchema,
  created_at: TimestampSchema,
}).strict().superRefine((decision, context) => {
  if ((decision.status === "allowed") !== (decision.reason === "allowed")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only an allowed Repair decision may use reason allowed" });
  }
});

const RepairExecutionInputSchema = z.object({
  run_id: IdentifierSchema,
  correlation_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  failure: ExactViewRefSchema,
  transformation: TransformationSchema,
  access_policy: ViewAccessPolicySnapshotSchema,
  access_use: ViewAccessUseSchema,
  policy: RepairPolicySnapshotSchema,
  invocation_inputs: z.array(z.object({
    role: IdentifierSchema,
    views: z.array(ExactViewRefSchema),
  }).strict()).optional(),
  runtime_override: ExecutionRuntimeOverrideSchema.optional(),
  failure_policy: ViewPolicySchema.optional(),
  previous_attempt_id: IdentifierSchema.optional(),
  created_at: TimestampSchema,
}).strict();

export type RepairDecisionReason = z.infer<typeof RepairDecisionReasonSchema>;
export type RepairDecisionRepresentation = z.infer<typeof RepairDecisionRepresentationSchema>;
export type RepairExecutionInput = z.infer<typeof RepairExecutionInputSchema>;

export type RepairExecutionResult =
  | { status: "blocked"; decision: View }
  | { status: "executed"; decision: View; execution: ExecutionResult };

export type RepairExecutionErrorCode =
  | "failure_not_found"
  | "failure_invalid"
  | "failure_not_declared"
  | "ancestor_not_found"
  | "ancestor_invalid";

export class RepairExecutionError extends Error {
  constructor(
    message: string,
    readonly code: RepairExecutionErrorCode,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepairExecutionError";
  }
}

export type RepairExecutionServiceOptions = {
  views: Pick<ViewRepository, "get" | "commit">;
  runtime: ExecutionRuntime;
};

export class RepairExecutionService {
  constructor(private readonly options: RepairExecutionServiceOptions) {}

  async execute(input: RepairExecutionInput, options: { signal?: AbortSignal } = {}): Promise<RepairExecutionResult> {
    const request = RepairExecutionInputSchema.parse(input);
    const failureView = await this.options.views.get(request.failure);
    if (!failureView) {
      throw new RepairExecutionError(
        `Repair target ${viewRevisionKey(request.failure)} does not exist`,
        "failure_not_found",
        { failure: request.failure },
      );
    }
    let failure;
    try {
      failure = parseFailureView(failureView);
    } catch (error) {
      throw new RepairExecutionError(
        `Repair target ${viewRevisionKey(request.failure)} is not valid Failure evidence`,
        "failure_invalid",
        { failure: request.failure },
        { cause: error },
      );
    }
    if (!declaresFailure(request.transformation, request.failure)) {
      throw new RepairExecutionError(
        `Repair Transformation ${request.transformation.id}@${request.transformation.revision} does not declare ${viewRevisionKey(request.failure)} as exact input`,
        "failure_not_declared",
        { failure: request.failure },
      );
    }

    const ancestors = [...failure.causal_chain.ancestor_failures, request.failure];
    const fingerprint = repairFingerprint(request.transformation, failureClassification(failure));
    const priorFingerprints: string[] = [];
    for (const ancestor of ancestors) {
      const view = viewRevisionKey(ancestor) === viewRevisionKey(request.failure)
        ? failureView
        : await this.options.views.get(ancestor);
      if (!view) {
        throw new RepairExecutionError(
          `Repair ancestor ${viewRevisionKey(ancestor)} does not exist`,
          "ancestor_not_found",
          { ancestor },
        );
      }
      try {
        const evidence = parseFailureView(view);
        if (evidence.repair) priorFingerprints.push(evidence.repair.fingerprint);
      } catch (error) {
        throw new RepairExecutionError(
          `Repair ancestor ${viewRevisionKey(ancestor)} is invalid`,
          "ancestor_invalid",
          { ancestor },
          { cause: error },
        );
      }
    }
    const repeatCount = priorFingerprints.filter(item => item === fingerprint).length;
    const failureClass = failureClassification(failure);
    const reason = decisionReason(request.failure, ancestors, request.policy, failureClass, repeatCount);
    const decision = RepairDecisionRepresentationSchema.parse({
      version: 1,
      decision_id: repairDecisionId(request, fingerprint),
      status: reason === "allowed" ? "allowed" : "blocked",
      reason,
      failure: request.failure,
      transformation: exactTransformationRef(request.transformation),
      fingerprint,
      failure_class: failureClass,
      ancestor_failures: ancestors,
      depth: ancestors.length,
      repeated_fingerprint_count: repeatCount,
      policy: request.policy,
      run_id: request.run_id,
      created_at: request.created_at,
    });
    const committed = await this.options.views.commit({
      draft: repairDecisionView(decision, failureView.policy),
      expected_revision: 0,
      idempotency_key: `repair-decision:${request.idempotency_key}`,
    });
    if (reason !== "allowed") return { status: "blocked", decision: committed.view };

    const start: StartExecutionInput = {
      run_id: request.run_id,
      correlation_id: request.correlation_id,
      transformation: request.transformation,
      access_policy: request.access_policy,
      access_use: request.access_use,
      idempotency_key: request.idempotency_key,
      repair_context: {
        parent_failure: request.failure,
        ancestor_failures: ancestors,
        fingerprint,
        policy: request.policy,
        decision_view: exactViewRef(committed.view),
        depth: ancestors.length,
      },
      ...(request.invocation_inputs ? { invocation_inputs: request.invocation_inputs } : {}),
      ...(request.runtime_override ? { runtime_override: request.runtime_override } : {}),
      ...(request.failure_policy ? { failure_policy: request.failure_policy as ViewPolicy } : {}),
      ...(request.previous_attempt_id ? { previous_attempt_id: request.previous_attempt_id } : {}),
    };
    const execution = await this.options.runtime.execute(start, options);
    return { status: "executed", decision: committed.view, execution };
  }
}

export function parseRepairDecisionView(view: View): RepairDecisionRepresentation {
  if (view.schema.name !== "metaflow.repair.decision" || view.schema.version !== 1 || view.representation.form !== "inline") {
    throw new TypeError(`View ${view.id}@${view.revision} is not a Repair decision View`);
  }
  const decision = RepairDecisionRepresentationSchema.parse(view.representation.value);
  if (!view.relations.some(relation => relation.type === "repair_decision_for"
    && viewRevisionKey(relation.target) === viewRevisionKey(decision.failure))) {
    throw new TypeError(`Repair decision ${view.id}@${view.revision} omits its exact Failure relation`);
  }
  return decision;
}

export function repairFingerprint(transformation: Transformation, failureClass: string): string {
  return createHash("sha256").update(canonicalJson({
    failure_class: failureClass,
    transformation: {
      id: transformation.id,
      instruction: transformation.instruction,
      operator: {
        id: transformation.operator.id,
        reference: transformation.operator.reference,
        configuration: transformation.operator.configuration,
        required_capabilities: transformation.operator.required_capabilities,
      },
      input_roles: transformation.inputs.map(binding => ({ role: binding.role, required: binding.required })),
      output: transformation.output,
      budget: transformation.budget ?? null,
    },
  })).digest("hex");
}

function decisionReason(
  target: ExactViewRef,
  ancestors: ExactViewRef[],
  policy: RepairPolicySnapshot,
  failureClass: string,
  repeatCount: number,
): RepairDecisionReason {
  const keys = ancestors.map(viewRevisionKey);
  if (new Set(keys).size !== keys.length || keys.slice(0, -1).includes(viewRevisionKey(target))) return "causal_cycle";
  if (ancestors.length > policy.max_depth) return "max_depth";
  if (policy.non_retryable_error_codes.includes(failureClass)) return "non_retryable_error";
  if (policy.retryable_error_codes.length > 0 && !policy.retryable_error_codes.includes(failureClass)) return "error_not_retryable";
  if (repeatCount >= policy.max_repeated_fingerprint) return "repeated_fingerprint";
  return "allowed";
}

function declaresFailure(transformation: Transformation, failure: ExactViewRef): boolean {
  const key = viewRevisionKey(failure);
  return transformation.inputs.some(binding => binding.sources.some(source => sourceKey(source) === key));
}

function sourceKey(source: TransformationInputSource): string | undefined {
  return source.kind === "view" ? viewRevisionKey(source.ref) : undefined;
}

function repairDecisionId(request: RepairExecutionInput, fingerprint: string): string {
  const digest = createHash("sha256").update(canonicalJson({
    idempotency_key: request.idempotency_key,
    failure: request.failure,
    transformation: exactTransformationRef(request.transformation),
    policy: request.policy,
    fingerprint,
  })).digest("hex").slice(0, 32);
  return `repair-decision:${digest}`;
}

function repairDecisionView(decision: RepairDecisionRepresentation, policy: ViewPolicy) {
  return parseViewDraft({
    id: `view:${decision.decision_id}`,
    name: `Repair ${decision.status}: ${decision.failure.view_id}@${decision.failure.revision}`,
    purpose: "Durable policy decision for one exact Failure repair request",
    aliases: [],
    schema: strictSchemaRef("metaflow.repair.decision", RepairDecisionRepresentationSchema),
    role: "derived",
    time: { created_at: decision.created_at },
    representation: {
      form: "inline",
      kind: "repair_decision",
      media_type: "application/json",
      value: decision,
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [{ type: "repair_decision_for", target: decision.failure, metadata: { status: decision.status, reason: decision.reason } }],
    provenance: { inputs: [decision.failure], actor: "repair-execution-service" },
    policy,
    metadata: { repair_status: decision.status, repair_reason: decision.reason },
  });
}

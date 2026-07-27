import { z } from "zod";
import {
  ExactViewRefSchema,
  ExecuteForgetParametersSchema,
  ForgetRequestParametersSchema,
  IdentifierSchema,
  JsonValueSchema,
  RelationTraversalQuerySchema,
  ViewGraphProjectionRequestSchema,
  ViewPolicySchema,
  ReindexViewSearchInputSchema,
  SourceTombstoneParametersSchema,
  TimestampSchema,
  type JsonObject,
  type JsonValue,
} from "@info/view";
import { SearchRequestV1Schema } from "@info/search";
import {
  ExactTransformationRefSchema,
  TransformationSchema,
} from "@info/transformation";
import {
  RecordFeedbackInputSchema,
  StartExecutionParametersSchema,
} from "@info/execution";
import {
  CaptureBatchSchema,
  CaptureDeliveryKindSchema,
  CaptureIdentifierSchema,
  ExactConnectorPackageRefSchema,
  NamedSecretReferencesSchema,
} from "@info/capture";
import {
  AuthoringApplyInputSchema,
  AuthoringDecisionInputSchema,
  AuthoringInspectInputSchema,
  AuthoringProposeInputSchema,
  AuthoringRejectInputSchema,
  AuthoringRequestInputSchema,
} from "@info/authoring";

export const OPERATION_NAMES = [
  "catalog.list",
  "connector.list",
  "connector.inspect",
  "capture.ingest",
  "capture.connection.list",
  "capture.connection.create",
  "capture.connection.check",
  "capture.connection.discover",
  "capture.connection.activate",
  "capture.connection.update",
  "capture.connection.pause",
  "capture.connection.run",
  "capture.dlq.list",
  "capture.dlq.replay",
  "view.get",
  "view.graph.project",
  "view.search",
  "view.search.reindex",
  "view.traverse",
  "view.tombstone",
  "view.authoring.request",
  "view.authoring.propose",
  "view.authoring.inspect",
  "view.authoring.approve",
  "view.authoring.reject",
  "view.authoring.apply",
  "transformation.submit",
  "transformation.get",
  "run.execute",
  "run.inspect",
  "run.cancel",
  "feedback.submit",
  "failure.inspect",
  "policy.decision.get",
  "privacy.forget.request",
  "privacy.forget.execute",
  "privacy.forget.inspect",
  "trace.read",
] as const;

export const OperationNameSchema = z.enum(OPERATION_NAMES);

export const OperationInputSchemas = {
  "catalog.list": z.object({}).strict(),
  "connector.list": z.object({}).strict(),
  "connector.inspect": z.object({ package: ExactConnectorPackageRefSchema }).strict(),
  "capture.ingest": z.object({ batch: CaptureBatchSchema }).strict(),
  "capture.connection.list": z.object({}).strict(),
  "capture.connection.create": z.object({
    idempotency_key: CaptureIdentifierSchema,
    package: ExactConnectorPackageRefSchema,
    connection: z.object({
      id: CaptureIdentifierSchema,
      display_name: z.string().trim().min(1).max(500),
      endpoint: z.string().trim().min(1).optional(),
      delivery_kinds: z.array(CaptureDeliveryKindSchema).min(1),
      secret_refs: NamedSecretReferencesSchema,
      configuration: z.record(JsonValueSchema),
      privacy: ViewPolicySchema.optional(),
    }).strict(),
  }).strict(),
  "capture.connection.check": lifecycleGenerationInput(),
  "capture.connection.discover": lifecycleGenerationInput({ parameters: z.record(JsonValueSchema).default({}) }),
  "capture.connection.activate": lifecycleGenerationInput(),
  "capture.connection.update": lifecycleGenerationInput({
    display_name: z.string().trim().min(1).max(500).optional(),
    endpoint: z.string().trim().min(1).optional(),
    delivery_kinds: z.array(CaptureDeliveryKindSchema).min(1).optional(),
    secret_refs: NamedSecretReferencesSchema.optional(),
    configuration: z.record(JsonValueSchema).optional(),
    privacy: ViewPolicySchema.optional(),
  }),
  "capture.connection.pause": lifecycleGenerationInput(),
  "capture.connection.run": lifecycleGenerationInput({
    delivery: z.enum(["pull", "stream", "reference"]),
    parameters: z.record(JsonValueSchema).default({}),
  }),
  "capture.dlq.list": z.object({
    connection_id: CaptureIdentifierSchema,
    status: z.enum(["pending", "resolved"]).optional(),
  }).strict(),
  "capture.dlq.replay": z.object({ id: CaptureIdentifierSchema }).strict(),
  "view.get": z.object({ ref: ExactViewRefSchema }).strict(),
  "view.graph.project": z.object({ request: ViewGraphProjectionRequestSchema }).strict(),
  "view.search": z.object({ request: SearchRequestV1Schema }).strict(),
  "view.search.reindex": ReindexViewSearchInputSchema,
  "view.traverse": z.object({ query: RelationTraversalQuerySchema }).strict(),
  "view.tombstone": SourceTombstoneParametersSchema,
  "view.authoring.request": AuthoringRequestInputSchema,
  "view.authoring.propose": AuthoringProposeInputSchema,
  "view.authoring.inspect": AuthoringInspectInputSchema,
  "view.authoring.approve": AuthoringDecisionInputSchema,
  "view.authoring.reject": AuthoringRejectInputSchema,
  "view.authoring.apply": AuthoringApplyInputSchema,
  "transformation.submit": z.object({
    transformation: TransformationSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: IdentifierSchema.optional(),
  }).strict(),
  "transformation.get": z.object({ ref: ExactTransformationRefSchema }).strict(),
  "run.execute": z.object({
    transformation: ExactTransformationRefSchema,
    parameters: StartExecutionParametersSchema,
  }).strict(),
  "run.inspect": z.object({ run_id: IdentifierSchema }).strict(),
  "run.cancel": z.object({ run_id: IdentifierSchema }).strict(),
  "feedback.submit": z.object({ feedback: RecordFeedbackInputSchema }).strict(),
  "failure.inspect": z.object({ ref: ExactViewRefSchema }).strict(),
  "policy.decision.get": z.object({ run_id: IdentifierSchema }).strict(),
  "privacy.forget.request": ForgetRequestParametersSchema,
  "privacy.forget.execute": ExecuteForgetParametersSchema,
  "privacy.forget.inspect": z.object({ request_id: IdentifierSchema }).strict(),
  "trace.read": z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("run"), run_id: IdentifierSchema }).strict(),
    z.object({ scope: z.literal("capture"), connection_id: IdentifierSchema }).strict(),
  ]),
} satisfies Record<OperationName, z.ZodTypeAny>;

export const OPERATION_DESCRIPTIONS: Record<OperationName, string> = {
  "catalog.list": "List the canonical Metaflow v1 operation catalog.",
  "connector.list": "List exact trusted Connector Package descriptors available for onboarding.",
  "connector.inspect": "Inspect one exact Connector Package descriptor by id, version, and artifact digest.",
  "capture.ingest": "Atomically admit one provider-neutral Capture Batch as Raw View revisions.",
  "capture.connection.list": "List durable Source Connections and their exact CAS generations.",
  "capture.connection.create": "Create one draft Source Connection from an exact trusted Connector Package.",
  "capture.connection.check": "Check credentials and provider compatibility for one exact Source Connection generation.",
  "capture.connection.discover": "Preview provider resources without admitting Raw Views or advancing checkpoints.",
  "capture.connection.activate": "Activate one checked Source Connection generation.",
  "capture.connection.update": "Create a new draft Source Connection generation through compare-and-swap.",
  "capture.connection.pause": "Pause one active Source Connection generation.",
  "capture.connection.run": "Run one active pull, stream, or reference Connector through Capture Runtime.",
  "capture.dlq.list": "Inspect durable Capture dead letters for one Source Connection.",
  "capture.dlq.replay": "Explicitly replay one durable Capture dead letter through Capture Runtime.",
  "view.get": "Read one exact immutable View revision.",
  "view.graph.project": "Project one bounded authorized exact-revision View graph without returning full View content.",
  "view.search": "Search one authorized exact View scope with declared keyword, semantic, or relation modes.",
  "view.search.reindex": "Explicitly rebuild the deterministic local View Search projection.",
  "view.traverse": "Traverse typed relations from one exact View revision.",
  "view.tombstone": "Append an immutable source-deletion tombstone without claiming privacy erasure.",
  "view.authoring.request": "Freeze one natural-language View authoring Request before Agent proposal generation.",
  "view.authoring.propose": "Generate and freeze one declarative untrusted Agent Proposal for an exact Request.",
  "view.authoring.inspect": "Inspect one exact Request, Proposal, Decision, or Receipt View.",
  "view.authoring.approve": "Approve one exact Proposal revision and digest without applying it.",
  "view.authoring.reject": "Reject one exact Proposal and atomically commit its terminal Receipt.",
  "view.authoring.apply": "Apply one exact approved Proposal through its canonical repository and commit a terminal Receipt.",
  "transformation.submit": "Commit one immutable Transformation revision.",
  "transformation.get": "Read one exact Transformation revision.",
  "run.execute": "Execute one committed Transformation revision with frozen inputs and policy.",
  "run.inspect": "Inspect a Run, attempts, trace, committed outputs, and Failure evidence.",
  "run.cancel": "Request cancellation of an active Run in this operation service.",
  "feedback.submit": "Record feedback about one exact View revision.",
  "failure.inspect": "Inspect one exact Failure View and its parsed evidence.",
  "policy.decision.get": "Read the frozen View access decision for one Run.",
  "privacy.forget.request": "Freeze a provenance impact plan or immediately execute a preauthorized sensitive cascade.",
  "privacy.forget.execute": "Execute one confirmed frozen Forget plan across every governed cleanup store.",
  "privacy.forget.inspect": "Inspect one content-free durable Forget audit and its cleanup receipts.",
  "trace.read": "Read a durable Run or Capture trace.",
};

export const OperationRequestSchema = z.object({
  operation: OperationNameSchema,
  input: JsonValueSchema,
}).strict();

export const OperationPrincipalSchema = z.object({
  id: IdentifierSchema,
  grants: z.array(z.union([OperationNameSchema, z.literal("*")])).default([]),
}).strict().superRefine((principal, context) => {
  if (new Set(principal.grants).size !== principal.grants.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["grants"], message: "Operation grants must be unique" });
  }
});

export const OperationContextSchema = z.object({
  request_id: IdentifierSchema,
  principal: OperationPrincipalSchema,
}).strict();

export const OperationErrorCategorySchema = z.enum([
  "invalid_request",
  "forbidden",
  "not_found",
  "conflict",
  "failed_dependency",
  "internal",
]);

export const OperationErrorSchema = z.object({
  code: IdentifierSchema,
  message: z.string().trim().min(1).max(2_000),
  category: OperationErrorCategorySchema,
  details: z.record(JsonValueSchema).default({}),
}).strict();

export const OperationSuccessSchema = z.object({
  ok: z.literal(true),
  request_id: IdentifierSchema,
  operation: OperationNameSchema,
  data: JsonValueSchema,
}).strict();

export const OperationFailureSchema = z.object({
  ok: z.literal(false),
  request_id: IdentifierSchema,
  operation: OperationNameSchema.optional(),
  error: OperationErrorSchema,
}).strict();

export const OperationEnvelopeSchema = z.union([OperationSuccessSchema, OperationFailureSchema]);

export const OperationTraceEventSchema = z.object({
  request_id: IdentifierSchema,
  operation: OperationNameSchema.optional(),
  actor: IdentifierSchema,
  type: z.enum(["operation.started", "operation.succeeded", "operation.failed"]),
  occurred_at: TimestampSchema,
  details: z.record(JsonValueSchema).default({}),
  error: OperationErrorSchema.optional(),
}).strict();

export type OperationName = z.infer<typeof OperationNameSchema>;
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationPrincipal = z.infer<typeof OperationPrincipalSchema>;
export type OperationContext = z.infer<typeof OperationContextSchema>;
export type OperationErrorCategory = z.infer<typeof OperationErrorCategorySchema>;
export type OperationError = z.infer<typeof OperationErrorSchema>;
export type OperationSuccess = z.infer<typeof OperationSuccessSchema>;
export type OperationFailure = z.infer<typeof OperationFailureSchema>;
export type OperationEnvelope = z.infer<typeof OperationEnvelopeSchema>;
export type OperationTraceEvent = z.infer<typeof OperationTraceEventSchema>;

export type OperationAuthorizationDecision = {
  allowed: boolean;
  reason: string;
};

export interface OperationAuthorizationPort {
  authorize(input: {
    principal: OperationPrincipal;
    operation: OperationName;
  }): Promise<OperationAuthorizationDecision>;
}

export interface OperationObserver {
  record(event: OperationTraceEvent, cause?: unknown): Promise<void>;
}

export type OperationContextProvider = (input: {
  transport: "cli" | "http" | "mcp";
  operation?: string;
}) => Promise<OperationContext> | OperationContext;

export function operationData(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}

export function operationDetails(value: JsonObject): JsonObject {
  return value;
}

function lifecycleGenerationInput<Shape extends z.ZodRawShape>(shape?: Shape) {
  return z.object({
    connection_id: CaptureIdentifierSchema,
    expected_generation: z.number().int().positive(),
    idempotency_key: CaptureIdentifierSchema,
    ...(shape ?? {} as Shape),
  }).strict();
}

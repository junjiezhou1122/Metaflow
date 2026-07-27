import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  TimestampSchema,
  ViewDraftSchema,
  ViewMaterializationManifestSchema,
  ViewPolicySchema,
  ViewRelationTargetSchema,
  ViewRepresentationSchema,
  ViewSchemaRefSchema,
  canonicalJson,
  type ExactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
} from "@info/view";
import {
  ExactTransformationRefSchema,
  TransformationSchema,
} from "@info/transformation";
import { ExecutionRunStatusSchema, StartExecutionParametersSchema, strictSchemaRef } from "@info/execution";

export const AuthoringArtifactKindSchema = z.enum(["view", "transformation", "view_package"]);

const ConcreteViewCandidateSchema = z.object({
  kind: z.literal("view"),
  view: z.object({
    id: IdentifierSchema,
    name: z.string().trim().min(1).max(500),
    purpose: z.string().trim().min(1).max(2_000),
    aliases: z.array(z.string().trim().min(1).max(500)).default([]),
    schema: ViewSchemaRefSchema,
    representation: ViewRepresentationSchema,
    materialization: ViewMaterializationManifestSchema,
    relations: z.array(ViewRelationTargetSchema).default([]),
    metadata: z.record(JsonValueSchema).default({}),
    expected_revision: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const TransformationCandidateSchema = z.object({
  kind: z.literal("transformation"),
  transformation: TransformationSchema,
  expected_revision: z.number().int().nonnegative(),
  execute: StartExecutionParametersSchema.optional(),
}).strict();

const ViewPackageCandidateSchema = z.object({
  kind: z.literal("view_package"),
  package: z.object({
    id: IdentifierSchema,
    version: z.number().int().positive(),
  }).strict(),
}).strict();

export const AuthoringAgentCandidateSchema = z.discriminatedUnion("kind", [
  ConcreteViewCandidateSchema,
  TransformationCandidateSchema,
  ViewPackageCandidateSchema,
]);

const FrozenViewPackageArtifactSchema = z.object({
  kind: z.literal("view_package"),
  package: z.object({
    id: IdentifierSchema,
    version: z.number().int().positive(),
    manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

export const AuthoringProposalArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("view"),
    view: ConcreteViewCandidateSchema.shape.view.extend({ created_at: TimestampSchema }).strict(),
  }).strict(),
  TransformationCandidateSchema,
  FrozenViewPackageArtifactSchema,
]);

export const AuthoringRequestValueSchema = z.object({
  contract_version: z.literal(1),
  artifact_kind: AuthoringArtifactKindSchema,
  prompt: z.string().trim().min(1).max(100_000),
  source_views: z.array(ExactViewRefSchema).default([]),
  requested_by: IdentifierSchema,
  trace_id: IdentifierSchema,
}).strict().superRefine((value, context) => uniqueRefs(value.source_views, ["source_views"], context));

export const AuthoringProposalValueSchema = z.object({
  contract_version: z.literal(1),
  request: ExactViewRefSchema,
  artifact: AuthoringProposalArtifactSchema,
  artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  proposed_by: IdentifierSchema,
  trace_id: IdentifierSchema,
}).strict().superRefine((value, context) => {
  if (proposalDigest(value.artifact) !== value.artifact_digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifact_digest"], message: "Proposal digest does not match artifact" });
  }
});

export const AuthoringDecisionValueSchema = z.object({
  contract_version: z.literal(1),
  proposal: ExactViewRefSchema,
  proposal_digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "rejected"]),
  decided_by: IdentifierSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
  trace_id: IdentifierSchema,
}).strict();

export const AuthoringAppliedTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), ref: ExactViewRefSchema }).strict(),
  z.object({
    kind: z.literal("transformation"),
    ref: ExactTransformationRefSchema,
    run_id: IdentifierSchema.optional(),
    run_status: ExecutionRunStatusSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("view_package"),
    id: IdentifierSchema,
    version: z.number().int().positive(),
    manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "transformation"
    && (value.run_id === undefined) !== (value.run_status === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_id"],
        message: "Transformation target run_id and run_status must appear together",
      });
  }
});

export const AuthoringReceiptValueSchema = z.object({
  contract_version: z.literal(1),
  request: ExactViewRefSchema,
  proposal: ExactViewRefSchema.optional(),
  decision: ExactViewRefSchema.optional(),
  status: z.enum(["applied", "rejected", "failed"]),
  target: AuthoringAppliedTargetSchema.optional(),
  error: z.object({ code: IdentifierSchema, message: z.string().trim().min(1).max(2_000) }).strict().optional(),
  completed_by: IdentifierSchema,
  trace_id: IdentifierSchema,
}).strict().superRefine((value, context) => {
  if (value.status === "applied" && !value.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "Applied receipt requires a target" });
  }
  if (value.status === "failed" && !value.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "Failed receipt requires an error" });
  }
  if (value.status !== "applied" && value.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "Only an applied receipt may contain a target" });
  }
  if (value.status !== "failed" && value.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "Only a failed receipt may contain an error" });
  }
});

export const AuthoringRequestInputSchema = z.object({
  view_id: IdentifierSchema,
  expected_revision: z.number().int().nonnegative(),
  artifact_kind: AuthoringArtifactKindSchema,
  prompt: z.string().trim().min(1).max(100_000),
  source_views: z.array(ExactViewRefSchema).default([]),
  policy: ViewPolicySchema.refine(policy => policy.retention === "normal" || policy.retention === "archive", {
    message: "Authoring lifecycle Views require durable normal or archive retention",
  }),
  trace_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  created_at: TimestampSchema,
}).strict().superRefine((value, context) => {
  uniqueRefs(value.source_views, ["source_views"], context);
  if (new Set(value.policy.labels).size !== value.policy.labels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policy", "labels"], message: "Authoring policy labels must be unique" });
  }
});

export const AuthoringProposeInputSchema = z.object({
  request: ExactViewRefSchema,
  proposal_view_id: IdentifierSchema,
  expected_revision: z.number().int().nonnegative(),
  runtime: IdentifierSchema.optional(),
  idempotency_key: IdentifierSchema,
  failure_receipt_view_id: IdentifierSchema,
  created_at: TimestampSchema,
}).strict().superRefine((value, context) => {
  const identities = [value.request.view_id, value.proposal_view_id, value.failure_receipt_view_id];
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal_view_id"],
      message: "Request, Proposal, and proposal-failure Receipt must use distinct View identities",
    });
  }
});

const AuthoringDecisionInputBaseSchema = z.object({
  proposal: ExactViewRefSchema,
  proposal_digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision_view_id: IdentifierSchema,
  expected_revision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2_000).optional(),
  idempotency_key: IdentifierSchema,
  created_at: TimestampSchema,
}).strict();

export const AuthoringDecisionInputSchema = AuthoringDecisionInputBaseSchema.superRefine((value, context) => {
  if (value.decision_view_id === value.proposal.view_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision_view_id"],
      message: "Decision and Proposal must use distinct View identities",
    });
  }
});

export const AuthoringRejectInputSchema = AuthoringDecisionInputBaseSchema.extend({
  receipt_view_id: IdentifierSchema,
}).strict().superRefine((value, context) => {
  const identities = [value.proposal.view_id, value.decision_view_id, value.receipt_view_id];
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt_view_id"],
      message: "Proposal, Decision, and rejection Receipt must use distinct View identities",
    });
  }
});

export const AuthoringApplyInputSchema = z.object({
  decision: ExactViewRefSchema,
  receipt_view_id: IdentifierSchema,
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: IdentifierSchema,
  created_at: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.receipt_view_id === value.decision.view_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt_view_id"],
      message: "Apply Receipt and Decision must use distinct View identities",
    });
  }
});

export const AuthoringInspectInputSchema = z.object({ ref: ExactViewRefSchema }).strict();

export const AuthoringTraceEventSchema = z.object({
  trace_id: IdentifierSchema,
  type: z.enum([
    "authoring.requested",
    "authoring.proposed",
    "authoring.approved",
    "authoring.rejected",
    "authoring.applied",
    "authoring.failed",
  ]),
  occurred_at: TimestampSchema,
  actor: IdentifierSchema,
  refs: z.array(ExactViewRefSchema).default([]),
  details: z.record(JsonValueSchema).default({}),
}).strict();

export type AuthoringArtifactKind = z.infer<typeof AuthoringArtifactKindSchema>;
export type AuthoringAgentCandidate = z.infer<typeof AuthoringAgentCandidateSchema>;
export type AuthoringProposalArtifact = z.infer<typeof AuthoringProposalArtifactSchema>;
export type AuthoringRequestValue = z.infer<typeof AuthoringRequestValueSchema>;
export type AuthoringProposalValue = z.infer<typeof AuthoringProposalValueSchema>;
export type AuthoringDecisionValue = z.infer<typeof AuthoringDecisionValueSchema>;
export type AuthoringReceiptValue = z.infer<typeof AuthoringReceiptValueSchema>;
export type AuthoringTraceEvent = z.infer<typeof AuthoringTraceEventSchema>;
export type AuthoringRequestInput = z.infer<typeof AuthoringRequestInputSchema>;
export type AuthoringProposeInput = z.infer<typeof AuthoringProposeInputSchema>;
export type AuthoringDecisionInput = z.infer<typeof AuthoringDecisionInputSchema>;
export type AuthoringRejectInput = z.infer<typeof AuthoringRejectInputSchema>;
export type AuthoringApplyInput = z.infer<typeof AuthoringApplyInputSchema>;

export type AuthoringProposalAgentInput = {
  request: AuthoringRequestValue;
  request_ref: ExactViewRef;
  policy: ViewPolicy;
  output_schema: JsonValue;
  runtime?: string;
};

export interface AuthoringProposalAgentPort {
  propose(input: AuthoringProposalAgentInput, context: { signal: AbortSignal }): Promise<unknown>;
}

export interface AuthoringObserver {
  record(event: AuthoringTraceEvent, cause?: unknown): Promise<void>;
}

const agentOutputSchemaRef = strictSchemaRef("metaflow.authoring.agent_candidate", AuthoringAgentCandidateSchema);
if (agentOutputSchemaRef.mode !== "strict") throw new TypeError("Authoring Agent output contract must be strict");
export const AuthoringAgentOutputJsonSchema: JsonValue = agentOutputSchemaRef.json_schema;

export function proposalDigest(artifact: AuthoringProposalArtifact): string {
  return createHash("sha256").update(canonicalJson(artifact)).digest("hex");
}

export function lifecycleValue(view: View): AuthoringRequestValue | AuthoringProposalValue | AuthoringDecisionValue | AuthoringReceiptValue {
  if (view.representation.form !== "inline") throw new AuthoringError("Authoring View must have inline Representation", "invalid_lifecycle_view");
  switch (view.schema.name) {
    case "metaflow.authoring.request": return AuthoringRequestValueSchema.parse(view.representation.value);
    case "metaflow.authoring.proposal": return AuthoringProposalValueSchema.parse(view.representation.value);
    case "metaflow.authoring.decision": return AuthoringDecisionValueSchema.parse(view.representation.value);
    case "metaflow.authoring.receipt": return AuthoringReceiptValueSchema.parse(view.representation.value);
    default: throw new AuthoringError("View is not an authoring lifecycle View", "invalid_lifecycle_view", { schema: view.schema.name });
  }
}

export class AuthoringError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthoringError";
  }
}

const lifecycleSchemas = {
  "metaflow.authoring.request": strictSchemaRef("metaflow.authoring.request", AuthoringRequestValueSchema),
  "metaflow.authoring.proposal": strictSchemaRef("metaflow.authoring.proposal", AuthoringProposalValueSchema),
  "metaflow.authoring.decision": strictSchemaRef("metaflow.authoring.decision", AuthoringDecisionValueSchema),
  "metaflow.authoring.receipt": strictSchemaRef("metaflow.authoring.receipt", AuthoringReceiptValueSchema),
};

export function lifecycleDraft(input: {
  id: string;
  schema_name: keyof typeof lifecycleSchemas;
  name: string;
  purpose: string;
  value: JsonValue;
  policy: ViewPolicy;
  actor: string;
  created_at: string;
  inputs: ExactViewRef[];
  relations?: ViewDraft["relations"];
  metadata?: JsonObject;
}): ViewDraft {
  return ViewDraftSchema.parse({
    id: input.id,
    name: input.name,
    purpose: input.purpose,
    aliases: [],
    schema: lifecycleSchemas[input.schema_name],
    role: "derived",
    time: { created_at: input.created_at },
    representation: {
      form: "inline",
      kind: input.schema_name,
      media_type: "application/json",
      value: input.value,
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: input.relations ?? [],
    provenance: { inputs: input.inputs, actor: input.actor, trace_id: extractTraceId(input.value) },
    policy: input.policy,
    metadata: input.metadata ?? {},
  });
}

function extractTraceId(value: JsonValue): string | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.trace_id === "string"
    ? value.trace_id
    : undefined;
}

function uniqueRefs(refs: ExactViewRef[], path: Array<string | number>, context: z.RefinementCtx): void {
  const keys = refs.map(ref => `${ref.view_id}@${ref.revision}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "Exact View refs must be unique" });
  }
}

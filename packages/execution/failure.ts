import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ExactViewRefSchema,
  JsonValueSchema,
  canonicalJson,
  exactViewRef,
  parseViewDraft,
  viewRevisionKey,
  type CommitViewInput,
  type ExactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewSchemaRef,
} from "@info/view";
import { ExactTransformationRefSchema, exactTransformationRef } from "@info/transformation";
import {
  ExecutionRunErrorSchema,
  RepairExecutionContextSchema,
  type ExecutionAttempt,
  type ExecutionRun,
  type ExecutionRunError,
  type ExecutionRunStatus,
} from "./runtime-contracts.js";
import { ViewAccessDecisionSchema, ViewAccessPolicySnapshotSchema } from "./view-access-policy.js";

const MAX_INLINE_CANDIDATE_BYTES = 64 * 1024;
const MAX_CANDIDATE_PREVIEW_CHARS = 4 * 1024;

export const CandidateArtifactRepresentationSchema = z.object({
  version: z.literal(1),
  run_id: z.string().trim().min(1),
  state: z.enum(["captured", "truncated", "unavailable"]),
  encoding: z.literal("application/json"),
  byte_length: z.number().int().nonnegative().optional(),
  digest: z.object({ algorithm: z.literal("sha256"), value: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  payload: JsonValueSchema.optional(),
  preview: z.string().optional(),
  reason: z.string().trim().min(1).optional(),
}).strict().superRefine((artifact, context) => {
  if (artifact.state === "captured" && artifact.payload === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "Captured candidate artifact requires payload" });
  }
  if (artifact.state === "truncated" && (!artifact.preview || !artifact.digest || artifact.byte_length === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Truncated candidate artifact requires preview, digest, and byte length" });
  }
  if (artifact.state === "unavailable" && !artifact.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Unavailable candidate artifact requires a reason" });
  }
});

export const FailureRepresentationSchema = z.object({
  version: z.literal(2),
  run_id: z.string().trim().min(1),
  trace_id: z.string().trim().min(1),
  status: z.enum(["failed", "cancelled", "timed_out"]),
  transformation: ExactTransformationRefSchema,
  attempt: z.object({
    attempt_id: z.string().trim().min(1),
    previous_attempt_id: z.string().trim().min(1).optional(),
  }).strict().optional(),
  access_policy: ViewAccessPolicySnapshotSchema,
  authorization: ViewAccessDecisionSchema,
  error: ExecutionRunErrorSchema,
  candidate_artifact: ExactViewRefSchema.optional(),
  causal_chain: z.object({
    ancestor_failures: z.array(ExactViewRefSchema),
    depth: z.number().int().nonnegative(),
  }).strict(),
  repair: RepairExecutionContextSchema.optional(),
}).strict();

export type CandidateArtifactRepresentation = z.infer<typeof CandidateArtifactRepresentationSchema>;
export type FailureRepresentation = z.infer<typeof FailureRepresentationSchema>;

export type BuildFailureEvidenceInput = {
  run: ExecutionRun;
  attempt?: ExecutionAttempt;
  inputs: View[];
  policy: ViewPolicy;
  error: ExecutionRunError;
  candidate: unknown;
  status: Extract<ExecutionRunStatus, "failed" | "cancelled" | "timed_out">;
  created_at: string;
};

export function buildFailureEvidence(input: BuildFailureEvidenceInput): {
  failure: ViewDraft;
  artifacts: CommitViewInput[];
} {
  const artifact = input.candidate === undefined
    ? undefined
    : candidateArtifactView(input.run, input.inputs, input.policy, input.candidate, input.created_at);
  const artifactRef = artifact ? { view_id: artifact.id, revision: 1 } : undefined;
  const repair = input.run.frozen.repair;
  const representation = FailureRepresentationSchema.parse({
    version: 2,
    run_id: input.run.id,
    trace_id: input.run.trace_id,
    status: input.status,
    transformation: exactTransformationRef(input.run.frozen.transformation),
    ...(input.attempt ? {
      attempt: {
        attempt_id: input.attempt.id,
        ...(input.attempt.previous_attempt_id ? { previous_attempt_id: input.attempt.previous_attempt_id } : {}),
      },
    } : {}),
    access_policy: input.run.frozen.access_policy,
    authorization: input.run.frozen.authorization,
    error: input.error,
    ...(artifactRef ? { candidate_artifact: artifactRef } : {}),
    causal_chain: {
      ancestor_failures: repair?.ancestor_failures ?? [],
      depth: repair?.depth ?? 0,
    },
    ...(repair ? { repair } : {}),
  });
  const inputRefs = sortedRefs(input.inputs.map(exactViewRef));
  const relations = [
    ...inputRefs.map(target => ({ type: "failed_input", target, metadata: {} })),
    ...(artifactRef ? [{ type: "candidate_artifact", target: artifactRef, metadata: {} }] : []),
    ...(repair ? [
      { type: "repair_of", target: repair.parent_failure, metadata: { fingerprint: repair.fingerprint } },
      { type: "repair_decision", target: repair.decision_view, metadata: { policy_id: repair.policy.id, policy_revision: repair.policy.revision } },
    ] : []),
  ];
  const failure = parseViewDraft({
    id: `view:failure:${input.run.id}`,
    name: `Failure: ${input.run.frozen.transformation.name}`,
    purpose: "Durable evidence for an unsuccessful Transformation Run",
    aliases: [],
    schema: strictSchemaRef("metaflow.execution.failure", FailureRepresentationSchema, 2),
    role: "derived",
    time: { created_at: input.created_at },
    representation: {
      form: "inline",
      kind: "execution_failure",
      media_type: "application/json",
      value: representation,
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations,
    provenance: {
      inputs: inputRefs,
      operator_run_id: input.run.id,
      actor: "execution-runtime",
      trace_id: input.run.trace_id,
    },
    policy: input.policy,
    metadata: { failure_code: input.error.code, failure_stage: input.error.stage },
  });
  return {
    failure,
    artifacts: artifact ? [{
      draft: artifact,
      expected_revision: 0,
      idempotency_key: `execution-candidate:${input.run.id}`,
    }] : [],
  };
}

export function parseFailureView(view: View): FailureRepresentation {
  if (view.schema.name !== "metaflow.execution.failure" || view.schema.version !== 2 || view.representation.form !== "inline") {
    throw new TypeError(`View ${view.id}@${view.revision} is not a Metaflow Failure View`);
  }
  const failure = FailureRepresentationSchema.parse(view.representation.value);
  if (failure.run_id !== view.provenance.operator_run_id || failure.trace_id !== view.provenance.trace_id) {
    throw new TypeError(`Failure View ${view.id}@${view.revision} does not match its Run provenance`);
  }
  if (failure.candidate_artifact && !hasRelation(view, "candidate_artifact", failure.candidate_artifact)) {
    throw new TypeError(`Failure View ${view.id}@${view.revision} omits its candidate artifact relation`);
  }
  if (failure.repair) {
    if (!hasRelation(view, "repair_of", failure.repair.parent_failure)
      || !hasRelation(view, "repair_decision", failure.repair.decision_view)) {
      throw new TypeError(`Failure View ${view.id}@${view.revision} omits repair causal relations`);
    }
  }
  return failure;
}

export function failureClassification(failure: FailureRepresentation): string {
  const operatorCode = failure.error.details.operator_code;
  return typeof operatorCode === "string" && operatorCode.trim() ? operatorCode : failure.error.code;
}

function candidateArtifactView(
  run: ExecutionRun,
  inputs: View[],
  policy: ViewPolicy,
  candidate: unknown,
  createdAt: string,
): ViewDraft {
  const representation = candidateArtifactRepresentation(run.id, candidate);
  const inputRefs = sortedRefs(inputs.map(exactViewRef));
  return parseViewDraft({
    id: `view:candidate:${run.id}`,
    name: `Candidate artifact: ${run.frozen.transformation.name}`,
    purpose: "Bounded evidence emitted before candidate validation failed",
    aliases: [],
    schema: strictSchemaRef("metaflow.execution.candidate-artifact", CandidateArtifactRepresentationSchema),
    role: "derived",
    time: { created_at: createdAt },
    representation: {
      form: "inline",
      kind: "operator_candidate_artifact",
      media_type: "application/json",
      value: representation,
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: inputRefs.map(target => ({ type: "candidate_for_input", target, metadata: {} })),
    provenance: {
      inputs: inputRefs,
      operator_run_id: run.id,
      actor: "execution-runtime",
      trace_id: run.trace_id,
    },
    policy,
    metadata: { candidate_state: representation.state },
  });
}

function candidateArtifactRepresentation(runId: string, candidate: unknown): CandidateArtifactRepresentation {
  const parsed = JsonValueSchema.safeParse(candidate);
  if (!parsed.success) {
    return CandidateArtifactRepresentationSchema.parse({
      version: 1,
      run_id: runId,
      state: "unavailable",
      encoding: "application/json",
      preview: boundedPreview(candidate),
      reason: "Operator candidate is not valid JSON evidence",
    });
  }
  const serialized = canonicalJson(parsed.data);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  const digest = { algorithm: "sha256" as const, value: createHash("sha256").update(serialized).digest("hex") };
  if (byteLength <= MAX_INLINE_CANDIDATE_BYTES) {
    return CandidateArtifactRepresentationSchema.parse({
      version: 1,
      run_id: runId,
      state: "captured",
      encoding: "application/json",
      byte_length: byteLength,
      digest,
      payload: parsed.data,
    });
  }
  return CandidateArtifactRepresentationSchema.parse({
    version: 1,
    run_id: runId,
    state: "truncated",
    encoding: "application/json",
    byte_length: byteLength,
    digest,
    preview: serialized.slice(0, MAX_CANDIDATE_PREVIEW_CHARS),
  });
}

function boundedPreview(value: unknown): string {
  try {
    return String(value).slice(0, MAX_CANDIDATE_PREVIEW_CHARS);
  } catch (error) {
    return `Preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function strictSchemaRef(name: string, schema: z.ZodTypeAny, version = 1): ViewSchemaRef {
  const generated = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "root" }) as JsonObject;
  const { $schema: _dialect, ...jsonSchema } = generated;
  return {
    name,
    version,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: normalizeGeneratedSchema(jsonSchema) as JsonValue,
  };
}

function normalizeGeneratedSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeGeneratedSchema);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "format")
      .map(([key, item]) => [key, normalizeGeneratedSchema(item)]),
  );
}

function hasRelation(view: View, type: string, target: ExactViewRef): boolean {
  const key = viewRevisionKey(target);
  return view.relations.some(relation => relation.type === type && viewRevisionKey(relation.target) === key);
}

function sortedRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...refs].sort((left, right) => viewRevisionKey(left).localeCompare(viewRevisionKey(right)));
}

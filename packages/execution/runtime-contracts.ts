import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  ReactiveCascadeContextSchema,
  TimestampSchema,
  ViewDraftSchema,
  ViewPolicySchema,
  type CommitViewBatchResult,
  type CommitViewInput,
  type ExactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
} from "@info/view";
import {
  OperatorSnapshotSchema,
  TransformationSchema,
  ViewSelectorSnapshotSchema,
  type Transformation,
  type TransformationInputSource,
} from "@info/transformation";
import {
  ViewAccessDecisionSchema,
  ViewAccessPolicySnapshotSchema,
  ViewAccessUseSchema,
  type ViewAccessDecision,
  type ViewAccessPolicySnapshot,
  type ViewAccessUse,
} from "./view-access-policy.js";

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const ExecutionRuntimeOverrideSchema = z.object({
  runtime: IdentifierSchema,
  requested_by: z.literal("user"),
  requested_name: IdentifierSchema.optional(),
}).strict();

export const PreExecutionFailureSchema = z.object({
  code: IdentifierSchema,
  message: z.string().trim().min(1).max(20_000),
  stage: z.enum(["authorization", "execution", "validation", "commit"]),
  details: JsonObjectSchema.default({}),
}).strict();

export const ResolvedInputSourceSchema = z.object({
  source: z.union([
    z.object({ kind: z.literal("view"), ref: ExactViewRefSchema }).strict(),
    z.object({
      kind: z.literal("selector"),
      selector: ViewSelectorSnapshotSchema,
    }).strict(),
  ]),
  candidates: z.array(ExactViewRefSchema),
  selected: z.array(ExactViewRefSchema),
}).strict();

export const ResolvedInputBindingSchema = z.object({
  role: IdentifierSchema,
  required: z.boolean(),
  sources: z.array(ResolvedInputSourceSchema),
  selected: z.array(ExactViewRefSchema),
}).strict();

export const RepairPolicySnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  max_depth: z.number().int().positive(),
  max_repeated_fingerprint: z.number().int().positive(),
  retryable_error_codes: z.array(IdentifierSchema).default([]),
  non_retryable_error_codes: z.array(IdentifierSchema).default([]),
}).strict().superRefine((policy, context) => {
  const retryable = new Set(policy.retryable_error_codes);
  const nonRetryable = new Set(policy.non_retryable_error_codes);
  if (retryable.size !== policy.retryable_error_codes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["retryable_error_codes"], message: "Repair retryable codes must be unique" });
  }
  if (nonRetryable.size !== policy.non_retryable_error_codes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["non_retryable_error_codes"], message: "Repair non-retryable codes must be unique" });
  }
  for (const code of retryable) {
    if (nonRetryable.has(code)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Repair error code ${code} cannot be both retryable and non-retryable` });
    }
  }
});

export const RepairExecutionContextSchema = z.object({
  parent_failure: ExactViewRefSchema,
  ancestor_failures: z.array(ExactViewRefSchema),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policy: RepairPolicySnapshotSchema,
  decision_view: ExactViewRefSchema,
  depth: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  const keys = value.ancestor_failures.map(ref => `${ref.view_id}@${ref.revision}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ancestor_failures"], message: "Repair ancestor failures must be unique" });
  }
  const parentKey = `${value.parent_failure.view_id}@${value.parent_failure.revision}`;
  if (keys.at(-1) !== parentKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ancestor_failures"], message: "Repair parent failure must terminate the ancestor chain" });
  }
  if (value.depth !== value.ancestor_failures.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["depth"], message: "Repair depth must equal the frozen ancestor count" });
  }
});

export const FrozenExecutionSnapshotSchema = z.object({
  transformation: TransformationSchema,
  inputs: z.array(ResolvedInputBindingSchema),
  invocation_inputs: z.array(z.object({
    role: IdentifierSchema,
    views: z.array(ExactViewRefSchema),
  }).strict()).optional(),
  access_policy: ViewAccessPolicySnapshotSchema,
  authorization: ViewAccessDecisionSchema,
  access_use: ViewAccessUseSchema,
  runtime_override: ExecutionRuntimeOverrideSchema.optional(),
  idempotency_key: IdentifierSchema.optional(),
  repair: RepairExecutionContextSchema.optional(),
  failure_policy: ViewPolicySchema.optional(),
  previous_attempt_id: IdentifierSchema.optional(),
  cascade: ReactiveCascadeContextSchema.optional(),
  pre_execution_failure: PreExecutionFailureSchema.optional(),
}).strict();

export const ExecutionRunStatusSchema = z.enum([
  "ready",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export const ExecutionRunErrorSchema = z.object({
  code: IdentifierSchema,
  message: z.string().trim().min(1),
  stage: z.enum(["authorization", "execution", "validation", "commit"]),
  details: JsonObjectSchema.default({}),
}).strict();

export const ExecutionRunSchema = z.object({
  id: IdentifierSchema,
  correlation_id: IdentifierSchema,
  trace_id: IdentifierSchema,
  status: ExecutionRunStatusSchema,
  frozen: FrozenExecutionSnapshotSchema,
  created_at: TimestampSchema,
  started_at: TimestampSchema.optional(),
  completed_at: TimestampSchema.optional(),
  output_views: z.array(ExactViewRefSchema).default([]),
  failure_view: ExactViewRefSchema.optional(),
  total_cost_usd: z.number().finite().nonnegative().default(0),
  error: ExecutionRunErrorSchema.optional(),
}).strict();

export const ExecutionAttemptStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export const ExecutionAttemptSchema = z.object({
  id: IdentifierSchema,
  run_id: IdentifierSchema,
  sequence: z.number().int().positive(),
  previous_attempt_id: IdentifierSchema.optional(),
  operator: OperatorSnapshotSchema,
  status: ExecutionAttemptStatusSchema,
  started_at: TimestampSchema,
  completed_at: TimestampSchema.optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  cost_usd: z.number().finite().nonnegative().default(0),
  error: ExecutionRunErrorSchema.optional(),
}).strict();

export const ExecutionTraceEventSchema = z.object({
  sequence: z.number().int().positive().optional(),
  run_id: IdentifierSchema,
  attempt_id: IdentifierSchema.optional(),
  type: IdentifierSchema,
  occurred_at: TimestampSchema,
  payload: JsonObjectSchema.default({}),
}).strict();

export const OperatorCandidateOutputSchema = z.object({
  draft: ViewDraftSchema,
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: IdentifierSchema.optional(),
}).strict();

export const OperatorCandidateEnvelopeSchema = z.object({
  outputs: z.array(OperatorCandidateOutputSchema),
  diagnostics: JsonObjectSchema.default({}),
}).strict();

export type ResolvedInputSource = {
  source: TransformationInputSource;
  candidates: ExactViewRef[];
  selected: ExactViewRef[];
};
export type ResolvedInputBinding = z.infer<typeof ResolvedInputBindingSchema>;
export type FrozenExecutionSnapshot = z.infer<typeof FrozenExecutionSnapshotSchema>;
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatusSchema>;
export type ExecutionRunError = z.infer<typeof ExecutionRunErrorSchema>;
export type ExecutionRun = z.infer<typeof ExecutionRunSchema>;
export type ExecutionAttemptStatus = z.infer<typeof ExecutionAttemptStatusSchema>;
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;
export type ExecutionTraceEvent = z.infer<typeof ExecutionTraceEventSchema>;
export type StoredExecutionTraceEvent = ExecutionTraceEvent & { sequence: number };
export type OperatorCandidateOutput = z.infer<typeof OperatorCandidateOutputSchema>;
export type OperatorCandidateEnvelope = z.infer<typeof OperatorCandidateEnvelopeSchema>;
export type ExecutionRuntimeOverride = z.infer<typeof ExecutionRuntimeOverrideSchema>;
export type RepairPolicySnapshot = z.infer<typeof RepairPolicySnapshotSchema>;
export type RepairExecutionContext = z.infer<typeof RepairExecutionContextSchema>;

export type OperatorExecutionInvocation = {
  run: ExecutionRun;
  attempt: ExecutionAttempt;
  inputs: Array<{ role: string; views: View[] }>;
};

export type OperatorExecutionEvent = {
  type: string;
  occurred_at?: string;
  payload?: JsonObject;
};

export class OperatorExecutionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OperatorExecutionFailure";
    IdentifierSchema.parse(code);
    JsonObjectSchema.parse(details);
  }
}

export type OperatorExecutionResult =
  | {
      status: "succeeded";
      candidate: unknown;
      cost_usd?: number;
      usage?: JsonObject;
    }
  | {
      status: "failed";
      error: { code: string; message: string; details?: JsonObject };
      cost_usd?: number;
    }
  | {
      status: "cancelled";
      reason?: string;
      cost_usd?: number;
    };

export interface OperatorExecutionPort {
  execute(
    invocation: OperatorExecutionInvocation,
    context: {
      signal: AbortSignal;
      emit(event: OperatorExecutionEvent): Promise<void>;
    },
  ): Promise<OperatorExecutionResult>;
  cancel(attemptId: string): Promise<void>;
}

const StartExecutionParametersShape = {
  run_id: IdentifierSchema,
  correlation_id: IdentifierSchema,
  access_policy: ViewAccessPolicySnapshotSchema,
  access_use: ViewAccessUseSchema,
  invocation_inputs: z.array(z.object({
    role: IdentifierSchema,
    views: z.array(ExactViewRefSchema),
  }).strict()).optional(),
  runtime_override: ExecutionRuntimeOverrideSchema.optional(),
  idempotency_key: IdentifierSchema.optional(),
  repair_context: RepairExecutionContextSchema.optional(),
  failure_policy: ViewPolicySchema.optional(),
  previous_attempt_id: IdentifierSchema.optional(),
  cascade: ReactiveCascadeContextSchema.optional(),
  pre_execution_failure: PreExecutionFailureSchema.optional(),
} as const;

function validateInvocationRoles(
  input: { invocation_inputs?: Array<{ role: string }> },
  context: z.RefinementCtx,
): void {
  const roles = input.invocation_inputs?.map(binding => binding.role) ?? [];
  if (new Set(roles).size !== roles.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invocation_inputs"],
      message: "Execution invocation input roles must be unique",
    });
  }
}

export const StartExecutionParametersSchema = z.object(StartExecutionParametersShape)
  .strict()
  .superRefine(validateInvocationRoles);

export const StartExecutionInputSchema = z.object({
  ...StartExecutionParametersShape,
  transformation: TransformationSchema,
}).strict().superRefine(validateInvocationRoles);

export type StartExecutionParameters = z.infer<typeof StartExecutionParametersSchema>;
export type StartExecutionInput = z.infer<typeof StartExecutionInputSchema>;

export type CommitExecutionSuccessInput = {
  run_id: string;
  attempt: ExecutionAttempt;
  completed_at: string;
  cost_usd: number;
  outputs: CommitViewInput[];
  terminal_event: ExecutionTraceEvent;
  cascade?: z.infer<typeof ReactiveCascadeContextSchema>;
};

export type CommitExecutionFailureInput = {
  run_id: string;
  attempt?: ExecutionAttempt;
  completed_at: string;
  status: Extract<ExecutionRunStatus, "failed" | "cancelled" | "timed_out">;
  cost_usd: number;
  error: ExecutionRunError;
  artifacts?: CommitViewInput[];
  failure: CommitViewInput;
  terminal_event: ExecutionTraceEvent;
  cascade?: z.infer<typeof ReactiveCascadeContextSchema>;
};

export interface ExecutionRepository {
  createRun(run: ExecutionRun): Promise<{ run: ExecutionRun; created: boolean }>;
  getRunByIdempotencyKey(idempotencyKey: string): Promise<ExecutionRun | undefined>;
  updateRunStarted(input: { run_id: string; attempt: ExecutionAttempt; started_at: string }): Promise<void>;
  appendTrace(event: ExecutionTraceEvent): Promise<StoredExecutionTraceEvent>;
  commitSuccess(input: CommitExecutionSuccessInput): Promise<CommitViewBatchResult>;
  commitFailure(input: CommitExecutionFailureInput): Promise<CommitViewBatchResult>;
  getRun(runId: string): Promise<ExecutionRun | undefined>;
  getAttempts(runId: string): Promise<ExecutionAttempt[]>;
  getTrace(runId: string): Promise<StoredExecutionTraceEvent[]>;
}

export type ExecutionResult = {
  run: ExecutionRun;
  outputs: View[];
  failure?: View;
};

export type ExecutionReplayExplanation = {
  run: ExecutionRun;
  attempts: ExecutionAttempt[];
  events: StoredExecutionTraceEvent[];
  committed_outputs: Array<{
    ref: ExactViewRef;
    operator_run_id: string;
    inputs: ExactViewRef[];
  }>;
  failure?: {
    ref: ExactViewRef;
    inputs: ExactViewRef[];
    candidate_artifact?: ExactViewRef;
    ancestor_failures: ExactViewRef[];
  };
};

export function parseExecutionRun(input: unknown): ExecutionRun {
  return ExecutionRunSchema.parse(input);
}

export function parseExecutionAttempt(input: unknown): ExecutionAttempt {
  return ExecutionAttemptSchema.parse(input);
}

export function parseExecutionTraceEvent(input: unknown): ExecutionTraceEvent {
  return ExecutionTraceEventSchema.parse(input);
}

export function parseOperatorCandidateEnvelope(input: unknown): OperatorCandidateEnvelope {
  return OperatorCandidateEnvelopeSchema.parse(input);
}

export function executionJsonValue(input: unknown): JsonValue {
  return JsonValueSchema.parse(input);
}

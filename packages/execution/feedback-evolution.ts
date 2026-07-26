import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  TimestampSchema,
  canonicalJson,
  exactViewRef,
  parseViewDraft,
  viewRevisionKey,
  type ExactViewRef,
  type JsonObject,
  type View,
  type ViewRepository,
} from "@info/view";
import {
  ExactTransformationRefSchema,
  OperatorSnapshotSchema,
  TransformationInputBindingSchema,
  TransformationInstructionSchema,
  TransformationOutputContractSchema,
  exactTransformationRef,
  parseTransformation,
  type Transformation,
  type TransformationRepository,
} from "@info/transformation";
import type { ExecutionRepository, ExecutionRun } from "./runtime-contracts.js";

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const FeedbackRequestedChangeSchema = z.enum([
  "instruction",
  "operator_configuration",
  "output_schema",
  "selection",
]);

const FeedbackRepresentationObjectSchema = z.object({
  version: z.literal(1),
  feedback_id: IdentifierSchema,
  sentiment: z.enum(["positive", "negative", "correction"]),
  message: z.string().trim().min(1).max(20_000),
  actor: IdentifierSchema,
  occurred_at: TimestampSchema,
  target_view: ExactViewRefSchema,
  target_run_id: IdentifierSchema.optional(),
  requested_changes: z.array(FeedbackRequestedChangeSchema).default([]),
  metadata: JsonObjectSchema.default({}),
}).strict();

function uniqueRequestedChanges(
  feedback: { requested_changes: FeedbackRequestedChange[] },
  context: z.RefinementCtx,
): void {
  if (new Set(feedback.requested_changes).size !== feedback.requested_changes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requested_changes"],
      message: "Feedback requested_changes must be unique",
    });
  }
}

export const FeedbackRepresentationSchema = FeedbackRepresentationObjectSchema.superRefine(uniqueRequestedChanges);

export const RecordFeedbackInputSchema = FeedbackRepresentationObjectSchema
  .omit({ version: true })
  .superRefine(uniqueRequestedChanges);

export const TransformationEvolutionChangeSchema = z.object({
  instruction: TransformationInstructionSchema.optional(),
  operator: OperatorSnapshotSchema.optional(),
  inputs: z.array(TransformationInputBindingSchema).optional(),
  output: TransformationOutputContractSchema.optional(),
}).strict().refine(change => Object.values(change).some(value => value !== undefined), {
  message: "Transformation evolution requires at least one explicit change",
});

export const ApplyFeedbackInputSchema = z.object({
  feedback: ExactViewRefSchema,
  base_transformation: ExactTransformationRefSchema,
  change: TransformationEvolutionChangeSchema,
  actor: IdentifierSchema,
  resolution: z.string().trim().min(1).max(20_000),
  created_at: TimestampSchema,
}).strict();

export type FeedbackRequestedChange = z.infer<typeof FeedbackRequestedChangeSchema>;
export type FeedbackRepresentation = z.infer<typeof FeedbackRepresentationSchema>;
export type RecordFeedbackInput = z.infer<typeof RecordFeedbackInputSchema>;
export type TransformationEvolutionChange = z.infer<typeof TransformationEvolutionChangeSchema>;
export type ApplyFeedbackInput = z.infer<typeof ApplyFeedbackInputSchema>;

export type FeedbackEvolutionErrorCode =
  | "target_view_not_found"
  | "target_run_not_found"
  | "target_run_mismatch"
  | "feedback_view_invalid"
  | "base_transformation_not_found"
  | "base_run_mismatch"
  | "requested_change_unresolved"
  | "operator_revision_invalid";

export class FeedbackEvolutionError extends Error {
  constructor(
    message: string,
    readonly code: FeedbackEvolutionErrorCode,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FeedbackEvolutionError";
  }
}

export type FeedbackEvolutionServiceOptions = {
  views: Pick<ViewRepository, "commit" | "get">;
  runs: Pick<ExecutionRepository, "getRun">;
  transformations: TransformationRepository;
};

export class FeedbackEvolutionService {
  constructor(private readonly options: FeedbackEvolutionServiceOptions) {}

  async record(input: RecordFeedbackInput): Promise<{ view: View; created: boolean }> {
    const feedback = RecordFeedbackInputSchema.parse(input);
    const target = await this.options.views.get(feedback.target_view);
    if (!target) {
      throw new FeedbackEvolutionError(
        `Feedback target ${viewRevisionKey(feedback.target_view)} does not exist`,
        "target_view_not_found",
        { target_view: feedback.target_view },
      );
    }
    const run = feedback.target_run_id
      ? await this.requireTargetRun(feedback.target_run_id, feedback.target_view, target)
      : undefined;
    const value = FeedbackRepresentationSchema.parse({ version: 1, ...feedback });
    const draft = parseViewDraft({
      id: `view:feedback:${feedback.feedback_id}`,
      name: `Feedback: ${target.name}`,
      purpose: "Record explicit user judgment about one exact View revision",
      aliases: [],
      schema: feedbackViewSchema(),
      role: "derived",
      time: { observed_at: feedback.occurred_at, created_at: feedback.occurred_at },
      representation: {
        form: "inline",
        kind: "feedback",
        media_type: "application/json",
        value,
        metadata: {},
      },
      materialization: {
        primary: {
          id: "canonical-json",
          format: "json",
          media_type: "application/json",
          location: { kind: "inline" },
        },
        alternatives: [],
      },
      relations: [{
        type: "feedback_for",
        target: feedback.target_view,
        metadata: {
          sentiment: feedback.sentiment,
          ...(feedback.target_run_id ? { run_id: feedback.target_run_id } : {}),
        },
      }],
      provenance: {
        inputs: [feedback.target_view],
        actor: feedback.actor,
        ...(run ? { trace_id: run.trace_id } : {}),
      },
      policy: target.policy,
      metadata: {
        feedback_id: feedback.feedback_id,
        ...(feedback.target_run_id ? { target_run_id: feedback.target_run_id } : {}),
      },
    });
    const committed = await this.options.views.commit({
      draft,
      expected_revision: 0,
      idempotency_key: `feedback:${feedback.feedback_id}`,
    });
    return { view: committed.view, created: committed.created };
  }

  async apply(input: ApplyFeedbackInput): Promise<Transformation> {
    const request = ApplyFeedbackInputSchema.parse(input);
    const feedbackView = await this.options.views.get(request.feedback);
    if (!feedbackView) {
      throw new FeedbackEvolutionError(
        `Feedback View ${viewRevisionKey(request.feedback)} does not exist`,
        "feedback_view_invalid",
        { feedback: request.feedback },
      );
    }
    const feedback = parseFeedbackView(feedbackView);
    const base = await this.options.transformations.get(request.base_transformation);
    if (!base) {
      throw new FeedbackEvolutionError(
        `Base Transformation ${transformationKey(request.base_transformation)} does not exist`,
        "base_transformation_not_found",
        { base_transformation: request.base_transformation },
      );
    }
    if (feedback.target_run_id) {
      const run = await this.options.runs.getRun(feedback.target_run_id);
      if (!run) {
        throw new FeedbackEvolutionError(
          `Feedback Run ${feedback.target_run_id} no longer exists`,
          "target_run_not_found",
          { target_run_id: feedback.target_run_id },
        );
      }
      if (transformationKey(exactTransformationRef(run.frozen.transformation)) !== transformationKey(request.base_transformation)) {
        throw new FeedbackEvolutionError(
          `Feedback Run ${run.id} did not execute base Transformation ${transformationKey(request.base_transformation)}`,
          "base_run_mismatch",
          {
            target_run_id: run.id,
            run_transformation: exactTransformationRef(run.frozen.transformation),
            base_transformation: request.base_transformation,
          },
        );
      }
    }
    assertRequestedChangesResolved(base, request.change, feedback.requested_changes);
    assertOperatorRevision(base, request.change);

    const inputs = withEvolutionEvidence(
      request.change.inputs ?? base.inputs,
      feedback.target_view,
      request.feedback,
    );
    const next = parseTransformation({
      ...base,
      revision: base.revision + 1,
      supersedes: exactTransformationRef(base),
      created_at: request.created_at,
      instruction: request.change.instruction ?? base.instruction,
      operator: request.change.operator ?? base.operator,
      inputs,
      output: request.change.output ?? base.output,
      metadata: {
        ...base.metadata,
        evolution: {
          feedback: request.feedback,
          target_view: feedback.target_view,
          ...(feedback.target_run_id ? { target_run_id: feedback.target_run_id } : {}),
          base_transformation: exactTransformationRef(base),
          actor: request.actor,
          resolution: request.resolution,
        },
      },
    });
    const committed = await this.options.transformations.commit({
      transformation: next,
      expected_revision: request.base_transformation.revision,
      idempotency_key: `feedback-evolution:${viewRevisionKey(request.feedback)}`,
    });
    return committed.transformation;
  }

  private async requireTargetRun(runId: string, targetRef: ExactViewRef, target: View): Promise<ExecutionRun> {
    const run = await this.options.runs.getRun(runId);
    if (!run) {
      throw new FeedbackEvolutionError(
        `Feedback target Run ${runId} does not exist`,
        "target_run_not_found",
        { target_run_id: runId },
      );
    }
    const targets = [...run.output_views, ...(run.failure_view ? [run.failure_view] : [])];
    if (!targets.some(ref => viewRevisionKey(ref) === viewRevisionKey(targetRef))
      || target.provenance.operator_run_id !== runId) {
      throw new FeedbackEvolutionError(
        `View ${viewRevisionKey(targetRef)} is not an output of Run ${runId}`,
        "target_run_mismatch",
        { target_view: targetRef, target_run_id: runId },
      );
    }
    return run;
  }
}

export function parseFeedbackView(view: View): FeedbackRepresentation {
  if (view.schema.name !== "metaflow.feedback" || view.schema.version !== 1
    || view.representation.form !== "inline") {
    throw new FeedbackEvolutionError(
      `View ${view.id}@${view.revision} is not a Metaflow Feedback View`,
      "feedback_view_invalid",
      { feedback: exactViewRef(view) },
    );
  }
  let feedback: FeedbackRepresentation;
  try {
    feedback = FeedbackRepresentationSchema.parse(view.representation.value);
  } catch (error) {
    throw new FeedbackEvolutionError(
      `Feedback View ${view.id}@${view.revision} has an invalid Representation`,
      "feedback_view_invalid",
      { feedback: exactViewRef(view) },
      { cause: error },
    );
  }
  const targetKey = viewRevisionKey(feedback.target_view);
  const relation = view.relations.some(item => item.type === "feedback_for" && viewRevisionKey(item.target) === targetKey);
  const provenance = view.provenance.inputs.some(item => viewRevisionKey(item) === targetKey);
  if (!relation || !provenance) {
    throw new FeedbackEvolutionError(
      `Feedback View ${view.id}@${view.revision} does not preserve exact target lineage`,
      "feedback_view_invalid",
      { feedback: exactViewRef(view), target_view: feedback.target_view },
    );
  }
  return feedback;
}

function withEvolutionEvidence(
  inputs: Transformation["inputs"],
  target: ExactViewRef,
  feedback: ExactViewRef,
): Transformation["inputs"] {
  const retained = inputs.filter(binding => binding.role !== "evolution_target" && binding.role !== "evolution_feedback");
  return [
    ...retained,
    { role: "evolution_target", required: true, sources: [{ kind: "view", ref: target }] },
    { role: "evolution_feedback", required: true, sources: [{ kind: "view", ref: feedback }] },
  ];
}

function assertRequestedChangesResolved(
  base: Transformation,
  change: TransformationEvolutionChange,
  requested: FeedbackRequestedChange[],
): void {
  if (requested.length === 0) {
    throw new FeedbackEvolutionError(
      "Feedback does not request a Transformation change",
      "requested_change_unresolved",
    );
  }
  const unresolved = requested.filter(item => {
    if (item === "instruction") {
      return !change.instruction || canonicalJson(change.instruction) === canonicalJson(base.instruction);
    }
    if (item === "operator_configuration") {
      return !change.operator || canonicalJson(change.operator.configuration) === canonicalJson(base.operator.configuration);
    }
    if (item === "output_schema") {
      return !change.output || canonicalJson(change.output.schema) === canonicalJson(base.output.schema);
    }
    return !change.inputs || canonicalJson(change.inputs) === canonicalJson(base.inputs);
  });
  if (unresolved.length > 0) {
    throw new FeedbackEvolutionError(
      `Feedback requested changes were not explicitly resolved: ${unresolved.join(", ")}`,
      "requested_change_unresolved",
      { unresolved },
    );
  }
}

function assertOperatorRevision(base: Transformation, change: TransformationEvolutionChange): void {
  const operator = change.operator;
  if (!operator || canonicalJson(operator) === canonicalJson(base.operator)) return;
  if (operator.id === base.operator.id && operator.revision !== base.operator.revision + 1) {
    throw new FeedbackEvolutionError(
      `Changed Operator ${operator.id} must advance exactly one revision`,
      "operator_revision_invalid",
      {
        operator_id: operator.id,
        expected_revision: base.operator.revision + 1,
        actual_revision: operator.revision,
      },
    );
  }
}

function feedbackViewSchema() {
  return {
    name: "metaflow.feedback",
    version: 1,
    mode: "strict" as const,
    dialect: "https://json-schema.org/draft/2020-12/schema" as const,
    json_schema: {
      type: "object",
      required: [
        "version",
        "feedback_id",
        "sentiment",
        "message",
        "actor",
        "occurred_at",
        "target_view",
        "requested_changes",
        "metadata",
      ],
      additionalProperties: false,
      properties: {
        version: { const: 1 },
        feedback_id: { type: "string", minLength: 1 },
        sentiment: { enum: ["positive", "negative", "correction"] },
        message: { type: "string", minLength: 1 },
        actor: { type: "string", minLength: 1 },
        occurred_at: { type: "string" },
        target_view: {
          type: "object",
          required: ["view_id", "revision"],
          additionalProperties: false,
          properties: {
            view_id: { type: "string", minLength: 1 },
            revision: { type: "integer", minimum: 1 },
          },
        },
        target_run_id: { type: "string", minLength: 1 },
        requested_changes: {
          type: "array",
          uniqueItems: true,
          items: { enum: FeedbackRequestedChangeSchema.options },
        },
        metadata: { type: "object" },
      },
    },
  };
}

function transformationKey(ref: { transformation_id: string; revision: number }): string {
  return `${ref.transformation_id}@${ref.revision}`;
}

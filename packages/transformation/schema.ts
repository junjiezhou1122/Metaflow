import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  TimestampSchema,
  ViewSchemaRefSchema,
  type JsonObject,
} from "@info/view";

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const ExactTransformationRefSchema = z.object({
  transformation_id: IdentifierSchema,
  revision: z.number().int().positive(),
}).strict();

export const TransformationInstructionSchema = z.object({
  format: z.literal("natural_language"),
  text: z.string().trim().min(1).max(100_000),
  language: IdentifierSchema.optional(),
  parameters: JsonObjectSchema.default({}),
}).strict();

const AgentOperatorReferenceSchema = z.object({
  kind: z.literal("agent"),
  adapter: IdentifierSchema,
  profile: IdentifierSchema.optional(),
}).strict();

const WorkflowOperatorReferenceSchema = z.object({
  kind: z.literal("workflow"),
  workflow_id: IdentifierSchema,
  revision: z.number().int().positive(),
}).strict();

const FunctionOperatorReferenceSchema = z.object({
  kind: z.literal("function"),
  function_id: IdentifierSchema,
  version: z.number().int().positive(),
}).strict();

const ModelOperatorReferenceSchema = z.object({
  kind: z.literal("model"),
  provider: IdentifierSchema,
  model: IdentifierSchema,
}).strict();

const HumanOperatorReferenceSchema = z.object({
  kind: z.literal("human"),
  channel: IdentifierSchema,
  role: IdentifierSchema.optional(),
}).strict();

const RemoteServiceOperatorReferenceSchema = z.object({
  kind: z.literal("remote_service"),
  service: IdentifierSchema,
  operation: IdentifierSchema,
  api_version: IdentifierSchema.optional(),
}).strict();

export const OperatorReferenceSchema = z.discriminatedUnion("kind", [
  AgentOperatorReferenceSchema,
  WorkflowOperatorReferenceSchema,
  FunctionOperatorReferenceSchema,
  ModelOperatorReferenceSchema,
  HumanOperatorReferenceSchema,
  RemoteServiceOperatorReferenceSchema,
]);

export const OperatorSnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  reference: OperatorReferenceSchema,
  configuration: JsonObjectSchema.default({}),
  required_capabilities: z.array(IdentifierSchema).default([]),
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.required_capabilities).size !== snapshot.required_capabilities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Operator required capabilities must be unique",
      path: ["required_capabilities"],
    });
  }
});

const ViewSelectorQuerySchema = z.object({
  scope: z.enum(["matching", "all"]),
  schema_names: z.array(IdentifierSchema).default([]),
  roles: z.array(z.enum(["raw", "derived"])).default([]),
  text: z.string().trim().min(1).optional(),
  observed_from: TimestampSchema.optional(),
  observed_to: TimestampSchema.optional(),
  revision_scope: z.enum(["latest", "all"]).default("latest"),
  order: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.number().int().positive().max(10_000),
  where: JsonObjectSchema.default({}),
}).strict().superRefine((query, context) => {
  if (query.observed_from && query.observed_to && Date.parse(query.observed_from) > Date.parse(query.observed_to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "observed_from must be at or before observed_to",
      path: ["observed_to"],
    });
  }
  const hasFilter = query.schema_names.length > 0
    || query.roles.length > 0
    || query.text !== undefined
    || query.observed_from !== undefined
    || query.observed_to !== undefined
    || Object.keys(query.where).length > 0;
  if (query.scope === "matching" && !hasFilter) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A matching View selector requires at least one filter",
      path: ["scope"],
    });
  }
  if (query.scope === "all" && hasFilter) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An all-scope View selector cannot carry matching filters",
      path: ["scope"],
    });
  }
});

export const ViewSelectorSnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  query: ViewSelectorQuerySchema,
}).strict();

export const TransformationInputSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), ref: ExactViewRefSchema }).strict(),
  z.object({ kind: z.literal("selector"), selector: ViewSelectorSnapshotSchema }).strict(),
]);

export const TransformationInputBindingSchema = z.object({
  role: IdentifierSchema,
  required: z.boolean().default(true),
  sources: z.array(TransformationInputSourceSchema).min(1),
}).strict();

export const TransformationOutputContractSchema = z.object({
  schema: ViewSchemaRefSchema,
  schema_origin: z.enum(["declared", "inferred"]),
  cardinality: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().positive().optional(),
  }).strict().refine(value => value.max === undefined || value.max >= value.min, {
    message: "output cardinality max must be greater than or equal to min",
  }),
}).strict();

export const TransformationTriggerSnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  kind: IdentifierSchema,
  configuration: JsonObjectSchema.default({}),
}).strict();

export const TransformationPolicySnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  configuration: JsonObjectSchema,
}).strict();

export const TransformationBudgetSnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  limits: z.object({
    timeout_ms: z.number().int().positive().optional(),
    max_attempts: z.number().int().positive().optional(),
    max_cost_usd: z.number().finite().nonnegative().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  }).strict(),
  extensions: JsonObjectSchema.default({}),
}).strict().superRefine((budget, context) => {
  const hasLimit = Object.values(budget.limits).some(value => value !== undefined)
    || Object.keys(budget.extensions).length > 0;
  if (!hasLimit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Transformation budget requires at least one limit",
      path: ["limits"],
    });
  }
});

const TransformationShape = {
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  instruction: TransformationInstructionSchema,
  operator: OperatorSnapshotSchema,
  inputs: z.array(TransformationInputBindingSchema).default([]),
  output: TransformationOutputContractSchema,
  trigger: TransformationTriggerSnapshotSchema.optional(),
  policy: TransformationPolicySnapshotSchema.optional(),
  budget: TransformationBudgetSnapshotSchema.optional(),
  created_at: TimestampSchema,
  supersedes: ExactTransformationRefSchema.optional(),
  metadata: JsonObjectSchema.default({}),
} as const;

export const TransformationSchema = z.object(TransformationShape).strict().superRefine((transformation, context) => {
  const roles = transformation.inputs.map(binding => binding.role);
  if (new Set(roles).size !== roles.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Transformation input roles must be unique",
      path: ["inputs"],
    });
  }
  if (transformation.revision === 1 && transformation.supersedes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A first Transformation revision cannot supersede another revision",
      path: ["supersedes"],
    });
  }
  if (transformation.revision > 1) {
    if (!transformation.supersedes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A later Transformation revision must supersede its exact prior revision",
        path: ["supersedes"],
      });
    } else if (
      transformation.supersedes.transformation_id !== transformation.id
      || transformation.supersedes.revision !== transformation.revision - 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Transformation supersedes must reference the same identity at revision - 1",
        path: ["supersedes"],
      });
    }
  }
});

export type ExactTransformationRef = z.infer<typeof ExactTransformationRefSchema>;
export type TransformationInstruction = z.infer<typeof TransformationInstructionSchema>;
export type OperatorReference = z.infer<typeof OperatorReferenceSchema>;
export type OperatorSnapshot = z.infer<typeof OperatorSnapshotSchema>;
export type ViewSelectorSnapshot = z.infer<typeof ViewSelectorSnapshotSchema>;
export type TransformationInputSource = z.infer<typeof TransformationInputSourceSchema>;
export type TransformationInputBinding = z.infer<typeof TransformationInputBindingSchema>;
export type TransformationOutputContract = z.infer<typeof TransformationOutputContractSchema>;
export type TransformationTriggerSnapshot = z.infer<typeof TransformationTriggerSnapshotSchema>;
export type TransformationPolicySnapshot = z.infer<typeof TransformationPolicySnapshotSchema>;
export type TransformationBudgetSnapshot = z.infer<typeof TransformationBudgetSnapshotSchema>;
export type Transformation = z.infer<typeof TransformationSchema>;

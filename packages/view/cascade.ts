import { z } from "zod";
import { ExactViewRefSchema, IdentifierSchema, TimestampSchema } from "./schema.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ReactiveCascadePolicySnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  limits: z.object({
    max_depth: z.number().int().positive(),
    max_fan_out: z.number().int().positive(),
    max_total_attempts: z.number().int().positive(),
    max_total_cost_usd: z.number().finite().nonnegative(),
    max_elapsed_ms: z.number().int().positive(),
    max_operator_concurrency: z.number().int().positive(),
    reservation_lease_ms: z.number().int().positive(),
  }).strict(),
}).strict();

export const ReactiveCascadeTargetSchema = z.object({
  automation: ExactViewRefSchema,
  transformation: z.object({
    transformation_id: IdentifierSchema,
    revision: z.number().int().positive(),
  }).strict(),
  operator: z.object({
    id: IdentifierSchema,
    revision: z.number().int().positive(),
  }).strict().optional(),
}).strict();

export const ReactiveCascadeContextSchema = z.object({
  attempt_id: IdentifierSchema,
  root_correlation_id: IdentifierSchema,
  root_event_id: IdentifierSchema,
  parent_event_id: IdentifierSchema,
  parent_run_id: IdentifierSchema.optional(),
  parent_attempt_id: IdentifierSchema.optional(),
  target: ReactiveCascadeTargetSchema,
  lineage: z.array(ExactViewRefSchema).min(1),
  depth: z.number().int().positive(),
  fan_out_index: z.number().int().nonnegative(),
  fan_out_total: z.number().int().positive(),
  semantic_fingerprints: z.array(DigestSchema).min(1),
  policy: ReactiveCascadePolicySnapshotSchema,
  root_started_at: TimestampSchema,
  attempt_started_at: TimestampSchema,
  aggregate: z.object({
    attempts: z.number().int().positive(),
    cost_usd: z.number().finite().nonnegative(),
  }).strict(),
  disposition: z.enum(["continue", "terminal"]),
  terminal: z.object({
    code: IdentifierSchema,
    message: z.string().trim().min(1).max(20_000),
    stage: z.enum(["admission", "authorization", "execution", "validation", "commit", "transport"]),
  }).strict().optional(),
  replay: z.object({
    kind: z.enum(["explicit_replay", "repair"]),
    previous_cascade_attempt_id: IdentifierSchema,
    previous_execution_attempt_id: IdentifierSchema,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.fan_out_index >= value.fan_out_total) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fan_out_index"],
      message: "cascade fan_out_index must be less than fan_out_total",
    });
  }
  const lineage = value.lineage.map(ref => `${ref.view_id}@${ref.revision}`);
  if (new Set(lineage).size !== lineage.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lineage"],
      message: "cascade lineage cannot contain the same exact View revision twice",
    });
  }
  if (value.depth > value.aggregate.attempts) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["depth"],
      message: "cascade depth cannot exceed aggregate attempts",
    });
  }
  if (value.disposition === "terminal" && !value.terminal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminal"],
      message: "terminal cascade context requires terminal evidence",
    });
  }
  if (value.disposition === "continue" && value.terminal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminal"],
      message: "continuing cascade context cannot carry terminal evidence",
    });
  }
});

export type ReactiveCascadePolicySnapshot = z.infer<typeof ReactiveCascadePolicySnapshotSchema>;
export type ReactiveCascadeTarget = z.infer<typeof ReactiveCascadeTargetSchema>;
export type ReactiveCascadeContext = z.infer<typeof ReactiveCascadeContextSchema>;

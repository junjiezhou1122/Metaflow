import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  TimestampSchema,
} from "./schema.js";
import type {
  ExactViewRef,
  View,
  ViewDraft,
  ViewMaterialization,
  ViewRelation,
  ViewRepresentation,
} from "./schema.js";
import type { ViewCommitContext } from "./events.js";

export type CommitViewInput = {
  draft: ViewDraft;
  expected_revision: number;
  idempotency_key?: string;
};

export type CommitViewResult = {
  view: View;
  created: boolean;
  transaction_id: string;
};

export type CommitViewBatchResult = {
  results: CommitViewResult[];
  transaction_id: string;
};

export const ViewQueryTimeRangeSchema = z.object({
  /** Select the exact View timestamp field to compare; observed_at never falls back to created_at. */
  basis: z.enum(["observed_at", "created_at"]),
  /** Inclusive lower bound of the half-open occurrence period. */
  start: TimestampSchema,
  /** Exclusive upper bound of the half-open occurrence period. */
  end: TimestampSchema,
}).strict().refine(value => Date.parse(value.start) < Date.parse(value.end), {
  message: "View query time range must be a non-empty half-open interval",
  path: ["end"],
});

export const ViewQuerySchema = z.object({
  /** Legacy singular Schema filter. Do not combine with schema_names. */
  schema_name: IdentifierSchema.optional(),
  /** Schema categories to match with OR semantics. */
  schema_names: z.array(IdentifierSchema).min(1).optional(),
  role: z.enum(["raw", "derived"]).optional(),
  text: z.string().trim().min(1).optional(),
  /** Exact half-open timestamp range: start <= timestamp < end. */
  time_range: ViewQueryTimeRangeSchema.optional(),
  revisions: z.enum(["latest", "all"]).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
}).strict().superRefine((query, context) => {
  if (query.schema_name && query.schema_names) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schema_names"],
      message: "View query cannot combine schema_name and schema_names",
    });
  }
});

export const RelationTraversalQuerySchema = z.object({
  ref: ExactViewRefSchema,
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  type: IdentifierSchema.optional(),
  limit: z.number().int().positive().max(10_000).optional(),
}).strict();

export type ViewQueryTimeRange = z.infer<typeof ViewQueryTimeRangeSchema>;
export type ViewQuery = z.infer<typeof ViewQuerySchema>;
export type RelationTraversalQuery = z.infer<typeof RelationTraversalQuerySchema>;

export type ViewMaterializationRole = "primary" | "alternative" | "derived";

export type StoredViewMaterialization = {
  view: ExactViewRef;
  role: ViewMaterializationRole;
  materialization: ViewMaterialization;
  generation: number;
  updated_at: string;
};

export type PutDerivedMaterializationInput = {
  view: ExactViewRef;
  materialization: ViewMaterialization;
  expected_generation: number;
  updated_at: string;
};

export const ReindexViewSearchInputSchema = z.object({
  run_id: IdentifierSchema,
  requested_at: TimestampSchema,
}).strict();

export const ReindexViewSearchReportSchema = z.object({
  run_id: IdentifierSchema,
  status: z.literal("succeeded"),
  projection_version: z.literal(1),
  scanned: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  semantic: z.object({
    adapter: z.literal("sqlite-vec"),
    extension_version: IdentifierSchema,
    profiles: z.number().int().positive(),
    scanned: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    orphans_repaired: z.number().int().nonnegative(),
    missing_rows_repaired: z.number().int().nonnegative(),
  }).strict().optional(),
  started_at: TimestampSchema,
  completed_at: TimestampSchema,
}).strict();

export type ReindexViewSearchInput = z.infer<typeof ReindexViewSearchInputSchema>;
export type ReindexViewSearchReport = z.infer<typeof ReindexViewSearchReportSchema>;

export interface ViewRepository {
  commit(input: CommitViewInput, context?: ViewCommitContext): Promise<CommitViewResult>;
  commitBatch(inputs: CommitViewInput[], context?: ViewCommitContext): Promise<CommitViewBatchResult>;
  get(ref: ExactViewRef): Promise<View | undefined>;
  getLatest(viewId: string): Promise<View | undefined>;
  resolveLatest(viewId: string): Promise<ExactViewRef | undefined>;
  query(query?: ViewQuery): Promise<View[]>;
  reindexSearch(input: ReindexViewSearchInput): Promise<ReindexViewSearchReport>;
  getRepresentation(ref: ExactViewRef): Promise<ViewRepresentation | undefined>;
  getMaterializations(ref: ExactViewRef): Promise<StoredViewMaterialization[]>;
  putDerivedMaterialization(input: PutDerivedMaterializationInput): Promise<StoredViewMaterialization>;
  traverseRelations(query: RelationTraversalQuery): Promise<ViewRelation[]>;
}

export type ViewRepositoryErrorCode =
  | "conflict"
  | "idempotency_conflict"
  | "source_identity_conflict"
  | "referential_integrity"
  | "policy_violation"
  | "invalid_request"
  | "corrupt_data"
  | "storage_failure";

export type ViewRepositoryErrorDetails = {
  operation: string;
  phase?: string;
  transaction_id?: string;
  view_ids?: string[];
  revision?: number;
  table?: string;
  connection_id?: string;
  migration_version?: number;
  idempotency_key?: string;
  sqlite_code?: string;
};

export class ViewRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: ViewRepositoryErrorCode,
    readonly details: ViewRepositoryErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewRepositoryError";
  }
}

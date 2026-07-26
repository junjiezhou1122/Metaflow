import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  TimestampSchema,
  type ExactViewRef,
} from "./schema.js";

export const VIEW_GRAPH_PROJECTION_VERSION = 1 as const;
export const VIEW_GRAPH_MAX_ROOTS = 20;
export const VIEW_GRAPH_MAX_EDGE_TYPES = 32;
export const VIEW_GRAPH_MAX_DEPTH = 5;
export const VIEW_GRAPH_MAX_NODES = 2_000;
export const VIEW_GRAPH_MAX_EDGES = 10_000;
export const VIEW_GRAPH_RELATION_PAGE_SIZE = 256;
export const VIEW_GRAPH_MAX_SCANNED_EDGES = 100_000;

function uniqueArray<T extends z.ZodTypeAny>(schema: T, label: string, max: number) {
  return z.array(schema).min(1).max(max).superRefine((values, context) => {
    const identities = values.map(value => JSON.stringify(value));
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be unique` });
    }
  });
}

export const ViewGraphProjectionRequestSchema = z.object({
  roots: uniqueArray(ExactViewRefSchema, "graph roots", VIEW_GRAPH_MAX_ROOTS),
  direction: z.enum(["incoming", "outgoing", "both"]),
  edge_types: uniqueArray(IdentifierSchema, "graph edge types", VIEW_GRAPH_MAX_EDGE_TYPES),
  max_depth: z.number().int().nonnegative().max(VIEW_GRAPH_MAX_DEPTH),
  max_nodes: z.number().int().positive().max(VIEW_GRAPH_MAX_NODES),
  max_edges: z.number().int().positive().max(VIEW_GRAPH_MAX_EDGES),
}).strict();

export const ViewGraphRelationEdgeSchema = z.object({
  id: IdentifierSchema,
  type: IdentifierSchema,
  source: ExactViewRefSchema,
  target: ExactViewRefSchema,
}).strict();

export const ViewGraphRelationCursorSchema = z.object({
  type: IdentifierSchema,
  source: ExactViewRefSchema,
  target: ExactViewRefSchema,
  relation_id: IdentifierSchema,
}).strict();

export const ViewGraphRelationPageSchema = z.object({
  edges: z.array(ViewGraphRelationEdgeSchema).max(VIEW_GRAPH_RELATION_PAGE_SIZE),
  next: ViewGraphRelationCursorSchema.optional(),
}).strict();

export const ViewGraphNodeSummarySchema = z.object({
  ref: ExactViewRefSchema,
  name: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(2_000),
  schema: z.object({
    name: IdentifierSchema,
    version: z.number().int().positive(),
  }).strict(),
  role: z.enum(["raw", "derived"]),
  time: z.object({
    observed_at: TimestampSchema.optional(),
    created_at: TimestampSchema,
  }).strict(),
  representation: z.object({
    kind: IdentifierSchema,
    media_type: z.string().trim().min(1).optional(),
  }).strict(),
}).strict();

export const ViewGraphProjectionNodeSchema = ViewGraphNodeSummarySchema.extend({
  depth: z.number().int().nonnegative().max(VIEW_GRAPH_MAX_DEPTH),
  path: z.array(IdentifierSchema).max(VIEW_GRAPH_MAX_DEPTH),
}).strict();

export const ViewGraphProjectionEdgeSchema = ViewGraphRelationEdgeSchema.extend({
  depth: z.number().int().positive().max(VIEW_GRAPH_MAX_DEPTH),
}).strict();

export const ViewGraphFrontierReasonSchema = z.enum(["depth_limit", "node_limit", "edge_limit"]);

export const ViewGraphProjectionResultSchema = z.object({
  projection_version: z.literal(VIEW_GRAPH_PROJECTION_VERSION),
  roots: z.array(ExactViewRefSchema).min(1).max(VIEW_GRAPH_MAX_ROOTS),
  nodes: z.array(ViewGraphProjectionNodeSchema).max(VIEW_GRAPH_MAX_NODES),
  edges: z.array(ViewGraphProjectionEdgeSchema).max(VIEW_GRAPH_MAX_EDGES),
  frontier: z.array(z.object({
    ref: ExactViewRefSchema,
    reason: ViewGraphFrontierReasonSchema,
  }).strict()).max(VIEW_GRAPH_MAX_NODES),
  truncation: z.object({
    truncated: z.boolean(),
    reasons: z.array(ViewGraphFrontierReasonSchema).max(3),
  }).strict(),
  redacted_boundary: z.boolean(),
}).strict().superRefine((result, context) => {
  requireUnique(result.roots.map(refIdentity), "roots", ["roots"], context);
  requireUnique(result.nodes.map(node => refIdentity(node.ref)), "nodes", ["nodes"], context);
  requireUnique(result.edges.map(edge => edge.id), "edges", ["edges"], context);
  requireUnique(result.frontier.map(item => `${item.reason}:${refIdentity(item.ref)}`), "frontier", ["frontier"], context);
  requireUnique(result.truncation.reasons, "truncation reasons", ["truncation", "reasons"], context);
  if (result.truncation.truncated !== (result.truncation.reasons.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncation"],
      message: "truncated must be true exactly when at least one truncation reason exists",
    });
  }
  const nodeRefs = new Set(result.nodes.map(node => refIdentity(node.ref)));
  const edgeIds = new Set(result.edges.map(edge => edge.id));
  result.nodes.forEach((node, index) => {
    if (node.path.length !== node.depth || node.path.some(relationId => !edgeIds.has(relationId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "path"],
        message: "node path must contain one returned relation id for every traversal depth",
      });
    }
  });
  result.edges.forEach((edge, index) => {
    if (!nodeRefs.has(refIdentity(edge.source)) || !nodeRefs.has(refIdentity(edge.target))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index],
        message: "returned graph edges require both authorized endpoint nodes",
      });
    }
  });
});

export type ViewGraphProjectionRequest = z.infer<typeof ViewGraphProjectionRequestSchema>;
export type ViewGraphRelationEdge = z.infer<typeof ViewGraphRelationEdgeSchema>;
export type ViewGraphRelationCursor = z.infer<typeof ViewGraphRelationCursorSchema>;
export type ViewGraphRelationPage = z.infer<typeof ViewGraphRelationPageSchema>;
export type ViewGraphNodeSummary = z.infer<typeof ViewGraphNodeSummarySchema>;
export type ViewGraphProjectionNode = z.infer<typeof ViewGraphProjectionNodeSchema>;
export type ViewGraphProjectionEdge = z.infer<typeof ViewGraphProjectionEdgeSchema>;
export type ViewGraphFrontierReason = z.infer<typeof ViewGraphFrontierReasonSchema>;
export type ViewGraphProjectionResult = z.infer<typeof ViewGraphProjectionResultSchema>;

export interface ViewGraphProjectionSource {
  readGraphRelationPage(input: {
    frontier: ExactViewRef[];
    direction: ViewGraphProjectionRequest["direction"];
    edge_types: string[];
    after?: ViewGraphRelationCursor;
    limit: number;
  }): Promise<ViewGraphRelationPage>;
  readGraphNodeSummaries(refs: ExactViewRef[]): Promise<ViewGraphNodeSummary[]>;
}

function refIdentity(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function requireUnique(
  values: readonly string[],
  label: string,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size === values.length) return;
  context.addIssue({ code: z.ZodIssueCode.custom, path, message: `${label} must be unique` });
}

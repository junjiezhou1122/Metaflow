import { z } from "zod";
import {
  ViewGraphProjectionRequestSchema,
  ViewGraphProjectionResultSchema,
  type ViewGraphProjectionRequest,
  type ViewGraphProjectionEdge,
  type ViewGraphProjectionNode,
  type ViewGraphProjectionResult,
} from "@info/view/graph";
import { ViewRevisionSchema, type ExactViewRef, type View } from "@info/view/schema";
import {
  SearchRequestV1Schema,
  SearchResponseV1Schema,
  type SearchRequestV1,
  type SearchResponseV1,
} from "@info/search/contracts";

export const EXPLORER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const EXPLORER_MAX_NODES = 2_000;
export const EXPLORER_MAX_EDGES = 10_000;

const OperationErrorSchema = z.object({
  code: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(2_000),
  category: z.enum(["invalid_request", "forbidden", "not_found", "conflict", "failed_dependency", "internal"]),
  details: z.record(z.unknown()),
}).strict();

export const OperationEnvelopeSchema = z.union([
  z.object({
    ok: z.literal(true),
    request_id: z.string().trim().min(1).max(240),
    operation: z.string().trim().min(1).max(240),
    data: z.unknown(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    request_id: z.string().trim().min(1).max(240),
    operation: z.string().trim().min(1).max(240).optional(),
    error: OperationErrorSchema,
  }).strict(),
]);

export type OperationEnvelope = z.infer<typeof OperationEnvelopeSchema>;
export type ExplorerOperation = "view.graph.project" | "view.get" | "view.search";
export type { ExactViewRef, SearchRequestV1, SearchResponseV1, View, ViewGraphProjectionEdge, ViewGraphProjectionNode, ViewGraphProjectionRequest, ViewGraphProjectionResult };
export { SearchRequestV1Schema, SearchResponseV1Schema, ViewGraphProjectionRequestSchema, ViewGraphProjectionResultSchema, ViewRevisionSchema };

export function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

export function parseExactRef(value: string): ExactViewRef | undefined {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const revision = Number(value.slice(separator + 1));
  if (!Number.isInteger(revision) || revision < 1) return undefined;
  const view_id = value.slice(0, separator);
  const parsed = z.object({ view_id: z.string().trim().min(1), revision: z.number().int().positive() }).strict().safeParse({ view_id, revision });
  return parsed.success ? parsed.data : undefined;
}

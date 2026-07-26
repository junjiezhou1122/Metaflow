import { z } from "zod";

export const SearchErrorStageSchema = z.enum(["validation", "authorization", "scope", "retrieval", "fusion", "rerank", "cursor", "observer"]);

export type SearchErrorStage = z.infer<typeof SearchErrorStageSchema>;

export const SearchErrorCodeSchema = z.enum([
  "invalid_request",
  "view_not_found",
  "view_read_forbidden",
  "scope_limit_exceeded",
  "scope_resolution_failed",
  "scope_stale",
  "mode_unavailable",
  "mode_forbidden",
  "semantic_not_configured",
  "relation_scope_unsupported",
  "retrieval_failed",
  "fusion_failed",
  "reranker_not_configured",
  "reranker_failed",
  "cursor_invalid",
  "cursor_request_mismatch",
  "cursor_stale",
  "observer_failed",
]);

export type SearchErrorCode = z.infer<typeof SearchErrorCodeSchema>;

export const SearchFailureV1Schema = z.object({
  contract_version: z.literal(1),
  error: z.object({
    code: SearchErrorCodeSchema,
    stage: SearchErrorStageSchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export type SearchFailureV1 = z.infer<typeof SearchFailureV1Schema>;

export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: SearchErrorCode,
    readonly stage: SearchErrorStage,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SearchError";
  }
}

export class SearchModeOutcomeError extends SearchError {
  constructor(
    readonly status: "unavailable" | "forbidden",
    code: SearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, code, "retrieval", false, options);
    this.name = "SearchModeOutcomeError";
  }
}

export class SearchModeUnavailableError extends SearchModeOutcomeError {
  constructor(code: SearchErrorCode, message: string, options?: ErrorOptions) {
    super("unavailable", code, message, options);
    this.name = "SearchModeUnavailableError";
  }
}

export class SearchModeForbiddenError extends SearchModeOutcomeError {
  constructor(message: string, options?: ErrorOptions) {
    super("forbidden", "mode_forbidden", message, options);
    this.name = "SearchModeForbiddenError";
  }
}

export function toSearchFailureV1(error: SearchError): SearchFailureV1 {
  return SearchFailureV1Schema.parse({
    contract_version: 1,
    error: {
      code: error.code,
      stage: error.stage,
      message: error.message.slice(0, 1_000),
      retryable: error.retryable,
    },
  });
}

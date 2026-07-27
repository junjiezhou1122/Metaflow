import { z } from "zod";
import { ExactViewRefSchema, IdentifierSchema, JsonPointerSchema, TimestampSchema } from "@info/view/schema";
import { compileViewSearchMatchExpression } from "@info/view/search-match";

export const SEARCH_CONTRACT_VERSION = 1 as const;
export const SEARCH_MAX_SCOPE_NODES = 1_000;
export const SEARCH_MAX_SCAN_REFS = 10_000;
export const SEARCH_MAX_DEPTH = 16;
export const SEARCH_MAX_PAGE_SIZE = 100;
export const SEARCH_MAX_CANDIDATES = 1_000;
export const SEARCH_MAX_QUERY_LENGTH = 2_000;

export const SearchModeSchema = z.enum(["keyword", "semantic", "relation"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

const uniqueNonEmpty = <T extends z.ZodTypeAny>(schema: T, label: string, max: number) => z.array(schema)
  .min(1)
  .max(max)
  .superRefine((values, context) => {
    const identities = values.map(value => JSON.stringify(value));
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be unique` });
    }
  });

export const ExactSearchScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact_views"),
    refs: uniqueNonEmpty(ExactViewRefSchema, "exact View refs", SEARCH_MAX_SCOPE_NODES),
  }).strict(),
  z.object({
    kind: z.literal("subgraph"),
    roots: uniqueNonEmpty(ExactViewRefSchema, "subgraph roots", 64),
    direction: z.enum(["incoming", "outgoing", "both"]),
    relation_types: uniqueNonEmpty(IdentifierSchema, "relation types", 32),
    max_depth: z.number().int().nonnegative().max(SEARCH_MAX_DEPTH),
    max_nodes: z.number().int().positive().max(SEARCH_MAX_SCOPE_NODES),
  }).strict(),
  z.object({
    kind: z.literal("all_visible"),
    max_nodes: z.number().int().positive().max(SEARCH_MAX_SCOPE_NODES),
    max_scan: z.number().int().positive().max(SEARCH_MAX_SCAN_REFS),
  }).strict(),
]).superRefine((scope, context) => {
  if (scope.kind === "all_visible" && scope.max_scan < scope.max_nodes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "all-visible max_scan must be at least max_nodes",
      path: ["max_scan"],
    });
  }
});

export const SearchTargetSchema = z.object({
  envelope: z.boolean(),
  internal: z.boolean(),
  related_views: z.boolean(),
}).strict().refine(target => target.envelope || target.internal || target.related_views, {
  message: "at least one Search target must be enabled",
});

export const ExactEmbeddingProfileRefSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
}).strict();

export const ExactRerankerDescriptorSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
}).strict();

export const SearchRequestV1Schema = z.object({
  contract_version: z.literal(SEARCH_CONTRACT_VERSION),
  query: z.object({ text: z.string().trim().min(1).max(SEARCH_MAX_QUERY_LENGTH) }).strict(),
  scope: ExactSearchScopeSchema,
  target: SearchTargetSchema,
  modes: uniqueNonEmpty(SearchModeSchema, "Search modes", 3),
  semantic: z.object({ embedding_profile: ExactEmbeddingProfileRefSchema }).strict().optional(),
  fusion: z.object({
    strategy: z.literal("rrf@1"),
    k: z.literal(60),
    weights: z.object({
      keyword: z.number().finite().positive().optional(),
      semantic: z.number().finite().positive().optional(),
      relation: z.number().finite().positive().optional(),
    }).strict(),
  }).strict(),
  reranker: z.object({
    descriptor: ExactRerankerDescriptorSchema,
    candidate_limit: z.number().int().positive().max(SEARCH_MAX_CANDIDATES),
  }).strict().optional(),
  failure_mode: z.enum(["require_all", "allow_explicit_partial"]).default("require_all"),
  page: z.object({
    limit: z.number().int().positive().max(SEARCH_MAX_PAGE_SIZE),
    cursor: z.string().trim().min(1).max(8_192).optional(),
  }).strict(),
}).strict().superRefine((request, context) => {
  const modes = new Set<SearchMode>(request.modes);
  if (modes.has("semantic") !== Boolean(request.semantic)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["semantic"],
      message: modes.has("semantic")
        ? "semantic mode requires one exact embedding profile"
        : "semantic configuration is forbidden when semantic mode is absent",
    });
  }
  for (const mode of Object.keys(request.fusion.weights) as SearchMode[]) {
    if (!modes.has(mode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fusion", "weights", mode],
        message: "fusion weights may name only requested modes",
      });
    }
  }
  if (modes.has("keyword") && !request.target.envelope && !request.target.internal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target"],
      message: "keyword mode requires envelope or internal targets",
    });
  }
  if (modes.has("keyword")) {
    try {
      compileViewSearchMatchExpression(request.query.text);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query", "text"],
        message: "keyword query must contain at least one searchable token",
      });
    }
  }
  if (modes.has("relation") && !request.target.related_views) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "related_views"],
      message: "relation mode requires related_views",
    });
  }
});

export type ExactSearchScope = z.infer<typeof ExactSearchScopeSchema>;
export type SearchTarget = z.infer<typeof SearchTargetSchema>;
export type ExactEmbeddingProfileRef = z.infer<typeof ExactEmbeddingProfileRefSchema>;
export type ExactRerankerDescriptor = z.infer<typeof ExactRerankerDescriptorSchema>;
export type SearchRequestV1 = z.infer<typeof SearchRequestV1Schema>;

export const SearchRepresentationCoordinatesSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("json_pointer"),
    path: JsonPointerSchema,
  }).strict(),
  z.object({
    kind: z.literal("table_cell"),
    path: JsonPointerSchema,
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    row_id: IdentifierSchema.optional(),
    column_id: IdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("graph_element"),
    path: JsonPointerSchema,
    element_kind: z.enum(["node", "edge"]),
    element_id: IdentifierSchema,
    property: JsonPointerSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("external_reference"),
    path: JsonPointerSchema,
  }).strict(),
]);

export const SearchMatchLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("envelope"), path: z.string().startsWith("/") }).strict(),
  z.object({
    kind: z.literal("representation"),
    path: z.string().startsWith("/"),
    element_id: IdentifierSchema.optional(),
    page: z.number().int().nonnegative().optional(),
    coordinates: SearchRepresentationCoordinatesSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("related_view"), ref: ExactViewRefSchema }).strict(),
]);

export const SearchMatchV1Schema = z.object({
  location: SearchMatchLocationSchema,
  snippet: z.string().max(512).optional(),
  value_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  modes: uniqueNonEmpty(SearchModeSchema, "match modes", 3),
  semantic_evidence_ref: ExactViewRefSchema.optional(),
}).strict();

export const SearchPathStepSchema = z.object({
  relation_id: IdentifierSchema,
  type: IdentifierSchema,
  from: ExactViewRefSchema,
  to: ExactViewRefSchema,
}).strict();

export const SearchHitV1Schema = z.object({
  ref: ExactViewRefSchema,
  owner_ref: ExactViewRefSchema,
  matched_schema: z.object({ name: IdentifierSchema, version: z.number().int().positive() }).strict(),
  representation_kind: IdentifierSchema,
  matches: z.array(SearchMatchV1Schema).min(1).max(128),
  path: z.array(SearchPathStepSchema).max(SEARCH_MAX_DEPTH).optional(),
  scores: z.object({
    keyword_rank: z.number().int().positive().optional(),
    semantic_rank: z.number().int().positive().optional(),
    relation_rank: z.number().int().positive().optional(),
    fused: z.number().finite().nonnegative(),
    reranker: z.number().finite().optional(),
  }).strict(),
  explanation: uniqueNonEmpty(z.enum(["keyword", "semantic", "relation", "reranked"]), "explanations", 4),
}).strict();

export const SearchModeOutcomeSchema = z.object({
  mode: SearchModeSchema,
  status: z.enum(["executed", "unavailable", "forbidden"]),
  candidate_count: z.number().int().nonnegative().max(SEARCH_MAX_CANDIDATES).optional(),
  code: IdentifierSchema.optional(),
}).strict().superRefine((outcome, context) => {
  if (outcome.status === "executed" && outcome.candidate_count === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidate_count"], message: "executed mode requires candidate_count" });
  }
  if (outcome.status !== "executed" && !outcome.code) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "skipped mode requires a code" });
  }
});

export const SearchResponseV1Schema = z.object({
  contract_version: z.literal(SEARCH_CONTRACT_VERSION),
  scope_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  strategy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  modes: z.array(SearchModeOutcomeSchema).min(1).max(3),
  hits: z.array(SearchHitV1Schema).max(SEARCH_MAX_PAGE_SIZE),
  next_cursor: z.string().trim().min(1).max(8_192).optional(),
}).strict();

export type SearchMatchLocation = z.infer<typeof SearchMatchLocationSchema>;
export type SearchRepresentationCoordinates = z.infer<typeof SearchRepresentationCoordinatesSchema>;
export type SearchMatchV1 = z.infer<typeof SearchMatchV1Schema>;
export type SearchPathStep = z.infer<typeof SearchPathStepSchema>;
export type SearchHitV1 = z.infer<typeof SearchHitV1Schema>;
export type SearchModeOutcome = z.infer<typeof SearchModeOutcomeSchema>;
export type SearchResponseV1 = z.infer<typeof SearchResponseV1Schema>;

export const SearchTraceEventSchema = z.object({
  type: z.enum([
    "search.started",
    "scope.resolved",
    "scope.failed",
    "mode.started",
    "mode.succeeded",
    "mode.unavailable",
    "mode.failed",
    "fusion.succeeded",
    "fusion.failed",
    "rerank.started",
    "rerank.succeeded",
    "rerank.failed",
    "search.succeeded",
    "search.failed",
  ]),
  request_id: IdentifierSchema,
  principal_id: IdentifierSchema,
  occurred_at: TimestampSchema,
  duration_ms: z.number().int().nonnegative(),
  scope_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  strategy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  mode: SearchModeSchema.optional(),
  count: z.number().int().nonnegative().max(SEARCH_MAX_CANDIDATES).optional(),
  code: IdentifierSchema.optional(),
  descriptor: z.object({ id: IdentifierSchema, revision: z.number().int().positive() }).strict().optional(),
}).strict().superRefine((event, context) => {
  if (event.type.startsWith("mode.") && !event.mode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: "mode event requires its exact mode" });
  }
  if ((event.type.endsWith(".failed") || event.type.endsWith(".unavailable")) && !event.code) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "failed or unavailable event requires a typed code" });
  }
  if (event.type === "scope.resolved" && (!event.scope_fingerprint || event.count === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "resolved scope requires fingerprint and count" });
  }
  if ((event.type === "mode.succeeded" || event.type === "fusion.succeeded" || event.type === "search.succeeded") && event.count === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "successful stage requires a bounded count" });
  }
});

export type SearchTraceEvent = z.infer<typeof SearchTraceEventSchema>;

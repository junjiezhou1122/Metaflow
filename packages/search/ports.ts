import { z } from "zod";
import { ExactViewRefSchema, IdentifierSchema, type ExactViewRef } from "@info/view";
import type {
  ExactEmbeddingProfileRef,
  ExactRerankerDescriptor,
  ExactSearchScope,
  SearchHitV1,
  SearchMode,
  SearchPathStep,
  SearchTarget,
  SearchTraceEvent,
} from "./contracts.js";
import { SearchMatchV1Schema, SearchPathStepSchema } from "./contracts.js";

export type SearchPrincipal = { id: string };

export const ViewReadAuthorizationDecisionSchema = z.object({
  ref: ExactViewRefSchema,
  status: z.enum(["allowed", "denied", "missing"]),
  code: IdentifierSchema.optional(),
}).strict();

export type ViewReadAuthorizationDecision = z.infer<typeof ViewReadAuthorizationDecisionSchema>;

export interface ViewReadAuthorizationPort {
  authorize(input: {
    principal: SearchPrincipal;
    refs: ExactViewRef[];
    purpose: "read" | "query" | "search" | "traverse" | "graph_project";
  }): Promise<ViewReadAuthorizationDecision[]>;
}

export type SearchRelationEdge = SearchPathStep;

export interface SearchScopeSource {
  listLatestExactRefs(input: {
    after_view_id?: string;
    limit: number;
  }): Promise<{ refs: ExactViewRef[]; next_after_view_id?: string }>;
  readRelations(input: {
    frontier: ExactViewRef[];
    direction: "incoming" | "outgoing" | "both";
    relation_types: string[];
  }): Promise<SearchRelationEdge[]>;
}

export type FrozenSearchNode = {
  ref: ExactViewRef;
  depth: number;
  path: SearchPathStep[];
};

export type FrozenSearchScope = {
  request: ExactSearchScope;
  nodes: FrozenSearchNode[];
  fingerprint: string;
};

export const SearchViewDescriptorSchema = z.object({
  ref: ExactViewRefSchema,
  schema: z.object({ name: IdentifierSchema, version: z.number().int().positive() }).strict(),
  representation_kind: IdentifierSchema,
}).strict();

export type SearchViewDescriptor = z.infer<typeof SearchViewDescriptorSchema>;

export interface SearchViewDescriptorReader {
  describe(refs: ExactViewRef[]): Promise<SearchViewDescriptor[]>;
}

export const RankedSearchCandidateSchema = z.object({
  ref: ExactViewRefSchema,
  owner_ref: ExactViewRefSchema,
  matched_schema: z.object({ name: IdentifierSchema, version: z.number().int().positive() }).strict(),
  representation_kind: IdentifierSchema,
  matches: z.array(SearchMatchV1Schema).min(1).max(128),
  path: z.array(SearchPathStepSchema).max(16).optional(),
}).strict();

export type RankedSearchCandidate = z.infer<typeof RankedSearchCandidateSchema>;

export interface KeywordRetriever {
  retrieve(input: {
    text: string;
    refs: ExactViewRef[];
    target: SearchTarget;
    candidate_limit: number;
  }): Promise<RankedSearchCandidate[]>;
}

export const QueryVectorSchema = z.object({
  values: z.array(z.number().finite()).min(1).max(4_096),
  dimension: z.number().int().positive().max(4_096),
  distance_metric: z.enum(["cosine", "l2"]),
}).strict().refine(vector => vector.values.length === vector.dimension, {
  message: "query vector dimension must equal its value count",
  path: ["dimension"],
});

export type QueryVector = z.infer<typeof QueryVectorSchema>;

export const RerankedSearchCandidateSchema = z.object({
  ref: ExactViewRefSchema,
  score: z.number().finite(),
}).strict();

export interface QueryEmbeddingPort {
  embed(input: { text: string; profile: ExactEmbeddingProfileRef }): Promise<QueryVector>;
}

export interface SemanticRetriever {
  retrieve(input: {
    vector: QueryVector;
    profile: ExactEmbeddingProfileRef;
    refs: ExactViewRef[];
    target: SearchTarget;
    candidate_limit: number;
  }): Promise<RankedSearchCandidate[]>;
}

export interface SearchReranker {
  rerank(input: {
    descriptor: ExactRerankerDescriptor;
    candidates: SearchHitV1[];
  }): Promise<Array<{ ref: ExactViewRef; score: number }>>;
}

export interface SearchObserver {
  record(event: SearchTraceEvent, cause?: unknown): Promise<void>;
}

export type SearchServiceDependencies = {
  authorization: ViewReadAuthorizationPort;
  scope_source: SearchScopeSource;
  descriptors: SearchViewDescriptorReader;
  keyword?: KeywordRetriever;
  semantic?: SemanticRetriever;
  query_embedding?: QueryEmbeddingPort;
  reranker?: SearchReranker;
  observer: SearchObserver;
  now?: () => string;
};

export type ModeCandidates = Partial<Record<SearchMode, RankedSearchCandidate[]>>;

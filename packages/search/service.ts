import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, ExactViewRefSchema, IdentifierSchema, type ExactViewRef } from "@info/view";
import {
  SEARCH_CONTRACT_VERSION,
  SEARCH_MAX_CANDIDATES,
  SearchRequestV1Schema,
  SearchResponseV1Schema,
  SearchTraceEventSchema,
  type SearchHitV1,
  type SearchMode,
  type SearchModeOutcome,
  type SearchPathStep,
  type SearchRequestV1,
  type SearchResponseV1,
  type SearchTraceEvent,
} from "./contracts.js";
import { decodeSearchCursor, encodeSearchCursor, sameSortTuple } from "./cursor.js";
import { SearchError, SearchModeOutcomeError, SearchModeUnavailableError } from "./errors.js";
import { fuseSearchCandidates, searchSortTuple } from "./fusion.js";
import {
  QueryVectorSchema,
  RankedSearchCandidateSchema,
  RerankedSearchCandidateSchema,
  SearchViewDescriptorSchema,
  ViewReadAuthorizationDecisionSchema,
} from "./ports.js";
import type {
  FrozenSearchNode,
  FrozenSearchScope,
  ModeCandidates,
  RankedSearchCandidate,
  SearchPrincipal,
  SearchRelationEdge,
  SearchServiceDependencies,
  SearchViewDescriptor,
  ViewReadAuthorizationDecision,
} from "./ports.js";

const SearchInvocationSchema = z.object({
  request_id: IdentifierSchema,
  principal: z.object({ id: IdentifierSchema }).strict(),
  request: SearchRequestV1Schema,
}).strict();

const ALL_VISIBLE_AUTHORIZATION_BATCH = 256;
const LatestRefsPageSchema = z.object({
  refs: z.array(ExactViewRefSchema).max(ALL_VISIBLE_AUTHORIZATION_BATCH),
  next_after_view_id: z.string().trim().min(1).optional(),
}).strict();

export class SearchService {
  private readonly now: () => string;

  constructor(private readonly dependencies: SearchServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async search(inputValue: {
    request_id: string;
    principal: SearchPrincipal;
    request: SearchRequestV1;
  }): Promise<SearchResponseV1> {
    let input: z.infer<typeof SearchInvocationSchema>;
    try {
      input = SearchInvocationSchema.parse(inputValue);
    } catch (cause) {
      throw new SearchError("Invalid Search invocation", "invalid_request", "validation", false, { cause });
    }

    const startedAt = this.now();
    const strategyFingerprint = fingerprintStrategy(input.request);
    await this.record({
      type: "search.started",
      request_id: input.request_id,
      principal_id: input.principal.id,
      occurred_at: startedAt,
      duration_ms: 0,
      strategy_fingerprint: strategyFingerprint,
    });

    let scopeFingerprint: string | undefined;
    try {
      const scope = await this.resolveScope(input.request.scope, input.principal);
      scopeFingerprint = scope.fingerprint;
      await this.record(this.event(input, startedAt, "scope.resolved", {
        scope_fingerprint: scope.fingerprint,
        strategy_fingerprint: strategyFingerprint,
        count: scope.nodes.length,
      }));

      const cursor = input.request.page.cursor ? decodeSearchCursor(input.request.page.cursor) : undefined;
      if (cursor && (cursor.scope_fingerprint !== scope.fingerprint || cursor.strategy_fingerprint !== strategyFingerprint)) {
        throw new SearchError("Search cursor does not belong to this request", "cursor_request_mismatch", "cursor");
      }

      const descriptors = await this.readDescriptors(scope);
      const { candidates, outcomes } = await this.executeModes(input, scope, descriptors, strategyFingerprint);
      let hits: SearchHitV1[];
      try {
        hits = fuseSearchCandidates({
          modes: input.request.modes,
          candidates,
          weights: input.request.fusion.weights,
          k: input.request.fusion.k,
        });
      } catch (cause) {
        await this.record(this.event(input, startedAt, "fusion.failed", {
          scope_fingerprint: scope.fingerprint,
          strategy_fingerprint: strategyFingerprint,
          code: searchError(cause, "fusion_failed", "fusion").code,
        }), cause);
        throw cause;
      }
      await this.record(this.event(input, startedAt, "fusion.succeeded", {
        scope_fingerprint: scope.fingerprint,
        strategy_fingerprint: strategyFingerprint,
        count: hits.length,
      }));

      if (input.request.reranker) {
        hits = await this.rerank(input, hits, startedAt, scope.fingerprint, strategyFingerprint);
      }

      const startIndex = cursor ? findCursorIndex(hits, cursor.last) + 1 : 0;
      const pageHits = hits.slice(startIndex, startIndex + input.request.page.limit);
      const hasMore = startIndex + pageHits.length < hits.length;
      const last = pageHits.at(-1);
      const response = SearchResponseV1Schema.parse({
        contract_version: SEARCH_CONTRACT_VERSION,
        scope_fingerprint: scope.fingerprint,
        strategy_fingerprint: strategyFingerprint,
        modes: outcomes,
        hits: pageHits,
        ...(hasMore && last ? {
          next_cursor: encodeSearchCursor({
            version: 1,
            scope_fingerprint: scope.fingerprint,
            strategy_fingerprint: strategyFingerprint,
            last: searchSortTuple(last),
          }),
        } : {}),
      });
      await this.record(this.event(input, startedAt, "search.succeeded", {
        scope_fingerprint: scope.fingerprint,
        strategy_fingerprint: strategyFingerprint,
        count: response.hits.length,
      }));
      return response;
    } catch (cause) {
      const error = searchError(cause, "retrieval_failed", "retrieval");
      const type = error.stage === "scope" || error.stage === "authorization" ? "scope.failed" : "search.failed";
      await this.record(this.event(input, startedAt, type, {
        ...(scopeFingerprint ? { scope_fingerprint: scopeFingerprint } : {}),
        strategy_fingerprint: strategyFingerprint,
        code: error.code,
      }), cause);
      if (type === "scope.failed") {
        await this.record(this.event(input, startedAt, "search.failed", {
          ...(scopeFingerprint ? { scope_fingerprint: scopeFingerprint } : {}),
          strategy_fingerprint: strategyFingerprint,
          code: error.code,
        }), cause);
      }
      throw error;
    }
  }

  private async resolveScope(request: SearchRequestV1["scope"], principal: SearchPrincipal): Promise<FrozenSearchScope> {
    if (request.kind === "exact_views") {
      const decisions = await this.authorize(principal, request.refs);
      const denied = decisions.find(decision => decision.status !== "allowed");
      if (denied) throw authorizationError(denied);
      return freezeScope(request, request.refs.map(ref => ({ ref, depth: 0, path: [] })));
    }

    if (request.kind === "all_visible") {
      const allowed: ExactViewRef[] = [];
      let afterViewId: string | undefined;
      do {
        let page: z.infer<typeof LatestRefsPageSchema>;
        try {
          page = LatestRefsPageSchema.parse(await this.dependencies.scope_source.listLatestExactRefs({
            ...(afterViewId ? { after_view_id: afterViewId } : {}),
            limit: ALL_VISIBLE_AUTHORIZATION_BATCH,
          }));
        } catch (cause) {
          throw searchError(cause, "scope_resolution_failed", "scope");
        }
        assertLatestRefPage(page, afterViewId);
        const decisions = await this.authorize(principal, page.refs);
        allowed.push(...decisions.filter(decision => decision.status === "allowed").map(decision => decision.ref));
        if (allowed.length > request.max_nodes) {
          throw new SearchError("Authorized all-visible scope exceeds max_nodes", "scope_limit_exceeded", "scope");
        }
        afterViewId = page.next_after_view_id;
      } while (afterViewId !== undefined);
      return freezeScope(request, allowed.sort(compareRefs).map(ref => ({ ref, depth: 0, path: [] })));
    }

    const rootDecisions = await this.authorize(principal, request.roots);
    const deniedRoot = rootDecisions.find(decision => decision.status !== "allowed");
    if (deniedRoot) throw authorizationError(deniedRoot);
    const nodes = new Map<string, FrozenSearchNode>();
    let frontier = request.roots.slice().sort(compareRefs);
    for (const ref of frontier) nodes.set(refKey(ref), { ref, depth: 0, path: [] });
    if (nodes.size > request.max_nodes) {
      throw new SearchError("Subgraph roots exceed max_nodes", "scope_limit_exceeded", "scope");
    }

    for (let depth = 1; depth <= request.max_depth && frontier.length > 0; depth += 1) {
      let edges: SearchRelationEdge[];
      try {
        edges = z.array(z.object({
          relation_id: IdentifierSchema,
          type: IdentifierSchema,
          from: ExactViewRefSchema,
          to: ExactViewRefSchema,
        }).strict()).parse(await this.dependencies.scope_source.readRelations({
          frontier,
          direction: request.direction,
          relation_types: request.relation_types,
        }));
      } catch (cause) {
        throw searchError(cause, "scope_resolution_failed", "scope");
      }
      const discoveries = new Map<string, { ref: ExactViewRef; path: SearchPathStep[] }>();
      for (const edge of edges.sort(compareEdges)) {
        const current = endpointIn(frontier, edge);
        if (!current) continue;
        const neighbor = sameRef(current, edge.from) ? edge.to : edge.from;
        if (nodes.has(refKey(neighbor))) continue;
        const parent = nodes.get(refKey(current));
        if (!parent) continue;
        const path = [...parent.path, edge];
        const key = refKey(neighbor);
        const existing = discoveries.get(key);
        if (!existing || canonicalJson(path) < canonicalJson(existing.path)) discoveries.set(key, { ref: neighbor, path });
      }
      if (discoveries.size === 0) break;
      const ordered = [...discoveries.values()].sort((left, right) => compareRefs(left.ref, right.ref));
      const decisions = await this.authorize(principal, ordered.map(item => item.ref));
      const decisionByRef = new Map(decisions.map(decision => [refKey(decision.ref), decision]));
      const next: ExactViewRef[] = [];
      for (const discovery of ordered) {
        if (decisionByRef.get(refKey(discovery.ref))?.status !== "allowed") continue;
        if (nodes.size >= request.max_nodes) {
          throw new SearchError("Authorized subgraph exceeds max_nodes", "scope_limit_exceeded", "scope");
        }
        nodes.set(refKey(discovery.ref), { ref: discovery.ref, depth, path: discovery.path });
        next.push(discovery.ref);
      }
      frontier = next;
    }
    return freezeScope(request, [...nodes.values()]);
  }

  private async authorize(principal: SearchPrincipal, refs: ExactViewRef[]): Promise<ViewReadAuthorizationDecision[]> {
    if (refs.length === 0) return [];
    let decisions: ViewReadAuthorizationDecision[];
    try {
      decisions = z.array(ViewReadAuthorizationDecisionSchema).parse(
        await this.dependencies.authorization.authorize({ principal, refs, purpose: "search" }),
      );
    } catch (cause) {
      throw searchError(cause, "view_read_forbidden", "authorization");
    }
    const expected = refs.map(refKey).sort();
    const actual = decisions.map(decision => refKey(ExactViewRefSchema.parse(decision.ref))).sort();
    if (canonicalJson(expected) !== canonicalJson(actual) || new Set(actual).size !== actual.length) {
      throw new SearchError("View read authorizer returned an incomplete or duplicate decision batch", "scope_resolution_failed", "authorization");
    }
    return decisions;
  }

  private async readDescriptors(scope: FrozenSearchScope): Promise<Map<string, SearchViewDescriptor>> {
    let descriptors: SearchViewDescriptor[];
    try {
      descriptors = z.array(SearchViewDescriptorSchema).parse(
        await this.dependencies.descriptors.describe(scope.nodes.map(node => node.ref)),
      );
    } catch (cause) {
      throw searchError(cause, "scope_stale", "scope");
    }
    const byRef = new Map(descriptors.map(descriptor => [refKey(descriptor.ref), descriptor]));
    if (byRef.size !== scope.nodes.length || scope.nodes.some(node => !byRef.has(refKey(node.ref)))) {
      throw new SearchError("Frozen Search scope changed before retrieval", "scope_stale", "scope");
    }
    return byRef;
  }

  private async executeModes(
    input: z.infer<typeof SearchInvocationSchema>,
    scope: FrozenSearchScope,
    descriptors: Map<string, SearchViewDescriptor>,
    strategyFingerprint: string,
  ): Promise<{ candidates: ModeCandidates; outcomes: SearchModeOutcome[] }> {
    const candidates: ModeCandidates = {};
    const outcomes: SearchModeOutcome[] = [];
    for (const mode of input.request.modes) {
      const modeStartedAt = this.now();
      await this.record(this.event(input, modeStartedAt, "mode.started", {
        scope_fingerprint: scope.fingerprint,
        strategy_fingerprint: strategyFingerprint,
        mode,
        ...(mode === "semantic" && input.request.semantic ? { descriptor: input.request.semantic.embedding_profile } : {}),
      }));
      try {
        const result = await this.executeMode(mode, input.request, scope, descriptors);
        if (result.length > SEARCH_MAX_CANDIDATES) {
          throw new SearchError(`${mode} retriever exceeded the candidate limit`, "retrieval_failed", "retrieval");
        }
        validateModeCandidates(mode, result, scope, descriptors);
        candidates[mode] = result;
        outcomes.push({ mode, status: "executed", candidate_count: uniqueCandidateCount(result) });
        await this.record(this.event(input, modeStartedAt, "mode.succeeded", {
          scope_fingerprint: scope.fingerprint,
          strategy_fingerprint: strategyFingerprint,
          mode,
          count: uniqueCandidateCount(result),
        }));
      } catch (cause) {
        if (cause instanceof SearchModeOutcomeError) {
          outcomes.push({ mode, status: cause.status, code: cause.code });
          await this.record(this.event(input, modeStartedAt, "mode.unavailable", {
            scope_fingerprint: scope.fingerprint,
            strategy_fingerprint: strategyFingerprint,
            mode,
            code: cause.code,
          }), cause);
          if (input.request.failure_mode === "allow_explicit_partial") continue;
          throw cause;
        }
        const error = searchError(cause, "retrieval_failed", "retrieval");
        await this.record(this.event(input, modeStartedAt, "mode.failed", {
          scope_fingerprint: scope.fingerprint,
          strategy_fingerprint: strategyFingerprint,
          mode,
          code: error.code,
        }), cause);
        throw error;
      }
    }
    return { candidates, outcomes };
  }

  private async executeMode(
    mode: SearchMode,
    request: SearchRequestV1,
    scope: FrozenSearchScope,
    descriptors: Map<string, SearchViewDescriptor>,
  ): Promise<RankedSearchCandidate[]> {
    const refs = scope.nodes.map(node => node.ref);
    if (mode === "keyword") {
      if (!this.dependencies.keyword) throw new SearchModeUnavailableError("mode_unavailable", "Keyword retriever is unavailable");
      return z.array(RankedSearchCandidateSchema).max(SEARCH_MAX_CANDIDATES).parse(
        await this.dependencies.keyword.retrieve({ text: request.query.text, refs, target: request.target, candidate_limit: SEARCH_MAX_CANDIDATES }),
      );
    }
    if (mode === "semantic") {
      if (!request.semantic || !this.dependencies.query_embedding || !this.dependencies.semantic) {
        throw new SearchModeUnavailableError("semantic_not_configured", "Semantic Search is not configured");
      }
      const vector = QueryVectorSchema.parse(
        await this.dependencies.query_embedding.embed({ text: request.query.text, profile: request.semantic.embedding_profile }),
      );
      return z.array(RankedSearchCandidateSchema).max(SEARCH_MAX_CANDIDATES).parse(await this.dependencies.semantic.retrieve({
        vector,
        profile: request.semantic.embedding_profile,
        refs,
        target: request.target,
        candidate_limit: SEARCH_MAX_CANDIDATES,
      }));
    }
    if (request.scope.kind === "all_visible") {
      throw new SearchModeUnavailableError("relation_scope_unsupported", "Relation ranking requires exact roots");
    }
    return scope.nodes
      .slice()
      .sort((left, right) => left.depth - right.depth || compareRefs(left.ref, right.ref) || canonicalJson(left.path).localeCompare(canonicalJson(right.path)))
      .map(node => {
        const descriptor = descriptors.get(refKey(node.ref));
        if (!descriptor) throw new SearchError("Missing descriptor for authorized relation candidate", "scope_stale", "scope");
        return {
          ref: node.ref,
          owner_ref: node.ref,
          matched_schema: descriptor.schema,
          representation_kind: descriptor.representation_kind,
          matches: [{
            location: { kind: "related_view", ref: node.ref },
            value_digest: digest(canonicalJson({ ref: node.ref, path: node.path })),
            modes: ["relation"],
          }],
          path: node.path,
        };
      });
  }

  private async rerank(
    input: z.infer<typeof SearchInvocationSchema>,
    hits: SearchHitV1[],
    startedAt: string,
    scopeFingerprint: string,
    strategyFingerprint: string,
  ): Promise<SearchHitV1[]> {
    const config = input.request.reranker!;
    if (!this.dependencies.reranker) {
      throw new SearchError("Requested reranker is not configured", "reranker_not_configured", "rerank");
    }
    const candidateCount = Math.min(config.candidate_limit, hits.length);
    const candidates = hits.slice(0, candidateCount);
    await this.record(this.event(input, startedAt, "rerank.started", {
      scope_fingerprint: scopeFingerprint,
      strategy_fingerprint: strategyFingerprint,
      count: candidates.length,
      descriptor: config.descriptor,
    }));
    try {
      const result = z.array(RerankedSearchCandidateSchema).max(config.candidate_limit).parse(
        await this.dependencies.reranker.rerank({ descriptor: config.descriptor, candidates }),
      );
      const expected = candidates.map(hit => refKey(hit.ref)).sort();
      const actual = result.map(item => refKey(item.ref)).sort();
      if (canonicalJson(expected) !== canonicalJson(actual) || new Set(actual).size !== actual.length || result.some(item => !Number.isFinite(item.score))) {
        throw new SearchError("Reranker must return one finite score for every candidate", "reranker_failed", "rerank");
      }
      const scoreByRef = new Map(result.map(item => [refKey(item.ref), item.score]));
      const reranked = candidates
        .map(hit => ({
          ...hit,
          scores: { ...hit.scores, reranker: scoreByRef.get(refKey(hit.ref))! },
          explanation: [...hit.explanation, "reranked" as const],
        }))
        .sort((left, right) => right.scores.reranker! - left.scores.reranker! || searchSortOrder(left, right));
      const output = [...reranked, ...hits.slice(candidateCount)];
      await this.record(this.event(input, startedAt, "rerank.succeeded", {
        scope_fingerprint: scopeFingerprint,
        strategy_fingerprint: strategyFingerprint,
        count: candidates.length,
        descriptor: config.descriptor,
      }));
      return output;
    } catch (cause) {
      const error = searchError(cause, "reranker_failed", "rerank");
      await this.record(this.event(input, startedAt, "rerank.failed", {
        scope_fingerprint: scopeFingerprint,
        strategy_fingerprint: strategyFingerprint,
        code: error.code,
        descriptor: config.descriptor,
      }), cause);
      throw error;
    }
  }

  private event(
    input: z.infer<typeof SearchInvocationSchema>,
    startedAt: string,
    type: SearchTraceEvent["type"],
    details: Partial<Omit<SearchTraceEvent, "type" | "request_id" | "principal_id" | "occurred_at" | "duration_ms">>,
  ): SearchTraceEvent {
    const occurredAt = this.now();
    return SearchTraceEventSchema.parse({
      type,
      request_id: input.request_id,
      principal_id: input.principal.id,
      occurred_at: occurredAt,
      duration_ms: Math.max(0, Date.parse(occurredAt) - Date.parse(startedAt)),
      ...details,
    });
  }

  private async record(event: SearchTraceEvent, cause?: unknown): Promise<void> {
    try {
      await this.dependencies.observer.record(SearchTraceEventSchema.parse(event), cause);
    } catch (observerCause) {
      throw new SearchError("Search observer failed", "observer_failed", "observer", false, { cause: observerCause });
    }
  }
}

function freezeScope(request: SearchRequestV1["scope"], nodesValue: FrozenSearchNode[]): FrozenSearchScope {
  const nodes = nodesValue.slice().sort((left, right) => compareRefs(left.ref, right.ref));
  return {
    request,
    nodes,
    fingerprint: digest(canonicalJson({ request, nodes })),
  };
}

function fingerprintStrategy(request: SearchRequestV1): string {
  return digest(canonicalJson({
    contract_version: request.contract_version,
    query_digest: digest(request.query.text.normalize("NFKC")),
    target: request.target,
    modes: request.modes,
    fusion: request.fusion,
    failure_mode: request.failure_mode,
    ...(request.semantic ? { semantic: request.semantic } : {}),
    ...(request.reranker ? { reranker: request.reranker } : {}),
  }));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorizationError(decision: ViewReadAuthorizationDecision): SearchError {
  if (decision.status === "missing") {
    return new SearchError(`Exact View ${refKey(decision.ref)} does not exist`, "view_not_found", "authorization");
  }
  return new SearchError(`Principal cannot read exact View ${refKey(decision.ref)}`, "view_read_forbidden", "authorization");
}

function endpointIn(frontier: ExactViewRef[], edge: SearchRelationEdge): ExactViewRef | undefined {
  return frontier.find(ref => sameRef(ref, edge.from) || sameRef(ref, edge.to));
}

function sameRef(left: ExactViewRef, right: ExactViewRef): boolean {
  return left.view_id === right.view_id && left.revision === right.revision;
}

function compareRefs(left: ExactViewRef, right: ExactViewRef): number {
  return left.view_id.localeCompare(right.view_id) || right.revision - left.revision;
}

function compareEdges(left: SearchRelationEdge, right: SearchRelationEdge): number {
  return left.relation_id.localeCompare(right.relation_id)
    || left.type.localeCompare(right.type)
    || compareRefs(left.from, right.from)
    || compareRefs(left.to, right.to);
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function uniqueCandidateCount(candidates: RankedSearchCandidate[]): number {
  return new Set(candidates.map(candidate => refKey(candidate.ref))).size;
}

function findCursorIndex(hits: SearchHitV1[], tuple: ReturnType<typeof searchSortTuple>): number {
  const index = hits.findIndex(hit => sameSortTuple(searchSortTuple(hit), tuple));
  if (index < 0) throw new SearchError("Search cursor boundary no longer exists", "cursor_stale", "cursor");
  return index;
}

function searchSortOrder(left: SearchHitV1, right: SearchHitV1): number {
  const a = searchSortTuple(left);
  const b = searchSortTuple(right);
  return b[0] - a[0] || a[1] - b[1] || a[2].localeCompare(b[2]) || b[3] - a[3] || a[4].localeCompare(b[4]);
}

function searchError(cause: unknown, code: ConstructorParameters<typeof SearchError>[1], stage: ConstructorParameters<typeof SearchError>[2]): SearchError {
  if (cause instanceof SearchError) return cause;
  return new SearchError(cause instanceof Error ? cause.message : "Search failed", code, stage, false, { cause });
}

function assertLatestRefPage(page: z.infer<typeof LatestRefsPageSchema>, previous: string | undefined): void {
  const ids = page.refs.map(ref => ref.view_id);
  if (new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
    || (previous !== undefined && ids.some(id => id <= previous))
    || (page.next_after_view_id !== undefined && page.next_after_view_id !== ids.at(-1))) {
    throw new SearchError("All-visible scope source returned an invalid page", "scope_resolution_failed", "scope");
  }
  if (page.refs.length === 0 && page.next_after_view_id !== undefined) {
    throw new SearchError("All-visible scope source returned a non-advancing page", "scope_resolution_failed", "scope");
  }
}

function validateModeCandidates(
  mode: SearchMode,
  candidates: RankedSearchCandidate[],
  scope: FrozenSearchScope,
  descriptors: Map<string, SearchViewDescriptor>,
): void {
  const authorized = new Set(scope.nodes.map(node => refKey(node.ref)));
  for (const candidate of candidates) {
    if (!authorized.has(refKey(candidate.ref)) || !authorized.has(refKey(candidate.owner_ref))) {
      throw new SearchError(`${mode} retriever returned a View outside the frozen authorized scope`, "retrieval_failed", "retrieval");
    }
    const descriptor = descriptors.get(refKey(candidate.ref));
    if (!descriptor || canonicalJson({
      schema: candidate.matched_schema,
      representation_kind: candidate.representation_kind,
    }) !== canonicalJson({
      schema: descriptor.schema,
      representation_kind: descriptor.representation_kind,
    })) {
      throw new SearchError(`${mode} retriever changed an immutable View descriptor`, "retrieval_failed", "retrieval");
    }
    if (candidate.matches.some(match => match.modes.length !== 1 || match.modes[0] !== mode)) {
      throw new SearchError(`${mode} retriever claimed evidence from another mode`, "retrieval_failed", "retrieval");
    }
    if (candidate.path?.some(step => !authorized.has(refKey(step.from)) || !authorized.has(refKey(step.to)))) {
      throw new SearchError(`${mode} retriever returned a path through an unauthorized View`, "retrieval_failed", "retrieval");
    }
  }
}

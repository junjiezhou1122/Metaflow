import { z } from "zod";
import {
  VIEW_GRAPH_MAX_SCANNED_EDGES,
  VIEW_GRAPH_RELATION_PAGE_SIZE,
  ViewGraphNodeSummarySchema,
  ViewGraphProjectionResultSchema,
  ViewGraphRelationPageSchema,
  ViewRepositoryError,
  canonicalJson,
  type ExactViewRef,
  type JsonObject,
  type ViewGraphFrontierReason,
  type ViewGraphProjectionEdge,
  type ViewGraphProjectionRequest,
  type ViewGraphProjectionResult,
  type ViewGraphProjectionSource,
  type ViewGraphRelationCursor,
  type ViewGraphRelationEdge,
} from "@info/view";
import {
  ViewReadAuthorizationDecisionSchema,
  type ViewReadAuthorizationDecision,
  type ViewReadAuthorizationPort,
} from "@info/search";

export type ViewGraphProjectionOperationErrorCode =
  | "view_graph_authorization_failed"
  | "view_graph_authorizer_invalid"
  | "view_graph_source_invalid"
  | "view_graph_scan_limit_exceeded"
  | "view_graph_projection_stale";

export class ViewGraphProjectionOperationError extends Error {
  constructor(
    message: string,
    readonly code: ViewGraphProjectionOperationErrorCode,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewGraphProjectionOperationError";
  }
}

type ProjectionNodeState = {
  ref: ExactViewRef;
  depth: number;
  path: string[];
};

type ProjectInput = {
  request: ViewGraphProjectionRequest;
  principal: { id: string };
  authorization: ViewReadAuthorizationPort;
  source: ViewGraphProjectionSource;
};

const AUTHORIZATION_BATCH_SIZE = 256;
const truncationOrder: ViewGraphFrontierReason[] = ["depth_limit", "node_limit", "edge_limit"];
const utf8Encoder = new TextEncoder();

export async function projectAuthorizedViewGraph(input: ProjectInput): Promise<ViewGraphProjectionResult> {
  const request = input.request;
  const roots = request.roots.slice().sort(compareRefs);
  const decisions = new Map<string, ViewReadAuthorizationDecision>();
  await authorizeRefs(input, roots, decisions);

  let redactedBoundary = roots.some(ref => decisions.get(refKey(ref))?.status !== "allowed");
  const nodes = new Map<string, ProjectionNodeState>();
  const frontier = new Map<string, { ref: ExactViewRef; reason: ViewGraphFrontierReason }>();
  const truncation = new Set<ViewGraphFrontierReason>();
  for (const ref of roots) {
    if (decisions.get(refKey(ref))?.status === "allowed") {
      if (nodes.size < request.max_nodes) {
        nodes.set(refKey(ref), { ref, depth: 0, path: [] });
      } else {
        truncation.add("node_limit");
        addFrontier(frontier, ref, "node_limit");
      }
    }
  }

  const edges = new Map<string, ViewGraphProjectionEdge>();
  const relationEvidence = new Map<string, string>();
  let current = [...nodes.values()].map(node => node.ref).sort(compareRefs);

  for (let depth = 0; depth < request.max_depth && current.length > 0; depth += 1) {
    const layerEdges = await readRelationLayer(input.source, request, current);
    const unknown = uniqueRefs(layerEdges.flatMap(edge => discoveryRefs(edge, current)))
      .filter(ref => !decisions.has(refKey(ref)));
    await authorizeRefs(input, unknown, decisions);
    if (unknown.some(ref => decisions.get(refKey(ref))?.status !== "allowed")) redactedBoundary = true;

    const next = new Map<string, ExactViewRef>();
    let edgeCapacityExhausted = edges.size >= request.max_edges;
    for (const edge of layerEdges) {
      const fingerprint = canonicalJson(edge);
      const previous = relationEvidence.get(edge.id);
      if (previous !== undefined && previous !== fingerprint) {
        throw sourceInvalid("Graph source reused one relation id for different exact evidence");
      }
      relationEvidence.set(edge.id, fingerprint);
      if (edges.has(edge.id)) continue;

      const activeRefs = activeEndpoints(edge, current);
      const discovered = discoveryRefs(edge, current);
      if (discovered.some(ref => decisions.get(refKey(ref))?.status !== "allowed")) {
        redactedBoundary = true;
        continue;
      }
      if (edgeCapacityExhausted) {
        truncation.add("edge_limit");
        for (const ref of activeRefs) addFrontier(frontier, ref, "edge_limit");
        continue;
      }

      const newRefs = discovered.filter(ref => !nodes.has(refKey(ref)));
      if (nodes.size + newRefs.length > request.max_nodes) {
        truncation.add("node_limit");
        for (const ref of activeRefs) addFrontier(frontier, ref, "node_limit");
        continue;
      }

      const parent = activeRefs
        .map(ref => nodes.get(refKey(ref)))
        .filter((value): value is ProjectionNodeState => value !== undefined)
        .sort(compareNodeStates)[0];
      if (!parent) throw sourceInvalid("Graph relation page did not retain an authorized traversal endpoint");
      for (const ref of newRefs) {
        const state = { ref, depth: depth + 1, path: [...parent.path, edge.id] };
        nodes.set(refKey(ref), state);
        next.set(refKey(ref), ref);
      }
      if (!nodes.has(refKey(edge.source)) || !nodes.has(refKey(edge.target))) {
        throw sourceInvalid("Graph edge endpoints were not present in the authorized projection");
      }
      edges.set(edge.id, { ...edge, depth: depth + 1 });
      if (edges.size >= request.max_edges) edgeCapacityExhausted = true;
    }
    current = [...next.values()].sort(compareRefs);
  }

  if (current.length > 0 && request.max_depth >= 0) {
    truncation.add("depth_limit");
    for (const ref of current) addFrontier(frontier, ref, "depth_limit");
  }

  const orderedStates = [...nodes.values()].sort(compareNodeStates);
  const summaries = await readAuthorizedSummaries(input.source, orderedStates.map(node => node.ref));
  const summaryByRef = new Map(summaries.map(summary => [refKey(summary.ref), summary]));
  const result = {
    projection_version: 1 as const,
    roots,
    nodes: orderedStates.map(state => ({
      ...summaryByRef.get(refKey(state.ref))!,
      depth: state.depth,
      path: state.path,
    })),
    edges: [...edges.values()].sort(compareProjectionEdges),
    frontier: [...frontier.values()].sort(compareFrontier),
    truncation: {
      truncated: truncation.size > 0,
      reasons: truncationOrder.filter(reason => truncation.has(reason)),
    },
    redacted_boundary: redactedBoundary,
  };
  return ViewGraphProjectionResultSchema.parse(result);
}

async function authorizeRefs(
  input: ProjectInput,
  refs: ExactViewRef[],
  decisions: Map<string, ViewReadAuthorizationDecision>,
): Promise<void> {
  for (let start = 0; start < refs.length; start += AUTHORIZATION_BATCH_SIZE) {
    const batch = refs.slice(start, start + AUTHORIZATION_BATCH_SIZE);
    let parsed: ViewReadAuthorizationDecision[];
    try {
      parsed = z.array(ViewReadAuthorizationDecisionSchema).parse(await input.authorization.authorize({
        principal: input.principal,
        refs: batch,
        purpose: "graph_project",
      }));
    } catch (cause) {
      throw new ViewGraphProjectionOperationError(
        "View graph read authorization failed",
        "view_graph_authorization_failed",
        {},
        { cause },
      );
    }
    const expected = batch.map(refKey).sort();
    const actual = parsed.map(decision => refKey(decision.ref)).sort();
    if (canonicalJson(expected) !== canonicalJson(actual) || new Set(actual).size !== actual.length) {
      throw new ViewGraphProjectionOperationError(
        "View graph authorizer returned an incomplete or duplicate decision batch",
        "view_graph_authorizer_invalid",
      );
    }
    for (const decision of parsed) decisions.set(refKey(decision.ref), decision);
  }
}

async function readRelationLayer(
  source: ViewGraphProjectionSource,
  request: ViewGraphProjectionRequest,
  frontier: ExactViewRef[],
): Promise<ViewGraphRelationEdge[]> {
  const edges: ViewGraphRelationEdge[] = [];
  const relationIds = new Set<string>();
  let after: ViewGraphRelationCursor | undefined;
  do {
    let page;
    try {
      page = ViewGraphRelationPageSchema.parse(await source.readGraphRelationPage({
        frontier,
        direction: request.direction,
        edge_types: request.edge_types,
        ...(after ? { after } : {}),
        limit: VIEW_GRAPH_RELATION_PAGE_SIZE,
      }));
    } catch (cause) {
      if (cause instanceof ViewRepositoryError) throw cause;
      if (cause instanceof ViewGraphProjectionOperationError) throw cause;
      throw sourceInvalid("Graph relation source returned an invalid page", cause);
    }
    validateRelationPage(page.edges, frontier, request, relationIds, after);
    edges.push(...page.edges);
    if (edges.length > VIEW_GRAPH_MAX_SCANNED_EDGES) {
      throw new ViewGraphProjectionOperationError(
        "View graph relation scan exceeded the fixed server limit",
        "view_graph_scan_limit_exceeded",
      );
    }
    if (page.next !== undefined) {
      const last = page.edges.at(-1);
      if (!last || canonicalJson(page.next) !== canonicalJson(cursorFor(last))) {
        throw sourceInvalid("Graph relation source returned a non-advancing cursor");
      }
    }
    after = page.next;
  } while (after !== undefined);
  return edges;
}

function validateRelationPage(
  edges: ViewGraphRelationEdge[],
  frontier: ExactViewRef[],
  request: ViewGraphProjectionRequest,
  relationIds: Set<string>,
  after: ViewGraphRelationCursor | undefined,
): void {
  const frontierKeys = new Set(frontier.map(refKey));
  const allowedTypes = new Set(request.edge_types);
  let previous = after ? edgeTupleFromCursor(after) : undefined;
  for (const edge of edges) {
    const sourceActive = frontierKeys.has(refKey(edge.source));
    const targetActive = frontierKeys.has(refKey(edge.target));
    const directionMatches = request.direction === "outgoing"
      ? sourceActive
      : request.direction === "incoming"
        ? targetActive
        : sourceActive || targetActive;
    const tuple = edgeTuple(edge);
    if (!allowedTypes.has(edge.type)
      || !directionMatches
      || relationIds.has(edge.id)
      || (previous !== undefined && compareTuples(previous, tuple) >= 0)) {
      throw sourceInvalid("Graph relation source returned evidence outside the exact bounded request");
    }
    relationIds.add(edge.id);
    previous = tuple;
  }
}

async function readAuthorizedSummaries(
  source: ViewGraphProjectionSource,
  refs: ExactViewRef[],
) {
  let summaries;
  try {
    summaries = z.array(ViewGraphNodeSummarySchema).parse(await source.readGraphNodeSummaries(refs));
  } catch (cause) {
    if (cause instanceof ViewRepositoryError) throw cause;
    throw sourceInvalid("Graph node summary source returned invalid evidence", cause);
  }
  const expected = refs.map(refKey).sort();
  const actual = summaries.map(summary => refKey(summary.ref)).sort();
  if (canonicalJson(expected) !== canonicalJson(actual) || new Set(actual).size !== actual.length) {
    throw new ViewGraphProjectionOperationError(
      "Authorized View graph changed before summary projection",
      "view_graph_projection_stale",
    );
  }
  return summaries;
}

function activeEndpoints(edge: ViewGraphRelationEdge, frontier: ExactViewRef[]): ExactViewRef[] {
  const keys = new Set(frontier.map(refKey));
  return uniqueRefs([edge.source, edge.target].filter(ref => keys.has(refKey(ref))));
}

function discoveryRefs(edge: ViewGraphRelationEdge, frontier: ExactViewRef[]): ExactViewRef[] {
  const keys = new Set(frontier.map(refKey));
  return uniqueRefs([edge.source, edge.target].filter(ref => !keys.has(refKey(ref))));
}

function addFrontier(
  frontier: Map<string, { ref: ExactViewRef; reason: ViewGraphFrontierReason }>,
  ref: ExactViewRef,
  reason: ViewGraphFrontierReason,
): void {
  frontier.set(`${reason}:${refKey(ref)}`, { ref, reason });
}

function sourceInvalid(message: string, cause?: unknown): ViewGraphProjectionOperationError {
  return new ViewGraphProjectionOperationError(message, "view_graph_source_invalid", {}, cause === undefined ? undefined : { cause });
}

function cursorFor(edge: ViewGraphRelationEdge): ViewGraphRelationCursor {
  return { type: edge.type, source: edge.source, target: edge.target, relation_id: edge.id };
}

function edgeTuple(edge: ViewGraphRelationEdge): Array<string | number> {
  return [edge.type, edge.source.view_id, edge.source.revision, edge.target.view_id, edge.target.revision, edge.id];
}

function edgeTupleFromCursor(cursor: ViewGraphRelationCursor): Array<string | number> {
  return [cursor.type, cursor.source.view_id, cursor.source.revision, cursor.target.view_id, cursor.target.revision, cursor.relation_id];
}

function compareTuples(left: Array<string | number>, right: Array<string | number>): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    const compared = typeof a === "number" && typeof b === "number" ? a - b : compareUtf8(String(a), String(b));
    if (compared !== 0) return compared;
  }
  return 0;
}

function compareRefs(left: ExactViewRef, right: ExactViewRef): number {
  return compareUtf8(left.view_id, right.view_id) || left.revision - right.revision;
}

function compareNodeStates(left: ProjectionNodeState, right: ProjectionNodeState): number {
  return left.depth - right.depth || compareRefs(left.ref, right.ref);
}

function compareProjectionEdges(left: ViewGraphProjectionEdge, right: ViewGraphProjectionEdge): number {
  return left.depth - right.depth || compareTuples(edgeTuple(left), edgeTuple(right));
}

function compareFrontier(
  left: { ref: ExactViewRef; reason: ViewGraphFrontierReason },
  right: { ref: ExactViewRef; reason: ViewGraphFrontierReason },
): number {
  return truncationOrder.indexOf(left.reason) - truncationOrder.indexOf(right.reason) || compareRefs(left.ref, right.ref);
}

function uniqueRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...new Map(refs.map(ref => [refKey(ref), ref])).values()].sort(compareRefs);
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const a = utf8Encoder.encode(left);
  const b = utf8Encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const compared = a[index]! - b[index]!;
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}

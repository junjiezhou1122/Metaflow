import {
  EXPLORER_DEFAULT_EDGE_TYPES,
  refKey,
  type ExactViewRef,
  type ExplorerOperation,
  type JsonValue,
  type OperationEnvelope,
  type View,
  type ViewGraphProjectionEdge,
  type ViewGraphProjectionNode,
  type ViewGraphProjectionResult,
} from "./contracts.js";
import type { OperationTransport } from "./operation-client.js";

export const FIXTURE_SIZES = [1, 10, 500, 2_000] as const;
export type FixtureSize = typeof FIXTURE_SIZES[number];
export const PERSONALIZED_FIXTURE_ID = "personalized" as const;
export type FixtureId = FixtureSize | typeof PERSONALIZED_FIXTURE_ID;

export const PERSONALIZED_VIEW_REFS = {
  application_space: { view_id: "view:fixture:view-explorer:personalized:application-space", revision: 1 },
  working_state: { view_id: "view:fixture:view-explorer:personalized:working-state", revision: 1 },
  codex_history: { view_id: "view:fixture:view-explorer:personalized:codex-history:session-001", revision: 1 },
  obsidian_view_model: { view_id: "view:fixture:view-explorer:personalized:obsidian-note:view-model", revision: 1 },
  obsidian_search_graph: { view_id: "view:fixture:view-explorer:personalized:obsidian-note:search-graph", revision: 1 },
  obsidian_connector_design: { view_id: "view:fixture:view-explorer:personalized:obsidian-note:connector-design", revision: 1 },
} as const satisfies Record<string, ExactViewRef>;

const CREATED_AT = "2026-07-27T08:00:00.000Z";
const EDGE_TYPES = EXPLORER_DEFAULT_EDGE_TYPES;

export type FixtureTransport = OperationTransport & {
  calls: Array<{ operation: ExplorerOperation; input: unknown }>;
};

export function parseFixtureSize(value: string | null): FixtureSize | undefined {
  const size = Number(value);
  return FIXTURE_SIZES.find(candidate => candidate === size);
}

export function parseFixtureId(value: string | null): FixtureId | undefined {
  if (value === PERSONALIZED_FIXTURE_ID) return PERSONALIZED_FIXTURE_ID;
  return parseFixtureSize(value);
}

export function fixtureRoot(fixture: FixtureId): ExactViewRef {
  return fixture === PERSONALIZED_FIXTURE_ID ? PERSONALIZED_VIEW_REFS.application_space : fixtureRef(0);
}

export function createFixtureTransport(fixture: FixtureId): FixtureTransport {
  const full = fixture === PERSONALIZED_FIXTURE_ID ? makePersonalizedProjection() : makeFixtureProjection(fixture);
  const views = fixture === PERSONALIZED_FIXTURE_ID ? makePersonalizedViews() : undefined;
  const calls: Array<{ operation: ExplorerOperation; input: unknown }> = [];
  return {
    calls,
    async call(operation, input, signal): Promise<OperationEnvelope> {
      if (signal.aborted) throw signal.reason;
      calls.push({ operation, input: structuredClone(input) });
      const request_id = `fixture-request-${calls.length}`;
      if (operation === "view.graph.project") {
        const request = (input as { request?: { roots?: ExactViewRef[]; edge_types?: string[]; direction?: string; max_depth?: number } }).request;
        const root = request?.roots?.[0];
        const data = root && refKey(root) !== refKey(full.roots[0]!)
          ? expansionProjection(full.nodes.find(node => refKey(node.ref) === refKey(root)) ?? makeExpandedNode(root), request?.edge_types ?? [...EDGE_TYPES])
          : filterProjection(full, request?.edge_types ?? [...EDGE_TYPES], request?.direction ?? "both", request?.max_depth ?? 2);
        return { ok: true, request_id, operation, data };
      }
      if (operation === "view.get") {
        const ref = (input as { ref?: ExactViewRef }).ref;
        const node = ref ? full.nodes.find(candidate => refKey(candidate.ref) === refKey(ref)) : undefined;
        const data = ref ? views?.get(refKey(ref)) : undefined;
        const resolved = data ?? makeFixtureView(node ?? makeExpandedNode(ref ?? full.roots[0]!));
        return { ok: true, request_id, operation, data: resolved };
      }
      const text = String((input as { request?: { query?: { text?: string } } }).request?.query?.text ?? "").toLowerCase();
      const matches = full.nodes.filter(node => `${node.name} ${node.schema.name} ${node.ref.view_id}`.toLowerCase().includes(text)).slice(0, 20);
      return {
        ok: true,
        request_id,
        operation,
        data: {
          contract_version: 1,
          scope_fingerprint: "a".repeat(64),
          strategy_fingerprint: "b".repeat(64),
          modes: [{ mode: "keyword", status: "executed", candidate_count: matches.length }],
          hits: matches.map((node, index) => ({
            ref: node.ref,
            owner_ref: node.ref,
            matched_schema: node.schema,
            representation_kind: node.representation.kind,
            matches: [{ location: { kind: "envelope", path: "/name" }, value_digest: String(index.toString(16)).padStart(64, "0"), modes: ["keyword"] }],
            scores: { keyword_rank: index + 1, fused: 1 / (61 + index) },
            explanation: ["keyword"],
          })),
        },
      };
    },
  };
}

export function makePersonalizedProjection(): ViewGraphProjectionResult {
  const refs = PERSONALIZED_VIEW_REFS;
  const relations = {
    working: "personalized:application:working-state",
    codex: "personalized:application:codex-history",
    viewModel: "personalized:application:obsidian-view-model",
    searchGraph: "personalized:application:obsidian-search-graph",
    connectorDesign: "personalized:application:obsidian-connector-design",
  } as const;
  const inputs = [
    [relations.codex, refs.codex_history, "Synthetic Codex Architecture Session", "codex.history.session", "json"],
    [relations.viewModel, refs.obsidian_view_model, "View Model Decisions", "obsidian.markdown.note", "markdown"],
    [relations.searchGraph, refs.obsidian_search_graph, "Search and Graph Notes", "obsidian.markdown.note", "markdown"],
    [relations.connectorDesign, refs.obsidian_connector_design, "Connector Design Notes", "obsidian.markdown.note", "markdown"],
  ] as const;
  const nodes: ViewGraphProjectionNode[] = [
    personalizedNode(refs.application_space, "Personal Knowledge Workspace", "Keep useful exact Views in one immutable Application Space", "metaflow.application_space", "derived", "graph", 0, []),
    personalizedNode(refs.working_state, "Metaflow Implementation Working State", "Reconcile code-reflected decisions, wiki-only decisions, and contradictions", "personalized.working_state", "derived", "json", 1, [relations.working]),
    ...inputs.map(([edgeId, ref, name, schema, representation]) => personalizedNode(ref, name, "Synthetic source evidence for personalized workflow acceptance", schema, "raw", representation, 1, [edgeId])),
  ];
  const edges: ViewGraphProjectionEdge[] = [
    { id: relations.working, type: "application_composition", source: refs.application_space, target: refs.working_state, depth: 1 },
    ...inputs.map(([edgeId, ref]) => ({ id: edgeId, type: "application_member", source: refs.application_space, target: ref, depth: 1 })),
    ...inputs.map(([, ref], index) => ({ id: `personalized:working-state:input:${index + 1}`, type: "derived_from", source: refs.working_state, target: ref, depth: 2 })),
  ];
  return {
    projection_version: 1,
    roots: [refs.application_space],
    nodes,
    edges,
    frontier: [],
    truncation: { truncated: false, reasons: [] },
    redacted_boundary: false,
  };
}

export function makeFixtureProjection(size: FixtureSize): ViewGraphProjectionResult {
  const nodes: ViewGraphProjectionNode[] = [];
  const edges: ViewGraphProjectionEdge[] = [];
  for (let index = 0; index < size; index += 1) {
    const ref = fixtureRef(index);
    if (index === 0) {
      nodes.push(makeNode(ref, index, 0, []));
      continue;
    }
    const parentIndex = index <= 48 ? 0 : 1 + ((index - 49) % Math.min(48, size - 1));
    const parent = nodes[parentIndex]!;
    const relationId = `fixture-edge-${index}`;
    const type = EDGE_TYPES[index % EDGE_TYPES.length]!;
    edges.push({ id: relationId, type, source: parent.ref, target: ref, depth: parent.depth + 1 });
    nodes.push(makeNode(ref, index, parent.depth + 1, [...parent.path, relationId]));
    if (index > 4 && index % 3 === 0) {
      edges.push({
        id: `fixture-cross-${index}`,
        type: EDGE_TYPES[(index + 1) % EDGE_TYPES.length]!,
        source: nodes[Math.max(0, index - 3)]!.ref,
        target: ref,
        depth: Math.max(1, parent.depth + 1),
      });
    }
  }
  const truncated = size === 2_000;
  return {
    projection_version: 1,
    roots: [fixtureRef(0)],
    nodes,
    edges,
    frontier: truncated ? nodes.slice(-8).map(node => ({ ref: node.ref, reason: "node_limit" as const })) : [],
    truncation: { truncated, reasons: truncated ? ["node_limit"] : [] },
    redacted_boundary: size >= 500,
  };
}

function filterProjection(full: ViewGraphProjectionResult, types: string[], direction: string, maxDepth: number): ViewGraphProjectionResult {
  const allowedTypes = new Set(types);
  const nodeByRef = new Map(full.nodes.map(node => [refKey(node.ref), node]));
  const rootKey = refKey(full.roots[0]!);
  const states = new Map<string, { depth: number; path: string[] }>([[rootKey, { depth: 0, path: [] }]]);
  const returnedEdges = new Map<string, ViewGraphProjectionEdge>();
  let current = new Set([rootKey]);
  for (let depth = 0; depth < maxDepth && current.size > 0; depth += 1) {
    const next = new Set<string>();
    for (const edge of full.edges) {
      if (!allowedTypes.has(edge.type)) continue;
      const source = refKey(edge.source);
      const target = refKey(edge.target);
      const traversals: Array<[string, string]> = [];
      if (direction !== "incoming" && current.has(source)) traversals.push([source, target]);
      if (direction !== "outgoing" && current.has(target)) traversals.push([target, source]);
      for (const [from, to] of traversals) {
        const parent = states.get(from)!;
        if (!states.has(to)) {
          states.set(to, { depth: depth + 1, path: [...parent.path, edge.id] });
          next.add(to);
        }
        returnedEdges.set(edge.id, { ...edge, depth: Math.max(1, depth + 1) });
      }
    }
    current = next;
  }
  const nodes = [...states].map(([key, state]) => ({ ...nodeByRef.get(key)!, ...state }));
  const nodeRefs = new Set(nodes.map(node => refKey(node.ref)));
  const edges = [...returnedEdges.values()].filter(edge => nodeRefs.has(refKey(edge.source)) && nodeRefs.has(refKey(edge.target)));
  const edgeIds = new Set(edges.map(edge => edge.id));
  for (const node of nodes) {
    if (node.path.some(id => !edgeIds.has(id))) throw new Error("Fixture traversal omitted a path relation");
  }
  return {
    ...full,
    nodes,
    edges,
    frontier: full.frontier.filter(item => nodeRefs.has(refKey(item.ref))),
  };
}

function expansionProjection(rootNode: ViewGraphProjectionNode, types: string[]): ViewGraphProjectionResult {
  const root = rootNode.ref;
  const expandedRef = { view_id: `${root.view_id}:expanded`, revision: 1 };
  const edge = { id: `expanded-edge-${root.view_id.replaceAll(":", "-")}`, type: types[0] ?? "references", source: root, target: expandedRef, depth: 1 };
  return {
    projection_version: 1,
    roots: [root],
    nodes: [{ ...rootNode, depth: 0, path: [] }, makeNode(expandedRef, 9_999, 1, [edge.id])],
    edges: [edge],
    frontier: [],
    truncation: { truncated: false, reasons: [] },
    redacted_boundary: false,
  };
}

function fixtureRef(index: number): ExactViewRef {
  return { view_id: `view:fixture:${String(index).padStart(4, "0")}`, revision: 1 + (index % 3) };
}

function makeExpandedNode(ref: ExactViewRef): ViewGraphProjectionNode {
  return makeNode(ref, 9_998, 0, []);
}

function makeNode(ref: ExactViewRef, index: number, depth: number, path: string[]): ViewGraphProjectionNode {
  const raw = index % 5 === 0;
  return {
    ref,
    name: index === 0 ? "Application Space" : `Research View ${String(index).padStart(4, "0")}`,
    purpose: index === 0 ? "Organize exact Views in one application-owned space" : `Preserve bounded fixture evidence for graph node ${index}`,
    schema: { name: index === 0 ? "metaflow.application_space" : `research.${["note", "source", "claim", "artifact"][index % 4]}`, version: 1 },
    role: raw ? "raw" : "derived",
    time: { ...(raw ? { observed_at: CREATED_AT } : {}), created_at: CREATED_AT },
    representation: { kind: index % 4 === 0 ? "markdown" : "json", media_type: index % 4 === 0 ? "text/markdown" : "application/json" },
    depth,
    path,
  };
}

export function makeFixtureView(node: ViewGraphProjectionNode): View {
  const raw = node.role === "raw";
  return {
    id: node.ref.view_id,
    revision: node.ref.revision,
    name: node.name,
    purpose: node.purpose,
    aliases: [],
    schema: { ...node.schema, mode: "freeform" },
    role: node.role,
    time: node.time,
    representation: { form: "inline", kind: node.representation.kind, ...(node.representation.media_type ? { media_type: node.representation.media_type } : {}), value: { fixture: true, ref: refKey(node.ref) }, metadata: {} },
    materialization: { primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } }, alternatives: [] },
    relations: [],
    provenance: raw ? {
      inputs: [], actor: "capture-ingress", capture: { connector: "fixture", connection_id: "fixture:default", source_id: node.ref.view_id, source_kind: "fixture", identity: "stable_source", assertion: "direct" },
    } : { inputs: node.depth > 0 ? [{ view_id: "view:fixture:0000", revision: 1 }] : [], actor: "operator:fixture", operator_run_id: "run:fixture" },
    policy: { owner: "user:fixture", visibility: "private", privacy: "private", retention: "normal", allow_external_model: false, allow_embedding: false, allow_local_search: true, labels: [] },
    metadata: {},
  };
}

function makePersonalizedViews(): Map<string, View> {
  const projection = makePersonalizedProjection();
  const inputRefs = [
    PERSONALIZED_VIEW_REFS.codex_history,
    PERSONALIZED_VIEW_REFS.obsidian_view_model,
    PERSONALIZED_VIEW_REFS.obsidian_search_graph,
    PERSONALIZED_VIEW_REFS.obsidian_connector_design,
  ];
  return new Map(projection.nodes.map(node => {
    const raw = node.role === "raw";
    const isWorkingState = refKey(node.ref) === refKey(PERSONALIZED_VIEW_REFS.working_state);
    const value: JsonValue = isWorkingState ? {
      code_reflected_decisions: ["Exact View revisions remain immutable evidence"],
      wiki_only_decisions: ["Parser Workers form bounded searchable fragments"],
      contradictions: ["One synthetic decision requires explicit reconciliation"],
      sources: inputRefs.map(refKey),
    } : refKey(node.ref) === refKey(PERSONALIZED_VIEW_REFS.application_space) ? {
      entries: projection.nodes.slice(1).map(candidate => refKey(candidate.ref)),
    } : {
      synthetic: true,
      source_kind: node.schema.name === "codex.history.session" ? "codex_history" : "obsidian_markdown",
      title: node.name,
    };
    const view: View = {
      ...makeFixtureView(node),
      representation: {
        form: "inline",
        kind: node.representation.kind,
        ...(node.representation.media_type ? { media_type: node.representation.media_type } : {}),
        value,
        metadata: { fixture: PERSONALIZED_FIXTURE_ID },
      },
      provenance: raw ? {
        inputs: [],
        actor: "capture-ingress",
        capture: {
          connector: node.schema.name === "codex.history.session" ? "codex-history" : "obsidian",
          connection_id: node.schema.name === "codex.history.session" ? "fixture:codex-history" : "fixture:obsidian",
          source_id: node.ref.view_id,
          source_kind: "synthetic_fixture",
          identity: "stable_source",
          assertion: "direct",
        },
      } : {
        inputs: isWorkingState ? inputRefs : projection.nodes.slice(1).map(candidate => candidate.ref),
        actor: isWorkingState ? "operator:personalized-working-state" : "operator:application-space",
        operator_run_id: isWorkingState ? "run:personalized-working-state:001" : "run:personalized-application-space:001",
      },
    };
    return [refKey(node.ref), view];
  }));
}

function personalizedNode(
  ref: ExactViewRef,
  name: string,
  purpose: string,
  schemaName: string,
  role: ViewGraphProjectionNode["role"],
  representationKind: string,
  depth: number,
  path: string[],
): ViewGraphProjectionNode {
  return {
    ref,
    name,
    purpose,
    schema: { name: schemaName, version: 1 },
    role,
    time: { ...(role === "raw" ? { observed_at: CREATED_AT } : {}), created_at: CREATED_AT },
    representation: {
      kind: representationKind,
      media_type: representationKind === "markdown" ? "text/markdown" : "application/json",
    },
    depth,
    path,
  };
}

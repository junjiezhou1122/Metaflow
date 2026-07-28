import type Graph from "graphology";

const FOCUSED_COLOR = "#6558d9";
const NEIGHBOR_COLOR = "#505553";
const MUTED_NODE_COLOR = "#d9dcda";
const MUTED_EDGE_COLOR = "#e5e7e5";

export type GraphAppearanceState = {
  selectedKey?: string | undefined;
  hoveredKey?: string | undefined;
};

export function assertGraphNodeLoaded(graph: Graph, key: string): void {
  if (!graph.hasNode(key)) throw new Error(`Sigma entered missing graph node ${key}`);
}

type DisplayAttributes = Record<string, unknown> & {
  color?: string;
  forceLabel?: boolean;
  hidden?: boolean;
  highlighted?: boolean;
  label?: string;
  relationType?: string;
  size?: number;
  zIndex?: number;
};

export function reduceNodeAppearance<T extends DisplayAttributes>(
  graph: Graph,
  key: string,
  attributes: T,
  state: GraphAppearanceState,
): T {
  const { active, hovered } = resolveActiveNode(graph, state);
  if (!active) return attributes;

  if (key === active) {
    return {
      ...attributes,
      color: FOCUSED_COLOR,
      forceLabel: true,
      highlighted: true,
      zIndex: hovered ? 3 : 2,
      size: Number(attributes.size) * (hovered ? 1.55 : 1.5),
    };
  }
  if (graph.areNeighbors(key, active)) {
    return hovered
      ? { ...attributes, color: NEIGHBOR_COLOR, zIndex: 2, size: Number(attributes.size) * 1.12 }
      : { ...attributes, color: NEIGHBOR_COLOR, zIndex: 1 };
  }
  return { ...attributes, color: MUTED_NODE_COLOR, label: "", zIndex: 0 };
}

export function reduceEdgeAppearance<T extends DisplayAttributes>(
  graph: Graph,
  key: string,
  attributes: T,
  state: GraphAppearanceState,
): T {
  const { active, hovered } = resolveActiveNode(graph, state);
  if (!active || !graph.hasEdge(key)) return attributes;

  const [source, target] = graph.extremities(key);
  if (source === active || target === active) {
    return {
      ...attributes,
      color: FOCUSED_COLOR,
      size: hovered ? 1.9 : 1.65,
      zIndex: hovered ? 2 : 1,
    };
  }
  return { ...attributes, color: MUTED_EDGE_COLOR, hidden: false, size: 0.3, zIndex: 0 };
}

function resolveActiveNode(graph: Graph, state: GraphAppearanceState): { active?: string; hovered?: string } {
  if (state.hoveredKey && graph.hasNode(state.hoveredKey)) return { active: state.hoveredKey, hovered: state.hoveredKey };
  if (state.selectedKey && graph.hasNode(state.selectedKey)) return { active: state.selectedKey };
  return {};
}

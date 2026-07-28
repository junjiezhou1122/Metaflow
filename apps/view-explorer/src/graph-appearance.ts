import type Graph from "graphology";

export const EDGE_COLORS: Record<string, string> = {
  derived_from: "#d86638",
  member_of: "#4878b7",
  references: "#7b6d61",
  application_member: "#2d8b72",
  application_composition: "#2d8b72",
};

export type GraphAppearanceState = {
  selectedKey?: string | undefined;
  hoveredKey?: string | undefined;
};

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
  const hovered = state.hoveredKey && graph.hasNode(state.hoveredKey) ? state.hoveredKey : undefined;
  const active = hovered ?? (state.selectedKey && graph.hasNode(state.selectedKey) ? state.selectedKey : undefined);
  if (!active) return attributes;

  if (key === active) {
    return {
      ...attributes,
      color: hovered ? "#0d594b" : "#e9ad31",
      forceLabel: true,
      highlighted: true,
      zIndex: hovered ? 3 : 2,
      size: Number(attributes.size) * (hovered ? 1.55 : 1.45),
    };
  }
  if (graph.areNeighbors(key, active)) {
    return hovered
      ? { ...attributes, forceLabel: true, zIndex: 2, size: Number(attributes.size) * 1.12 }
      : { ...attributes, zIndex: 1 };
  }
  return { ...attributes, color: "#c8cbc6", label: "", zIndex: 0 };
}

export function reduceEdgeAppearance<T extends DisplayAttributes>(
  graph: Graph,
  key: string,
  attributes: T,
  state: GraphAppearanceState,
): T {
  const hovered = state.hoveredKey && graph.hasNode(state.hoveredKey) ? state.hoveredKey : undefined;
  const active = hovered ?? (state.selectedKey && graph.hasNode(state.selectedKey) ? state.selectedKey : undefined);
  if (!active || !graph.hasEdge(key)) return attributes;

  const [source, target] = graph.extremities(key);
  if (source === active || target === active) {
    return {
      ...attributes,
      color: EDGE_COLORS[String(attributes.relationType)] ?? "#594f46",
      size: hovered ? 2.5 : 2.2,
      zIndex: hovered ? 2 : 1,
    };
  }
  return { ...attributes, color: "#dedfda", hidden: false, size: hovered ? 0.3 : 0.35, zIndex: 0 };
}

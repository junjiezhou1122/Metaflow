import { refKey, type ViewGraphProjectionResult } from "./contracts.js";

export type CameraState = { x: number; y: number; ratio: number; angle: number };

export class ProjectionMergeError extends Error {
  constructor(message: string, readonly code: "node_conflict" | "edge_conflict" | "capacity_exceeded") {
    super(message);
    this.name = "ProjectionMergeError";
  }
}

export function mergeProjection(
  current: ViewGraphProjectionResult,
  incoming: ViewGraphProjectionResult,
): ViewGraphProjectionResult {
  const nodes = new Map(current.nodes.map(node => [refKey(node.ref), node]));
  for (const node of incoming.nodes) {
    const key = refKey(node.ref);
    const previous = nodes.get(key);
    if (previous && stableSummary(previous) !== stableSummary(node)) {
      throw new ProjectionMergeError(`Projection reused exact View ${key} with conflicting summary evidence`, "node_conflict");
    }
    if (!previous) nodes.set(key, node);
  }
  const edges = new Map(current.edges.map(edge => [edge.id, edge]));
  for (const edge of incoming.edges) {
    const previous = edges.get(edge.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(edge)) {
      throw new ProjectionMergeError(`Projection reused relation ${edge.id} with conflicting evidence`, "edge_conflict");
    }
    if (!previous) edges.set(edge.id, edge);
  }
  if (nodes.size > 2_000 || edges.size > 10_000) {
    throw new ProjectionMergeError("Merged projection exceeded the fixed explorer capacity", "capacity_exceeded");
  }
  const frontier = new Map(current.frontier.map(item => [`${item.reason}:${refKey(item.ref)}`, item]));
  for (const item of incoming.frontier) frontier.set(`${item.reason}:${refKey(item.ref)}`, item);
  return {
    projection_version: 1,
    roots: current.roots,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    frontier: [...frontier.values()],
    truncation: {
      truncated: current.truncation.truncated || incoming.truncation.truncated,
      reasons: [...new Set([...current.truncation.reasons, ...incoming.truncation.reasons])],
    },
    redacted_boundary: current.redacted_boundary || incoming.redacted_boundary,
  };
}

function stableSummary(node: ViewGraphProjectionResult["nodes"][number]): string {
  return JSON.stringify({
    ref: node.ref,
    name: node.name,
    purpose: node.purpose,
    schema: node.schema,
    role: node.role,
    time: node.time,
    representation: node.representation,
  });
}

export function deterministicPosition(key: string, index: number, total: number): { x: number; y: number } {
  let hash = 2166136261;
  for (let offset = 0; offset < key.length; offset += 1) {
    hash ^= key.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 + ((hash >>> 0) % 997) / 997 * 0.12;
  const radius = 18 + Math.sqrt(index + 1) * 2.8;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/// <reference lib="webworker" />
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import { LAYOUT_PROTOCOL_VERSION, type LayoutRequest, type LayoutResponse } from "./layout-protocol.js";

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  try {
    const graph = new Graph({ multi: true, type: "directed", allowSelfLoops: false });
    for (const node of request.nodes) graph.addNode(node.key, { x: node.x, y: node.y, size: node.size });
    for (const edge of request.edges) {
      if (edge.source !== edge.target && !graph.hasEdge(edge.key)) graph.addDirectedEdgeWithKey(edge.key, edge.source, edge.target);
    }
    if (graph.order <= 1) {
      const response: LayoutResponse = {
        protocol_version: LAYOUT_PROTOCOL_VERSION,
        generation: request.generation,
        request_id: request.request_id,
        ok: true,
        positions: graph.mapNodes((key, attributes) => ({ key, x: Number(attributes.x), y: Number(attributes.y) })),
      };
      self.postMessage(response);
      return;
    }
    const iterations = graph.order > 1_000 ? 18 : graph.order > 100 ? 28 : 45;
    const forcePositions = forceAtlas2(graph, {
      iterations,
      settings: { ...forceAtlas2.inferSettings(graph), gravity: 0.08, scalingRatio: 8, barnesHutOptimize: graph.order > 250 },
    });
    for (const [key, position] of Object.entries(forcePositions)) graph.mergeNodeAttributes(key, position);
    const positions = noverlap(graph, { maxIterations: 32, settings: { margin: 4, ratio: 1.1, expansion: 1.08, gridSize: 20 } });
    const response: LayoutResponse = {
      protocol_version: LAYOUT_PROTOCOL_VERSION,
      generation: request.generation,
      request_id: request.request_id,
      ok: true,
      positions: request.nodes.map(node => ({ key: node.key, x: positions[node.key]!.x, y: positions[node.key]!.y })),
    };
    self.postMessage(response);
  } catch (error) {
    const response: LayoutResponse = {
      protocol_version: LAYOUT_PROTOCOL_VERSION,
      generation: request.generation,
      request_id: request.request_id,
      ok: false,
      message: error instanceof Error ? error.message : "Layout worker failed",
    };
    self.postMessage(response);
  }
};

export {};

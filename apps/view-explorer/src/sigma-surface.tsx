import { useEffect, useRef, useState } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { refKey, type ViewGraphProjectionResult } from "./contracts.js";
import { EDGE_COLORS, reduceEdgeAppearance, reduceNodeAppearance } from "./graph-appearance.js";
import { deterministicPosition, type CameraState } from "./graph-projection.js";
import {
  LAYOUT_PROTOCOL_VERSION,
  validateLayoutResponse,
  type LayoutRequest,
} from "./layout-protocol.js";

const SCHEMA_COLORS = ["#137a65", "#4263a9", "#a54835", "#9b6a17", "#7a4f91", "#39767d"];
type LayoutFailureCode = "graph_layout_worker_start_failed" | "graph_layout_worker_failed" | "graph_layout_protocol_failed";

type SigmaSurfaceProps = {
  projection: ViewGraphProjectionResult;
  selectedKey?: string;
  focusKey?: string;
  focusNodeKey?: string;
  cameraTarget?: CameraState & { nonce: number };
  forceWebglFailure?: boolean;
  onSelect(key: string, camera: CameraState): void;
  onCameraChange(camera: CameraState): void;
  onLayoutState(state: "running" | "ready" | "failed", message?: string, code?: LayoutFailureCode): void;
};

type ActiveLayoutWorker = {
  worker: Worker;
  onMessage: (event: MessageEvent<unknown>) => void;
  onError: (event: ErrorEvent) => void;
};

type DebugState = {
  sigmaCreated: number;
  sigmaKilled: number;
  workersCreated: number;
  workersTerminated: number;
  camera?: CameraState;
  focusedNode?: { key: string; x: number; y: number; width: number; height: number; visible: boolean };
  hoveredNeighborhood?: { key: string; neighborCount: number; incidentEdgeCount: number; unrelatedNodeCount: number; unrelatedEdgeCount: number } | undefined;
  hoverEnterCount?: number;
  hoverLeaveCount?: number;
  graph?: { nodes: number; edges: number; firstNode?: { x: number; y: number }; display?: unknown; dimensions?: unknown; graphDimensions?: unknown };
};

export default function SigmaSurface(props: SigmaSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | undefined>(undefined);
  const rendererRef = useRef<Sigma | undefined>(undefined);
  const workerRef = useRef<ActiveLayoutWorker | undefined>(undefined);
  const layoutGenerationRef = useRef(0);
  const hasRenderedProjectionRef = useRef(false);
  const selectedRef = useRef(props.selectedKey);
  const hoveredRef = useRef<string | undefined>(undefined);
  const cameraTargetRef = useRef(props.cameraTarget);
  const onSelectRef = useRef(props.onSelect);
  const onCameraRef = useRef(props.onCameraChange);
  const onLayoutRef = useRef(props.onLayoutState);
  const [failure, setFailure] = useState<string>();

  selectedRef.current = props.selectedKey;
  cameraTargetRef.current = props.cameraTarget;
  onSelectRef.current = props.onSelect;
  onCameraRef.current = props.onCameraChange;
  onLayoutRef.current = props.onLayoutState;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (props.forceWebglFailure) {
      setFailure("graph_webgl_unavailable");
      return;
    }
    let graph: Graph;
    let renderer: Sigma;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) {
        setFailure("graph_webgl_unavailable");
        return;
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      graph = new Graph({ multi: true, type: "directed", allowSelfLoops: false });
      renderer = new Sigma(graph, container, {
        allowInvalidContainer: false,
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 9,
        defaultNodeColor: "#4263a9",
        defaultEdgeColor: "#a7aaa5",
        nodeReducer: (key, attributes) => reduceNodeAppearance(graph, key, attributes, { selectedKey: selectedRef.current, hoveredKey: hoveredRef.current }),
        edgeReducer: (key, attributes) => reduceEdgeAppearance(graph, key, attributes, { selectedKey: selectedRef.current, hoveredKey: hoveredRef.current }),
      });
    } catch (error) {
      setFailure("graph_webgl_unavailable");
      reportDebugError(error);
      return;
    }
    graphRef.current = graph;
    rendererRef.current = renderer;
    debug().sigmaCreated += 1;
    const camera = renderer.getCamera();
    const click = ({ node }: { node: string }) => onSelectRef.current(node, camera.getState());
    const enterNode = ({ node }: { node: string }) => {
      if (!graph.hasNode(node)) return;
      hoveredRef.current = node;
      const incidentEdgeCount = graph.edges(node).length;
      const neighborCount = graph.neighbors(node).length;
      const state = debug();
      state.hoverEnterCount = (state.hoverEnterCount ?? 0) + 1;
      state.hoveredNeighborhood = {
        key: node,
        neighborCount,
        incidentEdgeCount,
        unrelatedNodeCount: Math.max(0, graph.order - neighborCount - 1),
        unrelatedEdgeCount: Math.max(0, graph.size - incidentEdgeCount),
      };
      renderer.scheduleRefresh();
    };
    const leaveNode = ({ node }: { node: string }) => {
      if (hoveredRef.current !== node) return;
      hoveredRef.current = undefined;
      const state = debug();
      state.hoverLeaveCount = (state.hoverLeaveCount ?? 0) + 1;
      state.hoveredNeighborhood = undefined;
      renderer.scheduleRefresh();
    };
    const cameraUpdated = () => {
      const state = camera.getState();
      debug().camera = state;
      if (validCamera(state)) onCameraRef.current(state);
    };
    renderer.on("clickNode", click);
    renderer.on("enterNode", enterNode);
    renderer.on("leaveNode", leaveNode);
    camera.on("updated", cameraUpdated);
    return () => {
      disposeWorker(workerRef);
      camera.off("updated", cameraUpdated);
      renderer.off("clickNode", click);
      renderer.off("enterNode", enterNode);
      renderer.off("leaveNode", leaveNode);
      hoveredRef.current = undefined;
      renderer.kill();
      debug().sigmaKilled += 1;
      rendererRef.current = undefined;
      graphRef.current = undefined;
    };
  }, [props.forceWebglFailure]);

  useEffect(() => {
    const graph = graphRef.current;
    const renderer = rendererRef.current;
    if (!graph || !renderer) return;
    disposeWorker(workerRef);
    hoveredRef.current = undefined;
    debug().hoveredNeighborhood = undefined;
    graph.clear();
    const total = props.projection.nodes.length;
    props.projection.nodes.forEach((node, index) => {
      const key = refKey(node.ref);
      const position = deterministicPosition(key, index, total);
      graph.addNode(key, {
        ...position,
        type: "circle",
        label: node.name,
        color: schemaColor(node.schema.name),
        size: node.role === "raw" ? 4.2 : 5.4,
        borderColor: node.role === "raw" ? "#1c2521" : "transparent",
        schema: node.schema.name,
      });
    });
    for (const edge of props.projection.edges) {
      const source = refKey(edge.source);
      const target = refKey(edge.target);
      if (graph.hasNode(source) && graph.hasNode(target) && !graph.hasEdge(edge.id)) {
        graph.addDirectedEdgeWithKey(edge.id, source, target, {
          type: "line",
          relationType: edge.type,
          color: EDGE_COLORS[edge.type] ?? "#8c8f89",
          size: 0.7,
        });
      }
    }
    const restoredCamera = cameraTargetRef.current;
    if (restoredCamera) {
      applyAuthoritativeCamera(renderer, restoredCamera);
    } else if (!hasRenderedProjectionRef.current) {
      renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    }
    hasRenderedProjectionRef.current = true;
    renderer.refresh();
    debug().camera = renderer.getCamera().getState();
    const firstNode = graph.nodes()[0];
    debug().graph = {
      nodes: graph.order,
      edges: graph.size,
      ...(firstNode ? { firstNode: { x: Number(graph.getNodeAttribute(firstNode, "x")), y: Number(graph.getNodeAttribute(firstNode, "y")) } } : {}),
      ...(firstNode ? { display: renderer.getNodeDisplayData(firstNode) } : {}),
      dimensions: renderer.getDimensions(),
      graphDimensions: renderer.getGraphDimensions(),
    };

    const generation = ++layoutGenerationRef.current;
    const requestId = `layout-${generation}`;
    const nodeKeys = new Set(graph.nodes());
    const request: LayoutRequest = {
      protocol_version: LAYOUT_PROTOCOL_VERSION,
      generation,
      request_id: requestId,
      nodes: graph.mapNodes((key, attributes) => ({ key, x: Number(attributes.x), y: Number(attributes.y), size: Number(attributes.size) })),
      edges: graph.mapEdges((key, _attributes, source, target) => ({ key, source, target })),
    };
    onLayoutRef.current("running");
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module", name: "metaflow-view-layout" });
      debug().workersCreated += 1;
      let active: ActiveLayoutWorker;
      const fail = (code: LayoutFailureCode, message: string) => {
        if (workerRef.current !== active) return;
        onLayoutRef.current("failed", message, code);
        disposeWorker(workerRef, active);
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (workerRef.current !== active) return;
        let result;
        try {
          result = validateLayoutResponse(event.data, { generation, request_id: requestId, node_keys: nodeKeys });
        } catch (error) {
          fail("graph_layout_protocol_failed", error instanceof Error ? error.message : "Layout worker response validation failed");
          return;
        }
        if (result.status === "stale") return;
        if (result.status === "failed") {
          fail("graph_layout_worker_failed", result.message);
          return;
        }
        for (const position of result.positions) graph.mergeNodeAttributes(position.key, { x: position.x, y: position.y });
        renderer.refresh();
        const currentRestoredCamera = cameraTargetRef.current;
        if (currentRestoredCamera) applyAuthoritativeCamera(renderer, currentRestoredCamera);
        else if (selectedRef.current) focusExactNode(renderer, selectedRef.current);
        onLayoutRef.current("ready");
        disposeWorker(workerRef, active);
      };
      const onError = (event: ErrorEvent) => fail("graph_layout_worker_failed", event.message || "Layout worker failed");
      active = { worker, onMessage, onError };
      workerRef.current = active;
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(request);
    } catch (error) {
      if (workerRef.current?.worker === worker) disposeWorker(workerRef);
      else if (worker) {
        worker.terminate();
        debug().workersTerminated += 1;
      }
      onLayoutRef.current("failed", error instanceof Error ? error.message : "Layout worker failed to start", "graph_layout_worker_start_failed");
    }
    return () => disposeWorker(workerRef);
  }, [props.projection]);

  useEffect(() => {
    rendererRef.current?.refresh();
  }, [props.selectedKey]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !props.focusNodeKey || cameraTargetRef.current) return;
    focusExactNode(renderer, props.focusNodeKey);
  }, [props.focusKey]);

  useEffect(() => {
    if (!props.cameraTarget) return;
    const renderer = rendererRef.current;
    if (renderer) applyAuthoritativeCamera(renderer, props.cameraTarget);
  }, [props.cameraTarget]);

  if (failure) {
    return <div className="graph-failure" role="alert" data-error-code={failure}><strong>Graph rendering unavailable</strong><span>{failure}</span><p>This browser did not provide the WebGL surface required by Sigma.</p></div>;
  }
  return <div ref={containerRef} className="sigma-container" data-testid="sigma-surface" aria-hidden="true" />;
}

function focusExactNode(renderer: Sigma, key: string): boolean {
  const display = renderer.getNodeDisplayData(key);
  if (!display || !Number.isFinite(display.x) || !Number.isFinite(display.y)) return false;
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280;
  const target = { x: display.x, y: display.y, ratio: 0.18, angle: renderer.getCamera().getState().angle };
  renderer.getCamera().animate(target, { duration });
  const viewport = renderer.framedGraphToViewport(display, { cameraState: target });
  const dimensions = renderer.getDimensions();
  debug().focusedNode = {
    key,
    x: viewport.x,
    y: viewport.y,
    width: dimensions.width,
    height: dimensions.height,
    visible: viewport.x >= 0 && viewport.x <= dimensions.width && viewport.y >= 0 && viewport.y <= dimensions.height,
  };
  return true;
}

function applyAuthoritativeCamera(renderer: Sigma, target: CameraState): void {
  const state = { x: target.x, y: target.y, ratio: target.ratio, angle: target.angle };
  const camera = renderer.getCamera();
  // Sigma has no public cancel method. A zero-duration animation cancels any
  // in-flight focus animation; setState makes the authoritative value immediate.
  camera.animate(state, { duration: 0 }, () => undefined);
  camera.setState(state);
  debug().camera = camera.getState();
}

function schemaColor(schema: string): string {
  let hash = 0;
  for (const character of schema) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return SCHEMA_COLORS[Math.abs(hash) % SCHEMA_COLORS.length]!;
}

function debug(): DebugState {
  const target = window as typeof window & { __METAFLOW_EXPLORER__?: DebugState };
  target.__METAFLOW_EXPLORER__ ??= { sigmaCreated: 0, sigmaKilled: 0, workersCreated: 0, workersTerminated: 0 };
  return target.__METAFLOW_EXPLORER__;
}

function validCamera(camera: CameraState): boolean {
  return Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.ratio) && camera.ratio > 0 && Number.isFinite(camera.angle);
}

function reportDebugError(error: unknown): void {
  window.dispatchEvent(new CustomEvent("metaflow:explorer-error", { detail: { code: "graph_webgl_unavailable", message: error instanceof Error ? error.message : String(error) } }));
}

function disposeWorker(reference: { current: ActiveLayoutWorker | undefined }, candidate = reference.current): void {
  if (!candidate) return;
  if (reference.current === candidate) reference.current = undefined;
  candidate.worker.removeEventListener("message", candidate.onMessage);
  candidate.worker.removeEventListener("error", candidate.onError);
  candidate.worker.terminate();
  debug().workersTerminated += 1;
}

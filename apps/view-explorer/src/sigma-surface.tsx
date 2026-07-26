import { useEffect, useRef, useState } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { refKey, type ViewGraphProjectionResult } from "./contracts.js";
import { deterministicPosition, type CameraState } from "./graph-projection.js";

const SCHEMA_COLORS = ["#137a65", "#4263a9", "#a54835", "#9b6a17", "#7a4f91", "#39767d"];
const EDGE_COLORS: Record<string, string> = {
  derived_from: "#d86638",
  member_of: "#4878b7",
  references: "#7b6d61",
  application_member: "#2d8b72",
};

type SigmaSurfaceProps = {
  projection: ViewGraphProjectionResult;
  selectedKey?: string;
  focusKey?: string;
  focusNodeKey?: string;
  initialCamera?: CameraState;
  cameraTarget?: CameraState & { nonce: number };
  forceWebglFailure?: boolean;
  onSelect(key: string, camera: CameraState): void;
  onCameraChange(camera: CameraState): void;
  onLayoutState(state: "running" | "ready" | "failed", message?: string): void;
};

type DebugState = {
  sigmaCreated: number;
  sigmaKilled: number;
  workersCreated: number;
  workersTerminated: number;
  camera?: CameraState;
  graph?: { nodes: number; edges: number; firstNode?: { x: number; y: number }; display?: unknown; dimensions?: unknown; graphDimensions?: unknown };
};

export default function SigmaSurface(props: SigmaSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | undefined>(undefined);
  const rendererRef = useRef<Sigma | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);
  const layoutIdRef = useRef(0);
  const hasRenderedProjectionRef = useRef(false);
  const selectedRef = useRef(props.selectedKey);
  const onSelectRef = useRef(props.onSelect);
  const onCameraRef = useRef(props.onCameraChange);
  const [failure, setFailure] = useState<string>();

  selectedRef.current = props.selectedKey;
  onSelectRef.current = props.onSelect;
  onCameraRef.current = props.onCameraChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (props.forceWebglFailure) {
      setFailure("graph_webgl_unavailable");
      return;
    }
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) {
      setFailure("graph_webgl_unavailable");
      return;
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const graph = new Graph({ multi: true, type: "directed", allowSelfLoops: false });
    graphRef.current = graph;
    let renderer: Sigma;
    try {
      renderer = new Sigma(graph, container, {
        allowInvalidContainer: false,
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 9,
        defaultNodeColor: "#4263a9",
        defaultEdgeColor: "#a7aaa5",
        nodeReducer: (key, attributes) => {
          const selected = selectedRef.current;
          if (!selected) return attributes;
          if (key === selected) return { ...attributes, color: "#e9ad31", highlighted: true, zIndex: 2, size: Number(attributes.size) * 1.45 };
          if (graph.hasNode(selected) && graph.areNeighbors(key, selected)) return { ...attributes, zIndex: 1 };
          return { ...attributes, color: "#c8cbc6", label: "", zIndex: 0 };
        },
        edgeReducer: (key, attributes) => {
          const selected = selectedRef.current;
          if (!selected || !graph.hasEdge(key)) return attributes;
          const [source, target] = graph.extremities(key);
          return source === selected || target === selected
            ? { ...attributes, color: EDGE_COLORS[String(attributes.relationType)] ?? "#594f46", size: 2.2, zIndex: 1 }
            : { ...attributes, color: "#dedfda", hidden: false, size: 0.35, zIndex: 0 };
        },
      });
    } catch (error) {
      setFailure("graph_webgl_unavailable");
      reportDebugError(error);
      return;
    }
    rendererRef.current = renderer;
    debug().sigmaCreated += 1;
    const camera = renderer.getCamera();
    if (props.initialCamera) camera.setState(props.initialCamera);
    const click = ({ node }: { node: string }) => onSelectRef.current(node, camera.getState());
    const cameraUpdated = () => {
      const state = camera.getState();
      debug().camera = state;
      if (validCamera(state)) onCameraRef.current(state);
    };
    renderer.on("clickNode", click);
    camera.on("updated", cameraUpdated);
    return () => {
      workerRef.current?.terminate();
      if (workerRef.current) debug().workersTerminated += 1;
      workerRef.current = undefined;
      camera.off("updated", cameraUpdated);
      renderer.off("clickNode", click);
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
    if (!hasRenderedProjectionRef.current) {
      renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
      hasRenderedProjectionRef.current = true;
    }
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
    workerRef.current?.terminate();
    if (workerRef.current) debug().workersTerminated += 1;
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module", name: "metaflow-view-layout" });
    workerRef.current = worker;
    debug().workersCreated += 1;
    const layoutId = ++layoutIdRef.current;
    props.onLayoutState("running");
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; positions?: Record<string, { x: number; y: number }>; message?: string }>) => {
      if (event.data.id !== layoutId || workerRef.current !== worker) return;
      if (!event.data.ok || !event.data.positions) {
        props.onLayoutState("failed", event.data.message ?? "Layout worker failed");
        finishWorker(workerRef, worker);
        return;
      }
      for (const [key, position] of Object.entries(event.data.positions)) {
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
          props.onLayoutState("failed", "Layout worker returned a non-finite position");
          finishWorker(workerRef, worker);
          return;
        }
        if (graph.hasNode(key)) graph.mergeNodeAttributes(key, position);
      }
      renderer.refresh();
      props.onLayoutState("ready");
      finishWorker(workerRef, worker);
    };
    worker.onerror = event => {
      props.onLayoutState("failed", event.message || "Layout worker failed");
      finishWorker(workerRef, worker);
    };
    worker.postMessage({
      id: layoutId,
      nodes: graph.mapNodes((key, attributes) => ({ key, x: Number(attributes.x), y: Number(attributes.y), size: Number(attributes.size) })),
      edges: graph.mapEdges((key, _attributes, source, target) => ({ key, source, target })),
    });
  }, [props.projection]);

  useEffect(() => {
    rendererRef.current?.refresh();
  }, [props.selectedKey]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph || !props.focusNodeKey || !graph.hasNode(props.focusNodeKey)) return;
    const attributes = graph.getNodeAttributes(props.focusNodeKey);
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280;
    renderer.getCamera().animate({ x: Number(attributes.x), y: Number(attributes.y), ratio: 0.18 }, { duration });
  }, [props.focusKey]);

  useEffect(() => {
    if (!props.cameraTarget) return;
    rendererRef.current?.getCamera().setState(props.cameraTarget);
  }, [props.cameraTarget]);

  if (failure) {
    return <div className="graph-failure" role="alert" data-error-code={failure}><strong>Graph rendering unavailable</strong><span>{failure}</span><p>This browser did not provide the WebGL surface required by Sigma.</p></div>;
  }
  return <div ref={containerRef} className="sigma-container" data-testid="sigma-surface" aria-hidden="true" />;
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

function finishWorker(reference: { current: Worker | undefined }, worker: Worker): void {
  if (reference.current !== worker) return;
  worker.terminate();
  reference.current = undefined;
  debug().workersTerminated += 1;
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Filter,
  Focus,
  GitBranch,
  History,
  Eye,
  ListTree,
  Network,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  EXPLORER_DEFAULT_EDGE_TYPES,
  EXPLORER_MAX_EDGES,
  EXPLORER_MAX_NODES,
  parseExactRef,
  refKey,
  type ExactViewRef,
  type View,
  type ViewGraphProjectionRequest,
  type ViewGraphProjectionResult,
} from "./contracts.js";
import { createFixtureTransport, fixtureRoot, parseFixtureId } from "./fixtures.js";
import { type CameraState, mergeProjection } from "./graph-projection.js";
import { ExplorerClientError, ViewExplorerOperationClient } from "./operation-client.js";
import { ExplorerRequestCoordinator } from "./request-coordinator.js";
import { VirtualNodeList } from "./node-list.js";
import { supportsViewRenderer, supportsViewSchema, ViewRendererSurface } from "./renderer-surface.js";

const SigmaSurface = lazy(() => import("./sigma-surface.js"));
const ViewContentDialog = lazy(async () => ({
  default: (await import("./view-content-dialog.js")).ViewContentDialog,
}));
type Direction = ViewGraphProjectionRequest["direction"];
type Drawer = "filters" | "list" | undefined;
type VisitedItem = { key: string; name: string; camera: CameraState };
type RestoredCamera = CameraState & { nonce: number };
type UiFailure = { code: string; message: string; operation?: string };
type HistoryMode = "push" | "replace" | "none";
type LoadProjectionOptions = {
  direction: Direction;
  depth: number;
  edgeTypes: string[];
  selected?: string;
  historyMode: HistoryMode;
  recordVisited?: boolean;
  requireSelection?: boolean;
};

export function ViewExplorer() {
  const initial = useMemo(readUrlState, []);
  const fixtureTransport = useMemo(() => initial.fixture ? createFixtureTransport(initial.fixture) : undefined, [initial.fixture]);
  const client = useMemo(() => new ViewExplorerOperationClient(fixtureTransport), [fixtureTransport]);
  const [root, setRoot] = useState<ExactViewRef | undefined>(initial.root ?? (initial.fixture ? fixtureRoot(initial.fixture) : undefined));
  const [projection, setProjection] = useState<ViewGraphProjectionResult>();
  const [selectedKey, setSelectedKey] = useState(initial.selected);
  const [view, setView] = useState<View>();
  const [surface, setSurface] = useState<"graph" | "view">("graph");
  const [direction, setDirection] = useState<Direction>(initial.direction);
  const [depth, setDepth] = useState(initial.depth);
  const [edgeTypes, setEdgeTypes] = useState<string[]>(initial.edgeTypes);
  const [pendingEdgeTypes, setPendingEdgeTypes] = useState<string[]>(initial.edgeTypes);
  const [query, setQuery] = useState("");
  const [focusKey, setFocusKey] = useState<string>();
  const [focusNonce, setFocusNonce] = useState(0);
  const [drawer, setDrawer] = useState<Drawer>();
  const [contentOpen, setContentOpen] = useState(Boolean(initial.selected));
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<UiFailure>();
  const [layout, setLayout] = useState<"idle" | "running" | "ready" | "failed">("idle");
  const [layoutMessage, setLayoutMessage] = useState<string>();
  const [layoutFailureCode, setLayoutFailureCode] = useState("graph_layout_failed");
  const [visited, setVisited] = useState<VisitedItem[]>([]);
  const [cameraTarget, setCameraTarget] = useState<RestoredCamera | undefined>(initial.camera ? { ...initial.camera, nonce: 0 } : undefined);
  const cameraRef = useRef<CameraState>(initial.camera ?? { x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  const cameraTargetRef = useRef<RestoredCamera | undefined>(initial.camera ? { ...initial.camera, nonce: 0 } : undefined);
  const cameraNonceRef = useRef(0);
  const selectedKeyRef = useRef(initial.selected);
  const searchRef = useRef<HTMLInputElement>(null);
  const requestsRef = useRef(new ExplorerRequestCoordinator());

  selectedKeyRef.current = selectedKey;

  const restoreCamera = useCallback((camera: CameraState) => {
    const target = { ...camera, nonce: ++cameraNonceRef.current };
    cameraRef.current = camera;
    cameraTargetRef.current = target;
    setCameraTarget(target);
  }, []);

  const releaseRestoredCamera = useCallback(() => {
    cameraTargetRef.current = undefined;
    setCameraTarget(undefined);
  }, []);

  const recordVisit = useCallback((key: string, name: string, arrivalCamera: CameraState) => {
    const priorKey = selectedKeyRef.current;
    const departureCamera = cameraRef.current;
    setVisited(items => {
      const withDeparture = priorKey && priorKey !== key
        ? items.map(item => item.key === priorKey ? { ...item, camera: departureCamera } : item)
        : items;
      return withDeparture.some(item => item.key === key)
        ? withDeparture
        : [...withDeparture.slice(-7), { key, name, camera: arrivalCamera }];
    });
  }, []);

  useEffect(() => {
    if (!fixtureTransport) return;
    (window as typeof window & { __METAFLOW_FIXTURE_CALLS__?: typeof fixtureTransport.calls }).__METAFLOW_FIXTURE_CALLS__ = fixtureTransport.calls;
  }, [fixtureTransport]);

  const selectedNode = useMemo(() => projection?.nodes.find(node => refKey(node.ref) === selectedKey), [projection, selectedKey]);
  const neighborKeys = useMemo(() => {
    if (!projection || !selectedKey) return [];
    return [...new Set(projection.edges.flatMap(edge => {
      const source = refKey(edge.source);
      const target = refKey(edge.target);
      if (source === selectedKey) return [target];
      if (target === selectedKey) return [source];
      return [];
    }))].sort();
  }, [projection, selectedKey]);
  const availableEdgeTypes = useMemo(() => [...new Set([...EXPLORER_DEFAULT_EDGE_TYPES, ...(projection?.edges.map(edge => edge.type) ?? [])])].sort(), [projection]);
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of projection?.edges ?? []) counts.set(edge.type, (counts.get(edge.type) ?? 0) + 1);
    return [...counts].sort(([left], [right]) => left.localeCompare(right));
  }, [projection]);

  const commitProjection = useCallback((result: ViewGraphProjectionResult, requestedRoot: ExactViewRef, options: LoadProjectionOptions) => {
    const selectedNode = options.selected ? result.nodes.find(node => refKey(node.ref) === options.selected) : undefined;
    if (options.requireSelection && !selectedNode) {
      throw new ExplorerNavigationError("Exact Search result was absent from its graph projection", "projection_missing_selected");
    }
    const nextSelected = selectedNode ? refKey(selectedNode.ref) : undefined;
    setProjection(result);
    setRoot(requestedRoot);
    setDirection(options.direction);
    setDepth(options.depth);
    setEdgeTypes(options.edgeTypes);
    setPendingEdgeTypes(options.edgeTypes);
    setSelectedKey(nextSelected);
    const hasRendererSurface = Boolean(selectedNode && supportsViewSchema(selectedNode.schema.name));
    setSurface(hasRendererSurface ? "view" : "graph");
    setContentOpen(Boolean(nextSelected) && !hasRendererSurface);
    if (nextSelected) {
      if (cameraTargetRef.current) {
        setFocusKey(undefined);
      } else {
        setFocusKey(nextSelected);
        setFocusNonce(value => value + 1);
      }
      if (options.recordVisited) recordVisit(nextSelected, selectedNode!.name, cameraTargetRef.current ?? cameraRef.current);
    } else {
      setFocusKey(undefined);
    }
    selectedKeyRef.current = nextSelected;
    if (options.historyMode !== "none") {
      updateUrl({ root: requestedRoot, selected: nextSelected, direction: options.direction, depth: options.depth, edgeTypes: options.edgeTypes, camera: cameraTargetRef.current ?? cameraRef.current }, options.historyMode);
    }
  }, [recordVisit]);

  const loadProjection = useCallback(async (requestedRoot: ExactViewRef, options: LoadProjectionOptions) => {
    const request = requestsRef.current.begin("projection");
    setLoading(true);
    setFailure(undefined);
    try {
      const result = await client.project({
        roots: [requestedRoot],
        direction: options.direction,
        edge_types: options.edgeTypes,
        max_depth: options.depth,
        max_nodes: EXPLORER_MAX_NODES,
        max_edges: EXPLORER_MAX_EDGES,
      }, request.controller.signal);
      if (!requestsRef.current.isCurrent(request.token, request.controller)) return;
      commitProjection(result, requestedRoot, options);
    } catch (error) {
      if (requestsRef.current.isCurrent(request.token, request.controller)) setFailure(toFailure(error));
    } finally {
      requestsRef.current.finish("projection", request.controller);
      if (requestsRef.current.isCurrent(request.token)) setLoading(false);
    }
  }, [client, commitProjection]);

  useEffect(() => {
    const initialRoot = initial.root ?? (initial.fixture ? fixtureRoot(initial.fixture) : undefined);
    if (initialRoot) void loadProjection(initialRoot, {
      direction: initial.direction,
      depth: initial.depth,
      edgeTypes: initial.edgeTypes,
      selected: initial.selected,
      historyMode: "replace",
      recordVisited: Boolean(initial.selected),
      requireSelection: Boolean(initial.selected),
    });
    return () => requestsRef.current.dispose();
  }, [initial, loadProjection]);

  useEffect(() => {
    if (!selectedNode) { setView(undefined); return; }
    const abort = new AbortController();
    setView(undefined);
    void client.getView(selectedNode.ref, abort.signal).then(nextView => {
      if (!abort.signal.aborted) setView(nextView);
    }).catch(error => {
      if (!abort.signal.aborted) setFailure(toFailure(error));
    });
    return () => abort.abort();
  }, [client, selectedNode]);

  useEffect(() => {
    const pop = () => {
      const state = readUrlState();
      const projectionConfigChanged = state.direction !== direction
        || state.depth !== depth
        || !sameStrings(state.edgeTypes, edgeTypes);
      setSelectedKey(state.selected);
      setDirection(state.direction);
      setDepth(state.depth);
      setEdgeTypes(state.edgeTypes);
      setPendingEdgeTypes(state.edgeTypes);
      if (state.camera) restoreCamera(state.camera); else releaseRestoredCamera();
      if (!state.root) {
        requestsRef.current.supersede("History navigation returned to the explorer entry surface");
        setRoot(undefined);
        setProjection(undefined);
        setSelectedKey(undefined);
        return;
      }
      if (!root || !projection || refKey(state.root) !== refKey(root) || projectionConfigChanged) {
        void loadProjection(state.root, {
          direction: state.direction,
          depth: state.depth,
          edgeTypes: state.edgeTypes,
          selected: state.selected,
          historyMode: "none",
          recordVisited: false,
          requireSelection: Boolean(state.selected),
        });
        return;
      }
      requestsRef.current.supersede("History selection superseded active explorer work");
      setSelectedKey(state.selected);
      selectedKeyRef.current = state.selected;
      if (state.camera) {
        setFocusKey(undefined);
      } else {
        setFocusKey(state.selected);
        setFocusNonce(value => value + 1);
      }
      const historyNode = projection.nodes.find(node => refKey(node.ref) === state.selected);
      const hasRendererSurface = Boolean(historyNode && supportsViewSchema(historyNode.schema.name));
      setSurface(hasRendererSurface ? "view" : "graph");
      setContentOpen(Boolean(state.selected) && !hasRendererSurface);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [depth, direction, edgeTypes, loadProjection, projection, releaseRestoredCamera, restoreCamera, root]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === "Escape") { setContentOpen(false); setDrawer(undefined); }
      if (event.key === "[") setDrawer(current => current === "filters" ? undefined : "filters");
      if (event.key === "]") setDrawer(current => current === "list" ? undefined : "list");
    };
    addEventListener("keydown", keyboard);
    return () => removeEventListener("keydown", keyboard);
  }, []);

  function selectNode(key: string, camera = cameraRef.current, historyMode: "push" | "replace" = "push", cameraMode: "focus" | "restore" = "focus"): void {
    const node = projection?.nodes.find(candidate => refKey(candidate.ref) === key);
    if (!node) return;
    requestsRef.current.supersede("Exact View selection superseded active explorer work");
    setLoading(false);
    recordVisit(key, node.name, camera);
    if (cameraMode === "restore") restoreCamera(camera); else releaseRestoredCamera();
    setSelectedKey(key);
    const hasRendererSurface = supportsViewSchema(node.schema.name);
    setSurface(hasRendererSurface ? "view" : "graph");
    setContentOpen(!hasRendererSurface);
    selectedKeyRef.current = key;
    if (cameraMode === "restore") {
      setFocusKey(undefined);
    } else {
      setFocusKey(key);
      setFocusNonce(value => value + 1);
    }
    updateUrl({ root, selected: key, direction, depth, edgeTypes, camera }, historyMode);
  }

  function selectNeighbor(position: "previous" | "next"): void {
    const key = position === "previous" ? neighborKeys.at(-1) : neighborKeys[0];
    if (key) selectNode(key);
  }

  async function searchNodes(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalized = query.trim().toLowerCase();
    if (!normalized) return;
    const local = projection?.nodes.find(node => `${node.name} ${node.schema.name} ${refKey(node.ref)}`.toLowerCase().includes(normalized));
    if (local) { selectNode(refKey(local.ref)); return; }
    const search = requestsRef.current.begin("search");
    let projectionController: AbortController | undefined;
    setLoading(true);
    setFailure(undefined);
    try {
      const response = await client.search({
        contract_version: 1,
        query: { text: query.trim() },
        scope: { kind: "all_visible", max_nodes: 1_000, max_scan: 10_000 },
        target: { envelope: true, internal: false, related_views: false },
        modes: ["keyword"],
        fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
        failure_mode: "require_all",
        page: { limit: 20 },
      }, search.controller.signal);
      if (!requestsRef.current.isCurrent(search.token, search.controller)) return;
      const hit = response.hits[0];
      if (!hit) { setFailure({ code: "search_no_results", message: "No authorized exact View matched this search." }); return; }
      projectionController = requestsRef.current.attach(search.token, "projection");
      const result = await client.project({
        roots: [hit.ref],
        direction,
        edge_types: edgeTypes,
        max_depth: depth,
        max_nodes: EXPLORER_MAX_NODES,
        max_edges: EXPLORER_MAX_EDGES,
      }, projectionController.signal);
      if (!requestsRef.current.isCurrent(search.token, projectionController)) return;
      releaseRestoredCamera();
      commitProjection(result, hit.ref, {
        direction,
        depth,
        edgeTypes,
        selected: refKey(hit.ref),
        historyMode: "push",
        recordVisited: true,
        requireSelection: true,
      });
    } catch (error) {
      if (requestsRef.current.isCurrent(search.token)) setFailure(toFailure(error));
    } finally {
      requestsRef.current.finish("search", search.controller);
      if (projectionController) requestsRef.current.finish("projection", projectionController);
      if (requestsRef.current.isCurrent(search.token)) setLoading(false);
    }
  }

  async function expandSelected(): Promise<void> {
    if (!selectedNode || !projection) return;
    const expand = requestsRef.current.begin("expand");
    const currentProjection = projection;
    setLoading(true);
    setFailure(undefined);
    try {
      const incoming = await client.project({ roots: [selectedNode.ref], direction: "both", edge_types: edgeTypes, max_depth: 1, max_nodes: 500, max_edges: 2_000 }, expand.controller.signal);
      if (!requestsRef.current.isCurrent(expand.token, expand.controller)) return;
      setProjection(mergeProjection(currentProjection, incoming));
      if (!cameraTargetRef.current) {
        setFocusKey(selectedKey);
        setFocusNonce(value => value + 1);
      }
    } catch (error) {
      if (requestsRef.current.isCurrent(expand.token, expand.controller)) setFailure(toFailure(error));
    } finally {
      requestsRef.current.finish("expand", expand.controller);
      if (requestsRef.current.isCurrent(expand.token)) setLoading(false);
    }
  }

  function applyFilters(): void {
    if (!root || pendingEdgeTypes.length === 0) return;
    setDrawer(undefined);
    void loadProjection(root, {
      direction,
      depth,
      edgeTypes: pendingEdgeTypes,
      selected: selectedKey,
      historyMode: "replace",
      recordVisited: false,
    });
  }

  if (!root) {
    return <EntrySurface query={query} setQuery={setQuery} search={searchNodes} failure={failure} inputRef={searchRef} />;
  }

  return (
    <main className="explorer-shell" data-layout-state={layout} data-node-count={projection?.nodes.length ?? 0} data-surface={surface}>
      <header className="topbar">
        <div className="brand"><Network size={19} strokeWidth={2.2} /><span>Metaflow</span><strong>Views</strong></div>
        <form className="search-box" role="search" onSubmit={searchNodes}>
          <Search size={16} aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} aria-label="Search exact Views" placeholder="Search Views" />
          <button type="submit" className="icon-button" title="Focus search result" aria-label="Focus search result"><Focus size={16} /></button>
        </form>
        <div className="topbar-actions">
          <div className="surface-switch segmented" role="group" aria-label="Explorer surface">
            <button type="button" aria-pressed={surface === "graph"} onClick={() => setSurface("graph")}><Network size={15} />Graph</button>
            <button type="button" aria-pressed={surface === "view"} disabled={!supportsViewRenderer(view)} onClick={() => setSurface("view")}><Eye size={15} />View</button>
          </div>
          {selectedNode && <button type="button" className="icon-button" onClick={() => setContentOpen(true)} aria-label="Open selected View" title="Open selected View"><BookOpen size={18} /></button>}
          <button type="button" className={`icon-button ${drawer === "list" ? "active" : ""}`} onClick={() => setDrawer(current => current === "list" ? undefined : "list")} aria-label="Browse Views" title="Browse Views"><ListTree size={18} /></button>
          <button type="button" className={`icon-button ${drawer === "filters" ? "active" : ""}`} onClick={() => setDrawer(current => current === "filters" ? undefined : "filters")} aria-label="Graph settings" title="Graph settings"><SlidersHorizontal size={18} /></button>
        </div>
      </header>

      <aside className={`left-panel panel ${drawer === "filters" ? "mobile-open" : ""}`} aria-label="Graph filters">
        <PanelHeader icon={<SlidersHorizontal size={16} />} title="Graph settings" close={() => setDrawer(undefined)} />
        <div className="panel-scroll">
          <Field label="Connections"><div className="segmented" role="group" aria-label="Graph direction">{(["incoming", "both", "outgoing"] as Direction[]).map(value => <button type="button" key={value} aria-pressed={direction === value} onClick={() => setDirection(value)}>{value === "both" ? "all" : value}</button>)}</div></Field>
          <Field label="Visible neighborhood"><div className="segmented range-control" role="group" aria-label="Visible neighborhood">{([{ label: "near", value: 1 }, { label: "local", value: 2 }, { label: "broad", value: 3 }] as const).map(option => <button type="button" key={option.value} aria-pressed={depth === option.value} onClick={() => setDepth(option.value)}>{option.label}</button>)}</div></Field>
          <fieldset className="filter-group"><legend>Connection types</legend>{availableEdgeTypes.map(type => <label key={type} className="check-row"><input type="checkbox" checked={pendingEdgeTypes.includes(type)} onChange={() => setPendingEdgeTypes(current => current.includes(type) ? current.filter(value => value !== type) : [...current, type])} /><span className={`edge-swatch edge-${edgeFamily(type)}`} /><span title={type}>{humanizeRelation(type)}</span></label>)}</fieldset>
          <button type="button" className="command primary" disabled={pendingEdgeTypes.length === 0 || loading} onClick={applyFilters}><Filter size={15} />Update graph</button>
          <details className="advanced-diagnostics"><summary>Advanced diagnostics</summary><section className="diagnostics" aria-label="Projection diagnostics"><Diagnostic active={Boolean(projection?.truncation.truncated)} label={projection?.truncation.truncated ? `Truncated: ${projection.truncation.reasons.join(", ")}` : "Within requested limits"} /><Diagnostic active={Boolean(projection?.frontier.length)} label={`${projection?.frontier.length ?? 0} frontier Views`} /><Diagnostic active={Boolean(projection?.redacted_boundary)} label={projection?.redacted_boundary ? "Redacted boundary present" : "No redacted boundary"} /></section></details>
        </div>
      </aside>

      {surface === "view" && view && supportsViewRenderer(view) ? <ViewRendererSurface view={view} client={client} /> : <section className="graph-stage" aria-label="View graph visualization">
        {projection ? (
          <Suspense fallback={<div className="graph-loading" role="status">Loading graph engine</div>}>
            <SigmaSurface
              projection={projection}
              selectedKey={selectedKey}
              focusKey={focusKey ? `${focusKey}:${focusNonce}` : undefined}
              focusNodeKey={focusKey}
              cameraTarget={cameraTarget}
              forceWebglFailure={Boolean(initial.fixture && initial.forceWebglFailure)}
              onSelect={selectNode}
              onCameraChange={camera => {
                const restored = cameraTargetRef.current;
                if (restored && sameCamera(camera, restored)) {
                  cameraRef.current = restored;
                  updateUrl({ root, selected: selectedKey, direction, depth, edgeTypes, camera: restored }, "replace");
                  return;
                }
                if (restored) releaseRestoredCamera();
                cameraRef.current = camera;
                updateUrl({ root, selected: selectedKey, direction, depth, edgeTypes, camera }, "replace");
              }}
              onLayoutState={(state, message, code) => { setLayout(state); setLayoutMessage(message); setLayoutFailureCode(code ?? "graph_layout_failed"); }}
            />
          </Suspense>
        ) : <div className="graph-loading" role="status">Loading projection</div>}
        <div className="canvas-stats" aria-hidden="true"><span>{projection?.nodes.length ?? 0} Views</span><span>{projection?.edges.length ?? 0} relations</span></div>
        {loading && <div className="busy-indicator" role="status">Updating</div>}
        {failure && <FailureBanner failure={failure} dismiss={() => setFailure(undefined)} />}
        {layout === "failed" && <FailureBanner failure={{ code: layoutFailureCode, message: layoutMessage ?? "Layout worker failed" }} dismiss={() => setLayout("idle")} />}
      </section>}

      <aside className={`companion ${drawer === "list" ? "drawer-open" : ""}`} aria-label="Browse Views">
        <PanelHeader icon={<ListTree size={16} />} title="Views" close={() => setDrawer(undefined)} />
        <div className="history-strip"><History size={15} aria-hidden="true" /><span className="history-label">Visited</span>{visited.length === 0 ? <span className="muted">None</span> : visited.map(item => <button type="button" key={item.key} onClick={() => selectNode(item.key, item.camera, "push", "restore")} title={item.key}>{item.name}</button>)}</div>
        {projection && <VirtualNodeList nodes={projection.nodes} selectedKey={selectedKey} onSelect={key => selectNode(key)} />}
        <div className="relation-summary" aria-label="Relations in projection">{relationCounts.map(([type, count]) => <span key={type}>{humanizeRelation(type)}: {count}</span>)}</div>
      </aside>

      {contentOpen && selectedNode && (
        <Suspense fallback={<ViewContentLoadingDialog close={() => setContentOpen(false)} />}>
          <ViewContentDialog node={selectedNode} view={view} loading={loading} neighborCount={neighborKeys.length} close={() => setContentOpen(false)} expand={expandSelected} selectNeighbor={selectNeighbor} />
        </Suspense>
      )}

      <div className="sr-status" role="status" aria-live="polite">{projection ? `${projection.nodes.length} Views and ${projection.edges.length} relations. Relation types: ${relationCounts.map(([type, count]) => `${type}: ${count}`).join(", ") || "none"}. ${projection.truncation.truncated ? `Projection truncated by ${projection.truncation.reasons.join(", ")}.` : "Projection complete within requested limits."}` : "Loading projection."}</div>
    </main>
  );
}

function ViewContentLoadingDialog({ close }: { close(): void }) {
  return (
    <div className="view-dialog-backdrop">
      <section className="view-dialog view-dialog-loading" role="dialog" aria-modal="true" aria-label="Loading View content">
        <div className="content-loading" role="status">Loading View content</div>
        <button type="button" className="icon-button dialog-close" onClick={close} aria-label="Close View"><X size={20} /></button>
      </section>
    </div>
  );
}

function EntrySurface(props: { query: string; setQuery(value: string): void; search(event: React.FormEvent): void; failure?: UiFailure; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [rootText, setRootText] = useState("");
  const [entryFailure, setEntryFailure] = useState<UiFailure>();
  function openExact(event: React.FormEvent) {
    event.preventDefault();
    const ref = parseExactRef(rootText);
    if (!ref) { setEntryFailure({ code: "invalid_exact_ref", message: "Exact View entry requires a non-empty View id and positive revision." }); return; }
    const url = new URL(location.href);
    url.searchParams.set("root", refKey(ref));
    location.assign(url);
  }
  return <main className="entry-surface"><div className="entry-brand"><Network size={22} /><span>Metaflow</span><strong>View Explorer</strong></div><section className="entry-workspace"><h1>Open an exact View graph</h1><form onSubmit={openExact}><label>Exact View reference<input value={rootText} onChange={event => { setRootText(event.target.value); setEntryFailure(undefined); }} placeholder="view:id@revision" /></label><button className="command primary" type="submit"><GitBranch size={16} />Open graph</button></form><div className="entry-divider"><span>or</span></div><form onSubmit={props.search}><label>Authorized Search<input ref={props.inputRef} value={props.query} onChange={event => props.setQuery(event.target.value)} placeholder="Search visible Views" /></label><button className="command" type="submit"><Search size={16} />Search</button></form>{(entryFailure ?? props.failure) && <FailureBanner failure={(entryFailure ?? props.failure)!} dismiss={() => setEntryFailure(undefined)} />}</section></main>;
}

function PanelHeader(props: { icon: React.ReactNode; title: string; close(): void }) { return <div className="panel-header">{props.icon}<strong>{props.title}</strong><button type="button" className="icon-button panel-close" onClick={props.close} aria-label={`Close ${props.title}`}><X size={17} /></button></div>; }
function Field(props: { label: string; children: React.ReactNode }) { return <div className="field"><span>{props.label}</span>{props.children}</div>; }
function Diagnostic(props: { active: boolean; label: string }) { return <div className={`diagnostic ${props.active ? "attention" : ""}`}><AlertTriangle size={14} aria-hidden="true" /><span>{props.label}</span></div>; }
function FailureBanner(props: { failure: UiFailure; dismiss(): void }) { return <div className="failure-banner" role="alert" data-error-code={props.failure.code}><AlertTriangle size={18} /><div><strong>{props.failure.code}</strong><span>{props.failure.message}</span></div><button className="icon-button" type="button" onClick={props.dismiss} aria-label="Dismiss error"><X size={16} /></button></div>; }

function toFailure(error: unknown): UiFailure {
  if (error instanceof ExplorerClientError) return { code: error.code, message: error.message, operation: error.operation };
  if (error instanceof ExplorerNavigationError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "explorer_failed", message: error.message };
  return { code: "explorer_failed", message: "The explorer failed without a valid error value." };
}

function edgeFamily(type: string): string {
  if (type.includes("derived") || type.includes("provenance")) return "provenance";
  if (type.startsWith("application_")) return "application";
  if (type.includes("member")) return "composition";
  return "reference";
}

function humanizeRelation(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, character => character.toUpperCase());
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCamera(left: CameraState, right: CameraState): boolean {
  const tolerance = 0.0001;
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.ratio - right.ratio) <= tolerance
    && Math.abs(left.angle - right.angle) <= tolerance;
}

function readUrlState() {
  const params = new URLSearchParams(location.search);
  const edgeTypes = (params.get("edges")?.split(",").filter(Boolean) ?? [...EXPLORER_DEFAULT_EDGE_TYPES]).slice(0, 32);
  const directionValue = params.get("direction");
  const direction: Direction = directionValue === "incoming" || directionValue === "outgoing" || directionValue === "both" ? directionValue : "both";
  const depthValue = Number(params.get("depth") ?? 2);
  const cameraValues = ["cx", "cy", "ratio", "angle"].map(key => Number(params.get(key)));
  const camera = cameraValues.every(Number.isFinite) && cameraValues[2]! > 0 ? { x: cameraValues[0]!, y: cameraValues[1]!, ratio: cameraValues[2]!, angle: cameraValues[3]! } : undefined;
  return { fixture: parseFixtureId(params.get("fixture")), root: parseExactRef(params.get("root") ?? ""), selected: parseExactRef(params.get("selected") ?? "") ? params.get("selected")! : undefined, direction, depth: Number.isInteger(depthValue) ? Math.max(0, Math.min(5, depthValue)) : 2, edgeTypes: edgeTypes.length ? edgeTypes : [...EXPLORER_DEFAULT_EDGE_TYPES], camera, forceWebglFailure: params.get("webgl") === "off" };
}

class ExplorerNavigationError extends Error {
  constructor(message: string, readonly code: "projection_missing_selected") {
    super(message);
    this.name = "ExplorerNavigationError";
  }
}

function updateUrl(input: { root?: ExactViewRef; selected?: string; direction: Direction; depth: number; edgeTypes: string[]; camera: CameraState }, mode: "push" | "replace"): void {
  const url = new URL(location.href);
  if (input.root) url.searchParams.set("root", refKey(input.root));
  if (input.selected) url.searchParams.set("selected", input.selected); else url.searchParams.delete("selected");
  url.searchParams.set("direction", input.direction);
  url.searchParams.set("depth", String(input.depth));
  url.searchParams.set("edges", input.edgeTypes.join(","));
  url.searchParams.set("cx", input.camera.x.toFixed(4));
  url.searchParams.set("cy", input.camera.y.toFixed(4));
  url.searchParams.set("ratio", input.camera.ratio.toFixed(4));
  url.searchParams.set("angle", input.camera.angle.toFixed(4));
  history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchActivityTimeline, fetchContextView, fetchRuntimeSettings, fetchViewFamilies, fetchViewsByType, fetchViewsByTypes, runRuntimeTick, saveRuntimeSettings, screenpipeFrameUrl, submitViewFeedback, syncScreenpipe } from "./api";
import type { ActivityTimelineResponse, ContextViewSummary, RuntimeSettings, RuntimeTickResponse, TimelineBucket, TimelineItem, ViewCatalogResponse, ViewFamiliesResponse, ViewFamilyDefinition, ViewFamilySummary } from "./types";
import "./styles.css";

const POLL_MS = 60_000;
const DEFAULT_MINUTES = 60;
const FALLBACK_VIEW_TYPE_ORDER = [
  "state.surface", "work.focus_set", "project.current", "memory.daily", "memory.profile",
  "evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow", "memory",
  "thread.active_work", "project.current_context", "brief.research", "brief.background_research",
  "advice.research", "advice.writing_assist",
  "agent.task_list",
  "task.background_research", "draft.writing_continuation",
  "opportunity.tool", "task.toolsmith_prototype", "draft.tool_prototype", "tool.prototype_artifact",
  "app.language.review_queue", "memory.language.difficult_segments",
];
const AMBIENT_VIEW_TYPES = [
  "advice.research",
  "agent.task_list",
  "task.background_research",
  "brief.background_research",
  "advice.writing_assist",
  "draft.writing_continuation",
  "opportunity.tool",
  "task.toolsmith_prototype",
  "draft.tool_prototype",
  "tool.prototype_artifact",
  "app.language.review_queue",
  "memory.language.difficult_segments",
];
const VIEW_GROUPS = [
  {
    id: "surface",
    title: "Now",
    subtitle: "current work state",
    types: ["state.surface", "work.focus_set", "project.current", "thread.active_work", "project.current_context"],
  },
  {
    id: "actions",
    title: "Actions",
    subtitle: "things the runtime can help with",
    types: ["agent.task_list", "advice.research", "advice.writing_assist", "task.background_research", "draft.writing_continuation", "opportunity.tool", "task.toolsmith_prototype", "draft.tool_prototype", "tool.prototype_artifact"],
  },
  {
    id: "memory",
    title: "Memory",
    subtitle: "durable context",
    types: ["memory.profile", "memory.daily", "memory", "brief.research", "brief.background_research", "resource"],
  },
  {
    id: "patterns",
    title: "Patterns",
    subtitle: "intent and workflow compression",
    types: ["intent", "workflow", "activity_block", "activity", "proposal"],
  },
  {
    id: "evidence",
    title: "Evidence",
    subtitle: "raw signals for debugging",
    types: ["audio", "visual_frame", "evidence"],
  },
];
const DEFAULT_VIEW_TYPE = "work.focus_set";
const VIEW_CATALOG_CACHE = new Map<string, ViewFamilyDefinition>();
let VIEW_CATALOG_ORDER_CACHE: string[] = FALLBACK_VIEW_TYPE_ORDER;
type SourceFilter = "screenpipe" | "browser" | "runtime" | "all";
type DetailMode = "activity" | "debug";
type ActiveTab = "home" | "timeline" | "ambient" | "views" | "settings";
type FramePreview = { frameId: string | number; title?: string };

function App() {
  const [timeline, setTimeline] = useState<ActivityTimelineResponse | null>(null);
  const [viewFamilies, setViewFamilies] = useState<ViewFamiliesResponse | null>(null);
  const [lastTick, setLastTick] = useState<RuntimeTickResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewsLoading, setViewsLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [status, setStatus] = useState("Connecting…");
  const [viewStatus, setViewStatus] = useState("Views not loaded");
  const [settingsStatus, setSettingsStatus] = useState("Settings not loaded");
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [detailMode, setDetailMode] = useState<DetailMode>("activity");
  const [activeTab, setActiveTab] = useState<ActiveTab>("home");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [viewInspector, setViewInspector] = useState<{ view?: ContextViewSummary; loading: boolean }>({ loading: false });
  const [previewFrame, setPreviewFrame] = useState<FramePreview | null>(null);
  const refreshSeq = useRef(0);
  const viewRefreshSeq = useRef(0);

  async function refresh(quiet = false) {
    const seq = ++refreshSeq.current;
    if (!quiet) {
      setLoading(true);
      setStatus("Loading timeline…");
    }
    try {
      const debugMode = detailMode === "debug";
      const next = await fetchActivityTimeline({
        minutes,
        limit: timelineUiRecordLimit(minutes, sourceFilter, detailMode),
        bucketMinutes: chooseBucket(minutes),
        includeLowLevelScreenpipe: debugMode,
        dedupe: !debugMode,
        bucketItemLimit: debugMode ? 80 : 18,
        summarizeHeartbeats: !debugMode,
        sourceFilter,
        mergeContinuous: true,
        mergeGapMinutes: debugMode ? 3 : 8,
      });
      if (seq !== refreshSeq.current) return;
      setTimeline(next);
      const windows = lastTick?.diagnostics?.screenpipe_activity?.count ?? 0;
      setStatus(`${next.records_used} records · ${next.buckets.length} buckets · ${windows} Screenpipe windows`);
    } catch (error) {
      if (seq !== refreshSeq.current) return;
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === refreshSeq.current && !quiet) setLoading(false);
    }
  }

  async function refreshViews(quiet = false) {
    const seq = ++viewRefreshSeq.current;
    if (!quiet) {
      setViewsLoading(true);
      setViewStatus("Loading views…");
    }
    try {
      const next = await fetchViewFamilies();
      if (seq !== viewRefreshSeq.current) return;
      rememberViewCatalog(next.catalog);
      setViewFamilies(next);
      const aiViews = next.views.filter(view => compilerId(view).startsWith("ai.")).length;
      setViewStatus(`${next.views.length} active views · ${aiViews} AI-compressed`);
    } catch (error) {
      if (seq !== viewRefreshSeq.current) return;
      setViewStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === viewRefreshSeq.current && !quiet) setViewsLoading(false);
    }
  }

  async function syncNow() {
    setLoading(true);
    setStatus("Syncing Screenpipe…");
    try {
      const tick = await syncScreenpipe(Math.min(30, Math.max(5, Math.round(minutes / 12))));
      setLastTick(tick);
      const syncedWindows = tick.diagnostics?.screenpipe_activity?.count ?? 0;
      setStatus(`${syncedWindows} Screenpipe windows synced · reloading timeline…`);
      await refresh(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(false).catch(error => setStatus(error instanceof Error ? error.message : String(error)));
  }, [minutes, detailMode, sourceFilter]);

  useEffect(() => {
    if (activeTab !== "views") return;
    refreshViews(false).catch(error => setViewStatus(error instanceof Error ? error.message : String(error)));
  }, [activeTab]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => refresh(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, minutes, detailMode, sourceFilter]);

  useEffect(() => {
    if (!previewFrame) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPreviewFrame(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewFrame]);

  const filteredBuckets = useMemo(() => filterBuckets(timeline?.buckets ?? [], sourceFilter, detailMode), [timeline, sourceFilter, detailMode]);
  const selectedItem = useMemo(() => findItem(filteredBuckets, selectedItemId), [filteredBuckets, selectedItemId]);
  const filteredSignals = useMemo(() => summarizeSignals(filteredBuckets), [filteredBuckets]);
  const stats = useMemo(() => summarize(filteredBuckets, lastTick), [filteredBuckets, lastTick]);

  return (
    <div className={`app-shell ${activeTab === "home" ? "home-mode" : activeTab === "views" || activeTab === "ambient" ? "views-mode" : ""}`}>
      <aside className="sidebar">
        <div className="workspace-title">
          <div className="workspace-icon">M</div>
          <div>
            <b>MetaFlow</b>
            <span>Local runtime</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="App navigation">
          <button className={`nav-item ${activeTab === "home" ? "active" : ""}`} onClick={() => setActiveTab("home")}><span>⌁</span>Home</button>
          <button className={`nav-item ${activeTab === "timeline" ? "active" : ""}`} onClick={() => setActiveTab("timeline")}><span>◷</span>Timeline</button>
          <button className={`nav-item ${activeTab === "ambient" ? "active" : ""}`} onClick={() => setActiveTab("ambient")}><span>✦</span>Ambient</button>
          <button className={`nav-item ${activeTab === "views" ? "active" : ""}`} onClick={() => setActiveTab("views")}><span>◇</span>Views</button>
          <button className={`nav-item ${activeTab === "settings" ? "active" : ""}`} onClick={() => setActiveTab("settings")}><span>⚙</span>Settings</button>
        </nav>
        <div className="sidebar-foot">
          <div className={`live-dot ${live ? "on" : ""}`} />
          <span>{live ? "Live sync" : "Paused"}</span>
        </div>
      </aside>

      <main className="page">
        {activeTab === "home" ? (
          <MetaFlowHome onNavigate={setActiveTab} live={live} stats={stats} status={status} />
        ) : (
          <>
            <header className="page-header">
              <div>
                <div className="breadcrumb">MetaFlow / Local runtime</div>
                <h1>{activeTab === "timeline" ? "Timeline" : activeTab === "ambient" ? "Ambient" : activeTab === "views" ? "Runtime Views" : "Runtime Settings"}</h1>
                <p>{activeTab === "timeline" ? "按时间整理最近 focus 的 app、网页和项目活动。" : activeTab === "ambient" ? "主动后台搜索、写作介入和小工具机会都会先沉淀成可检查的 Views。" : activeTab === "views" ? "查看 Observation 压缩和 ambient Programs 产出的 Evidence、Intent、Workflow、Advice、Task、Draft 和 Memory Views。" : "控制 VisionFrame、ActivityBlock、Intent 和 Workflow 压缩的模型与开关。"}</p>
              </div>
              <div className="header-actions">
                {activeTab === "timeline" ? (
                  <>
                    <select value={sourceFilter} onChange={event => setSourceFilter(event.target.value as SourceFilter)} aria-label="Timeline source">
                      <option value="all">All sources</option>
                      <option value="screenpipe">Screenpipe</option>
                      <option value="browser">Browser</option>
                      <option value="runtime">Runtime</option>
                    </select>
                    <select value={detailMode} onChange={event => setDetailMode(event.target.value as DetailMode)} aria-label="Timeline detail mode">
                      <option value="activity">Activity</option>
                      <option value="debug">Evidence debug</option>
                    </select>
                    <select value={minutes} onChange={event => setMinutes(Number(event.target.value))} aria-label="Timeline window">
                      <option value={60}>Last 1h</option>
                      <option value={180}>Last 3h</option>
                      <option value={480}>Last 8h</option>
                      <option value={1440}>Today</option>
                    </select>
                    <button className="secondary" onClick={() => setLive(value => !value)}>{live ? "Live" : "Paused"}</button>
                    <button className="secondary" onClick={() => refresh(false)} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
                    <button onClick={syncNow} disabled={loading}>{loading ? "Syncing…" : "Sync Screenpipe"}</button>
                  </>
                ) : activeTab === "views" ? (
                  <>
                    <button className="secondary" onClick={() => setViewStatus("Create View will use the shared View catalog")}>Create View</button>
                    <button onClick={() => refreshViews(false)} disabled={viewsLoading}>{viewsLoading ? "Loading…" : "Reload Views"}</button>
                  </>
                ) : activeTab === "ambient" ? (
                  <button onClick={() => setViewStatus("Ambient panel has local controls")}>Ambient Controls</button>
                ) : (
                  <button onClick={() => setSettingsStatus("Reload settings from panel")}>Runtime Controls</button>
                )}
              </div>
            </header>

            {activeTab === "timeline" ? (
          <>
            <section className="status-row">
              <Stat label="Items" value={stats.items} />
              <Stat label="Screenpipe" value={stats.screenpipe} />
              <Stat label="Last seen" value={stats.last} />
              <div className="status-text">{sourceFilterLabel(sourceFilter)} · local-first load · {status}</div>
            </section>

            <section className="context-row" aria-label="Top signals">
              <Signal label="Sources" values={filteredSignals.top_sources} />
              <Signal label="Apps" values={filteredSignals.top_apps} />
              <Signal label="Domains" values={filteredSignals.top_domains} />
            </section>

            <Timeline buckets={filteredBuckets} loading={loading && !timeline} sourceFilter={sourceFilter} selectedItemId={selectedItemId} onSelect={setSelectedItemId} onOpenFrame={setPreviewFrame} />
          </>
        ) : activeTab === "ambient" ? (
          <AmbientPanel onInspect={setViewInspector} />
        ) : activeTab === "views" ? (
          <MemoryViewsPanel response={viewFamilies} loading={viewsLoading && !viewFamilies} status={viewStatus} onInspect={setViewInspector} />
        ) : (
          <RuntimeSettingsPanel initialStatus={settingsStatus} onStatus={setSettingsStatus} onTick={setLastTick} />
        )}
          </>
        )}
      </main>
      {activeTab === "home"
        ? null
        : activeTab === "views" || activeTab === "ambient"
        ? <aside className="view-inspector"><ViewDetail view={viewInspector.view} loading={viewInspector.loading} /></aside>
        : activeTab === "settings"
          ? <aside className="inspector empty"><span>{settingsStatus}</span></aside>
        : <Inspector item={selectedItem} onClose={() => setSelectedItemId(null)} onOpenFrame={setPreviewFrame} />}
      <FrameLightbox preview={previewFrame} onClose={() => setPreviewFrame(null)} />
    </div>
  );
}

function AmbientPanel({ onInspect }: { onInspect: (state: { view?: ContextViewSummary; loading: boolean }) => void }) {
  const [views, setViews] = useState<ContextViewSummary[]>([]);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ContextViewSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("Ambient views not loaded");

  const sortedViews = useMemo(() => views.filter(isSurfaceableAmbientView).sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "")), [views]);
  const selectedSummary = sortedViews.find(view => view.id === selectedViewId) ?? sortedViews[0];
  const activeView = selectedDetail?.id === selectedSummary?.id ? selectedDetail : selectedSummary;
  const researchViews = sortedViews.filter(view => ["advice.research", "task.background_research", "brief.background_research"].includes(view.view_type));
  const queueViews = sortedViews.filter(view => ["agent.task_list"].includes(view.view_type));
  const writingViews = sortedViews.filter(view => ["advice.writing_assist", "draft.writing_continuation"].includes(view.view_type));
  const toolViews = sortedViews.filter(view => ["opportunity.tool", "task.toolsmith_prototype", "draft.tool_prototype", "tool.prototype_artifact"].includes(view.view_type));
  const languageViews = sortedViews.filter(view => ["app.language.review_queue", "memory.language.difficult_segments"].includes(view.view_type));
  const pendingTasks = sortedViews.filter(view => view.view_type.startsWith("task.") && !taskProcessedStatus(view));
  const processedTasks = sortedViews.filter(view => taskProcessedStatus(view) === "completed");

  useEffect(() => {
    void refreshAmbient();
  }, []);

  useEffect(() => {
    if (!sortedViews.length) {
      setSelectedViewId(null);
      setSelectedDetail(null);
      return;
    }
    if (selectedViewId && !sortedViews.some(view => view.id === selectedViewId)) {
      setSelectedViewId(null);
      setSelectedDetail(null);
    }
  }, [sortedViews, selectedViewId]);

  useEffect(() => {
    if (!selectedViewId) return;
    let cancelled = false;
    setDetailLoading(true);
    fetchContextView(selectedViewId)
      .then(view => {
        if (!cancelled) setSelectedDetail(view);
      })
      .catch(() => {
        if (!cancelled) setSelectedDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedViewId]);

  useEffect(() => {
    onInspect({ view: activeView, loading: detailLoading });
  }, [activeView, detailLoading, onInspect]);

  async function refreshAmbient() {
    setLoading(true);
    setStatus("Loading ambient views...");
    try {
      const result = await fetchViewsByTypes(AMBIENT_VIEW_TYPES, { limit: 96 });
      const nextViews = result.views ?? [];
      const hidden = nextViews.filter(view => !isSurfaceableAmbientView(view)).length;
      setViews(nextViews);
      setStatus(`${nextViews.length - hidden} ambient views loaded${hidden ? ` · ${hidden} scaffold writing views hidden` : ""}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function runBackgroundTasks() {
    setRunning(true);
    setStatus("Processing ambient background tasks...");
    try {
      const tick = await runRuntimeTick({
        include_screenpipe: false,
        include_ai_sessions: false,
        include_git: false,
        compile_views: false,
        process_background_tasks: true,
        background_task_limit: 6,
        force: true,
      });
      const processed = tick.diagnostics?.background_tasks?.processed ?? 0;
      const skipped = tick.diagnostics?.background_tasks?.skipped ?? 0;
      setStatus(`Background tasks processed ${processed} · skipped ${skipped}`);
      await refreshAmbient();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  async function buildToolArtifacts() {
    setRunning(true);
    setStatus("Building sandbox tool artifacts...");
    try {
      const tick = await runRuntimeTick({
        include_screenpipe: false,
        include_ai_sessions: false,
        include_git: false,
        compile_views: false,
        process_toolsmith_artifacts: true,
        toolsmith_artifact_limit: 6,
        force: true,
      });
      const processed = tick.diagnostics?.toolsmith_artifacts?.processed ?? 0;
      const skipped = tick.diagnostics?.toolsmith_artifacts?.skipped ?? 0;
      setStatus(`Tool artifacts built ${processed} · skipped ${skipped}`);
      await refreshAmbient();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  async function markFeedback(view: ContextViewSummary, action: "use" | "dismiss", extra: Record<string, unknown> = {}) {
    setActionBusy(`${action}:${view.id}`);
    const type = action === "dismiss" ? "analysis.dismissed" : "analysis.useful";
    const value = action === "dismiss" ? "dismissed" : "useful";
    try {
      await submitViewFeedback({
        view_id: view.id,
        type,
        value,
        reason: action === "dismiss" ? `Dismissed ${view.view_type} from Ambient panel` : `Used ${view.view_type} from Ambient panel`,
        payload: {
          surface: "ambient.panel",
          action,
          view_type: view.view_type,
          ...extra,
        },
      });
      setStatus(`${viewFamilyLabel(view.view_type)} marked ${value}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(null);
    }
  }

  async function copyDraft(view: ContextViewSummary) {
    const text = draftTextOf(view);
    if (!text) {
      setStatus("No draft text available to copy");
      return;
    }
    setActionBusy(`copy:${view.id}`);
    try {
      await navigator.clipboard.writeText(text);
      await markFeedback(view, "use", { action: "copy_draft", copied_text: text.slice(0, 1200) });
      setStatus("Draft copied and feedback recorded");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setActionBusy(null);
    }
  }

  return (
    <section className="ambient-panel" aria-label="Ambient suggestions">
      <section className="status-row ambient-status">
        <Stat label="Ambient Views" value={sortedViews.length} />
        <Stat label="Pending Tasks" value={pendingTasks.length} />
        <Stat label="Completed" value={processedTasks.length} />
        <div className="status-text">{status}</div>
      </section>

      <div className="ambient-actions">
        <button className="secondary" onClick={refreshAmbient} disabled={loading || running}>{loading ? "Loading..." : "Refresh"}</button>
        <button onClick={runBackgroundTasks} disabled={running || loading}>{running ? "Processing..." : "Run Background Tasks"}</button>
        <button onClick={buildToolArtifacts} disabled={running || loading}>{running ? "Working..." : "Build Tool Artifacts"}</button>
      </div>

      {activeView && (
        <AmbientFocus
          view={activeView}
          busy={Boolean(actionBusy?.endsWith(`:${activeView.id}`))}
          onSelect={() => setSelectedViewId(activeView.id)}
          onFeedback={markFeedback}
          onCopy={copyDraft}
        />
      )}

      <div className="ambient-grid">
        <AmbientColumn title="Queue" subtitle="agent task list" views={queueViews} selectedId={selectedSummary?.id} actionBusy={actionBusy} onSelect={setSelectedViewId} onFeedback={markFeedback} onCopy={copyDraft} empty={loading ? "Loading queue..." : "No queued agent tasks yet."} />
        <AmbientColumn title="Research" subtitle="background search" views={researchViews} selectedId={selectedSummary?.id} actionBusy={actionBusy} onSelect={setSelectedViewId} onFeedback={markFeedback} onCopy={copyDraft} empty={loading ? "Loading research..." : "No research suggestions yet."} />
        <AmbientColumn title="Writing" subtitle="inline drafts" views={writingViews} selectedId={selectedSummary?.id} actionBusy={actionBusy} onSelect={setSelectedViewId} onFeedback={markFeedback} onCopy={copyDraft} empty={loading ? "Loading writing..." : "No writing assists yet."} />
        <AmbientColumn title="Toolsmith" subtitle="workflow tools" views={toolViews} selectedId={selectedSummary?.id} actionBusy={actionBusy} onSelect={setSelectedViewId} onFeedback={markFeedback} onCopy={copyDraft} empty={loading ? "Loading tools..." : "No tool opportunities yet."} />
        <AmbientColumn title="Language" subtitle="youtube review" views={languageViews} selectedId={selectedSummary?.id} actionBusy={actionBusy} onSelect={setSelectedViewId} onFeedback={markFeedback} onCopy={copyDraft} empty={loading ? "Loading language..." : "No review items yet."} />
      </div>
    </section>
  );
}

function AmbientFocus({ view, busy, onSelect, onFeedback, onCopy }: { view: ContextViewSummary; busy: boolean; onSelect: () => void; onFeedback: (view: ContextViewSummary, action: "use" | "dismiss", extra?: Record<string, unknown>) => void; onCopy: (view: ContextViewSummary) => void }) {
  const snippets = ambientSnippets(view).slice(0, 4);
  const canCopy = Boolean(draftTextOf(view));
  const artifactUri = toolArtifactUri(view);
  return (
    <section className="ambient-focus">
      <button className="ambient-focus-main" type="button" onClick={onSelect}>
        <span>{viewFamilyLabel(view.view_type)}</span>
        <h2>{view.title || view.id}</h2>
        {view.summary && <p>{view.summary}</p>}
        {snippets.length > 0 && <div className="ambient-snippets">{snippets.map(snippet => <span key={snippet}>{snippet}</span>)}</div>}
      </button>
      <div className="ambient-focus-side">
        <b>{relativeTime(view.updated_at) || "fresh"}</b>
        <span>{viewTypePurpose(view.view_type)}</span>
        <div>
          {canCopy && <button className="secondary" onClick={() => onCopy(view)} disabled={busy}>{busy ? "..." : "Copy"}</button>}
          {artifactUri && <a className="ambient-open-link" href={artifactUri} target="_blank" rel="noreferrer" onClick={() => onFeedback(view, "use", { action: "open_artifact", artifact_uri: artifactUri })}>Open</a>}
          <button className="secondary" onClick={() => onFeedback(view, "dismiss")} disabled={busy}>{busy ? "..." : "Dismiss"}</button>
          <button onClick={() => onFeedback(view, "use")} disabled={busy}>{busy ? "..." : "Use"}</button>
        </div>
      </div>
    </section>
  );
}

function AmbientColumn({ title, subtitle, views, selectedId, actionBusy, onSelect, onFeedback, onCopy, empty }: { title: string; subtitle: string; views: ContextViewSummary[]; selectedId?: string; actionBusy: string | null; onSelect: (id: string) => void; onFeedback: (view: ContextViewSummary, action: "use" | "dismiss", extra?: Record<string, unknown>) => void; onCopy: (view: ContextViewSummary) => void; empty: string }) {
  const shownViews = views.slice(0, 12);
  const hiddenCount = Math.max(0, views.length - shownViews.length);
  return (
    <section className="ambient-column">
      <div className="ambient-column-head">
        <div>
          <b>{title}</b>
          <span>{subtitle}</span>
        </div>
        <strong>{views.length}</strong>
      </div>
      <div className="ambient-cards">
        {shownViews.length ? shownViews.map(view => (
          <AmbientCard key={view.id} view={view} selected={view.id === selectedId} busy={Boolean(actionBusy?.endsWith(`:${view.id}`))} onSelect={() => onSelect(view.id)} onFeedback={onFeedback} onCopy={onCopy} />
        )) : <div className="empty-inline">{empty}</div>}
        {hiddenCount > 0 && <div className="ambient-more">Showing latest 12 · {hiddenCount} older hidden for speed</div>}
      </div>
    </section>
  );
}

function AmbientCard({ view, selected, busy, onSelect, onFeedback, onCopy }: { view: ContextViewSummary; selected: boolean; busy: boolean; onSelect: () => void; onFeedback: (view: ContextViewSummary, action: "use" | "dismiss", extra?: Record<string, unknown>) => void; onCopy: (view: ContextViewSummary) => void }) {
  const taskStatus = taskProcessedStatus(view);
  const snippets = ambientSnippets(view);
  const canCopy = Boolean(draftTextOf(view));
  const artifactUri = toolArtifactUri(view);
  return (
    <article className={`ambient-card ${selected ? "selected" : ""}`}>
      <button className="ambient-card-main" onClick={onSelect}>
        <div className="ambient-card-top">
          <span>{viewFamilyLabel(view.view_type)}</span>
          {typeof view.confidence === "number" && <b>{Math.round(view.confidence * 100)}%</b>}
        </div>
        <h3>{view.title || view.id}</h3>
        {view.summary && <p>{view.summary}</p>}
        {snippets.length > 0 && (
          <div className="ambient-snippets">
            {snippets.slice(0, 3).map(snippet => <span key={snippet}>{snippet}</span>)}
          </div>
        )}
      </button>
      <div className="ambient-card-meta">
        <span>{taskStatus ? `task ${taskStatus}` : viewTypePurpose(view.view_type)}</span>
        <span>{relativeTime(view.updated_at) || "—"}</span>
      </div>
      <div className="ambient-card-actions">
        {canCopy && <button className="secondary" onClick={() => onCopy(view)} disabled={busy}>{busy ? "..." : "Copy"}</button>}
        {artifactUri && <a className="ambient-open-link" href={artifactUri} target="_blank" rel="noreferrer" onClick={() => onFeedback(view, "use", { action: "open_artifact", artifact_uri: artifactUri })}>Open</a>}
        <button className="secondary" onClick={() => onFeedback(view, "dismiss")} disabled={busy}>{busy ? "..." : "Dismiss"}</button>
        <button onClick={() => onFeedback(view, "use")} disabled={busy}>{busy ? "..." : "Use"}</button>
      </div>
    </article>
  );
}

function isSurfaceableAmbientView(view: ContextViewSummary): boolean {
  if (!["advice.writing_assist", "draft.writing_continuation"].includes(view.view_type)) return true;
  const compiler = typeof view.compiler === "object" ? view.compiler : undefined;
  if (compiler?.id === "program.writing_ambient" && compiler.mode === "deterministic") return false;
  if (view.content?.scaffold_only === true || view.content?.generated_by === "deterministic_scaffold") return false;
  return true;
}

function RuntimeSettingsPanel({ initialStatus, onStatus, onTick }: { initialStatus: string; onStatus: (status: string) => void; onTick: (tick: RuntimeTickResponse) => void }) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  async function loadSettings() {
    setLoading(true);
    setStatus("Loading runtime settings…");
    try {
      const response = await fetchRuntimeSettings();
      setSettings(response.settings);
      setStatus("Runtime settings loaded");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    setStatus("Saving runtime settings…");
    try {
      const response = await saveRuntimeSettings(stripEmptySecrets(settings));
      setSettings(response.settings);
      setStatus("Runtime settings saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function runAiTick() {
    if (!settings) return;
    setRunning(true);
    setStatus("Running AI tick…");
    try {
      const tick = await runRuntimeTick({
        include_screenpipe: true,
        include_ai_sessions: false,
        include_git: false,
        force: true,
        window_minutes: 30,
        screenpipe_limit: 80,
        compile_views: true,
        ai_view_compression: !settings.ai_paused && settings.ai_view_compression !== false,
        visual_view_compression: !settings.visual_paused && settings.visual_view_compression !== false,
      });
      onTick(tick);
      const compiled = Array.isArray(tick.compiled_views) ? tick.compiled_views.length : 0;
      setStatus(`AI tick finished · ${compiled} compiler results`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  function update(patch: RuntimeSettings) {
    setSettings(prev => ({ ...(prev ?? {}), ...patch }));
  }

  function updateLlm(kind: "llm" | "vision_llm", patch: RuntimeSettings["llm"]) {
    setSettings(prev => ({ ...(prev ?? {}), [kind]: { ...(prev?.[kind] ?? {}), ...(patch ?? {}) } }));
  }

  if (loading && !settings) return <div className="empty-state">Loading runtime settings…</div>;
  const value = settings ?? {};
  return (
    <section className="settings-panel" aria-label="Runtime settings">
      <section className="status-row settings-status">
        <Stat label="Vision" value={value.visual_paused ? "Paused" : value.visual_view_compression === false ? "Off" : "On"} />
        <Stat label="AI Views" value={value.ai_paused ? "Paused" : value.ai_view_compression === false ? "Off" : "On"} />
        <Stat label="Interval" value={`${value.view_compile_interval_seconds ?? 120}s`} />
        <div className="status-text">{status}</div>
      </section>

      <div className="settings-grid">
        <article className="settings-card">
          <div className="settings-card-head">
            <div>
              <span>Vision parsing</span>
              <h2>VisualFrameView</h2>
            </div>
            <label className="toggle-line">
              <input type="checkbox" checked={!value.visual_paused} onChange={event => update({ visual_paused: !event.target.checked })} />
              <span>{value.visual_paused ? "Paused" : "Active"}</span>
            </label>
          </div>
          <label className="field-line">
            <span>Enable visual compiler</span>
            <input type="checkbox" checked={value.visual_view_compression !== false} onChange={event => update({ visual_view_compression: event.target.checked })} />
          </label>
          <TextField label="Base URL" value={value.vision_llm?.base_url} onChange={next => updateLlm("vision_llm", { base_url: next })} />
          <TextField label="Model" value={value.vision_llm?.model} onChange={next => updateLlm("vision_llm", { model: next })} />
          <PasswordField label="API key" value={value.vision_llm?.api_key} onChange={next => updateLlm("vision_llm", { api_key: next })} />
          <NumberField label="Frame limit" value={value.visual_frame_limit} min={0} onChange={next => update({ visual_frame_limit: next })} />
          <NumberField label="Concurrency" value={value.visual_frame_concurrency} min={1} onChange={next => update({ visual_frame_concurrency: next })} />
          <NumberField label="Sample seconds" value={value.visual_frame_sample_seconds} min={0} onChange={next => update({ visual_frame_sample_seconds: next })} />
        </article>

        <article className="settings-card">
          <div className="settings-card-head">
            <div>
              <span>Text compression</span>
              <h2>ActivityBlock / Intent / Workflow</h2>
            </div>
            <label className="toggle-line">
              <input type="checkbox" checked={!value.ai_paused} onChange={event => update({ ai_paused: !event.target.checked })} />
              <span>{value.ai_paused ? "Paused" : "Active"}</span>
            </label>
          </div>
          <label className="field-line">
            <span>Enable AI view compression</span>
            <input type="checkbox" checked={value.ai_view_compression !== false} onChange={event => update({ ai_view_compression: event.target.checked })} />
          </label>
          <TextField label="Base URL" value={value.llm?.base_url} onChange={next => updateLlm("llm", { base_url: next })} />
          <TextField label="Model" value={value.llm?.model} onChange={next => updateLlm("llm", { model: next })} />
          <PasswordField label="API key" value={value.llm?.api_key} onChange={next => updateLlm("llm", { api_key: next })} />
          <NumberField label="Temperature" value={value.llm?.temperature} min={0} step={0.1} onChange={next => updateLlm("llm", { temperature: next })} />
          <NumberField label="Compile interval seconds" value={value.view_compile_interval_seconds} min={0} onChange={next => update({ view_compile_interval_seconds: next })} />
          <label className="field-line">
            <span>Omit max_tokens</span>
            <input type="checkbox" checked={value.llm?.omit_max_tokens !== false} onChange={event => updateLlm("llm", { omit_max_tokens: event.target.checked })} />
          </label>
        </article>
      </div>

      <div className="settings-actions">
        <button className="secondary" onClick={loadSettings} disabled={loading || saving || running}>{loading ? "Loading…" : "Reload"}</button>
        <button className="secondary" onClick={runAiTick} disabled={!settings || running || saving}>{running ? "Running…" : "Run AI tick"}</button>
        <button onClick={saveSettings} disabled={!settings || saving || running}>{saving ? "Saving…" : "Save settings"}</button>
      </div>
    </section>
  );
}

function TextField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string) => void }) {
  return (
    <label className="field-line">
      <span>{label}</span>
      <input value={value ?? ""} onChange={event => onChange(event.target.value)} />
    </label>
  );
}

function PasswordField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string) => void }) {
  return (
    <label className="field-line">
      <span>{label}</span>
      <input type="password" placeholder={value ? "saved" : ""} value={isRedactedSecret(value) ? "" : value ?? ""} onChange={event => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({ label, value, min, step = 1, onChange }: { label: string; value?: number; min?: number; step?: number; onChange: (value: number | undefined) => void }) {
  return (
    <label className="field-line">
      <span>{label}</span>
      <input type="number" min={min} step={step} value={value ?? ""} onChange={event => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />
    </label>
  );
}

function stripEmptySecrets(settings: RuntimeSettings): RuntimeSettings {
  const clean = structuredClone(settings);
  for (const key of ["llm", "vision_llm"] as const) {
    if (clean[key]?.api_key === "") delete clean[key]?.api_key;
    if (isRedactedSecret(clean[key]?.api_key)) delete clean[key]?.api_key;
  }
  return clean;
}

function isRedactedSecret(secret?: string) {
  return Boolean(secret && (secret.includes("…") || /^\*+$/.test(secret)));
}

function ViewGraph({ families }: { families: ViewFamilySummary[] }) {
  const canonical = viewTypeOrder({ families });
  const shown = families.filter(family => family.count > 0 || canonical.includes(family.family));
  return (
    <section className="view-graph" aria-label="Agent Surface view graph">
      <div className="view-graph-head">
        <span>Agent Surface Views</span>
        <b>Surface → Focus Set → Project Current → Daily/Profile Memory</b>
      </div>
      <div className="view-family-list">
        {shown.map(family => <ViewFamily key={family.family} family={family} />)}
      </div>
    </section>
  );
}

function rememberViewCatalog(catalog?: ViewCatalogResponse) {
  if (!catalog) return;
  VIEW_CATALOG_CACHE.clear();
  for (const family of catalog.families ?? []) VIEW_CATALOG_CACHE.set(family.view_type, family);
  VIEW_CATALOG_ORDER_CACHE = catalog.order?.length ? prioritizeAgentSurfaceTypes(catalog.order) : FALLBACK_VIEW_TYPE_ORDER;
}

function currentViewCatalogDefinition(type: string): ViewFamilyDefinition | undefined {
  return VIEW_CATALOG_CACHE.get(type);
}

function viewTypeOrder(input: { response?: ViewFamiliesResponse | null; families?: ViewFamilySummary[] } = {}) {
  const fromResponse = input.response?.catalog?.order;
  if (fromResponse?.length) return prioritizeAgentSurfaceTypes(fromResponse);
  const fromFamilies = input.families?.map(family => family.family).filter(Boolean);
  if (fromFamilies?.length) return prioritizeAgentSurfaceTypes(fromFamilies);
  return VIEW_CATALOG_ORDER_CACHE;
}

function prioritizeAgentSurfaceTypes(types: string[]) {
  const seen = new Set(types);
  const prioritized = FALLBACK_VIEW_TYPE_ORDER.filter(type => seen.has(type));
  const rest = types.filter(type => !prioritized.includes(type));
  return [...prioritized, ...rest];
}

function ViewFamily({ family }: { family: ViewFamilySummary }) {
  if (family.definition) VIEW_CATALOG_CACHE.set(family.family, family.definition);
  const title = family.latest?.title ?? family.family;
  return (
    <article className={`view-family ${family.count ? "has-views" : ""}`}>
      <div>
        <span>{viewFamilyLabel(family.family)}</span>
        <b>{family.count}</b>
      </div>
      <p>{title}</p>
      <div>
        {(family.kinds.length ? family.kinds : ["waiting"]).slice(0, 4).map(kind => <Tag key={kind}>{kind}</Tag>)}
      </div>
    </article>
  );
}

function MemoryViewsPanel({ response, loading, status, onInspect }: { response: ViewFamiliesResponse | null; loading: boolean; status: string; onInspect: (state: { view?: ContextViewSummary; loading: boolean }) => void }) {
  const [selectedGroupId, setSelectedGroupId] = useState(VIEW_GROUPS[0].id);
  const [selectedType, setSelectedType] = useState(DEFAULT_VIEW_TYPE);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ContextViewSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [typeViews, setTypeViews] = useState<Record<string, ContextViewSummary[]>>({});
  const [typeLoading, setTypeLoading] = useState(false);
  const [typeStatus, setTypeStatus] = useState("");
  const families = response?.families ?? [];
  const familyByType = useMemo(() => new Map(families.map(family => [family.family, family])), [families]);
  const groups = useMemo(() => viewGroupSummaries(families), [families]);
  const selectedGroup = groups.find(group => group.id === selectedGroupId) ?? groups[0];
  const visibleTypes = selectedGroup?.types ?? [];
  const views = typeViews[selectedType] ?? [];
  const selectedTypeLoaded = typeViews[selectedType]?.length ?? 0;
  const loadedViews = Object.values(typeViews).flat();
  const tabs = useMemo(() => visibleTypes.map(type => {
    const family = familyByType.get(type);
    const loaded = typeViews[type]?.length ?? 0;
    return { type, count: family?.count ?? 0, loaded };
  }), [familyByType, visibleTypes, typeViews]);
  const selectedViews = useMemo(() => views
    .filter(view => view.view_type === selectedType)
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "")), [views, selectedType]);
  const selectedSummary = selectedViews.find(view => view.id === selectedViewId) ?? selectedViews[0];
  const activeView = selectedDetail?.id === selectedSummary?.id ? selectedDetail : selectedSummary;
  const totalCount = families.reduce((sum, family) => sum + family.count, 0);
  const readableCount = groups.reduce((sum, group) => sum + group.count, 0);

  useEffect(() => {
    if (!families.length) return;
    const group = groups.find(group => group.id === selectedGroupId) ?? groups[0];
    if (!group) return;
    if (!group.types.includes(selectedType) || (familyByType.get(selectedType)?.count ?? 0) === 0) {
      setSelectedGroupId(group.id);
      setSelectedType(firstPopulatedType(group, familyByType) ?? group.types[0] ?? DEFAULT_VIEW_TYPE);
      setSelectedViewId(null);
      setSelectedDetail(null);
    }
  }, [families, familyByType, groups, selectedGroupId, selectedType]);

  useEffect(() => {
    const familyCount = familyByType.get(selectedType)?.count ?? 0;
    if (!familyCount || selectedTypeLoaded) return;
    let cancelled = false;
    setTypeLoading(true);
    setTypeStatus(`Loading ${viewFamilyLabel(selectedType)}…`);
    fetchViewsByType(selectedType, { limit: initialViewPageSize(selectedType) })
      .then(result => {
        if (cancelled) return;
        setTypeViews(prev => ({ ...prev, [selectedType]: result.views ?? [] }));
        setTypeStatus(`${result.views?.length ?? 0}/${familyCount} ${viewFamilyLabel(selectedType)} loaded`);
      })
      .catch(error => {
        if (!cancelled) setTypeStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setTypeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedType, familyByType, selectedTypeLoaded]);

  useEffect(() => {
    if (!selectedViews.length) {
      setSelectedViewId(null);
      setSelectedDetail(null);
      return;
    }
    if (!selectedViewId || !selectedViews.some(view => view.id === selectedViewId)) {
      setSelectedViewId(selectedViews[0].id);
      setSelectedDetail(null);
    }
  }, [selectedViews, selectedViewId]);

  useEffect(() => {
    if (!selectedViewId) return;
    let cancelled = false;
    setDetailLoading(true);
    fetchContextView(selectedViewId)
      .then(view => {
        if (!cancelled) setSelectedDetail(view);
      })
      .catch(() => {
        if (!cancelled) setSelectedDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedViewId]);

  useEffect(() => {
    onInspect({ view: activeView, loading: detailLoading });
  }, [activeView, detailLoading, onInspect]);

  async function loadMore() {
    const current = typeViews[selectedType] ?? [];
    const familyCount = familyByType.get(selectedType)?.count ?? 0;
    if (typeLoading || current.length >= familyCount) return;
    setTypeLoading(true);
    setTypeStatus(`Loading more ${viewFamilyLabel(selectedType)}…`);
    try {
      const result = await fetchViewsByType(selectedType, { limit: Math.min(current.length + initialViewPageSize(selectedType), viewPageSize(selectedType)) });
      setTypeViews(prev => ({ ...prev, [selectedType]: result.views ?? [] }));
      setTypeStatus(`${result.views?.length ?? 0}/${familyCount} ${viewFamilyLabel(selectedType)} loaded`);
    } catch (error) {
      setTypeStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTypeLoading(false);
    }
  }

  if (loading) return <ViewSkeleton />;
  return (
    <>
      <section className="status-row views-status">
        <Stat label="Readable" value={readableCount} />
        <Stat label="Loaded" value={loadedViews.length} />
        <Stat label="Total Stored" value={compactNumber(totalCount)} />
        <div className="status-text">{typeStatus || status}</div>
      </section>
      <section className="view-workspace" aria-label="Runtime workspace">
        <div className="view-group-rail" aria-label="View groups">
          {groups.map(group => (
            <button key={group.id} className={group.id === selectedGroup?.id ? "active" : ""} onClick={() => {
              setSelectedGroupId(group.id);
              setSelectedType(firstPopulatedType(group, familyByType) ?? group.types[0] ?? DEFAULT_VIEW_TYPE);
              setSelectedViewId(null);
              setSelectedDetail(null);
            }}>
              <span>{group.title}</span>
              <b>{compactNumber(group.count)}</b>
              <em>{group.subtitle}</em>
            </button>
          ))}
        </div>
      <section className="view-type-tabs compact" aria-label="View type tabs">
        {tabs.map(tab => (
          <button key={tab.type} className={tab.type === selectedType ? "active" : ""} onClick={() => {
            setSelectedType(tab.type);
            setSelectedViewId(null);
            setSelectedDetail(null);
          }}>
            <span>{viewFamilyLabel(tab.type)}</span>
            <b>{compactNumber(tab.count)}</b>
            <em>{tab.loaded > 0 ? `${tab.loaded} loaded` : viewTypePurpose(tab.type)}</em>
          </button>
        ))}
      </section>
      <section className="view-reader" aria-label="Selected runtime views">
        <div className="view-list-panel">
          <div className="view-list-head">
            <div>
              <b>{viewFamilyLabel(selectedType)}</b>
              <span>{selectedViews.length}/{familyByType.get(selectedType)?.count ?? 0} loaded</span>
            </div>
            <Tag>{viewTypePurpose(selectedType)}</Tag>
          </div>
          <div className="view-list-items">
            {selectedViews.length ? selectedViews.map(view => (
              <ViewListRow key={view.id} view={view} selected={view.id === selectedSummary?.id} onSelect={() => setSelectedViewId(view.id)} />
            )) : <div className="empty-inline">{typeLoading ? `Loading ${viewFamilyLabel(selectedType)}…` : `No ${viewFamilyLabel(selectedType)} yet.`}</div>}
            {selectedViews.length < Math.min(familyByType.get(selectedType)?.count ?? 0, viewPageSize(selectedType)) && (
              <button className="load-more-button" type="button" onClick={loadMore} disabled={typeLoading}>
                {typeLoading ? "Loading more..." : `Load ${Math.min(initialViewPageSize(selectedType), (familyByType.get(selectedType)?.count ?? 0) - selectedViews.length)} more`}
              </button>
            )}
          </div>
        </div>
      </section>
      </section>
    </>
  );
}

function ViewListRow({ view, selected, onSelect }: { view: ContextViewSummary; selected: boolean; onSelect: () => void }) {
  const kind = typeof view.content?.kind === "string" ? view.content.kind : view.view_type;
  const compiler = compilerId(view);
  const primaryText = view.view_type === "audio" ? audioListText(view) : view.summary;
  const audioTags = view.view_type === "audio" ? audioListTags(view) : [];
  const badge = viewPrimaryBadge(view);
  return (
    <button className={`view-list-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="view-list-row-top">
        <span>{kind}</span>
        {badge && <b>{badge}</b>}
      </div>
      <h3>{view.title || view.id}</h3>
      {primaryText && <p>{primaryText}</p>}
      {audioTags.length > 0 && <div className="view-list-row-tags">{audioTags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>}
      <div className="view-list-row-meta">
        <span>{compiler || "compiler unknown"}</span>
        <span>{relativeTime(view.updated_at) || "—"}</span>
      </div>
    </button>
  );
}

function audioListText(view: ContextViewSummary): string | undefined {
  return stringContent(view, "transcript_excerpt") || view.summary;
}

function audioListTags(view: ContextViewSummary): string[] {
  const tags = [
    stringContent(view, "transcript_quality"),
    stringContent(view, "speaker_label"),
    stringContent(view, "device_name"),
    ...stringArrayContent(view, "topics").slice(0, 3),
  ];
  return [...new Set(tags.filter((tag): tag is string => Boolean(tag)))];
}

function stringContent(view: ContextViewSummary, key: string): string | undefined {
  const value = view.content?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayContent(view: ContextViewSummary, key: string): string[] {
  const value = view.content?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function taskProcessedStatus(view: ContextViewSummary): string | undefined {
  const task = view.content?.background_task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return undefined;
  const status = (task as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function ambientSnippets(view: ContextViewSummary): string[] {
  const out: string[] = [];
  const content = view.content ?? {};
  const keys = ["focus", "goal", "topic", "draft_text", "opportunity_kind", "output_target"];
  for (const key of keys) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  const suggestions = content.suggestions;
  if (Array.isArray(suggestions)) {
    out.push(...suggestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
  }
  return [...new Set(out.map(value => value.replace(/\s+/g, " ").slice(0, 180)))];
}

function toolArtifactUri(view: ContextViewSummary): string | undefined {
  const uri = view.content?.uri;
  return view.view_type === "tool.prototype_artifact" && typeof uri === "string" && uri.trim() ? uri.trim() : undefined;
}

function draftTextOf(view: ContextViewSummary): string | undefined {
  const value = view.content?.draft_text ?? view.content?.text ?? view.summary;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readableViewPills(view: ContextViewSummary): string[] {
  const pills = [
    view.status ?? "active",
    view.stability,
    view.lossiness,
    view.updated_at ? relativeTime(view.updated_at) : undefined,
    sourceRecordCount(view) ? `${sourceRecordCount(view)} records` : undefined,
    sourceViewCount(view) ? `${sourceViewCount(view)} views` : undefined,
  ];
  return [...new Set(pills.filter((pill): pill is string => Boolean(pill && pill.trim())))].slice(0, 6);
}

function readableViewSections(view: ContextViewSummary): Array<{ title: string; body?: string; items?: string[] }> {
  const content = view.content ?? {};
  const sections: Array<{ title: string; body?: string; items?: string[] }> = [];
  const primary = firstString(content, ["focus", "goal", "topic", "question", "claim", "analysis", "text", "draft_text", "transcript_excerpt"]);
  if (primary && primary !== view.summary) sections.push({ title: readableHeading(view.view_type), body: primary });
  const keyPoints = firstStringArray(content, ["key_points", "takeaways", "findings", "decisions", "open_questions", "next_actions", "suggestions"]);
  if (keyPoints.length) sections.push({ title: arraySectionTitle(content), items: keyPoints.slice(0, 8) });
  const tasks = readableTasks(content);
  if (tasks.length) sections.push({ title: "Tasks", items: tasks.slice(0, 8) });
  const sources = readableSources(content);
  if (sources.length) sections.push({ title: "Sources", items: sources.slice(0, 6) });
  if (!sections.length && view.summary) sections.push({ title: readableHeading(view.view_type), body: view.summary });
  return sections;
}

function readableHeading(viewType: string) {
  if (viewType.includes("research")) return "Research";
  if (viewType.includes("writing") || viewType.includes("draft")) return "Draft";
  if (viewType.includes("task")) return "Task";
  if (viewType.includes("tool")) return "Tool";
  if (viewType.includes("memory")) return "Memory";
  return "Readable view";
}

function arraySectionTitle(content: Record<string, unknown>) {
  if (Array.isArray(content.open_questions)) return "Open questions";
  if (Array.isArray(content.next_actions)) return "Next actions";
  if (Array.isArray(content.decisions)) return "Decisions";
  if (Array.isArray(content.suggestions)) return "Suggestions";
  return "Key points";
}

function firstString(content: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstStringArray(content: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = content[key];
    if (Array.isArray(value)) {
      const strings = value.map(readableValue).filter((item): item is string => Boolean(item));
      if (strings.length) return strings;
    }
  }
  return [];
}

function readableTasks(content: Record<string, unknown>): string[] {
  const items = content.items ?? content.tasks;
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    return readableValue(record.title) ?? readableValue(record.summary) ?? readableValue(record.goal) ?? readableValue(record.id);
  }).filter((item): item is string => Boolean(item));
}

function readableSources(content: Record<string, unknown>): string[] {
  const sources = content.sources ?? content.supporting_sources ?? content.source_records;
  if (!Array.isArray(sources)) return [];
  return sources.map(readableValue).filter((item): item is string => Boolean(item));
}

function readableValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return readableValue(record.title) ?? readableValue(record.summary) ?? readableValue(record.url) ?? readableValue(record.id);
}

function ViewDetail({ view, loading }: { view?: ContextViewSummary; loading: boolean }) {
  if (!view) return <article className="view-detail empty"><span>Select a view to inspect it.</span></article>;
  const kind = typeof view.content?.kind === "string" ? view.content.kind : view.view_type;
  const compiler = compilerId(view);
  const badge = viewPrimaryBadge(view);
  const sections = readableViewSections(view);
  const pills = readableViewPills(view);
  return (
    <article className="view-detail">
      <div className="view-detail-header">
        <div>
          <span>{viewFamilyLabel(view.view_type)} · {kind}</span>
          <h2>{view.title || view.id}</h2>
        </div>
        {badge && <b>{badge}</b>}
      </div>
      {view.summary && <p className="view-detail-summary">{view.summary}</p>}
      {pills.length > 0 && <div className="view-detail-pills">{pills.map(pill => <span key={pill}>{pill}</span>)}</div>}
      {loading && <div className="view-detail-loading">Loading richer detail...</div>}
      {sections.length > 0 ? sections.map(section => (
        <section className="view-detail-section view-readable-section" key={section.title}>
          <h3>{section.title}</h3>
          {section.body && <p>{section.body}</p>}
          {section.items && (
            <ul>
              {section.items.map(item => <li key={item}>{item}</li>)}
            </ul>
          )}
        </section>
      )) : (
        <section className="view-detail-section view-readable-section">
          <h3>Summary</h3>
          <p>No readable fields were found for this view yet.</p>
        </section>
      )}
      {toolArtifactUri(view) && (
        <section className="view-detail-section">
          <h3>Artifact</h3>
          <a className="url-card" href={toolArtifactUri(view)} target="_blank" rel="noreferrer">{toolArtifactUri(view)}</a>
        </section>
      )}
      <details className="view-detail-section view-technical">
        <summary>Technical metadata</summary>
        <dl className="view-detail-meta">
          <dt>compiler</dt><dd>{compiler || "unknown"}</dd>
          <dt>updated</dt><dd>{view.updated_at ? new Date(view.updated_at).toLocaleString() : "—"}</dd>
          <dt>source records</dt><dd>{sourceRecordCount(view)}</dd>
          <dt>source views</dt><dd>{sourceViewCount(view)}</dd>
          <dt>status</dt><dd>{view.status ?? "active"}</dd>
          <dt>stability</dt><dd>{view.stability ?? "—"}</dd>
        </dl>
        <code>{view.id}</code>
      </details>
      <details className="view-detail-section view-technical">
        <summary>Raw content</summary>
        <pre>{JSON.stringify(view.content ?? {}, null, 2)}</pre>
      </details>
    </article>
  );
}

function ViewSkeleton() {
  return (
    <section className="view-skeleton" aria-label="Loading runtime workspace">
      <div className="skeleton-line short" />
      <div className="skeleton-grid">
        {Array.from({ length: 5 }).map((_, index) => <div className="skeleton-card" key={index} />)}
      </div>
      <div className="skeleton-list">
        {Array.from({ length: 6 }).map((_, index) => <div className="skeleton-row" key={index} />)}
      </div>
    </section>
  );
}

function Timeline({ buckets, loading, sourceFilter, selectedItemId, onSelect, onOpenFrame }: { buckets: TimelineBucket[]; loading: boolean; sourceFilter: SourceFilter; selectedItemId: string | null; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
  if (loading) return <TimelineSkeleton />;
  if (!buckets.length) return <div className="empty-state">No {sourceFilterLabel(sourceFilter).toLowerCase()} items in this time window. Click Sync or widen the time range.</div>;
  return (
    <section className="timeline-list" aria-label="Activity timeline">
      {buckets.map(bucket => <Bucket key={bucket.label} bucket={bucket} selectedItemId={selectedItemId} onSelect={onSelect} onOpenFrame={onOpenFrame} />)}
    </section>
  );
}

function TimelineSkeleton() {
  return (
    <section className="timeline-list timeline-skeleton" aria-label="Loading timeline">
      {Array.from({ length: 4 }).map((_, bucketIndex) => (
        <section className="bucket" key={bucketIndex}>
          <div className="bucket-heading">
            <div>
              <div className="skeleton-line time" />
              <div className="skeleton-line summary" />
            </div>
            <span>Loading</span>
          </div>
          <div className="bucket-items">
            {Array.from({ length: 3 }).map((_, rowIndex) => (
              <div className="timeline-row" key={rowIndex}>
                <div className="row-icon" />
                <div className="row-content">
                  <div className="skeleton-line" />
                  <div className="skeleton-line summary" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

function Bucket({ bucket, selectedItemId, onSelect, onOpenFrame }: { bucket: TimelineBucket; selectedItemId: string | null; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
  const dominant = dominantLabel(bucket);
  return (
    <section className="bucket">
      <div className="bucket-heading">
        <div>
          <time>{formatRange(bucket.start, bucket.end)}</time>
          {bucket.summary && <p>{bucket.summary}</p>}
        </div>
        <span>{dominant} · {bucket.count}</span>
      </div>
      <div className="bucket-items">
        {bucket.items.map(item => <TimelineRow key={item.id} item={item} selected={item.id === selectedItemId} onSelect={() => onSelect(item.id)} onOpenFrame={onOpenFrame} />)}
      </div>
    </section>
  );
}

function TimelineRow({ item, selected, onSelect, onOpenFrame }: { item: TimelineItem; selected: boolean; onSelect: () => void; onOpenFrame: (preview: FramePreview) => void }) {
  const frameIds = frameIdsOf(item);
  const visibleFrameIds = frameIds.slice(0, selected ? 3 : 1);
  return (
    <article className={`timeline-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className={`row-icon ${sourceClass(item)}`}>{iconFor(item)}</div>
      <div className="row-content">
        <div className="row-title">
          <b>{item.title}</b>
          <time>{timeOfDay(item.observed_at)}</time>
        </div>
        <div className="row-subtitle">{item.subtitle || sourceLabel(item)}</div>
        <AttributionStrip item={item} />
        {item.text && <div className="row-text">{item.text}</div>}
        {visibleFrameIds.length > 0 && (
          <div className="row-frames" aria-label="Screenpipe OCR screenshots">
            {visibleFrameIds.map(frameId => (
              <FrameThumb key={String(frameId)} frameId={frameId} title={item.title} onOpenFrame={onOpenFrame} />
            ))}
            {frameIds.length > visibleFrameIds.length && (
              <button className="row-frame-count" type="button" onClick={event => {
                event.stopPropagation();
                onSelect();
              }}>+{frameIds.length - visibleFrameIds.length}</button>
            )}
          </div>
        )}
        <div className="row-meta">
          <Tag>{item.source}</Tag>
          {item.schema && <Tag>{item.schema}</Tag>}
          {item.app && <Tag>{item.app}</Tag>}
          {item.domain && <Tag>{item.domain}</Tag>}
          {item.project && <Tag>{item.project}</Tag>}
          {item.stats?.dwell_seconds !== undefined && <Tag>{Math.round(Number(item.stats.dwell_seconds))}s dwell</Tag>}
          {detailTags(item).map(tag => <Tag key={tag}>{tag}</Tag>)}
        </div>
        {(item.url || item.path || detailCode(item)) && <code>{item.url || item.path || detailCode(item)}</code>}
      </div>
    </article>
  );
}

function Inspector({ item, onClose, onOpenFrame }: { item?: TimelineItem; onClose: () => void; onOpenFrame: (preview: FramePreview) => void }) {
  if (!item) {
    return <aside className="inspector empty"><span>Select a timeline item</span></aside>;
  }
  const frameIds = frameIdsOf(item);
  const webUrl = item.url || stringStat(item, "browser_url");
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <span>Evidence</span>
          <h2>{item.title}</h2>
        </div>
        <button onClick={onClose} aria-label="Close inspector">×</button>
      </div>

      {frameIds.length > 0 && (
        <section className="inspector-section">
          <h3>Screenshots</h3>
          <div className="frame-grid">
            {frameIds.slice(0, 8).map(frameId => (
              <figure key={String(frameId)} className="frame-card">
                <FrameThumb frameId={frameId} title={item.title} onOpenFrame={onOpenFrame} large />
                <figcaption>frame_id: {frameId}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {webUrl && (
        <section className="inspector-section">
          <h3>Web</h3>
          <a className="url-card" href={webUrl} target="_blank" rel="noreferrer">{webUrl}</a>
        </section>
      )}

      {item.text && (
        <section className="inspector-section">
          <h3>Text</h3>
          <pre>{item.text}</pre>
        </section>
      )}

      <section className="inspector-section">
        <h3>Attribution</h3>
        <dl>
          {attributionEntries(item).map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>

      <section className="inspector-section">
        <h3>Metadata</h3>
        <dl>
          <dt>source</dt><dd>{item.source}</dd>
          {item.schema && <><dt>schema</dt><dd>{item.schema}</dd></>}
          <dt>time</dt><dd>{new Date(item.observed_at).toLocaleString()}</dd>
          {item.app && <><dt>app</dt><dd>{item.app}</dd></>}
          {item.domain && <><dt>domain</dt><dd>{item.domain}</dd></>}
        </dl>
        <pre>{JSON.stringify(item.stats ?? {}, null, 2)}</pre>
      </section>
    </aside>
  );
}

function FrameThumb({ frameId, title, onOpenFrame, large = false }: { frameId: string | number; title?: string; onOpenFrame: (preview: FramePreview) => void; large?: boolean }) {
  return (
    <button
      className={large ? "frame-button large" : "frame-button"}
      type="button"
      onClick={event => {
        event.stopPropagation();
        onOpenFrame({ frameId, title });
      }}
      aria-label={`Open Screenpipe frame ${frameId}`}
    >
      <img className={large ? "frame-image" : undefined} src={screenpipeFrameUrl(frameId)} alt={`Screenpipe frame ${frameId}`} loading="lazy" />
    </button>
  );
}

function FrameLightbox({ preview, onClose }: { preview: FramePreview | null; onClose: () => void }) {
  if (!preview) return null;
  return (
    <div className="frame-lightbox" role="dialog" aria-modal="true" aria-label={`Screenpipe frame ${preview.frameId}`} onClick={onClose}>
      <div className="frame-lightbox-panel" onClick={event => event.stopPropagation()}>
        <div className="frame-lightbox-header">
          <div>
            <b>{preview.title ?? "Screenpipe frame"}</b>
            <span>frame_id: {preview.frameId}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close frame preview">×</button>
        </div>
        <img src={screenpipeFrameUrl(preview.frameId)} alt={`Screenpipe frame ${preview.frameId}`} />
      </div>
    </div>
  );
}

function MetaFlowHome({ onNavigate, live, stats, status }: { onNavigate: (tab: ActiveTab) => void; live: boolean; stats: { items: number; screenpipe: number | string; last: string }; status: string }) {
  return (
    <section className="metaflow-home" aria-label="MetaFlow home">
      <header className="mf-nav">
        <button className="mf-wordmark" type="button" onClick={() => onNavigate("home")} aria-label="MetaFlow home">
          <span>MetaFlow</span>
        </button>
        <nav aria-label="MetaFlow sections">
          <button type="button" onClick={() => onNavigate("timeline")}>Timeline</button>
          <button type="button" onClick={() => onNavigate("ambient")}>Ambient</button>
          <button type="button" onClick={() => onNavigate("views")}>Views</button>
        </nav>
      </header>

      <section className="mf-hero">
        <MetaFlowField />
        <div className="mf-debug mf-debug-left" aria-hidden="true">
          <span>FLOW FIELD</span>
          <b>CTX 0.86</b>
          <b>AGENTS {live ? "LIVE" : "PAUSED"}</b>
          <b>VIEWGRAPH HOT</b>
        </div>
        <div className="mf-debug mf-debug-right" aria-hidden="true">
          <span>RUNTIME</span>
          <b>OBSERVE</b>
          <b>COMPRESS</b>
          <b>ACT</b>
        </div>
        <div className="mf-hero-copy">
          <p>Personal context that moves with your work.</p>
          <h1>Own your flow.</h1>
          <span>MetaFlow turns your screens, sessions, memories, and agent work into a living local intelligence layer.</span>
        </div>
        <button className="mf-scroll" type="button" onClick={() => document.getElementById("metaflow-mission")?.scrollIntoView({ behavior: "smooth" })}>SCROLL</button>
      </section>

      <section id="metaflow-mission" className="mf-mission">
        <div className="mf-mission-copy">
          <div className="mf-kicker">SYSTEM</div>
          <h2>Observe your work. Route the task. Compile the right view.</h2>
          <p>
            MetaFlow is a local-first context runtime for agentic work. It watches the sources you already use,
            understands what kind of task is emerging, then turns raw evidence into durable views agents can inspect and act on.
          </p>
        </div>
        <div className="mf-flow-diagram" aria-label="MetaFlow observe route view pipeline">
          <div className="mf-flow-step">
            <span>01</span>
            <b>Observe</b>
            <p>screen, browser, repo, audio, memory, active thread</p>
          </div>
          <div className="mf-flow-step">
            <span>02</span>
            <b>Route</b>
            <p>research, writing, planning, toolsmith, language review</p>
          </div>
          <div className="mf-flow-step">
            <span>03</span>
            <b>Compile Views</b>
            <p>evidence, intent, workflow, advice, task, draft, memory</p>
          </div>
          <div className="mf-flow-step">
            <span>04</span>
            <b>Act</b>
            <p>ambient suggestions, background tasks, artifacts, agent handoff</p>
          </div>
        </div>
        <div className="mf-source-grid" aria-label="Sources and views">
          <div>
            <span>Sources</span>
            <b>Screenpipe</b>
            <b>Browser</b>
            <b>Git + project</b>
            <b>Runtime events</b>
          </div>
          <div>
            <span>Task shape</span>
            <b>Need research</b>
            <b>Continue writing</b>
            <b>Build a tool</b>
            <b>Review language</b>
          </div>
          <div>
            <span>Views</span>
            <b>brief.research</b>
            <b>advice.writing</b>
            <b>task.toolsmith</b>
            <b>memory.profile</b>
          </div>
        </div>
      </section>

      <section className="mf-stack" aria-label="MetaFlow runtime stack">
        <div className="mf-stack-visual" aria-hidden="true">
          <div className="mf-layer layer-one"><span>Evidence</span></div>
          <div className="mf-layer layer-two"><span>Views</span></div>
          <div className="mf-layer layer-three"><span>Programs</span></div>
          <div className="mf-layer layer-four"><span>Agents</span></div>
        </div>
        <div className="mf-stack-copy">
          <div className="mf-kicker">RUNTIME</div>
          <h2>Context becomes a surface agents can actually use.</h2>
          <p>
            Every signal is shaped into inspectable views before it becomes advice, a task, a draft, or a tool artifact.
            That keeps MetaFlow fast, local, and accountable.
          </p>
          <div className="mf-actions">
            <button type="button" onClick={() => onNavigate("ambient")}>Open Ambient</button>
            <button type="button" onClick={() => onNavigate("views")}>Inspect Views</button>
            <button type="button" onClick={() => onNavigate("timeline")}>Read Timeline</button>
          </div>
        </div>
      </section>

      <section className="mf-status" aria-label="Current runtime status">
        <Stat label="Items" value={stats.items} />
        <Stat label="Screenpipe" value={stats.screenpipe} />
        <Stat label="Last seen" value={stats.last} />
        <div className="status-text">{status}</div>
      </section>
    </section>
  );
}

function MetaFlowField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const surface = canvas;
    const ctx = context;

    let frame = 0;
    let animation = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    function resize() {
      const rect = surface.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      surface.width = Math.floor(width * dpr);
      surface.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      frame += 0.0075;
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#071d36");
      gradient.addColorStop(0.46, "#0c3140");
      gradient.addColorStop(1, "#062522");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (let band = 0; band < 18; band += 1) {
        const yBase = height * (0.17 + band * 0.042);
        const hue = band % 3 === 0 ? "151, 229, 206" : band % 3 === 1 ? "98, 178, 255" : "239, 232, 203";
        ctx.beginPath();
        for (let x = -40; x <= width + 40; x += 18) {
          const drift = Math.sin(x * 0.008 + frame * (1.8 + band * 0.02) + band * 0.67) * (24 + band * 0.9);
          const pulse = Math.cos(x * 0.014 - frame * 1.3 + band) * 8;
          const y = yBase + drift + pulse + Math.sin(frame + band) * 20;
          if (x === -40) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${hue}, ${0.08 + band * 0.006})`;
        ctx.lineWidth = band % 4 === 0 ? 1.6 : 0.8;
        ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.88;
      for (let i = 0; i < 90; i += 1) {
        const phase = frame * (0.5 + (i % 7) * 0.05) + i * 2.17;
        const x = (width * (0.08 + ((i * 37) % 100) / 118) + Math.sin(phase) * 46) % width;
        const y = height * (0.16 + ((i * 23) % 100) / 134) + Math.cos(phase * 0.9) * 34;
        const radius = i % 9 === 0 ? 2.2 : 1.15;
        ctx.fillStyle = i % 5 === 0 ? "rgba(181, 255, 221, 0.72)" : "rgba(222, 245, 235, 0.42)";
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      const shade = ctx.createRadialGradient(width * 0.5, height * 0.5, height * 0.08, width * 0.5, height * 0.55, height * 0.78);
      shade.addColorStop(0, "rgba(255,255,255,0)");
      shade.addColorStop(1, "rgba(0,0,0,0.48)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      animation = window.requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(animation);
    };
  }, []);

  return <canvas ref={canvasRef} className="mf-field" aria-hidden="true" />;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="stat"><span>{label}</span><b>{value}</b></div>;
}

function Signal({ label, values }: { label: string; values?: string[] }) {
  const shown = values?.filter(Boolean).slice(0, 5) ?? [];
  return <div className="signal"><span>{label}</span><div>{shown.length ? shown.map(value => <Tag key={value}>{value}</Tag>) : <em>—</em>}</div></div>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="tag">{children}</span>;
}

function AttributionStrip({ item }: { item: TimelineItem }) {
  const entries = attributionEntries(item);
  if (!entries.length) return null;
  return (
    <div className="attribution-strip" aria-label="Attribution signals">
      {entries.map(([label, value]) => <span key={label}><b>{label}</b>{value}</span>)}
    </div>
  );
}

function summarize(buckets: TimelineBucket[], tick: RuntimeTickResponse | null) {
  const items = buckets.reduce((sum, bucket) => sum + bucket.items.length, 0);
  const screenpipe = tick?.diagnostics?.screenpipe_activity?.count ?? countScreenpipe(buckets);
  const latest = buckets.flatMap(bucket => bucket.items).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0]?.observed_at;
  return { items, screenpipe, last: relativeTime(latest) || "—" };
}

function countScreenpipe(buckets: TimelineBucket[]) {
  return buckets.flatMap(bucket => bucket.items).filter(item => item.source.toLowerCase().includes("screenpipe") || item.schema?.includes("screenpipe")).length;
}

function findItem(buckets: TimelineBucket[], id: string | null) {
  if (!id) return undefined;
  return buckets.flatMap(bucket => bucket.items).find(item => item.id === id);
}

function filterBuckets(buckets: TimelineBucket[], filter: SourceFilter, detailMode: DetailMode): TimelineBucket[] {
  void detailMode;
  return buckets.map(bucket => {
    const items = bucket.items.filter(item => sourceMatches(item, filter));
    return {
      ...bucket,
      count: items.length,
      items,
      top_sources: top(items.map(item => item.source), 5),
      top_apps: top(items.map(item => item.app).filter(Boolean) as string[], 5),
      top_domains: top(items.map(item => item.domain).filter(Boolean) as string[], 5),
      top_projects: top(items.map(item => item.project).filter(Boolean) as string[], 5),
    };
  }).filter(bucket => bucket.items.length > 0);
}

function sourceMatches(item: TimelineItem, filter: SourceFilter) {
  if (filter === "all") return true;
  const hay = `${item.source} ${item.schema ?? ""} ${item.kind} ${item.event_type ?? ""}`.toLowerCase();
  return hay.includes(filter);
}

function sourceFilterLabel(filter: SourceFilter) {
  if (filter === "screenpipe") return "Screenpipe";
  if (filter === "browser") return "Browser";
  if (filter === "runtime") return "Runtime";
  return "All sources";
}

function viewFamilyLabel(family: string) {
  const definition = currentViewCatalogDefinition(family);
  if (definition?.label) return definition.label;
  const labels: Record<string, string> = {
    "state.surface": "Current Surface",
    "work.focus_set": "Work Focus Set",
    "project.current": "Current Project",
    "memory.daily": "Daily Memory",
    "memory.profile": "Memory Profile",
    evidence: "EvidenceView",
    visual_frame: "VisualFrameView",
    audio: "AudioView",
    activity: "ActivityView",
    activity_block: "ActivityBlockView",
    proposal: "ProposalView",
    intent: "IntentView",
    workflow: "WorkflowView",
    memory: "MemoryView",
    resource: "ResourceView",
    "thread.active_work": "Active Work",
    "project.current_context": "Project Context",
    "brief.research": "Research Brief",
    "brief.background_research": "Background Research",
    "advice.research": "Research Advice",
    "agent.task_list": "Agent Task List",
    "advice.writing_assist": "Writing Assist",
    "task.background_research": "Research Task",
    "draft.writing_continuation": "Writing Draft",
    "opportunity.tool": "Tool Opportunity",
    "task.toolsmith_prototype": "Toolsmith Task",
    "draft.tool_prototype": "Tool Prototype",
    "tool.prototype_artifact": "Tool Artifact",
    answer: "AnswerView",
  };
  return labels[family] ?? family;
}

function isAgentSurfaceView(type: string) {
  return ["state.surface", "work.focus_set", "project.current", "memory.daily", "memory.profile"].includes(type);
}

function viewPrimaryBadge(view: ContextViewSummary): string | undefined {
  if (isAgentSurfaceView(view.view_type)) return sourceSummary(view);
  return typeof view.confidence === "number" ? `${Math.round(view.confidence * 100)}%` : undefined;
}

function sourceSummary(view: ContextViewSummary): string | undefined {
  const total = sourceRecordCount(view) + sourceViewCount(view);
  if (total > 0) return `${total} source${total === 1 ? "" : "s"}`;
  return compilerId(view) || "provenance";
}

function compactNumber(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function viewGroupSummaries(families: ViewFamilySummary[]) {
  const byType = new Map(families.map(family => [family.family, family]));
  const used = new Set<string>();
  const groups = VIEW_GROUPS.map(group => {
    const types = group.types.filter(type => byType.has(type) || currentViewCatalogDefinition(type));
    types.forEach(type => used.add(type));
    return {
      ...group,
      types,
      count: types.reduce((sum, type) => sum + (byType.get(type)?.count ?? 0), 0),
    };
  });
  const otherTypes = viewTypeOrder({ families }).filter(type => !used.has(type));
  if (otherTypes.length) {
    groups.push({
      id: "other",
      title: "Other",
      subtitle: "less common runtime views",
      types: otherTypes,
      count: otherTypes.reduce((sum, type) => sum + (byType.get(type)?.count ?? 0), 0),
    });
  }
  return groups.filter(group => group.types.length);
}

function firstPopulatedType(group: { types: string[] }, familyByType: Map<string, ViewFamilySummary>) {
  return group.types.find(type => (familyByType.get(type)?.count ?? 0) > 0);
}

function initialViewPageSize(type: string) {
  if (type === "evidence" || type === "visual_frame" || type === "activity") return 24;
  if (type === "audio" || type === "activity_block" || type === "proposal") return 36;
  if (type.startsWith("advice.") || type.startsWith("task.") || type.startsWith("draft.") || type.startsWith("opportunity.")) return 30;
  return 20;
}

function viewPageSize(type: string) {
  const catalogSize = currentViewCatalogDefinition(type)?.default_page_size;
  const localSize = type === "state.surface" || type === "work.focus_set" || type === "project.current" ? 40 : type === "memory.daily" || type === "memory.profile" ? 30 : type === "evidence" || type === "activity" ? 80 : type === "visual_frame" || type === "proposal" ? 60 : type.startsWith("advice.") || type.startsWith("task.") || type.startsWith("draft.") || type.startsWith("opportunity.") ? 60 : 48;
  return Math.min(catalogSize ?? localSize, localSize);
}

function viewTypePurpose(type: string) {
  const definition = currentViewCatalogDefinition(type);
  if (definition?.purpose) return definition.purpose;
  const labels: Record<string, string> = {
    "state.surface": "current user surface",
    "work.focus_set": "current focus lanes",
    "project.current": "project identity and current state",
    "memory.daily": "daily memory",
    "memory.profile": "durable memory profile",
    evidence: "raw evidence",
    visual_frame: "screen semantics",
    audio: "speech semantics",
    activity: "time chunk",
    activity_block: "10m block",
    proposal: "next view",
    resource: "material",
    intent: "goal signal",
    workflow: "work session",
    memory: "agent memory",
    "thread.active_work": "current focus",
    "project.current_context": "project state",
    "brief.research": "research synthesis",
    "brief.background_research": "background search",
    "advice.research": "surface suggestion",
    "agent.task_list": "agent task queue",
    "advice.writing_assist": "inline help",
    "task.background_research": "delegated search",
    "draft.writing_continuation": "editable text",
    "opportunity.tool": "workflow improvement",
    "task.toolsmith_prototype": "tool design task",
    "draft.tool_prototype": "prototype plan",
    "tool.prototype_artifact": "sandbox artifact",
  };
  return labels[type] ?? "view";
}

function compilerId(view: { compiler?: { id?: string } | string }) {
  if (typeof view.compiler === "string") return view.compiler;
  return view.compiler?.id ?? "";
}

function sourceRecordCount(view: ContextViewSummary) {
  return view.source_record_count ?? view.source_records?.length ?? 0;
}

function sourceViewCount(view: ContextViewSummary) {
  return view.source_view_count ?? view.source_views?.length ?? 0;
}

function groupViews(views: ViewFamiliesResponse["views"]) {
  const order = FALLBACK_VIEW_TYPE_ORDER;
  const byType = new Map<string, ViewFamiliesResponse["views"]>();
  for (const view of views) {
    const group = byType.get(view.view_type) ?? [];
    group.push(view);
    byType.set(view.view_type, group);
  }
  return [...byType.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a[0].localeCompare(b[0]);
    })
    .map(([type, groupedViews]) => ({ type, views: groupedViews.slice(0, 24) }));
}

function summarizeSignals(buckets: TimelineBucket[]) {
  const items = buckets.flatMap(bucket => bucket.items);
  return {
    top_sources: top(items.map(item => item.source), 10),
    top_apps: top(items.map(item => item.app).filter(Boolean) as string[], 10),
    top_domains: top(items.map(item => item.domain).filter(Boolean) as string[], 10),
  };
}

function dominantLabel(bucket: TimelineBucket) {
  return bucket.top_apps[0] || bucket.top_domains[0] || bucket.top_projects[0] || bucket.top_sources[0] || "activity";
}

function chooseBucket(minutes: number) {
  if (minutes <= 90) return 5;
  if (minutes <= 240) return 10;
  if (minutes <= 720) return 20;
  return 30;
}

function timelineUiRecordLimit(minutes: number, sourceFilter: SourceFilter, detailMode: DetailMode) {
  if (detailMode === "debug") {
    const samplesPerMinute = sourceFilter === "runtime" ? 2 : sourceFilter === "browser" ? 8 : sourceFilter === "screenpipe" ? 10 : 12;
    return Math.min(2_400, Math.max(400, Math.ceil(minutes * samplesPerMinute)));
  }
  const samplesPerMinute = sourceFilter === "runtime" ? 1 : sourceFilter === "browser" ? 2 : sourceFilter === "screenpipe" ? 3 : 4;
  return Math.min(720, Math.max(160, Math.ceil(minutes * samplesPerMinute)));
}

function iconFor(item: TimelineItem) {
  const hay = `${item.source} ${item.schema ?? ""} ${item.kind}`.toLowerCase();
  if (hay.includes("screenpipe")) return "◉";
  if (hay.includes("browser")) return "↗";
  if (hay.includes("runtime")) return "◆";
  if (hay.includes("local") || hay.includes("git")) return "⌘";
  if (hay.includes("ai") || hay.includes("claude") || hay.includes("codex")) return "AI";
  return "•";
}

function sourceClass(item: TimelineItem) {
  const hay = `${item.source} ${item.schema ?? ""} ${item.kind}`.toLowerCase();
  if (hay.includes("screenpipe")) return "screenpipe";
  if (hay.includes("browser")) return "browser";
  if (hay.includes("runtime")) return "runtime";
  return "other";
}

function sourceLabel(item: TimelineItem) {
  return [item.schema, item.event_type, item.app, item.domain].filter(Boolean).join(" · ");
}

function detailTags(item: TimelineItem) {
  const stats = item.stats ?? {};
  const pairs: string[] = [];
  if (typeof stats.duration_minutes === "number" && Number.isFinite(stats.duration_minutes)) pairs.push(`duration: ${formatDuration(Number(stats.duration_minutes))}`);
  for (const key of ["content_type", "role", "frame_id", "minutes", "frame_count", "node_count", "text_source", "capture_trigger", "attribution_source"] as const) {
    if (stats[key] !== undefined && stats[key] !== "") pairs.push(`${key}: ${stats[key]}`);
  }
  return pairs.slice(0, 8);
}

function formatDuration(minutes: number) {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function attributionEntries(item: TimelineItem): Array<[string, string]> {
  const stats = item.stats ?? {};
  const entries: Array<[string, unknown]> = [
    ["interaction", stats.interaction_app],
    ["interaction event", stats.interaction_event],
    ["reported app", stats.reported_app ?? stats.app_name ?? item.app],
    ["visible", stats.visible_label],
    ["visual domain", stats.visual_domain ?? item.domain],
    ["window", stats.window_title ?? stats.window_name],
    ["reported url", stats.reported_url ?? stats.browser_url ?? item.url],
    ["source", stats.attribution_source],
  ];
  const seen = new Set<string>();
  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .filter(([label, value]) => {
      const key = `${label}:${value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function detailCode(item: TimelineItem) {
  const stats = item.stats ?? {};
  return String(stats.browser_url ?? stats.project_path ?? stats.repo ?? stats.window_name ?? "");
}

function frameIdOf(item: TimelineItem): string | number | undefined {
  const value = item.stats?.frame_id;
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function frameIdsOf(item: TimelineItem): Array<string | number> {
  const values: Array<string | number> = [];
  const raw = item.stats?.frame_ids;
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === "string" || typeof value === "number") values.push(value);
    }
  }
  const single = frameIdOf(item);
  if (single !== undefined) values.push(single);
  const seen = new Set<string>();
  return values.filter(value => {
    const key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringStat(item: TimelineItem, key: string): string | undefined {
  const value = item.stats?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function formatRange(start: string, end: string) {
  return `${timeOfDay(start)} – ${timeOfDay(end)}`;
}

function timeOfDay(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function relativeTime(iso?: string) {
  if (!iso) return "";
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "";
  const seconds = Math.max(1, Math.round(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function top(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, limit);
}

createRoot(document.getElementById("root")!).render(<App />);

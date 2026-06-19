import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronLeft, ChevronRight, CircleDotDashed, FileText, Home, Search, Settings } from "lucide-react";
import { createContextView, fetchActivityTimeline, fetchActivityTimelineWatermark, fetchAudioTranscripts, fetchContextView, fetchLatestActivityTimelineView, fetchProcessors, fetchRecentRecords, fetchRuntimeSettings, fetchViewFamilies, fetchViewsByType, fetchViewsByTypes, patchViewStatus, runProcessor, runRuntimeTick, saveRuntimeSettings, screenpipeFrameUrl, submitViewFeedback, syncScreenpipe, updateContextView } from "./api";
import type { ActivityTimelineResponse, AudioTranscriptItem, ContextRecordSummary, ContextViewInput, ContextViewSummary, ContextViewUpdateInput, ProcessorDefinitionSummary, RuntimeSettings, RuntimeTickResponse, TimelineBucket, TimelineItem, ViewCatalogResponse, ViewFamiliesResponse, ViewFamilyDefinition, ViewFamilySummary, ViewStatus } from "./types";
import metaflowMarkUrl from "./assets/metaflow-mark.png";
import "./styles.css";

const TIMELINE_WATERMARK_POLL_MS = 5_000;
const VIEW_REFRESH_POLL_MS = 15_000;
const DEFAULT_BUCKET_MINUTES = 60;
const DEFAULT_TIMELINE_MINUTES = 24 * 60;
const TIMELINE_DAY_RECORD_LIMIT = 1_200;
const FALLBACK_VIEW_TYPE_ORDER = [
  "state.surface", "work.focus_set", "project.current", "memory.daily", "memory.profile",
  "evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow", "memory",
  "thread.active_work", "project.current_context", "brief.research", "brief.background_research",
  "advice.research", "advice.writing_assist",
  "agent.task_list",
  "task.background_research", "draft.writing_continuation",
  "opportunity.tool", "task.toolsmith_prototype", "draft.tool_prototype", "tool.prototype_artifact",
  "learning.review_queue", "memory.language.difficult_segments",
];
const AMBIENT_VIEW_TYPES = [
  "advice.research",
  "agent.task_list",
  "task.background_research",
  "brief.background_research",
  "advice.writing_assist",
  "draft.writing_continuation",
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
    types: ["memory.profile", "memory.daily", "memory.preferences", "memory.workflow_patterns", "memory.skill_gaps", "memory.agent_collaboration_style", "agent.case_memory", "memory", "brief.research", "brief.background_research", "resource"],
  },
  {
    id: "learning",
    title: "Learning",
    subtitle: "review and difficult segments",
    types: ["learning.review_queue", "learning.youtube_fragment", "memory.language.difficult_segments", "app.language.review_queue"],
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
const DEFAULT_VIEW_TYPE = "state.surface";
const VIEW_CATALOG_CACHE = new Map<string, ViewFamilyDefinition>();
let VIEW_CATALOG_ORDER_CACHE: string[] = FALLBACK_VIEW_TYPE_ORDER;
type SourceFilter = "screenpipe" | "browser" | "runtime" | "all";
type DetailMode = "activity" | "debug";
type ActiveTab = "home" | "timeline" | "ambient" | "views" | "settings";
type SidebarItem = {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  tab: ActiveTab;
};
type FramePreview = { frameId: string | number; title?: string };
type TimelineSyncState = "idle" | "syncing" | "error";
type FocusSegment = {
  id: string;
  title: string;
  subtitle?: string;
  app?: string;
  domain?: string;
  url?: string;
  sourceClass: string;
  sources: string[];
  items: TimelineItem[];
  start: string;
  end: string;
  durationMinutes?: number;
  samples: number;
  frameIds: Array<string | number>;
  screenshotCount: number;
  dwellSeconds?: number;
  scrollDepth?: number;
  text?: string;
};
type FocusBucket = {
  label: string;
  start: string;
  end: string;
  count: number;
  dominant: string;
  segments: FocusSegment[];
};
type AudioTimelineItem = {
  id: string;
  text: string;
  observed_at?: string;
  ended_at?: string;
  speaker_label?: string;
  device_name?: string;
  quality?: string;
  source: "screenpipe" | "audio_view";
  chunk_count?: number;
  chunk_id?: string | number;
  start_time?: number;
  end_time?: number;
  view?: ContextViewSummary;
};
type ViewListGroup = {
  key: string;
  view: ContextViewSummary;
  views: ContextViewSummary[];
};
const TIMELINE_WINDOWS = [
  { label: "15分", value: 15 },
  { label: "30分", value: 30 },
  { label: "60分", value: 60 },
];
const VIEW_FAMILIES_CACHE_KEY = "metaflow.viewFamilies.v1";
const VIEW_TYPE_VIEWS_CACHE_KEY = "metaflow.viewTypeViews.v1";
const TIMELINE_CACHE_KEY = "metaflow.timeline.v1";
const SIDEBAR_COLLAPSED_CACHE_KEY = "metaflow.sidebar.collapsed.v1";
let AMBIENT_VIEWS_MEMORY_CACHE: { views: ContextViewSummary[]; status: string } | null = null;
let RUNTIME_SETTINGS_MEMORY_CACHE: { settings: RuntimeSettings; status: string } | null = null;

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "home", label: "Home", icon: Home, tab: "home" },
  { id: "timeline", label: "Timeline", icon: Search, tab: "timeline" },
  { id: "ambient", label: "Ambient", icon: CircleDotDashed, tab: "ambient" },
  { id: "views", label: "Views", icon: FileText, tab: "views" },
  { id: "settings", label: "Settings", icon: Settings, tab: "settings" },
];

function App() {
  const initialViewCache = useMemo(() => loadCachedViewFamilies(), []);
  const initialTimelineCache = useMemo(() => loadCachedTimeline(), []);
  const [timeline, setTimeline] = useState<ActivityTimelineResponse | null>(initialTimelineCache?.response ?? null);
  const [viewFamilies, setViewFamilies] = useState<ViewFamiliesResponse | null>(initialViewCache?.response ?? null);
  const [lastTick, setLastTick] = useState<RuntimeTickResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewsLoading, setViewsLoading] = useState(false);
  const [timelineSyncState, setTimelineSyncState] = useState<TimelineSyncState>("idle");
  const [timelineSyncStatus, setTimelineSyncStatus] = useState("");
  const [live, setLive] = useState(true);
  const [status, setStatus] = useState(initialTimelineCache ? cachedTimelineStatus(initialTimelineCache.response, initialTimelineCache.cachedAt) : "Connecting…");
  const [viewStatus, setViewStatus] = useState(initialViewCache ? cachedViewsStatus(initialViewCache.response, initialViewCache.cachedAt) : "Views not loaded");
  const [settingsStatus, setSettingsStatus] = useState("Settings not loaded");
  const [bucketMinutes, setBucketMinutes] = useState(DEFAULT_BUCKET_MINUTES);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [detailMode, setDetailMode] = useState<DetailMode>("activity");
  const [activeTab, setActiveTab] = useState<ActiveTab>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_CACHE_KEY) === "1");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [viewComposerOpen, setViewComposerOpen] = useState(false);
  const [previewFrame, setPreviewFrame] = useState<FramePreview | null>(null);
  const refreshSeq = useRef(0);
  const viewRefreshSeq = useRef(0);
  const viewFamiliesInFlightRef = useRef(false);
  const viewCacheMsRef = useRef(initialViewCache?.cachedAt ?? 0);
  const timelineCacheMsRef = useRef(initialTimelineCache?.cachedAt ?? 0);
  const timelineSignatureRef = useRef(initialTimelineCache?.signature ?? timelineSignature(bucketMinutes, detailMode, sourceFilter));
  const timelineInFlightSignatureRef = useRef<string | null>(null);
  const timelineSyncInFlightRef = useRef(false);
  const timelineWatermarkRef = useRef(initialTimelineCache?.watermark ?? "");
  const timelineWatermarkInFlightRef = useRef(false);

  async function refresh(options: boolean | { quiet?: boolean; force?: boolean } = false) {
    const quiet = typeof options === "boolean" ? options : options.quiet ?? false;
    const force = typeof options === "boolean" ? true : options.force ?? true;
    if (!force && timeline) {
      const age = timelineCacheMsRef.current ? relativeTime(new Date(timelineCacheMsRef.current).toISOString()) : "cached";
      setStatus(`${timeline.records_used} records · ${timeline.buckets.length} buckets · cached ${age}`);
      return;
    }
    const requestSignature = timelineSignature(bucketMinutes, detailMode, sourceFilter);
    if (timelineInFlightSignatureRef.current === requestSignature) return;
    timelineInFlightSignatureRef.current = requestSignature;
    const seq = ++refreshSeq.current;
    if (!quiet) {
      setLoading(true);
      setStatus("Loading timeline…");
    }
    try {
      const debugMode = detailMode === "debug";
      const sourceNeedsRawRecords = sourceFilter === "screenpipe" || sourceFilter === "runtime";
      const rawMode = debugMode || sourceNeedsRawRecords;
      const range = todayRange();
      const rangeMinutes = timelineRangeMinutes(range);
      const next = await fetchActivityTimeline({
        minutes: rangeMinutes,
        startTime: range.start,
        endTime: range.end,
        limit: timelineUiRecordLimit(rangeMinutes, sourceFilter, detailMode),
        bucketMinutes,
        includeLowLevelScreenpipe: rawMode,
        includeRuntimeEvents: debugMode || sourceFilter === "runtime",
        dedupe: sourceNeedsRawRecords ? false : !debugMode,
        bucketItemLimit: rawMode ? 80 : 18,
        summarizeHeartbeats: !rawMode,
        sourceFilter,
        mergeContinuous: sourceFilter !== "screenpipe",
        mergeGapMinutes: rawMode ? 3 : 8,
        write: true,
      });
      if (seq !== refreshSeq.current) return;
      setTimeline(next);
      timelineCacheMsRef.current = Date.now();
      timelineSignatureRef.current = requestSignature;
      const watermark = timelineWatermarkRef.current || timelineWatermarkFromResponse(next);
      timelineWatermarkRef.current = watermark;
      saveCachedTimeline(next, timelineCacheMsRef.current, timelineSignatureRef.current, watermark);
      const windows = lastTick?.diagnostics?.screenpipe_activity?.count ?? 0;
      setStatus(`${next.records_used} records · ${next.buckets.length} buckets · ${windows} Screenpipe windows`);
    } catch (error) {
      if (seq !== refreshSeq.current) return;
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (timelineInFlightSignatureRef.current === requestSignature) timelineInFlightSignatureRef.current = null;
      if (seq === refreshSeq.current && !quiet) setLoading(false);
    }
  }

  async function hydrateLatestTimelineView() {
    if (timeline) return;
    try {
      const cached = await fetchLatestActivityTimelineView({ todayOnly: true });
      if (!cached) return;
      setTimeline(cached);
      timelineCacheMsRef.current = Date.now();
      timelineSignatureRef.current = timelineSignature(bucketMinutes, detailMode, sourceFilter);
      const watermark = timelineWatermarkFromResponse(cached);
      timelineWatermarkRef.current = watermark;
      saveCachedTimeline(cached, timelineCacheMsRef.current, timelineSignatureRef.current, watermark);
      setStatus(`${cached.records_used} records · ${cached.buckets.length} buckets · latest compiled view`);
    } catch {
      // The compile path below can still populate the timeline.
    }
  }

  async function refreshViews(options: boolean | { quiet?: boolean; force?: boolean } = false) {
    const quiet = typeof options === "boolean" ? options : options.quiet ?? false;
    const force = typeof options === "boolean" ? false : options.force ?? false;
    const hasCachedViews = Boolean(viewFamilies);
    if (!force && hasCachedViews) {
      setViewStatus(cachedViewsStatus(viewFamilies!, viewCacheMsRef.current));
      return;
    }
    if (viewFamiliesInFlightRef.current) return;
    viewFamiliesInFlightRef.current = true;
    const seq = ++viewRefreshSeq.current;
    if (!quiet) {
      setViewsLoading(true);
      setViewStatus("Loading views…");
    } else if (!hasCachedViews) {
      setViewStatus("Loading views…");
    }
    try {
      const next = await fetchViewFamilies();
      if (seq !== viewRefreshSeq.current) return;
      rememberViewCatalog(next.catalog);
      setViewFamilies(next);
      viewCacheMsRef.current = Date.now();
      saveCachedViewFamilies(next, viewCacheMsRef.current);
      const aiViews = next.views.filter(view => compilerId(view).startsWith("ai.")).length;
      setViewStatus(`${next.views.length} active views · ${aiViews} AI-compressed`);
    } catch (error) {
      if (seq !== viewRefreshSeq.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setViewStatus(hasCachedViews ? `Showing cached views · refresh failed: ${message}` : message);
    } finally {
      if (seq === viewRefreshSeq.current) viewFamiliesInFlightRef.current = false;
      if (seq === viewRefreshSeq.current && !quiet) setViewsLoading(false);
    }
  }

  async function syncTimeline(options: { fullDay?: boolean; manual?: boolean } = {}) {
    if (timelineSyncInFlightRef.current) return;
    timelineSyncInFlightRef.current = true;
    setTimelineSyncState("syncing");
    setTimelineSyncStatus(options.manual ? "Syncing now..." : "Auto syncing...");
    if (options.manual) setStatus("Syncing Screenpipe…");
    try {
      const tick = await syncScreenpipe(options.fullDay ? timelineRangeMinutes(todayRange()) : liveSyncWindowMinutes());
      setLastTick(tick);
      const syncedWindows = tick.diagnostics?.screenpipe_activity?.count ?? 0;
      setTimelineSyncState("idle");
      setTimelineSyncStatus(`${syncedWindows} windows synced`);
      if (options.manual) setStatus(`${syncedWindows} Screenpipe windows synced · reloading timeline…`);
      await refresh({ quiet: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTimelineSyncState("error");
      setTimelineSyncStatus(message);
      if (options.manual) setStatus(message);
    } finally {
      timelineSyncInFlightRef.current = false;
    }
  }

  async function checkTimelineWatermark(options: { refreshOnChange?: boolean; forceRefresh?: boolean } = {}) {
    if (timelineWatermarkInFlightRef.current) return;
    timelineWatermarkInFlightRef.current = true;
    try {
      const next = await fetchActivityTimelineWatermark({
        minutes: 24 * 60,
        sourceFilter,
        includeRuntimeEvents: detailMode === "debug" || sourceFilter === "runtime",
      });
      const previous = timelineWatermarkRef.current;
      timelineWatermarkRef.current = next.watermark;
      if (options.forceRefresh || (options.refreshOnChange !== false && previous && previous !== next.watermark)) {
        setTimelineSyncStatus("New activity detected");
        await refresh({ quiet: true, force: true });
        return;
      }
      if (!previous) {
        setTimelineSyncStatus(next.latest_observed_at ? `Live · latest ${relativeTime(next.latest_observed_at)}` : "Watching for activity");
      } else {
        setTimelineSyncStatus(next.latest_observed_at ? `Live · latest ${relativeTime(next.latest_observed_at)}` : "Live · watching");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTimelineSyncState("error");
      setTimelineSyncStatus(message);
    } finally {
      timelineWatermarkInFlightRef.current = false;
    }
  }

  async function syncNow() {
    await syncTimeline({ fullDay: true, manual: true });
  }

  async function showTodayTimeline() {
    setTimelineSyncStatus("Loading today...");
    await refresh({ quiet: false, force: true });
  }

  useEffect(() => {
    if (activeTab !== "views") return;
    refreshViews({ quiet: Boolean(viewFamilies), force: true }).catch(error => setViewStatus(error instanceof Error ? error.message : String(error)));
  }, [activeTab]);

  useEffect(() => {
    if (!live) return;
    if (activeTab !== "views") return;
    const timer = window.setInterval(() => {
      refreshViews({ quiet: true, force: true }).catch(() => undefined);
    }, VIEW_REFRESH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeTab, live]);

  useEffect(() => {
    if (activeTab !== "timeline") return;
    const force = !isTodayTimelineResponse(timeline) || timelineSignatureRef.current !== timelineSignature(bucketMinutes, detailMode, sourceFilter);
    hydrateLatestTimelineView().catch(() => undefined);
    if (!timeline) {
      setStatus(initialTimelineCache ? cachedTimelineStatus(initialTimelineCache.response, timelineCacheMsRef.current) : "Loading latest timeline view...");
      refresh({ quiet: true, force: true }).catch(error => setStatus(error instanceof Error ? error.message : String(error)));
    } else {
      if (force) refresh({ quiet: true, force: true }).catch(error => setStatus(error instanceof Error ? error.message : String(error)));
    }
    checkTimelineWatermark({ refreshOnChange: false }).catch(error => setTimelineSyncStatus(error instanceof Error ? error.message : String(error)));
  }, [activeTab, bucketMinutes, detailMode, sourceFilter, live]);

  useEffect(() => {
    if (!live) return;
    if (activeTab !== "timeline") return;
    const timer = window.setInterval(() => {
      checkTimelineWatermark({ refreshOnChange: true }).catch(() => undefined);
    }, TIMELINE_WATERMARK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeTab, live, bucketMinutes, detailMode, sourceFilter]);

  useEffect(() => {
    if (!previewFrame) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPreviewFrame(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewFrame]);

  const filteredBuckets = useMemo(() => filterBuckets(timeline?.buckets ?? [], sourceFilter, detailMode), [timeline, sourceFilter, detailMode]);
  const filteredSignals = useMemo(() => summarizeSignals(filteredBuckets), [filteredBuckets]);
  const stats = useMemo(() => summarize(filteredBuckets, lastTick), [filteredBuckets, lastTick]);
  const shellClass = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    activeTab === "home" ? "home-mode" : "",
    activeTab === "views" || activeTab === "ambient" ? "workspace-mode" : "",
    activeTab === "views" ? "views-mode" : "",
    activeTab === "timeline" ? "timeline-mode" : "",
    activeTab === "settings" ? "settings-mode" : "",
  ].filter(Boolean).join(" ");

  function toggleSidebar() {
    setSidebarCollapsed(value => {
      const next = !value;
      localStorage.setItem(SIDEBAR_COLLAPSED_CACHE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div className={shellClass}>
      <RuntimeSidebar activeTab={activeTab} collapsed={sidebarCollapsed} live={live} onNavigate={setActiveTab} onToggleCollapse={toggleSidebar} />

      <main className="page">
        {activeTab === "home" ? (
          <MetaFlowHome onNavigate={setActiveTab} live={live} stats={stats} status={status} />
        ) : (
          <>
            <header className="page-header">
              <div>
                <div className="breadcrumb">MetaFlow / Local runtime</div>
                <h1>{pageTitle(activeTab)}</h1>
                <p>{pageDescription(activeTab)}</p>
              </div>
              <div className="header-actions">
                {activeTab === "timeline" ? (
                  <>
                    <div className="timeline-window-switch" role="group" aria-label="Timeline window">
                      <button className={detailMode === "activity" ? "active" : ""} type="button" onClick={() => setDetailMode("activity")}>事件</button>
                      {TIMELINE_WINDOWS.slice(0, 3).map(option => (
                        <button key={option.value} className={bucketMinutes === option.value ? "active" : ""} type="button" onClick={() => setBucketMinutes(option.value)}>{option.label}</button>
                      ))}
                    </div>
                    <button className="secondary today-button" type="button" onClick={showTodayTimeline} disabled={loading}>{loading ? "加载中" : "今天"}</button>
                    <button className="secondary" onClick={() => setDetailMode(value => value === "debug" ? "activity" : "debug")}>{detailMode === "debug" ? "事件" : "原始"}</button>
                    <button className="secondary" onClick={() => setLive(value => !value)}>{live ? "Live" : "Paused"}</button>
                    <button className="secondary" onClick={() => refresh(false)} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
                    <button onClick={syncNow} disabled={timelineSyncState === "syncing"}>{timelineSyncState === "syncing" ? "Auto syncing..." : "Sync now"}</button>
                  </>
                ) : activeTab === "views" ? (
                  <>
                    <button className="secondary" onClick={() => setViewComposerOpen(true)}>Create View</button>
                    <button onClick={() => refreshViews({ force: true })} disabled={viewsLoading}>{viewsLoading ? "Loading…" : "Reload Views"}</button>
                  </>
                ) : activeTab === "ambient" ? (
                  <button onClick={() => setViewStatus("Ambient panel has local controls")}>Ambient Controls</button>
                ) : activeTab === "settings" ? (
                  <button onClick={() => setSettingsStatus("Reload settings from panel")}>Runtime Controls</button>
                ) : (
                  null
                )}
              </div>
            </header>

            {activeTab === "timeline" ? (
          <TimelineWorkbench
            timeline={timeline}
            buckets={filteredBuckets}
            signals={filteredSignals}
            stats={stats}
            loading={loading && !timeline}
            status={status}
            syncState={timelineSyncState}
            syncStatus={timelineSyncStatus}
            live={live}
            detailMode={detailMode}
            sourceFilter={sourceFilter}
            selectedItemId={selectedItemId}
            onSelect={(id) => setSelectedItemId(current => current === id ? null : id)}
            onOpenFrame={setPreviewFrame}
            onSourceFilter={setSourceFilter}
            onSync={syncNow}
          />
        ) : activeTab === "ambient" ? (
          <AmbientPanel />
        ) : activeTab === "views" ? (
          <MemoryViewsPanel response={viewFamilies} loading={viewsLoading && !viewFamilies} composerOpen={viewComposerOpen} onComposerClose={() => setViewComposerOpen(false)} onRefreshViews={() => refreshViews({ quiet: true, force: true })} />
        ) : (
          <RuntimeSettingsPanel initialStatus={settingsStatus} onStatus={setSettingsStatus} onTick={setLastTick} />
        )}
          </>
        )}
      </main>
      {activeTab === "home"
        ? null
        : null}
      <FrameLightbox preview={previewFrame} onClose={() => setPreviewFrame(null)} />
    </div>
  );
}

function RuntimeSidebar({ activeTab, collapsed, live, onNavigate, onToggleCollapse }: { activeTab: ActiveTab; collapsed: boolean; live: boolean; onNavigate: (tab: ActiveTab) => void; onToggleCollapse: () => void }) {
  return (
    <aside className="sidebar" data-collapsed={collapsed ? "true" : "false"}>
      <div className="sidebar-brand">
        <div className="sidebar-logo" aria-hidden="true">
          <img src={metaflowMarkUrl} alt="" />
        </div>
        {!collapsed && <b>MetaFlow</b>}
      </div>
      <nav className="nav-list" aria-label="App navigation">
        {SIDEBAR_ITEMS.map(item => {
          const Icon = item.icon;
          const active = item.tab === activeTab;
          return (
            <button
              key={item.id}
              className={`nav-item ${active ? "active" : ""}`}
              type="button"
              title={collapsed ? item.label : undefined}
              onClick={() => onNavigate(item.tab)}
            >
              <span className="nav-icon"><Icon size={19} strokeWidth={2.1} /></span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-lower">
        <div className="sidebar-status" title={live ? "Live sync" : "Paused"}>
          <div className={`live-dot ${live ? "on" : ""}`} />
          {!collapsed && <span>{live ? "Live sync" : "Paused"}</span>}
        </div>
        <button className="sidebar-collapse-button" type="button" onClick={onToggleCollapse} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <ChevronRight size={24} strokeWidth={2.3} /> : <ChevronLeft size={24} strokeWidth={2.3} />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

function pageTitle(tab: ActiveTab): string {
  if (tab === "timeline") return "Timeline";
  if (tab === "ambient") return "Ambient";
  if (tab === "views") return "Runtime Views";
  return "Runtime Settings";
}

function pageDescription(tab: ActiveTab): string {
  if (tab === "timeline") return "按时间整理最近 focus 的 app、网页和项目活动。";
  if (tab === "ambient") return "主动后台搜索、写作介入和小工具机会都会先沉淀成可检查的 Views。";
  if (tab === "views") return "查看 Observation 压缩和 ambient Programs 产出的 Evidence、Intent、Workflow、Advice、Task、Draft 和 Memory Views。";
  return "控制 VisionFrame、ActivityBlock、Intent 和 Workflow 压缩的模型与开关。";
}

function AmbientPanel() {
  const [views, setViews] = useState<ContextViewSummary[]>(() => AMBIENT_VIEWS_MEMORY_CACHE?.views ?? []);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ContextViewSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [status, setStatus] = useState(AMBIENT_VIEWS_MEMORY_CACHE?.status ?? "Ambient views not loaded");

  const sortedViews = useMemo(() => views.filter(isSurfaceableAmbientView).sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "")), [views]);
  const selectedSummary = sortedViews.find(view => view.id === selectedViewId) ?? sortedViews[0];
  const activeView = selectedDetail?.id === selectedSummary?.id ? selectedDetail : selectedSummary;
  const researchViews = sortedViews.filter(view => ["advice.research", "task.background_research", "brief.background_research"].includes(view.view_type));
  const queueViews = sortedViews.filter(view => ["agent.task_list"].includes(view.view_type));
  const writingViews = sortedViews.filter(view => ["advice.writing_assist", "draft.writing_continuation"].includes(view.view_type));
  const pendingTasks = sortedViews.filter(view => view.view_type.startsWith("task.") && !taskProcessedStatus(view));
  const processedTasks = sortedViews.filter(view => taskProcessedStatus(view) === "completed");

  useEffect(() => {
    if (AMBIENT_VIEWS_MEMORY_CACHE) return;
    void refreshAmbient();
  }, []);

  useEffect(() => {
    AMBIENT_VIEWS_MEMORY_CACHE = { views, status };
  }, [views, status]);

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

  async function markFeedback(view: ContextViewSummary, action: "use" | "dismiss", extra: Record<string, unknown> = {}) {
    setActionBusy(`${action}:${view.id}`);
    const type = action === "dismiss" ? "analysis.dismissed" : "analysis.useful";
    const value = action === "dismiss" ? "dismissed" : "useful";
    const lifecycleStatus: ViewStatus = action === "dismiss" ? "rejected" : "accepted";
    try {
      const updatedView = await patchViewStatus(view.id, lifecycleStatus);
      setViews(current => current.map(item => item.id === view.id ? { ...item, ...updatedView } : item));
      if (selectedDetail?.id === view.id) setSelectedDetail(updatedView);
      await submitViewFeedback({
        view_id: view.id,
        type,
        value,
        reason: action === "dismiss" ? `Dismissed ${view.view_type} from Ambient panel` : `Used ${view.view_type} from Ambient panel`,
        payload: {
          surface: "ambient.panel",
          action,
          view_type: view.view_type,
          lifecycle_status: lifecycleStatus,
          ...extra,
        },
      });
      setStatus(`${viewFamilyLabel(view.view_type)} marked ${value} · lifecycle ${lifecycleStatus}`);
      if (action === "dismiss") await refreshAmbient();
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
  const [settings, setSettings] = useState<RuntimeSettings | null>(() => RUNTIME_SETTINGS_MEMORY_CACHE?.settings ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(RUNTIME_SETTINGS_MEMORY_CACHE?.status ?? initialStatus);

  useEffect(() => {
    if (RUNTIME_SETTINGS_MEMORY_CACHE) return;
    void loadSettings();
  }, []);

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  useEffect(() => {
    if (!settings) return;
    RUNTIME_SETTINGS_MEMORY_CACHE = { settings, status };
  }, [settings, status]);

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

function ViewGraph({ families, selectedType, onSelectType }: { families: ViewFamilySummary[]; selectedType: string; onSelectType: (type: string, inspect?: boolean) => void }) {
  const [hoveredType, setHoveredType] = useState<string | null>(null);
  const baseNodes = useMemo(() => buildViewGraphNodes(families), [families]);
  const nodes = baseNodes;
  const selected = nodes.find(node => node.type === selectedType) ?? nodes[0];
  const focusedType = hoveredType ?? selected?.type;
  const derivations = useMemo(() => buildViewGraphDerivations(nodes), [nodes]);
  const edges = useMemo(() => buildViewGraphEdges(nodes, derivations, focusedType), [nodes, derivations, focusedType]);
  const canvasSize = useMemo(() => viewGraphCanvasSize(nodes), [nodes]);
  const focusedSummary = useMemo(() => focusedType ? viewGraphFocusSummary(focusedType, derivations) : "", [focusedType, derivations]);

  return (
    <section className="view-graph-app" aria-label="ViewGraph">
      <div className="view-graph-canvas">
        <div className="view-graph-stage" style={{ width: canvasSize.width, height: canvasSize.height }} onMouseLeave={() => setHoveredType(null)}>
        {VIEW_TREE_COLUMNS.map(column => (
          <span key={column.id} className="view-graph-lane" style={{ left: column.x, top: 32 }}>{column.title}</span>
        ))}
        <svg className="view-graph-edges" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} aria-hidden="true">
          <defs>
            <marker id="view-graph-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {edges.map(edge => (
            <path key={`${edge.from}-${edge.to}-${edge.kind}-${edge.source}`} d={edge.path} className={`view-graph-edge ${edge.kind} ${edge.related ? "related" : ""}`} />
          ))}
        </svg>
        {nodes.map(node => (
          <button
            key={node.type}
            type="button"
            className={`view-graph-node ${node.count ? "live" : "empty"} ${viewGraphInputCount(node.type, derivations) > 1 ? "merge" : ""} ${node.type === selected?.type ? "active" : ""} ${isLineageNode(node.type, focusedType, derivations) ? "lineage" : ""}`}
            style={{ left: node.x, top: node.y }}
            aria-label={`${viewFamilyLabel(node.type)} view node`}
            onMouseEnter={() => setHoveredType(node.type)}
            onFocus={() => setHoveredType(node.type)}
            onBlur={() => setHoveredType(null)}
            onClick={() => onSelectType(node.type, false)}
            onDoubleClick={() => onSelectType(node.type, true)}
          >
            <span>{node.cluster}</span>
            <b>{viewFamilyLabel(node.type)}</b>
            <em>{viewGraphNodeBadge(node, derivations, families.length > 0)}</em>
          </button>
        ))}
        </div>
      </div>
      <div className="view-graph-foot">
        <span>{focusedType ?? "view"}</span>
        <b>{focusedType ? viewFamilyLabel(focusedType) : "Select a node"}</b>
        <em>{focusedSummary || (focusedType ? viewTypePurpose(focusedType) : "Hover a card to trace local links. Click to select. Double-click to open records.")}</em>
      </div>
    </section>
  );
}

type ViewGraphNode = {
  type: string;
  cluster: string;
  x: number;
  y: number;
  count: number;
  family?: ViewFamilySummary;
  definition?: ViewFamilyDefinition;
  reason?: string;
};

type ViewGraphDerivation = {
  from: string;
  to: string;
  kind: "derived" | "merge" | "fallback";
  source: "catalog" | "fallback";
};

type ViewGraphEdge = ViewGraphDerivation & {
  path: string;
  related: boolean;
};

const VIEW_GRAPH_NODE_WIDTH = 156;
const VIEW_GRAPH_NODE_HALF = VIEW_GRAPH_NODE_WIDTH / 2;

const VIEW_TREE_COLUMNS = [
  { id: "Evidence", title: "Evidence", x: 96 },
  { id: "Signal", title: "Signals", x: 292 },
  { id: "Core", title: "Core", x: 488 },
  { id: "Project", title: "Project", x: 684 },
  { id: "Memory", title: "Memory", x: 880 },
  { id: "Work", title: "Work", x: 1076 },
  { id: "Artifact", title: "Artifact", x: 1272 },
];

const VIEW_BIRTH_PARENTS: Record<string, string[]> = {
  "state.surface": ["evidence"],
  "work.focus_set": ["state.surface"],
  "project.current": ["work.focus_set"],
  "project.current_context": ["project.current"],
  "project.inbox": ["project.current"],
  "project.tasks": ["project.inbox"],
  "project.decisions": ["project.current_context"],
  "project.memory": ["project.current"],
  project_timeline: ["project.current", "project.memory"],
  "summary.project_work_episode": ["project_timeline"],
  "memory.daily": ["project.current", "activity"],
  "memory.profile": ["memory.daily"],
  "memory.preferences": ["memory.daily"],
  "memory.workflow_patterns": ["memory.daily", "workflow"],
  "memory.skill_gaps": ["memory.daily"],
  "memory.agent_collaboration_style": ["memory.daily"],
  "memory.language.difficult_segments": ["learning.youtube_fragment"],
  "agent.case_memory": ["memory"],
  "agent.task_list": ["project.inbox", "task.background_research", "opportunity.tool"],
  "task.background_research": ["project.inbox"],
  "brief.background_research": ["task.background_research"],
  "brief.research": ["task.background_research"],
  "advice.research": ["brief.background_research"],
  "advice.writing_assist": ["memory.preferences", "project.current_context"],
  "draft.writing_continuation": ["advice.writing_assist"],
  "opportunity.tool": ["project.current", "project.inbox"],
  "task.toolsmith_prototype": ["opportunity.tool"],
  "draft.tool_prototype": ["task.toolsmith_prototype"],
  "tool.prototype_artifact": ["draft.tool_prototype"],
  "learning.review_queue": ["memory.language.difficult_segments"],
  "learning.youtube_fragment": ["audio", "visual_frame", "evidence"],
  "view.promotion_candidates": ["memory.preferences", "project.memory"],
  activity: ["evidence"],
  activity_block: ["activity"],
  proposal: ["activity"],
  intent: ["proposal"],
  workflow: ["intent"],
  resource: ["evidence"],
  audio: ["evidence"],
  visual_frame: ["evidence"],
  evidence: [],
};

const VIEW_TREE_PLACEMENTS: Record<string, { column: string; y: number }> = {
  evidence: { column: "Evidence", y: 402 },
  audio: { column: "Signal", y: 242 },
  visual_frame: { column: "Signal", y: 322 },
  activity: { column: "Signal", y: 402 },
  resource: { column: "Signal", y: 482 },
  "learning.youtube_fragment": { column: "Signal", y: 562 },
  "state.surface": { column: "Core", y: 242 },
  "work.focus_set": { column: "Core", y: 322 },
  "thread.active_work": { column: "Core", y: 402 },
  work_thread: { column: "Core", y: 482 },
  activity_block: { column: "Core", y: 562 },
  proposal: { column: "Core", y: 642 },
  intent: { column: "Core", y: 722 },
  workflow: { column: "Core", y: 802 },
  "project.current": { column: "Project", y: 322 },
  "project.current_context": { column: "Project", y: 202 },
  "project.decisions": { column: "Project", y: 122 },
  "project.inbox": { column: "Project", y: 442 },
  "project.tasks": { column: "Project", y: 522 },
  "project.memory": { column: "Project", y: 642 },
  project_timeline: { column: "Project", y: 722 },
  "summary.project_work_episode": { column: "Project", y: 802 },
  "memory.daily": { column: "Memory", y: 282 },
  "memory.profile": { column: "Memory", y: 122 },
  "memory.preferences": { column: "Memory", y: 202 },
  "memory.workflow_patterns": { column: "Memory", y: 362 },
  "memory.skill_gaps": { column: "Memory", y: 442 },
  "memory.agent_collaboration_style": { column: "Memory", y: 522 },
  memory: { column: "Memory", y: 642 },
  "agent.case_memory": { column: "Memory", y: 722 },
  "memory.language.difficult_segments": { column: "Memory", y: 802 },
  "learning.review_queue": { column: "Memory", y: 882 },
  "task.background_research": { column: "Work", y: 202 },
  "brief.background_research": { column: "Work", y: 122 },
  "brief.research": { column: "Work", y: 282 },
  "advice.research": { column: "Work", y: 362 },
  "advice.writing_assist": { column: "Work", y: 442 },
  "draft.writing_continuation": { column: "Work", y: 522 },
  "opportunity.tool": { column: "Work", y: 642 },
  "agent.task_list": { column: "Work", y: 722 },
  "task.toolsmith_prototype": { column: "Work", y: 802 },
  "view.promotion_candidates": { column: "Work", y: 882 },
  "draft.tool_prototype": { column: "Artifact", y: 722 },
  "tool.prototype_artifact": { column: "Artifact", y: 802 },
};

function buildViewGraphNodes(families: ViewFamilySummary[]): ViewGraphNode[] {
  const byType = new Map(families.map(family => [family.family, family]));
  const order = viewTypeOrder({ families }).filter(type => byType.has(type) || currentViewCatalogDefinition(type));
  const fallbackIndexByColumn = new Map<string, number>();
  const nodes: ViewGraphNode[] = [];
  for (const type of order) {
    const family = byType.get(type);
    const definition = family?.definition ?? currentViewCatalogDefinition(type);
    const cluster = graphClusterForType(type);
    const placement = VIEW_TREE_PLACEMENTS[type] ?? fallbackViewGraphPlacement(type, fallbackIndexByColumn);
    const column = VIEW_TREE_COLUMNS.find(item => item.id === placement.column) ?? VIEW_TREE_COLUMNS[2];
    nodes.push({
      type,
      cluster,
      x: column.x,
      y: placement.y,
      count: family?.count ?? 0,
      family,
      definition,
      reason: viewNonProducingReason(type, family, definition),
    });
  }
  return nodes;
}

function fallbackViewGraphPlacement(type: string, fallbackIndexByColumn: Map<string, number>) {
  const column = graphColumnForType(type);
  const index = fallbackIndexByColumn.get(column) ?? 0;
  fallbackIndexByColumn.set(column, index + 1);
  return { column, y: 982 + index * 80 };
}

function graphColumnForType(type: string) {
  if (type === "evidence") return "Evidence";
  if (["visual_frame", "audio", "activity", "resource", "learning.youtube_fragment"].includes(type)) return "Signal";
  if (["state.surface", "work.focus_set", "proposal", "intent", "workflow", "resource", "thread.active_work", "work_thread"].includes(type)) return "Core";
  if (type.startsWith("project.") || type === "project_timeline" || type === "summary.project_work_episode") return "Project";
  if (type === "memory" || type.startsWith("memory.") || type === "agent.case_memory" || type.startsWith("learning.")) return "Memory";
  if (type.startsWith("task.") || type === "agent.task_list" || type.startsWith("opportunity.") || type.startsWith("advice.") || type.startsWith("brief.")) return "Work";
  if (type.startsWith("draft.") || type.startsWith("tool.")) return "Artifact";
  return "Core";
}

function buildViewGraphDerivations(nodes: ViewGraphNode[]): ViewGraphDerivation[] {
  const nodeTypes = new Set(nodes.map(node => node.type));
  const edges: ViewGraphDerivation[] = [];
  for (const node of nodes) {
    const catalogInputs = viewGraphDeclaredInputs(node).filter(input => input !== node.type && nodeTypes.has(input));
    const inputs = catalogInputs.length
      ? catalogInputs
      : (VIEW_BIRTH_PARENTS[node.type] ?? []).filter(input => input !== node.type && nodeTypes.has(input));
    const kind = catalogInputs.length
      ? inputs.length > 1 ? "merge" : "derived"
      : "fallback";
    for (const input of inputs) {
      edges.push({ from: input, to: node.type, kind, source: catalogInputs.length ? "catalog" : "fallback" });
    }
  }
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = `${edge.from}:${edge.to}:${edge.kind}:${edge.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function viewGraphDeclaredInputs(node: ViewGraphNode) {
  return (node.definition?.consumes?.views ?? [])
    .map(input => canonicalViewInput(input))
    .filter((input): input is string => Boolean(input));
}

function canonicalViewInput(input: string) {
  if (!input || input.includes("*")) return undefined;
  if (input === "research.brief") return "brief.research";
  if (input === "writing.advice") return "advice.writing_assist";
  return input;
}

function buildViewGraphEdges(nodes: ViewGraphNode[], derivations: ViewGraphDerivation[], selectedType?: string) {
  const byType = new Map(nodes.map(node => [node.type, node]));
  const focusKeys = selectedType ? viewGraphFocusedEdgeKeys(selectedType, derivations) : new Set<string>();
  const visibleKeys = selectedType ? focusKeys : viewGraphBackboneEdgeKeys(derivations);
  const edges: ViewGraphEdge[] = [];
  const add = (edge: ViewGraphDerivation) => {
    const { from, to } = edge;
    const a = byType.get(from);
    const b = byType.get(to);
    if (!a || !b) return;
    const related = focusKeys.has(viewGraphEdgeKey(edge));
    if (!visibleKeys.has(viewGraphEdgeKey(edge)) && !related) return;
    const sameOrBackColumn = b.x <= a.x + 4;
    const x1 = sameOrBackColumn ? a.x - VIEW_GRAPH_NODE_HALF : a.x + VIEW_GRAPH_NODE_HALF;
    const y1 = a.y;
    const x2 = b.x - VIEW_GRAPH_NODE_HALF;
    const y2 = b.y;
    edges.push({ ...edge, path: viewGraphEdgePath(x1, y1, x2, y2, sameOrBackColumn ? "left" : "middle"), related });
  };
  for (const edge of derivations) add(edge);
  return edges.sort((a, b) => Number(a.related) - Number(b.related));
}

function viewGraphRelatedTypes(type: string, derivations: ViewGraphDerivation[]) {
  const related = new Set<string>([type]);
  for (const key of viewGraphFocusedEdgeKeys(type, derivations)) {
    const [from, to] = key.split("->");
    if (from) related.add(from);
    if (to) related.add(to);
  }
  return related;
}

function viewGraphFocusedEdgeKeys(type: string, derivations: ViewGraphDerivation[]) {
  const focused = new Set<string>();
  for (const edge of derivations) {
    if (edge.to === type) focused.add(viewGraphEdgeKey(edge));
    if (edge.from === type) focused.add(viewGraphEdgeKey(edge));
  }
  return focused;
}

function viewGraphBackboneEdgeKeys(derivations: ViewGraphDerivation[]) {
  const keys = new Set<string>();
  const backbone = [
    ["evidence", "activity"],
    ["activity", "activity_block"],
    ["activity", "proposal"],
    ["proposal", "intent"],
    ["intent", "workflow"],
    ["state.surface", "work.focus_set"],
    ["work.focus_set", "project.current"],
    ["project.current", "project.current_context"],
    ["project.current", "project.inbox"],
    ["project.inbox", "task.background_research"],
    ["task.background_research", "brief.background_research"],
    ["brief.background_research", "advice.research"],
    ["project.current", "memory.daily"],
    ["memory.daily", "memory.profile"],
    ["memory.daily", "memory.preferences"],
    ["opportunity.tool", "task.toolsmith_prototype"],
    ["task.toolsmith_prototype", "draft.tool_prototype"],
    ["draft.tool_prototype", "tool.prototype_artifact"],
  ];
  const available = new Set(derivations.map(viewGraphEdgeKey));
  for (const [from, to] of backbone) {
    const key = `${from}->${to}`;
    if (available.has(key)) keys.add(key);
  }
  if (!keys.size) {
    for (const edge of derivations) {
      if (edge.from === "evidence") keys.add(viewGraphEdgeKey(edge));
      if (keys.size >= 6) break;
    }
  }
  return keys;
}

function viewGraphEdgePath(x1: number, y1: number, x2: number, y2: number, route: "middle" | "left") {
  if (route === "left") {
    const laneX = Math.min(x1, x2) - 28;
    const direction = y2 >= y1 ? 1 : -1;
    return `M ${x1} ${y1} L ${laneX + 18} ${y1} Q ${laneX} ${y1} ${laneX} ${y1 + direction * 18} L ${laneX} ${y2 - direction * 18} Q ${laneX} ${y2} ${laneX + 18} ${y2} L ${x2} ${y2}`;
  }
  const laneX = Math.round((x1 + x2) / 2);
  if (Math.abs(y2 - y1) < 8) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const direction = y2 >= y1 ? 1 : -1;
  return `M ${x1} ${y1} L ${laneX - 18} ${y1} Q ${laneX} ${y1} ${laneX} ${y1 + direction * 18} L ${laneX} ${y2 - direction * 18} Q ${laneX} ${y2} ${laneX + 18} ${y2} L ${x2} ${y2}`;
}

function viewGraphFocusSummary(type: string, derivations: ViewGraphDerivation[]) {
  const inputs = derivations.filter(edge => edge.to === type).map(edge => viewFamilyLabel(edge.from));
  const outputs = derivations.filter(edge => edge.from === type).map(edge => viewFamilyLabel(edge.to));
  const parts = [];
  if (inputs.length) parts.push(`from ${inputs.slice(0, 3).join(", ")}${inputs.length > 3 ? ` +${inputs.length - 3}` : ""}`);
  if (outputs.length) parts.push(`to ${outputs.slice(0, 3).join(", ")}${outputs.length > 3 ? ` +${outputs.length - 3}` : ""}`);
  return parts.join(" · ");
}

function viewGraphEdgeKey(edge: Pick<ViewGraphDerivation, "from" | "to">) {
  return `${edge.from}->${edge.to}`;
}

function viewGraphLineage(type: string, derivations: ViewGraphDerivation[]) {
  const lineage: string[] = [];
  let current: string | undefined = type;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    lineage.unshift(current);
    current = derivations.find(edge => edge.to === current)?.from;
  }
  return lineage;
}

function isLineageNode(type: string, focusedType?: string | null, derivations: ViewGraphDerivation[] = []) {
  if (!focusedType) return false;
  return viewGraphRelatedTypes(focusedType, derivations).has(type);
}

function viewGraphNodeBadge(node: ViewGraphNode, derivations: ViewGraphDerivation[], hasFamilies: boolean) {
  if (!hasFamilies) return "...";
  const inputCount = viewGraphInputCount(node.type, derivations);
  if (inputCount > 1) return `merge ${inputCount}`;
  if (inputCount === 1) return node.count > 0 ? compactNumber(node.count) : "derived";
  return node.count > 0 ? compactNumber(node.count) : "observation";
}

function viewGraphInputCount(type: string, derivations: ViewGraphDerivation[]) {
  return derivations.filter(edge => edge.to === type).length;
}

function viewGraphCanvasSize(nodes: ViewGraphNode[]) {
  const maxX = Math.max(...nodes.map(node => node.x), VIEW_TREE_COLUMNS[VIEW_TREE_COLUMNS.length - 1]?.x ?? 1226);
  const maxY = Math.max(...nodes.map(node => node.y), 640);
  return {
    width: Math.max(1420, maxX + 170),
    height: Math.max(820, maxY + 116),
  };
}

function ViewGraphModal({ type, family, views, loading, onSelectView, onEditView, onLoadMore, onClose }: {
  type: string | null;
  family?: ViewFamilySummary;
  views?: ContextViewSummary[];
  loading: boolean;
  onSelectView: (view: ContextViewSummary) => void;
  onEditView: (view: ContextViewSummary) => void;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [liveAudio, setLiveAudio] = useState<AudioTranscriptItem[]>([]);
  const [liveAudioStatus, setLiveAudioStatus] = useState("");
  const [audioWindowMinutes, setAudioWindowMinutes] = useState(120);
  const [audioLimit, setAudioLimit] = useState(2_000);
  const [audioLoadingMore, setAudioLoadingMore] = useState(false);
  const selectedView = views?.find(view => view.id === selectedViewId) ?? views?.[0] ?? family?.latest;
  const detailSections = selectedView ? readableViewSections(selectedView) : [];
  const detailPills = selectedView ? readableViewPills(selectedView) : [];
  const selectedFrameIds = selectedView ? viewFrameIdsOf(selectedView) : [];
  const isAudioView = type === "audio";
  const audioTimelineItems = isAudioView ? audioTimelineItemsFrom(views ?? [], liveAudio) : [];
  const viewGroups = !isAudioView ? compactViewListGroups(type ?? "", views ?? []) : [];
  useEffect(() => {
    if (!type) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [type, onClose]);
  useEffect(() => {
    setSelectedViewId(null);
  }, [type]);
  useEffect(() => {
    if (!isAudioView) {
      setLiveAudio([]);
      setLiveAudioStatus("");
      setAudioWindowMinutes(120);
      setAudioLimit(2_000);
      return;
    }
    let cancelled = false;
    setLiveAudioStatus("Loading live transcripts...");
    fetchAudioTranscripts({ minutes: audioWindowMinutes, limit: audioLimit })
      .then(result => {
        if (cancelled) return;
        setLiveAudio(result.transcripts ?? []);
        setAudioLoadingMore(false);
        const count = result.count ?? result.transcripts?.length ?? 0;
        setLiveAudioStatus(count > 0 ? `${count} raw transcript chunks from the last ${audioWindowMinutes} minutes` : `No raw transcript chunks found in the last ${audioWindowMinutes} minutes`);
      })
      .catch(error => {
        if (!cancelled) {
          setLiveAudio([]);
          setAudioLoadingMore(false);
          setLiveAudioStatus(`Live transcript fetch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAudioView, audioWindowMinutes, audioLimit]);
  useEffect(() => {
    if (!isAudioView) return;
    setAudioWindowMinutes(120);
    setAudioLimit(2_000);
  }, [isAudioView, type]);
  useEffect(() => {
    setAudioLoadingMore(false);
  }, [liveAudio]);
  function loadMoreAudioTranscripts() {
    setAudioLoadingMore(true);
    setAudioWindowMinutes(prev => Math.min(prev * 2, 24 * 60));
    setAudioLimit(2_000);
  }
  if (!type) return null;
  const definition = family?.definition ?? currentViewCatalogDefinition(type);
  const reason = viewNonProducingReason(type, family, definition);
  return (
    <div className="view-node-modal-backdrop" role="dialog" aria-modal="true" aria-label={`${viewFamilyLabel(type)} detail`} onClick={onClose}>
      <section className="view-node-modal" onClick={event => event.stopPropagation()}>
        <div className="view-node-modal-head">
          <div>
            <span>{type}</span>
            <h2>{viewFamilyLabel(type)}</h2>
            <p>{viewTypePurpose(type)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close view detail">×</button>
        </div>
        <div className="view-node-modal-body">
          <dl>
            <dt>Status</dt><dd>{family?.count ? "Producing" : "No recent output"}</dd>
            <dt>Count</dt><dd>{compactNumber(family?.count ?? 0)}</dd>
            <dt>Lifecycle</dt><dd>{definition?.lifecycle ?? "session"}</dd>
            <dt>Category</dt><dd>{definition?.category ?? graphClusterForType(type)}</dd>
            <dt>Producers</dt><dd>{definition?.producer_ids?.join(", ") || definition?.producers?.join(", ") || "unknown"}</dd>
            <dt>Aliases</dt><dd>{definition?.aliases?.join(", ") || definition?.alias_of || "none"}</dd>
          </dl>
          <div className="view-node-modal-sections">
            {reason && <section><h3>Why Empty</h3><p>{reason}</p></section>}
            {definition?.graph_operations?.length ? (
              <section>
                <h3>Graph Operations</h3>
                <div className="view-node-ops">{definition.graph_operations.map(op => <Tag key={op}>{op}</Tag>)}</div>
              </section>
            ) : null}
            {family?.latest && !views?.some(view => view.id === family.latest?.id) && (
              <section>
                <h3>Latest</h3>
                <b>{family.latest.title ?? family.latest.id}</b>
                {family.latest.summary && <p>{family.latest.summary}</p>}
              </section>
            )}
            <section>
              <h3>{isAudioView ? "Transcript Timeline" : "Recent Views"}</h3>
              {isAudioView && liveAudioStatus ? <p className="view-node-loading-note">{liveAudioStatus}</p> : null}
              {isAudioView ? (
                audioTimelineItems.length ? (
                  <div className="audio-transcript-timeline">
                    {audioTimelineItems.map(item => <AudioTranscriptRow key={item.id} item={item} selected={item.view?.id === selectedView?.id} onSelect={() => {
                      if (!item.view) return;
                      setSelectedViewId(item.view.id);
                      onSelectView(item.view);
                    }} />)}
                  </div>
                ) : loading ? (
                  <div className="view-node-modal-loading">
                    {Array.from({ length: 2 }).map((_, index) => <div className="view-mini-skeleton" key={index} />)}
                  </div>
                ) : (
                  <p>No audio transcript lines are loaded yet.</p>
                )
              ) : viewGroups.length ? (
                <div className="view-node-modal-list">
                  {viewGroups.map(group => <ViewListRow key={group.key} group={group} selected={group.views.some(view => view.id === selectedView?.id)} onSelect={() => {
                    setSelectedViewId(group.view.id);
                    onSelectView(group.view);
                  }} />)}
                </div>
              ) : loading ? (
                <div className="view-node-modal-loading">
                  {Array.from({ length: 2 }).map((_, index) => <div className="view-mini-skeleton" key={index} />)}
                </div>
              ) : (
                <p>No concrete records are loaded for this family yet.</p>
              )}
              {loading && views?.length ? <p className="view-node-loading-note">Refreshing recent views...</p> : null}
              {(isAudioView ? audioWindowMinutes < 24 * 60 : (family?.count ?? 0) > (views?.length ?? 0)) && (
                <button className="view-node-load-more" type="button" onClick={isAudioView ? loadMoreAudioTranscripts : onLoadMore} disabled={isAudioView ? audioLoadingMore : loading}>
                  {isAudioView ? (audioLoadingMore ? "Loading raw audio..." : "Load more transcripts") : loading ? "Loading..." : "Load more"}
                </button>
              )}
            </section>
            {selectedView && !isAudioView && (
              <section className="view-node-readable">
                <h3>Selected View</h3>
                <div className="view-node-selected-head">
                  <b>{selectedView.title ?? selectedView.id}</b>
                  <button className="view-node-update-button" type="button" onClick={() => onEditView(selectedView)}>Update View</button>
                </div>
                {selectedView.summary && <p>{selectedView.summary}</p>}
                {selectedFrameIds.length > 0 && <ViewFramePreview frameIds={selectedFrameIds} title={selectedView.title ?? selectedView.id} />}
                {detailPills.length > 0 && <div className="view-detail-pills">{detailPills.map(pill => <span key={pill}>{pill}</span>)}</div>}
                {detailSections.map(section => (
                  <div className="view-node-readable-section" key={section.title}>
                    <strong>{section.title}</strong>
                    {section.body && <p>{section.body}</p>}
                    {section.items?.length ? <ul>{section.items.map(item => <li key={item}>{item}</li>)}</ul> : null}
                  </div>
                ))}
              </section>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function inferredGraphInputs(type: string, definition?: ViewFamilyDefinition): string[] {
  const inputs = new Set((definition as any)?.consumes?.views as string[] | undefined);
  if (type === "project.current_context") inputs.add("project.current");
  if (type === "learning.review_queue") inputs.add("learning.youtube_fragment");
  if (type === "memory.language.difficult_segments") inputs.add("learning.youtube_fragment");
  return [...inputs].filter(input => input !== "*" && !input.includes("*")).slice(0, 8);
}

function graphClusterForType(type: string) {
  if (["evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow"].includes(type)) return "Observation";
  if (["state.surface", "work.focus_set", "project.current", "thread.active_work", "work_thread"].includes(type)) return "Core";
  if (type.startsWith("project.") || type === "project_timeline" || type === "summary.project_work_episode") return "Project";
  if (type === "memory" || type.startsWith("memory.") || type === "agent.case_memory") return "Memory";
  if (type.startsWith("task.") || type === "agent.task_list") return "Task";
  if (type.startsWith("advice.") || type.startsWith("brief.") || type.startsWith("draft.") || type.startsWith("tool.") || type.startsWith("opportunity.")) return "Advice";
  if (type.includes("timeline") || type === "activity_block") return "Timeline";
  return "Misc";
}

function viewNonProducingReason(type: string, family?: ViewFamilySummary, definition?: ViewFamilyDefinition) {
  if ((family?.count ?? 0) > 0) return undefined;
  if (!definition) return "Not in the canonical catalog yet.";
  const explicit: Record<string, string> = {
    "project.inbox": "Now wired through runtime tick local processors; run a forced tick with recent project observations to produce it.",
    "project.tasks": "Now wired after project.inbox; it needs Codex/Claude project messages with actionable work.",
    "project.decisions": "Now wired through the decision extractor; it needs decision-like project conversation records.",
    "view.promotion_candidates": "Now wired once per runtime tick; it needs recent route clusters, feedback, stale views, or failures.",
    "memory.daily": "Still manual/agent-owned. No deterministic daily markdown producer exists in this pass.",
    "memory.profile": "Now wired from memory.daily plus feedback; empty until daily memory or feedback exists.",
    "memory.preferences": "Now wired from feedback; empty until output edits or dismissed views are recorded.",
    "learning.youtube_fragment": "Still waiting on a canonical YouTube caption-fragment observation producer.",
    "learning.review_queue": "Now wired for YouTube comprehension gaps and language feedback; empty without those records.",
    "brief.background_research": "Produced by background task processing only; enable process_background_tasks or queue a task.background_research.",
    "draft.tool_prototype": "Produced by toolsmith ambient/program path; requires a tool opportunity/task source.",
    "tool.prototype_artifact": "Produced by toolsmith sandbox artifact processing; enable process_toolsmith_artifacts after a prototype draft exists.",
    "summary.project_work_episode": "No active episode summarizer is wired in the runtime tick yet.",
    visual_frame: "Visual compression is optional and disabled unless visual_view_compression is enabled and vision LLM settings are valid.",
  };
  return explicit[type] ?? `Catalogued as ${definition.lifecycle ?? "session"}; waiting for ${definition.producers?.join(", ") || "a producer"}.`;
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

function MemoryViewsPanel({ response, loading, composerOpen, onComposerClose, onRefreshViews }: { response: ViewFamiliesResponse | null; loading: boolean; composerOpen: boolean; onComposerClose: () => void; onRefreshViews: () => Promise<void> }) {
  const [selectedType, setSelectedType] = useState(DEFAULT_VIEW_TYPE);
  const [inspectedType, setInspectedType] = useState<string | null>(null);
  const [typeViews, setTypeViews] = useState<Record<string, ContextViewSummary[]>>(() => loadCachedTypeViews());
  const [typeLoading, setTypeLoading] = useState(false);
  const [editingView, setEditingView] = useState<ContextViewSummary | null>(null);
  const families = response?.families ?? [];
  const familySeeds = useMemo(() => seedViewFamilies(viewTypeOrder()), []);
  const workspaceFamilies = families.length ? families : loading ? [] : familySeeds;
  const familyByType = useMemo(() => new Map(workspaceFamilies.map(family => [family.family, family])), [workspaceFamilies]);
  const inspectedLoaded = inspectedType ? Object.prototype.hasOwnProperty.call(typeViews, inspectedType) : false;
  const selectedViews = useMemo(() => {
    const loaded = typeViews[selectedType];
    const latest = familyByType.get(selectedType)?.latest;
    const seed = loaded?.length ? loaded : latest ? [latest] : [];
    return seed
    .filter(view => view.view_type === selectedType)
    .filter(view => view.status !== "archived" && view.status !== "rejected")
    .sort(compareViewsNewestFirst);
  }, [familyByType, typeViews, selectedType]);

  useEffect(() => {
    saveCachedTypeViews(typeViews);
  }, [typeViews]);

  function selectViewType(type: string, inspect = false) {
    setSelectedType(type);
    setInspectedType(inspect ? type : null);
  }

  useEffect(() => {
    if (!inspectedType) return;
    const cachedCount = typeViews[inspectedType]?.length ?? 0;
    const familyCount = familyByType.get(inspectedType)?.count ?? 0;
    const targetCount = Math.min(initialViewPageSize(inspectedType), familyCount || initialViewPageSize(inspectedType));
    const needsCacheTopUp = inspectedLoaded && cachedCount > 0 && cachedCount < targetCount;
    if (inspectedLoaded && !needsCacheTopUp) return;
    let cancelled = false;
    setTypeLoading(true);
    fetchViewsByType(inspectedType, { limit: targetCount, activeOnly: true })
      .then(result => {
        if (cancelled) return;
        const latest = familyByType.get(inspectedType)?.latest;
        const views = result.views?.length ? result.views : latest ? [latest] : [];
        rememberTypeViews(inspectedType, views);
      })
      .catch(error => {
        if (!cancelled) {
          const latest = familyByType.get(inspectedType)?.latest;
          if (latest) rememberTypeViews(inspectedType, [latest]);
          console.warn("Failed to load view type", error);
        }
      })
      .finally(() => {
        if (!cancelled) setTypeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [familyByType, inspectedLoaded, inspectedType, typeViews]);

  async function loadMore() {
    const type = inspectedType ?? selectedType;
    const current = typeViews[type] ?? [];
    const familyCount = familyByType.get(type)?.count ?? 0;
    if (typeLoading || (familyCount > 0 && current.length >= familyCount)) return;
    setTypeLoading(true);
    try {
      const result = await fetchViewsByType(type, { limit: Math.min(current.length + initialViewPageSize(type), viewPageSize(type)), activeOnly: true });
      rememberTypeViews(type, result.views ?? []);
    } catch (error) {
      console.warn("Failed to load more views", error);
    } finally {
      setTypeLoading(false);
    }
  }

  async function inspectConcreteView(view: ContextViewSummary) {
    try {
      setTypeLoading(true);
      const detail = await fetchContextView(view.id);
      setTypeViews(prev => {
        const existing = prev[view.view_type] ?? [];
        const next = existing.some(item => item.id === detail.id) ? existing.map(item => item.id === detail.id ? detail : item) : [detail, ...existing];
        return { ...prev, [view.view_type]: next };
      });
    } finally {
      setTypeLoading(false);
    }
  }

  async function editConcreteView(view: ContextViewSummary) {
    try {
      setTypeLoading(true);
      const detail = await fetchContextView(view.id);
      rememberSavedView(detail);
      setEditingView(detail);
    } catch {
      setEditingView(view);
    } finally {
      setTypeLoading(false);
    }
  }

  function rememberSavedView(view: ContextViewSummary) {
    setSelectedType(view.view_type);
    setInspectedType(view.view_type);
    setTypeViews(prev => {
      const existing = prev[view.view_type] ?? [];
      const next = existing.some(item => item.id === view.id) ? existing.map(item => item.id === view.id ? view : item) : [view, ...existing];
      return { ...prev, [view.view_type]: next };
    });
  }

  async function handleSaveView(view: ContextViewSummary) {
    rememberSavedView(view);
    await onRefreshViews();
  }

  function rememberTypeViews(type: string, views: ContextViewSummary[]) {
    setTypeViews(prev => ({ ...prev, [type]: views }));
  }

  return (
    <>
      {workspaceFamilies.length ? (
        <ViewGraph families={workspaceFamilies} selectedType={selectedType} onSelectType={selectViewType} />
      ) : (
        <section className="view-graph-app view-graph-loading" aria-label="ViewGraph loading">
          <div className="view-graph-loading-body">
            {Array.from({ length: 10 }).map((_, index) => <div className="view-mini-skeleton" key={index} />)}
          </div>
        </section>
      )}
      <ViewGraphModal
        type={inspectedType}
        family={inspectedType ? familyByType.get(inspectedType) : undefined}
        views={selectedViews}
        loading={typeLoading}
        onSelectView={inspectConcreteView}
        onEditView={editConcreteView}
        onLoadMore={loadMore}
        onClose={() => setInspectedType(null)}
      />
      <ViewComposer
        open={composerOpen || Boolean(editingView)}
        catalog={response?.catalog}
        initialView={editingView ?? undefined}
        defaultType={selectedType}
        onClose={() => {
          setEditingView(null);
          onComposerClose();
        }}
        onSaved={handleSaveView}
      />
    </>
  );
}

function ViewListEmpty({ loading, selectedType, expectedCount }: { loading: boolean; selectedType: string; expectedCount: number }) {
  if (loading) {
    return (
      <>
        {Array.from({ length: 4 }).map((_, index) => <div className="view-mini-skeleton" key={index} />)}
      </>
    );
  }
  return (
    <div className="empty-inline view-empty-inline">
      <b>{expectedCount > 0 ? `${compactNumber(expectedCount)} ${viewFamilyLabel(selectedType)} are indexed` : `No ${viewFamilyLabel(selectedType)} yet`}</b>
      <span>{expectedCount > 0 ? "Use Load more or Reload Views to fetch this family into the current workspace." : "This family will appear here after the runtime writes it."}</span>
    </div>
  );
}

type ViewFormState = {
  viewType: string;
  title: string;
  summary: string;
  status: ViewStatus;
  contentText: string;
  sourceRecordsText: string;
  sourceViewsText: string;
  metadataText: string;
  patchMode: boolean;
};

type ViewComposerMode = "processor" | "manual";
type ProcessorInputKind = "observation" | "view";

function ViewComposer({ open, catalog, initialView, defaultType, onClose, onSaved }: {
  open: boolean;
  catalog?: ViewCatalogResponse;
  initialView?: ContextViewSummary;
  defaultType: string;
  onClose: () => void;
  onSaved: (view: ContextViewSummary) => Promise<void>;
}) {
  const isEditing = Boolean(initialView);
  const viewOptions = useMemo(() => {
    const manual = catalog?.manual_create ?? [];
    const families = catalog?.families ?? [];
    const byType = new Map<string, ViewFamilyDefinition>();
    for (const family of [...manual, ...families]) byType.set(family.view_type, family);
    if (!byType.has(defaultType)) {
      const definition = currentViewCatalogDefinition(defaultType);
      if (definition) byType.set(defaultType, definition);
    }
    return [...byType.values()].sort((a, b) => {
      if (a.manual_create !== b.manual_create) return a.manual_create ? -1 : 1;
      return viewFamilyLabel(a.view_type).localeCompare(viewFamilyLabel(b.view_type));
    });
  }, [catalog, defaultType]);
  const [form, setForm] = useState<ViewFormState>(() => viewFormInitialState(initialView, defaultType));
  const [mode, setMode] = useState<ViewComposerMode>(initialView ? "manual" : "processor");
  const [inputKind, setInputKind] = useState<ProcessorInputKind>("view");
  const [records, setRecords] = useState<ContextRecordSummary[]>([]);
  const [sourceViews, setSourceViews] = useState<ContextViewSummary[]>([]);
  const [processors, setProcessors] = useState<ProcessorDefinitionSummary[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedSourceViewId, setSelectedSourceViewId] = useState("");
  const [selectedProcessorId, setSelectedProcessorId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const selectedRecord = records.find(record => record.id === selectedRecordId);
  const selectedSourceView = sourceViews.find(view => view.id === selectedSourceViewId);
  const selectedInputType = inputKind === "observation" ? selectedRecord?.schema.name : selectedSourceView?.view_type;
  const compatibleProcessors = useMemo(() => {
    if (!selectedInputType) return processors;
    return processors.filter(processor => processor.compatible !== false);
  }, [processors, selectedInputType]);
  const selectedProcessor = compatibleProcessors.find(processor => processor.id === selectedProcessorId) ?? compatibleProcessors[0];

  useEffect(() => {
    if (!open) return;
    setForm(viewFormInitialState(initialView, defaultType));
    setMode(initialView ? "manual" : "processor");
    setMessage("");
  }, [defaultType, initialView, open]);

  useEffect(() => {
    if (!open || isEditing) return;
    let cancelled = false;
    Promise.all([fetchRecentRecords(80), fetchViewsByTypes(catalog?.order?.length ? catalog.order : FALLBACK_VIEW_TYPE_ORDER, { limit: 120 })])
      .then(([nextRecords, nextViews]) => {
        if (cancelled) return;
        setRecords(nextRecords);
        setSourceViews(nextViews.views ?? []);
        setSelectedRecordId(current => current || nextRecords[0]?.id || "");
        setSelectedSourceViewId(current => current || nextViews.views?.[0]?.id || "");
      })
      .catch(error => !cancelled && setMessage(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, [catalog, isEditing, open]);

  useEffect(() => {
    if (!open || isEditing || mode !== "processor") return;
    let cancelled = false;
    const type = selectedInputType;
    fetchProcessors(type ? { sourceKind: inputKind, sourceType: type } : {})
      .then(result => {
        if (cancelled) return;
        setProcessors(result.processors ?? []);
        setSelectedProcessorId(current => {
          if (current && result.processors?.some(processor => processor.id === current)) return current;
          return result.processors?.[0]?.id ?? "";
        });
      })
      .catch(error => !cancelled && setMessage(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, [inputKind, isEditing, mode, open, selectedInputType]);

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(mode === "processor" && !isEditing ? "Running processor..." : isEditing ? "Updating view..." : "Creating view...");
    try {
      if (mode === "processor" && !isEditing) {
        if (!selectedProcessor) throw new Error("Choose a processor");
        const result = await runProcessor({
          processor_id: selectedProcessor.id,
          record_id: inputKind === "observation" ? selectedRecordId : undefined,
          view_id: inputKind === "view" ? selectedSourceViewId : undefined,
        });
        const saved = result.views[0];
        if (!saved) throw new Error("Processor completed but did not write a View");
        await onSaved(saved);
        setMessage(`${result.views.length} view${result.views.length === 1 ? "" : "s"} created`);
        onClose();
        return;
      }
      const content = parseJsonObject(form.contentText, "Content JSON");
      const metadata = parseJsonObject(form.metadataText, "Metadata JSON");
      const source_records = refsFromText(form.sourceRecordsText);
      const source_views = refsFromText(form.sourceViewsText);
      const saved = isEditing && initialView
        ? await updateContextView(initialView.id, buildViewUpdateInput(form, content, metadata, source_records, source_views))
        : await createContextView(buildViewCreateInput(form, content, metadata, source_records, source_views));
      await onSaved(saved);
      setMessage(isEditing ? "View updated" : "View created");
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view-composer-backdrop" role="dialog" aria-modal="true" aria-label={isEditing ? "Edit View" : "Create View"} onClick={onClose}>
      <form className="view-composer" onSubmit={submit} onClick={event => event.stopPropagation()}>
        <div className="view-composer-head">
          <div>
            <span>{isEditing ? initialView?.id : mode === "processor" ? "processor_create" : "manual_create"}</span>
            <h2>{isEditing ? "Edit View" : "Create View"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close view form">×</button>
        </div>
        {!isEditing && (
          <div className="view-composer-tabs" role="tablist" aria-label="Create view mode">
            <button type="button" className={mode === "processor" ? "active" : ""} onClick={() => setMode("processor")}>Run Processor</button>
            <button type="button" className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}>Manual JSON</button>
          </div>
        )}
        {mode === "processor" && !isEditing ? (
          <div className="view-form-grid">
            <label>
              <span>Input Kind</span>
              <select value={inputKind} onChange={event => setInputKind(event.target.value as ProcessorInputKind)}>
                <option value="view">View</option>
                <option value="observation">Observation</option>
              </select>
            </label>
            {inputKind === "view" ? (
              <label className="view-form-wide">
                <span>Input View</span>
                <select value={selectedSourceViewId} onChange={event => setSelectedSourceViewId(event.target.value)}>
                  {sourceViews.map(view => <option key={view.id} value={view.id}>{viewFamilyLabel(view.view_type)} · {view.title || view.id}</option>)}
                </select>
              </label>
            ) : (
              <label className="view-form-wide">
                <span>Input Observation</span>
                <select value={selectedRecordId} onChange={event => setSelectedRecordId(event.target.value)}>
                  {records.map(record => <option key={record.id} value={record.id}>{record.schema.name} · {recordTitle(record)}</option>)}
                </select>
              </label>
            )}
            <label className="view-form-wide">
              <span>Processor</span>
              <select value={selectedProcessor?.id ?? ""} onChange={event => setSelectedProcessorId(event.target.value)}>
                {compatibleProcessors.map(processor => <option key={processor.id} value={processor.id}>{processorLabel(processor)}</option>)}
              </select>
            </label>
            <div className="view-form-wide processor-create-summary">
              <b>{selectedProcessor?.title || selectedProcessor?.id || "No compatible processor"}</b>
              <span>{selectedProcessor?.description || processorContractSummary(selectedProcessor)}</span>
              {selectedProcessor && <code>{processorContractSummary(selectedProcessor)}</code>}
            </div>
          </div>
        ) : (
        <div className="view-form-grid">
          <label>
            <span>Type</span>
            <select value={form.viewType} onChange={event => setForm({ ...form, viewType: event.target.value })} disabled={isEditing}>
              {viewOptions.map(definition => <option key={definition.view_type} value={definition.view_type}>{viewFamilyLabel(definition.view_type)} · {definition.view_type}</option>)}
              {!viewOptions.some(definition => definition.view_type === form.viewType) && <option value={form.viewType}>{form.viewType}</option>}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as ViewStatus })}>
              <option value="candidate">candidate</option>
              <option value="accepted">accepted</option>
              <option value="archived">archived</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
          <label className="view-form-wide">
            <span>Title</span>
            <input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="View title" />
          </label>
          <label className="view-form-wide">
            <span>Summary</span>
            <textarea value={form.summary} onChange={event => setForm({ ...form, summary: event.target.value })} rows={3} placeholder="Short human-readable summary" />
          </label>
          <label>
            <span>Source Records</span>
            <input value={form.sourceRecordsText} onChange={event => setForm({ ...form, sourceRecordsText: event.target.value })} placeholder="record-id-1, record-id-2" />
          </label>
          <label>
            <span>Source Views</span>
            <input value={form.sourceViewsText} onChange={event => setForm({ ...form, sourceViewsText: event.target.value })} placeholder="view-id-1, view-id-2" />
          </label>
          {isEditing && (
            <label className="view-form-check view-form-wide">
              <input type="checkbox" checked={form.patchMode} onChange={event => setForm({ ...form, patchMode: event.target.checked })} />
              <span>Patch content keys instead of replacing the content object</span>
            </label>
          )}
          <label className="view-form-wide">
            <span>{isEditing && form.patchMode ? "Content Patch JSON" : "Content JSON"}</span>
            <textarea className="view-json-input" value={form.contentText} onChange={event => setForm({ ...form, contentText: event.target.value })} rows={12} spellCheck={false} />
          </label>
          <label className="view-form-wide">
            <span>Metadata JSON</span>
            <textarea className="view-json-input" value={form.metadataText} onChange={event => setForm({ ...form, metadataText: event.target.value })} rows={7} spellCheck={false} />
          </label>
        </div>
        )}
        <div className="view-composer-actions">
          <span>{message}</span>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" disabled={saving || (mode === "processor" && !isEditing && (!selectedProcessor || (inputKind === "view" ? !selectedSourceViewId : !selectedRecordId)))}>
            {saving ? "Saving..." : mode === "processor" && !isEditing ? "Run Processor" : isEditing ? "Update View" : "Create View"}
          </button>
        </div>
      </form>
    </div>
  );
}

function viewFormInitialState(view: ContextViewSummary | undefined, defaultType: string): ViewFormState {
  return {
    viewType: view?.view_type ?? defaultType,
    title: view?.title ?? "",
    summary: view?.summary ?? "",
    status: normalizeViewStatus(view?.status),
    contentText: JSON.stringify(view?.content ?? {}, null, 2),
    sourceRecordsText: (view?.source_records ?? []).join(", "),
    sourceViewsText: (view?.source_views ?? []).join(", "),
    metadataText: JSON.stringify(view?.metadata ?? {}, null, 2),
    patchMode: false,
  };
}

function buildViewCreateInput(form: ViewFormState, content: Record<string, unknown>, metadata: Record<string, unknown>, source_records: string[], source_views: string[]): ContextViewInput {
  return compactViewInput({
    view_type: form.viewType,
    title: nonEmpty(form.title),
    summary: nonEmpty(form.summary),
    status: form.status,
    source_records,
    source_views,
    content,
    metadata,
  });
}

function buildViewUpdateInput(form: ViewFormState, content: Record<string, unknown>, metadata: Record<string, unknown>, source_records: string[], source_views: string[]): ContextViewUpdateInput {
  return compactViewInput({
    title: nonEmpty(form.title),
    summary: nonEmpty(form.summary),
    status: form.status,
    source_records,
    source_views,
    ...(form.patchMode ? { content_patch: content } : { content }),
    metadata,
  });
}

function compactViewInput<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  })) as T;
}

function recordTitle(record: ContextRecordSummary) {
  return record.title || record.text || String(record.content?.title ?? record.payload?.title ?? record.url ?? record.path ?? record.id).slice(0, 90);
}

function processorLabel(processor: ProcessorDefinitionSummary) {
  const produced = processor.produces.views?.join(", ") || processor.produces.observations?.join(", ") || "output";
  return `${processor.title || processor.id} -> ${produced}`;
}

function processorContractSummary(processor?: ProcessorDefinitionSummary) {
  if (!processor) return "No processor matches this input yet.";
  const consumes = [
    ...(processor.consumes.observations ?? []).map(item => `obs:${item}`),
    ...(processor.consumes.views ?? []).map(item => `view:${item}`),
  ].join(", ") || "any";
  const produces = [
    ...(processor.produces.views ?? []).map(item => `view:${item}`),
    ...(processor.produces.observations ?? []).map(item => `obs:${item}`),
  ].join(", ") || "none";
  return `${processor.runtime} · ${consumes} -> ${produces}`;
}

function normalizeViewStatus(status?: string): ViewStatus {
  if (status === "accepted" || status === "archived" || status === "rejected" || status === "candidate") return status;
  return "candidate";
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function refsFromText(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map(item => item.trim()).filter(Boolean))];
}

function nonEmpty(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
}

function compactViewListGroups(type: string, views: ContextViewSummary[]): ViewListGroup[] {
  if (type !== "visual_frame") return views.map(view => ({ key: view.id, view, views: [view] }));
  const groups: ViewListGroup[] = [];
  for (const view of views) {
    const last = groups[groups.length - 1];
    if (last && shouldGroupVisualFrames(last.view, view)) {
      last.views.push(view);
      continue;
    }
    groups.push({ key: view.id, view, views: [view] });
  }
  return groups;
}

function shouldGroupVisualFrames(a: ContextViewSummary, b: ContextViewSummary): boolean {
  const appA = readableValue(a.content?.app) ?? "";
  const appB = readableValue(b.content?.app) ?? "";
  if (appA && appB && appA !== appB) return false;
  const timeA = Date.parse(a.updated_at ?? "");
  const timeB = Date.parse(b.updated_at ?? "");
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && Math.abs(timeA - timeB) > 90_000) return false;
  const titleA = normalizeGroupText(a.title ?? "");
  const titleB = normalizeGroupText(b.title ?? "");
  const summaryA = normalizeGroupText(a.summary ?? "");
  const summaryB = normalizeGroupText(b.summary ?? "");
  return titleA === titleB || summaryA === summaryB || commonPrefixRatio(summaryA, summaryB) > 0.72;
}

function normalizeGroupText(value: string): string {
  return value.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 180);
}

function commonPrefixRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index / Math.max(a.length, b.length);
}

function frameRangeLabel(frameIds: Array<string | number>): string {
  const uniqueIds = [...new Set(frameIds.map(value => String(value)))];
  if (!uniqueIds.length) return "";
  if (uniqueIds.length === 1) return uniqueIds[0];
  const nums = uniqueIds.map(value => Number(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === uniqueIds.length) return `${nums[0]}-${nums[nums.length - 1]}`;
  return `${uniqueIds[0]}-${uniqueIds[uniqueIds.length - 1]}`;
}

function ViewListRow({ group, selected, onSelect }: { group: ViewListGroup; selected: boolean; onSelect: () => void }) {
  const view = group.view;
  const kind = typeof view.content?.kind === "string" ? view.content.kind : view.view_type;
  const compiler = compilerId(view);
  const primaryText = view.view_type === "audio" ? audioListText(view) : view.summary;
  const audioTags = view.view_type === "audio" ? audioListTags(view) : [];
  const badge = viewPrimaryBadge(view);
  const groupFrameIds = group.views.flatMap(viewFrameIdsOf);
  const metaPrefix = group.views.length > 1 ? `${group.views.length} frames${groupFrameIds.length ? ` · ${frameRangeLabel(groupFrameIds)}` : ""}` : compiler || "compiler unknown";
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
        <span>{metaPrefix}</span>
        <span>{relativeTime(view.updated_at) || "—"}</span>
      </div>
    </button>
  );
}

function AudioTranscriptRow({ item, selected, onSelect }: { item: AudioTimelineItem; selected: boolean; onSelect: () => void }) {
  const tags = audioTimelineTags(item);
  return (
    <button className={`audio-transcript-row ${selected ? "selected" : ""} ${item.view ? "" : "live-only"}`} onClick={onSelect} disabled={!item.view}>
      <time>{audioTimelineTimeLabel(item)}</time>
      <div>
        <p>{item.text}</p>
        {tags.length > 0 && <div>{tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
      </div>
    </button>
  );
}

function ViewSpotlight({ view, loading, selectedType, expectedCount, loadedCount }: { view?: ContextViewSummary; loading: boolean; selectedType: string; expectedCount: number; loadedCount: number }) {
  if (!view) {
    return (
      <section className="view-spotlight empty">
        <div>
          <span>{viewFamilyLabel(selectedType)}</span>
          <h2>{loading ? "Loading views..." : expectedCount > 0 ? "Indexed, not loaded yet" : "No views yet"}</h2>
          <p>{expectedCount > 0 ? `${compactNumber(expectedCount)} views exist for this type. The workspace loads them on demand so the page stays fast.` : "Pick another type or run the runtime to compile fresh views."}</p>
        </div>
      </section>
    );
  }
  const kind = typeof view.content?.kind === "string" ? view.content.kind : view.view_type;
  const sections = readableViewSections(view);
  const pills = readableViewPills(view).slice(0, 5);
  return (
    <section className="view-spotlight" aria-label="Selected view preview">
      <div className="view-spotlight-main">
        <div className="view-spotlight-kicker">{viewFamilyLabel(view.view_type)} · {kind}</div>
        <h2>{view.title || view.id}</h2>
        {view.summary && <p>{view.summary}</p>}
        {pills.length > 0 && <div className="view-detail-pills">{pills.map(pill => <span key={pill}>{pill}</span>)}</div>}
      </div>
      <div className="view-spotlight-body">
        <div className="view-spotlight-count">{loadedCount}/{expectedCount || loadedCount} loaded</div>
        {loading ? (
          <div className="view-detail-loading">Loading richer detail...</div>
        ) : sections.length > 0 ? (
          sections.slice(0, 2).map(section => (
            <section className="view-readable-section" key={section.title}>
              <h3>{section.title}</h3>
              {section.body && <p>{section.body}</p>}
              {section.items && <ul>{section.items.slice(0, 5).map(item => <li key={item}>{item}</li>)}</ul>}
            </section>
          ))
        ) : (
          <div className="empty-inline">No readable fields were found for this view yet.</div>
        )}
        <details className="view-technical compact">
          <summary>Technical</summary>
          <code>{view.id}</code>
          <pre>{JSON.stringify(view.content ?? {}, null, 2)}</pre>
        </details>
      </div>
    </section>
  );
}

function seedViewFamilies(types: string[]): ViewFamilySummary[] {
  return [...new Set(types)].map(type => ({
    family: type,
    count: 0,
    kinds: [],
    latest: undefined,
    definition: currentViewCatalogDefinition(type),
  }));
}

function timelineSignature(bucketMinutes: number, detailMode: DetailMode, sourceFilter: SourceFilter) {
  return `${bucketMinutes}:${detailMode}:${sourceFilter}`;
}

function loadCachedTimeline(): { response: ActivityTimelineResponse; cachedAt: number; signature: string; watermark: string } | null {
  try {
    const raw = window.localStorage.getItem(TIMELINE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { response?: ActivityTimelineResponse; cachedAt?: number; signature?: string; watermark?: string };
    if (!parsed.response?.ok || !Array.isArray(parsed.response.buckets)) return null;
    if (parsed.response.view?.metadata?.live === true) return null;
    if (!isTodayTimelineResponse(parsed.response)) return null;
    return {
      response: parsed.response,
      cachedAt: Number(parsed.cachedAt ?? 0) || 0,
      signature: parsed.signature || timelineSignature(DEFAULT_BUCKET_MINUTES, "activity", "all"),
      watermark: parsed.watermark || timelineWatermarkFromResponse(parsed.response),
    };
  } catch {
    return null;
  }
}

function isTodayTimelineResponse(response: ActivityTimelineResponse | null | undefined): response is ActivityTimelineResponse {
  if (!response?.ok) return false;
  if (response.view.id.startsWith("view:timeline:activity:day:")) return true;
  const minutes = response.view.content?.minutes;
  return typeof minutes === "number" && minutes > 4 * 60;
}

function saveCachedTimeline(response: ActivityTimelineResponse, cachedAt = Date.now(), signature = timelineSignature(DEFAULT_BUCKET_MINUTES, "activity", "all"), watermark = timelineWatermarkFromResponse(response)) {
  try {
    window.localStorage.setItem(TIMELINE_CACHE_KEY, JSON.stringify({ response, cachedAt, signature, watermark }));
  } catch {
    // Cache writes are best-effort; a failed write should not block navigation.
  }
}

function timelineWatermarkFromResponse(response: ActivityTimelineResponse) {
  const latestItem = response.buckets
    .flatMap(bucket => bucket.items)
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
  const viewUpdatedAt = response.view.updated_at ?? "";
  return [
    "response",
    response.records_used,
    response.events_used,
    latestItem?.observed_at ?? "",
    latestItem?.id ?? "",
    viewUpdatedAt,
  ].join(":");
}

function cachedTimelineStatus(response: ActivityTimelineResponse, cachedAt: number) {
  const age = cachedAt ? relativeTime(new Date(cachedAt).toISOString()) : "cached";
  return `${response.records_used} records · ${response.buckets.length} buckets · cached ${age}`;
}

function loadCachedViewFamilies(): { response: ViewFamiliesResponse; cachedAt: number } | null {
  try {
    const raw = window.localStorage.getItem(VIEW_FAMILIES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { response?: ViewFamiliesResponse; cachedAt?: number };
    if (!parsed.response?.ok || !Array.isArray(parsed.response.families)) return null;
    rememberViewCatalog(parsed.response.catalog);
    return { response: parsed.response, cachedAt: Number(parsed.cachedAt ?? 0) || 0 };
  } catch {
    return null;
  }
}

function saveCachedViewFamilies(response: ViewFamiliesResponse, cachedAt = Date.now()) {
  try {
    window.localStorage.setItem(VIEW_FAMILIES_CACHE_KEY, JSON.stringify({ response, cachedAt }));
  } catch {
    // Cache writes are best-effort; the app should keep working without storage.
  }
}

function cachedViewsStatus(response: ViewFamiliesResponse, cachedAt: number) {
  const age = cachedAt ? relativeTime(new Date(cachedAt).toISOString()) : "cached";
  return `${response.views.length} active views · cached ${age}`;
}

function loadCachedTypeViews(): Record<string, ContextViewSummary[]> {
  try {
    const raw = window.localStorage.getItem(VIEW_TYPE_VIEWS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { viewsByType?: Record<string, ContextViewSummary[]> };
    if (!parsed.viewsByType || typeof parsed.viewsByType !== "object") return {};
    const out: Record<string, ContextViewSummary[]> = {};
    for (const [type, views] of Object.entries(parsed.viewsByType)) {
      if (!Array.isArray(views)) continue;
      out[type] = views.filter(view => view && view.view_type === type && typeof view.id === "string").slice(0, 80);
    }
    return out;
  } catch {
    return {};
  }
}

function saveCachedTypeViews(viewsByType: Record<string, ContextViewSummary[]>) {
  try {
    const compact: Record<string, ContextViewSummary[]> = {};
    for (const [type, views] of Object.entries(viewsByType)) {
      if (!views.length) continue;
      compact[type] = views.slice(0, 80);
    }
    window.localStorage.setItem(VIEW_TYPE_VIEWS_CACHE_KEY, JSON.stringify({ viewsByType: compact, cachedAt: Date.now() }));
  } catch {
    // Cache writes are best-effort; the next request can hydrate this again.
  }
}

function audioListText(view: ContextViewSummary): string | undefined {
  return audioTranscriptText(view) || stringContent(view, "transcript_excerpt") || view.summary;
}

function audioListTags(view: ContextViewSummary): string[] {
  return audioDetailTags(view).slice(0, 5);
}

function audioDetailTags(view: ContextViewSummary): string[] {
  const tags = [
    stringContent(view, "transcript_quality"),
    stringContent(view, "speaker_label"),
    stringContent(view, "device_name"),
    ...stringArrayContent(view, "topics").slice(0, 3),
  ];
  return [...new Set(tags.filter((tag): tag is string => Boolean(tag)))];
}

function audioTimelineItemsFrom(_views: ContextViewSummary[], liveItems: AudioTranscriptItem[]): AudioTimelineItem[] {
  const items: AudioTimelineItem[] = [];
  for (const item of liveItems) {
    const text = typeof item.text === "string" && item.text.trim() ? item.text.trim() : undefined;
    if (!text) continue;
    items.push({
      id: `screenpipe:${item.chunk_id ?? item.id}`,
      text,
      observed_at: item.observed_at,
      speaker_label: item.speaker_label,
      device_name: item.device_name,
      chunk_id: item.chunk_id,
      start_time: item.start_time,
      end_time: item.end_time,
      source: "screenpipe",
    });
  }
  const deduped = dedupeAudioTimelineItems(items);
  return mergeAudioTimelineItems(deduped, 90_000);
}

function dedupeAudioTimelineItems(items: AudioTimelineItem[]): AudioTimelineItem[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => Date.parse(b.observed_at ?? "") - Date.parse(a.observed_at ?? ""))
    .filter(item => {
      const observedMs = Date.parse(item.observed_at ?? "");
      const timeKey = Number.isFinite(observedMs) ? String(Math.floor(observedMs / 1000)) : item.id;
      const key = `${timeKey}:${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mergeAudioTimelineItems(items: AudioTimelineItem[], maxGapMs: number): AudioTimelineItem[] {
  const sorted = [...items].sort((a, b) => audioAbsoluteStartMs(a) - audioAbsoluteStartMs(b));
  const groups: AudioTimelineItem[][] = [];
  for (const item of sorted) {
    const itemTime = audioAbsoluteStartMs(item);
    const lastGroup = groups.at(-1);
    const lastItem = lastGroup?.at(-1);
    const lastTime = lastItem ? audioAbsoluteEndMs(lastItem) : Number.NaN;
    if (!lastGroup || !Number.isFinite(itemTime) || !Number.isFinite(lastTime) || itemTime - lastTime > maxGapMs) {
      groups.push([item]);
    } else {
      lastGroup.push(item);
    }
  }
  return groups.map(group => {
    const first = group[0];
    const last = group[group.length - 1];
    const speakers = [...new Set(group.map(item => item.speaker_label).filter((value): value is string => Boolean(value)))];
    const devices = [...new Set(group.map(item => item.device_name).filter((value): value is string => Boolean(value)))];
    return {
      id: group.map(item => item.id).join("|"),
      text: group.map(item => item.text).join("\n"),
      observed_at: first.observed_at,
      ended_at: audioTimestampWithOffset(last.observed_at, last.end_time ?? last.start_time),
      speaker_label: speakers.length === 1 ? speakers[0] : speakers.length ? `${speakers.length} speakers` : undefined,
      device_name: devices.length === 1 ? devices[0] : devices.length ? `${devices.length} devices` : undefined,
      source: "screenpipe" as const,
      chunk_count: group.length,
    };
  }).sort((a, b) => Date.parse(b.ended_at ?? b.observed_at ?? "") - Date.parse(a.ended_at ?? a.observed_at ?? ""));
}

function audioAbsoluteStartMs(item: AudioTimelineItem): number {
  const base = Date.parse(item.observed_at ?? "");
  return Number.isFinite(base) ? base + Math.max(0, item.start_time ?? 0) * 1000 : Number.NaN;
}

function audioAbsoluteEndMs(item: AudioTimelineItem): number {
  const base = Date.parse(item.observed_at ?? "");
  const offset = item.end_time ?? item.start_time ?? 0;
  return Number.isFinite(base) ? base + Math.max(0, offset) * 1000 : Number.NaN;
}

function audioTimestampWithOffset(value?: string, offsetSeconds?: number): string | undefined {
  const base = Date.parse(value ?? "");
  if (!Number.isFinite(base)) return value;
  return new Date(base + Math.max(0, offsetSeconds ?? 0) * 1000).toISOString();
}

function audioTimelineTags(item: AudioTimelineItem): string[] {
  return [...new Set([
    item.source === "screenpipe" ? "live" : item.quality,
    item.speaker_label,
    item.device_name,
    item.chunk_count && item.chunk_count > 1 ? `${item.chunk_count} chunks` : undefined,
  ].filter((tag): tag is string => Boolean(tag)))];
}

function audioTimelineTimeLabel(item: AudioTimelineItem): string {
  const start = clockTime(item.observed_at);
  const end = clockTime(item.ended_at);
  if (start && end && start !== end) return `${start}\n${end}`;
  return start || relativeTime(item.observed_at) || "—";
}


function audioObservedAt(view: ContextViewSummary): string | undefined {
  const timeRange = view.scope?.time_range;
  if (timeRange && typeof timeRange === "object" && !Array.isArray(timeRange)) {
    const start = (timeRange as Record<string, unknown>).start;
    if (typeof start === "string") return start;
  }
  return view.updated_at ?? view.created_at;
}

function audioTranscriptText(view: ContextViewSummary): string | undefined {
  const content = view.content ?? {};
  const direct = firstString(content, ["transcript", "full_transcript", "text", "utterance", "transcription"]);
  if (direct) return direct;
  const segments = audioSegments(view);
  if (segments.length) return segments.map(segment => segment.text).join("\n");
  return undefined;
}

function audioSegments(view: ContextViewSummary): Array<{ text: string; at?: string; speaker?: string }> {
  const content = view.content ?? {};
  const candidates = [content.segments, content.utterances, content.transcript_segments, content.lines];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const segments = value.map(item => {
      if (typeof item === "string" && item.trim()) return { text: item.trim() };
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const text = readableValue(record.text) ?? readableValue(record.transcript) ?? readableValue(record.utterance);
      if (!text) return undefined;
      const at = readableValue(record.time) ?? readableValue(record.at) ?? readableValue(record.start) ?? readableValue(record.start_at);
      const speaker = readableValue(record.speaker) ?? readableValue(record.speaker_label);
      return { text, at, speaker };
    }).filter((segment): segment is { text: string; at?: string; speaker?: string } => Boolean(segment));
    if (segments.length) return segments;
  }
  return [];
}

function audioTimeLabel(view: ContextViewSummary): string | undefined {
  const timeRange = view.scope?.time_range;
  if (timeRange && typeof timeRange === "object" && !Array.isArray(timeRange)) {
    const record = timeRange as Record<string, unknown>;
    const start = typeof record.start === "string" ? record.start : undefined;
    const end = typeof record.end === "string" ? record.end : undefined;
    if (start && end && start !== end) return `${clockTime(start)}-${clockTime(end)}`;
    if (start) return clockTime(start);
  }
  return clockTime(view.updated_at ?? view.created_at);
}

function clockTime(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function TimelineWorkbench({
  timeline,
  buckets,
  signals,
  stats,
  loading,
  status,
  syncState,
  syncStatus,
  live,
  detailMode,
  sourceFilter,
  selectedItemId,
  onSelect,
  onOpenFrame,
  onSourceFilter,
  onSync,
}: {
  timeline: ActivityTimelineResponse | null;
  buckets: TimelineBucket[];
  signals: ReturnType<typeof summarizeSignals>;
  stats: ReturnType<typeof summarize>;
  loading: boolean;
  status: string;
  syncState: TimelineSyncState;
  syncStatus: string;
  live: boolean;
  detailMode: DetailMode;
  sourceFilter: SourceFilter;
  selectedItemId: string | null;
  onSelect: (id: string) => void;
  onOpenFrame: (preview: FramePreview) => void;
  onSourceFilter: (filter: SourceFilter) => void;
  onSync: () => void;
}) {
  const rawItems = numericMeta(timeline?.view?.metadata?.item_count, buckets.reduce((sum, bucket) => sum + bucket.count, 0));
  const recordCount = timeline?.records_used ?? 0;
  const timelineStatus = syncState === "syncing" || syncState === "error"
    ? syncStatus || status
    : stats.last !== "—"
      ? `Live · latest ${stats.last}`
      : syncStatus || status;
  return (
    <section className="timeline-workspace" aria-label="Timeline workspace">
      <div className="timeline-main-panel">
        <div className="timeline-greeting">
          <h2>早上好, Junjie</h2>
          <span>{live ? "正在记录" : "已暂停"} · {timelineStatus}</span>
        </div>
        <Timeline buckets={buckets} loading={loading} sourceFilter={sourceFilter} selectedItemId={selectedItemId} detailMode={detailMode} onSelect={onSelect} onOpenFrame={onOpenFrame} />
      </div>
      <aside className="timeline-side-panel" aria-label="Timeline details">
        <section className="capture-card">
          <div className="capture-card-head">
            <div>
              <span>桌面</span>
              <b>{signals.top_apps[0] ?? signals.top_domains[0] ?? "MetaFlow"}</b>
            </div>
            <button className={`capture-toggle ${live ? "on" : ""}`} type="button" aria-label="Timeline recording state" aria-pressed={live} />
          </div>
          <div className="capture-orbit" aria-hidden="true">
            <span>{sourceGlyph(sourceFilter)}</span>
          </div>
          <div className="capture-stats">
            <button type="button" onClick={onSync} aria-label="Sync now">↵</button>
            <div><b>{stats.items}</b><span>今天</span></div>
            <div><b>{rawItems}</b><span>总计</span></div>
          </div>
          <div className={`capture-sync-state ${syncState}`}>
            {live ? (syncState === "syncing" ? "Auto syncing" : syncState === "error" ? "Sync needs attention" : "Auto sync on") : "Auto sync paused"}
          </div>
        </section>

        <section className="timeline-view-card">
          <div>
            <span>记录中的 View</span>
            <b>{timeline?.view?.view_type ?? "timeline.activity"}</b>
          </div>
          <p>{timeline?.view?.id ?? "刷新后会写入当前 timeline view"}</p>
          <div className="timeline-view-stats">
            <Tag>{recordCount} records</Tag>
            <Tag>{timeline?.buckets.length ?? 0} buckets</Tag>
            <Tag>{detailMode === "debug" ? "raw" : "simple"}</Tag>
          </div>
        </section>

        <section className="timeline-source-card">
          <span>来源</span>
          <div>
            {(["all", "browser", "screenpipe", "runtime"] as SourceFilter[]).map(filter => (
              <button key={filter} className={sourceFilter === filter ? "active" : ""} type="button" onClick={() => onSourceFilter(filter)}>
                {sourceFilterLabel(filter)}
              </button>
            ))}
          </div>
        </section>
      </aside>
    </section>
  );
}

function Timeline({ buckets, loading, sourceFilter, selectedItemId, detailMode, onSelect, onOpenFrame }: { buckets: TimelineBucket[]; loading: boolean; sourceFilter: SourceFilter; selectedItemId: string | null; detailMode: DetailMode; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
  if (loading) return <TimelineSkeleton />;
  if (!buckets.length) return (
    <div className="timeline-empty-state">
      <div className="empty-clock">◷</div>
      <b>暂无事件</b>
      <span>开始屏幕录制后，事件将在此显示</span>
    </div>
  );
  if (detailMode === "activity") {
    const focusBuckets = focusBucketsFromTimeline(buckets);
    return (
      <section className="timeline-list focus-timeline-list" aria-label="Focus timeline">
        {focusBuckets.map(bucket => (
          <FocusBucketView
            key={bucket.label}
            bucket={bucket}
            selectedItemId={selectedItemId}
            onSelect={onSelect}
            onOpenFrame={onOpenFrame}
          />
        ))}
      </section>
    );
  }
  return (
    <section className="timeline-list" aria-label="Activity timeline">
      {buckets.map(bucket => <Bucket key={bucket.label} bucket={bucket} selectedItemId={selectedItemId} detailMode={detailMode} onSelect={onSelect} onOpenFrame={onOpenFrame} />)}
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

function Bucket({ bucket, selectedItemId, detailMode, onSelect, onOpenFrame }: { bucket: TimelineBucket; selectedItemId: string | null; detailMode: DetailMode; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
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
        {bucket.items.map(item => <TimelineRow key={item.id} item={item} selected={item.id === selectedItemId} detailMode={detailMode} onSelect={() => onSelect(item.id)} onOpenFrame={onOpenFrame} />)}
      </div>
    </section>
  );
}

function FocusBucketView({ bucket, selectedItemId, onSelect, onOpenFrame }: { bucket: FocusBucket; selectedItemId: string | null; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
  return (
    <section className="bucket focus-bucket">
      <div className="bucket-heading focus-bucket-heading">
        <div>
          <time>{formatRange(bucket.start, bucket.end)}</time>
          <p>{bucket.segments.length} focus segment{bucket.segments.length === 1 ? "" : "s"} around {bucket.dominant}</p>
        </div>
        <span>{bucket.dominant} · {bucket.count}</span>
      </div>
      <div className="focus-segments">
        {bucket.segments.map(segment => (
          <FocusSegmentRow
            key={segment.id}
            segment={segment}
            selected={segment.items.some(item => item.id === selectedItemId)}
            onSelect={() => onSelect(segment.items[0]?.id ?? segment.id)}
            onOpenFrame={onOpenFrame}
          />
        ))}
      </div>
    </section>
  );
}

function FocusSegmentRow({ segment, selected, onSelect, onOpenFrame }: { segment: FocusSegment; selected: boolean; onSelect: () => void; onOpenFrame: (preview: FramePreview) => void }) {
  const shownSources = segment.sources.slice(0, 3);
  return (
    <article className={`focus-segment ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="focus-time">
        <time>{formatSegmentRange(segment.start, segment.end)}</time>
        {segment.durationMinutes !== undefined && <span>{formatDuration(segment.durationMinutes)}</span>}
      </div>
      <div className={`focus-source-mark ${segment.sourceClass}`}>{focusIcon(segment)}</div>
      <div className="focus-content">
        <div className="focus-title">
          <b>{segment.title}</b>
          <span>{segment.app ?? segment.domain ?? "activity"}</span>
        </div>
        {segment.subtitle && <p>{segment.subtitle}</p>}
        <div className="focus-tags">
          {shownSources.map(source => <Tag key={source}>{source}</Tag>)}
          <Tag>{segment.samples} samples</Tag>
          {segment.dwellSeconds !== undefined && <Tag>{Math.round(segment.dwellSeconds)}s dwell</Tag>}
          {segment.scrollDepth !== undefined && <Tag>{Math.round(segment.scrollDepth * 100)}% scroll</Tag>}
          {segment.frameIds.length > 0 ? <Tag>{segment.frameIds.length} frames</Tag> : segment.screenshotCount > 0 ? <Tag>{segment.screenshotCount} screenshots</Tag> : null}
        </div>
        {selected && (
          <section className="timeline-inline-detail focus-inline-detail" aria-label="Selected focus evidence">
            <EvidencePath item={segment.items.at(-1) ?? segment.items[0]} title="Focus path" />
            {segment.frameIds.length > 0 && <FrameLauncher frameIds={segment.frameIds} title={segment.title} onSelect={onSelect} onOpenFrame={onOpenFrame} expanded />}
            {segment.text && <EvidenceText title={evidenceTextTitle(segment.items)} text={segment.text} />}
            <div className="timeline-inline-facts">
              {inlineFact("source mix", segment.sources.join(", "))}
              {inlineFact("app", segment.app)}
              {inlineFact("domain", segment.domain)}
              {inlineFact("time", `${new Date(segment.start).toLocaleString()} - ${new Date(segment.end).toLocaleString()}`)}
            </div>
            <EvidenceRecordList items={segment.items} />
          </section>
        )}
      </div>
      {segment.frameIds.length > 0 && (
        <div className="focus-frame-strip" onClick={event => event.stopPropagation()}>
          <FrameLauncher frameIds={segment.frameIds.slice(0, 3)} title={segment.title} onSelect={onSelect} onOpenFrame={onOpenFrame} />
        </div>
      )}
    </article>
  );
}

function TimelineRow({ item, selected, detailMode, onSelect, onOpenFrame }: { item: TimelineItem; selected: boolean; detailMode: DetailMode; onSelect: () => void; onOpenFrame: (preview: FramePreview) => void }) {
  const frameIds = frameIdsOf(item);
  const screenshotHint = frameIds.length === 0 ? screenshotCountOf(item) : 0;
  const webUrl = item.url || stringStat(item, "browser_url");
  const showEvidence = detailMode === "debug" || selected;
  const aiSession = isAiSessionItem(item);
  return (
    <article className={`timeline-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className={`row-icon ${sourceClass(item)}`}>{iconFor(item)}</div>
      <div className="row-content">
        <div className="row-title">
          <b>{item.title}</b>
          <time>{timeOfDay(item.observed_at)}</time>
        </div>
        <div className="row-subtitle">{item.subtitle || sourceLabel(item)}</div>
        {showEvidence && <AttributionStrip item={item} />}
        {showEvidence && item.text && <div className="row-text">{item.text}</div>}
        {showEvidence && frameIds.length > 0 && <FrameLauncher frameIds={frameIds} title={item.title} onSelect={onSelect} onOpenFrame={onOpenFrame} />}
        {showEvidence && screenshotHint > 0 && (
          <div className="row-evidence-hint" title="This activity summary has screenshots, but no frame IDs were attached to the summary. Switch to Evidence debug for raw OCR frames.">
            {screenshotHint} screenshots captured · raw frames in Evidence debug
          </div>
        )}
        {showEvidence && <div className="row-meta">
          <Tag>{item.source}</Tag>
          {item.schema && <Tag>{item.schema}</Tag>}
          {item.app && <Tag>{item.app}</Tag>}
          {item.domain && <Tag>{item.domain}</Tag>}
          {item.project && <Tag>{item.project}</Tag>}
          {item.stats?.dwell_seconds !== undefined && <Tag>{Math.round(Number(item.stats.dwell_seconds))}s dwell</Tag>}
          {detailTags(item).map(tag => <Tag key={tag}>{tag}</Tag>)}
        </div>}
        {showEvidence && (item.url || item.path || detailCode(item)) && <code>{item.url || item.path || detailCode(item)}</code>}
        {selected && (
          <section className="timeline-inline-detail" aria-label="Selected timeline evidence">
            <EvidencePath item={item} title="Observation path" />
            {frameIds.length > 0 && <FrameLauncher frameIds={frameIds} title={item.title} onSelect={onSelect} onOpenFrame={onOpenFrame} expanded />}
            {aiSession ? <AiSessionDetail item={item} /> : item.text && <EvidenceText title={evidenceTextTitle([item])} text={item.text} />}
            <div className="timeline-inline-facts">
              {inlineFact("source", item.source)}
              {inlineFact("schema", item.schema)}
              {inlineFact("app", item.app)}
              {inlineFact("domain", item.domain)}
              {inlineFact("tool", stringStat(item, "tool"))}
              {inlineFact("time", new Date(item.observed_at).toLocaleString())}
            </div>
            <EvidenceRecordList items={[item]} />
          </section>
        )}
      </div>
    </article>
  );
}

function EvidencePath({ item, title }: { item?: TimelineItem; title: string }) {
  if (!item) return null;
  const url = item.url ?? stringStat(item, "browser_url") ?? stringStat(item, "reported_url");
  const path = item.path ?? stringStat(item, "source_path") ?? stringStat(item, "project_path");
  const windowName = stringStat(item, "window_title") ?? stringStat(item, "window_name");
  const steps = [
    item.source,
    item.schema,
    item.app ?? item.domain,
    windowName,
    url ?? path,
  ].filter((value): value is string => Boolean(value));
  if (!steps.length) return null;
  return (
    <div className="evidence-path">
      <span>{title}</span>
      <div>
        {steps.map((step, index) => (
          <React.Fragment key={`${step}-${index}`}>
            {index > 0 && <i>/</i>}
            {index === steps.length - 1 && url ? (
              <a href={url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{step}</a>
            ) : (
              <b>{step}</b>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function EvidenceText({ title, text }: { title: string; text: string }) {
  return (
    <details className="evidence-text" open>
      <summary>{title}</summary>
      <p>{text}</p>
    </details>
  );
}

function EvidenceRecordList({ items }: { items: TimelineItem[] }) {
  const rows = items.flatMap(item => {
    const ids = item.record_ids?.length ? item.record_ids : item.event_ids ?? [];
    return ids.map(id => ({ id, item }));
  });
  if (!rows.length) return null;
  return (
    <details className="evidence-records">
      <summary>{rows.length} source record{rows.length === 1 ? "" : "s"}</summary>
      <div>
        {rows.slice(0, 24).map(({ id, item }, index) => (
          <code key={`${id}-${index}`}>
            <span>{item.schema ?? item.event_type ?? item.kind}</span>
            <b>{timeOfDay(item.observed_at)} · {item.title}</b>
            <em>{id}</em>
          </code>
        ))}
        {rows.length > 24 && <strong>+{rows.length - 24} more records</strong>}
      </div>
    </details>
  );
}

function evidenceTextTitle(items: TimelineItem[]) {
  const hay = items.map(item => `${item.schema ?? ""} ${item.source} ${stringStat(item, "content_type") ?? ""}`).join(" ").toLowerCase();
  if (hay.includes("audio")) return "Audio transcript";
  if (hay.includes("ocr") || hay.includes("screenpipe")) return "Screen OCR text";
  if (hay.includes("browser")) return "Page text";
  return "Observation text";
}

function AiSessionDetail({ item }: { item: TimelineItem }) {
  const stats = item.stats ?? {};
  const files = stringArrayStat(item, "files_touched");
  const commands = stringArrayStat(item, "commands_run");
  return (
    <div className="ai-session-detail">
      <div className="ai-session-summary">
        {aiSessionFact("messages", numberStat(stats.message_count))}
        {aiSessionFact("tool calls", numberStat(stats.tool_call_count))}
        {aiSessionFact("files", numberStat(stats.files_touched_count) ?? files.length)}
        {aiSessionFact("window", aiSessionWindowLabel(item))}
      </div>
      {item.text && <p>{item.text}</p>}
      {files.length > 0 && (
        <div className="ai-session-list">
          <b>Files touched</b>
          {files.slice(0, 6).map(file => <code key={file}>{file}</code>)}
        </div>
      )}
      {commands.length > 0 && (
        <div className="ai-session-list">
          <b>Commands</b>
          {commands.slice(0, 4).map(command => <code key={command}>{command}</code>)}
        </div>
      )}
      {(item.path || stringStat(item, "source_path")) && <code className="ai-session-path">{item.path || stringStat(item, "source_path")}</code>}
    </div>
  );
}

function aiSessionFact(label: string, value?: string | number | null) {
  if (value === undefined || value === null || value === "") return null;
  return <span><b>{label}</b>{value}</span>;
}

function inlineFact(label: string, value?: string) {
  if (!value) return null;
  return <span key={label}><b>{label}</b>{value}</span>;
}

function ViewFramePreview({ frameIds, title }: { frameIds: Array<string | number>; title?: string }) {
  const [preview, setPreview] = useState<FramePreview | null>(null);
  return (
    <>
      <div className="view-frame-preview">
        <div className="view-frame-preview-head">
          <strong>OCR frame</strong>
          <span>{frameIds.length === 1 ? `frame_id: ${frameIds[0]}` : `${frameIds.length} frames`}</span>
        </div>
        <FrameLauncher frameIds={frameIds} title={title} onSelect={() => undefined} onOpenFrame={setPreview} expanded />
      </div>
      <FrameLightbox preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function FrameLauncher({ frameIds, title, onSelect, onOpenFrame, expanded = false }: { frameIds: Array<string | number>; title?: string; onSelect: () => void; onOpenFrame: (preview: FramePreview) => void; expanded?: boolean }) {
  const shown = expanded ? frameIds.slice(0, 6) : frameIds.slice(0, 1);
  return (
    <div className={`row-frames ${expanded ? "expanded frame-grid" : "compact"}`} aria-label="Screenpipe OCR screenshots">
      {shown.map((frameId, index) => (
        <div
          key={String(frameId)}
          className="frame-preview-wrap"
        >
          <FrameThumb frameId={frameId} title={title} onOpenFrame={onOpenFrame} large={expanded} />
          <span>{expanded ? `Screenshot ${index + 1}` : "Screenshot"} · {frameId}</span>
        </div>
      ))}
      {frameIds.length > shown.length && (
        <button className="row-frame-count" type="button" onClick={event => {
          event.stopPropagation();
          onSelect();
        }}>+{frameIds.length - shown.length}</button>
      )}
    </div>
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
  return buckets.map(bucket => {
    const items = bucket.items.filter(item => sourceMatches(item, filter) && (detailMode === "debug" || !isDebugTimelineItem(item)));
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

function isDebugTimelineItem(item: TimelineItem) {
  const hay = `${item.source} ${item.schema ?? ""} ${item.event_type ?? ""}`.toLowerCase();
  return hay.includes("route_candidate") || hay.includes("processor.route_candidate");
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

function sourceGlyph(filter: SourceFilter) {
  if (filter === "screenpipe") return "◉";
  if (filter === "browser") return "↗";
  if (filter === "runtime") return "◆";
  return "M";
}

function numericMeta(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  return Number.isFinite(number) ? number : fallback;
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
    "memory.preferences": "Memory Preferences",
    "memory.workflow_patterns": "Workflow Patterns",
    "memory.skill_gaps": "Skill Gaps",
    "memory.agent_collaboration_style": "Agent Collaboration",
    "agent.case_memory": "Agent Case Memory",
    "learning.youtube_fragment": "YouTube Fragment",
    "learning.review_queue": "Review Queue",
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

function compareViewsNewestFirst(a: ContextViewSummary, b: ContextViewSummary) {
  const updated = dateMs(b.updated_at) - dateMs(a.updated_at);
  if (updated) return updated;
  const created = dateMs(b.created_at) - dateMs(a.created_at);
  if (created) return created;
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

function dateMs(value?: string) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
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
    "memory.preferences": "stable user preferences",
    "memory.workflow_patterns": "reusable work patterns",
    "memory.skill_gaps": "support areas to revisit",
    "memory.agent_collaboration_style": "agent collaboration style",
    "agent.case_memory": "reusable agent cases",
    "learning.youtube_fragment": "caption fragment",
    "learning.review_queue": "review queue",
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

function focusBucketsFromTimeline(buckets: TimelineBucket[]): FocusBucket[] {
  const bucketByLabel = new Map<string, { start: string; end: string; segments: FocusSegment[] }>();
  for (const bucket of buckets) bucketByLabel.set(bucket.label, { start: bucket.start, end: bucket.end, segments: [] });
  for (const segment of focusSegmentsFromItems(buckets.flatMap(bucket => bucket.items))) {
    const label = bucketLabelForIso(segment.end, buckets);
    const bucket = bucketByLabel.get(label) ?? { start: segment.start, end: segment.end, segments: [] };
    bucket.segments.push(segment);
    bucketByLabel.set(label, bucket);
  }
  return [...bucketByLabel.entries()]
    .map(([label, bucket]) => {
      const segments = bucket.segments.sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
      return {
        label,
        start: bucket.start,
        end: bucket.end,
        count: segments.reduce((sum, segment) => sum + segment.samples, 0),
        dominant: top(segments.map(segment => segment.app ?? segment.domain ?? segment.sources[0]).filter(Boolean) as string[], 1)[0] ?? "activity",
        segments,
      };
    })
    .filter(bucket => bucket.segments.length > 0)
    .sort((a, b) => b.label.localeCompare(a.label));
}

function focusSegmentsFromItems(items: TimelineItem[]): FocusSegment[] {
  const sorted = [...items]
    .filter(item => !isDebugTimelineItem(item))
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const groups: TimelineItem[][] = [];
  for (const item of sorted) {
    const key = focusIdentityKey(item);
    const at = Date.parse(item.observed_at);
    const previous = groups.at(-1);
    const previousItem = previous?.at(-1);
    const canMerge = !isScreenOcrItem(item) && previousItem && !isScreenOcrItem(previousItem);
    if (previous && previousItem && canMerge && key === focusIdentityKey(previousItem) && at - Date.parse(previousItem.observed_at) <= 8 * 60_000) {
      previous.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups.map(focusSegmentFromGroup)
    .filter(segment => !isLowValueFocusSegment(segment))
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
}

function focusSegmentFromGroup(group: TimelineItem[]): FocusSegment {
  const sorted = [...group].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const first = sorted[0];
  const last = sorted.at(-1) ?? first;
  const start = stringStat(first, "start") ?? first.observed_at;
  const end = stringStat(last, "end") ?? last.observed_at;
  const durationMinutes = durationMinutesBetween(start, end) ?? durationMinutesFromItems(sorted);
  const frameIds = uniqueValues(sorted.flatMap(frameIdsOf));
  const dwellSeconds = maxNumberFromItems(sorted, "dwell_seconds");
  const scrollDepth = maxNumberFromItems(sorted, "scroll_depth");
  const title = cleanFocusTitle(bestFocusTitle(sorted));
  const domain = last.domain ?? first.domain ?? domainFromUrl(last.url ?? first.url);
  const app = last.app ?? first.app;
  const sources = top(sorted.map(item => sourceShortLabel(item)), 5);
  const subtitleParts = [
    readableDomain(domain),
    isScreenOcrItem(last) ? stringStat(last, "window_title") ?? stringStat(last, "window_name") : undefined,
    isScreenOcrItem(last) ? frameRangeLabel(frameIdsOf(last)) : undefined,
    urlPathLabel(last.url ?? first.url),
    durationMinutes !== undefined ? formatDuration(durationMinutes) : undefined,
    sorted.length > 1 ? `${sorted.length} records` : undefined,
  ].filter(Boolean);
  return {
    id: `focus:${hashText(`${focusIdentityKey(last)}|${start}|${end}|${sorted.map(item => item.id).join("|")}`)}`,
    title,
    subtitle: subtitleParts.join(" · ") || last.subtitle || sourceLabel(last),
    app,
    domain,
    url: last.url ?? first.url ?? stringStat(last, "browser_url") ?? stringStat(first, "browser_url"),
    sourceClass: dominantSourceClass(sorted),
    sources,
    items: sorted,
    start,
    end,
    durationMinutes,
    samples: sorted.reduce((sum, item) => sum + numberStatValue(item.stats?.samples, 1), 0),
    frameIds,
    screenshotCount: sorted.reduce((sum, item) => sum + screenshotCountOf(item), 0),
    dwellSeconds,
    scrollDepth,
    text: sorted.find(item => item.text)?.text,
  };
}

function isLowValueFocusSegment(segment: FocusSegment) {
  const title = segment.title.toLowerCase();
  if (segment.items.some(isScreenOcrItem)) return false;
  if (title.includes("continued") && segment.samples <= 1) return true;
  return false;
}

function focusIdentityKey(item: TimelineItem) {
  const url = normalizeTimelineUrl(item.url ?? stringStat(item, "browser_url") ?? stringStat(item, "reported_url"));
  if (url) return `url:${url}`;
  const windowName = stringStat(item, "window_name") ?? stringStat(item, "window_title");
  return [
    sourceClass(item),
    item.app ?? "",
    item.domain ?? "",
    cleanFocusTitle(windowName ?? item.title),
  ].join("|").toLowerCase();
}

function bestFocusTitle(items: TimelineItem[]) {
  const candidates = [...items].reverse();
  if (candidates.some(isScreenOcrItem)) return "Screen OCR";
  return candidates.find(item => item.url && item.title)?.title
    ?? candidates.find(item => item.schema?.includes("screenpipe_activity_summary") && item.title)?.title
    ?? candidates.find(item => !item.title.toLowerCase().includes("continued"))?.title
    ?? candidates[0]?.title
    ?? "Activity";
}

function isScreenOcrItem(item: TimelineItem) {
  const contentType = stringStat(item, "content_type") ?? stringStat(item, "reported_content_type");
  const hay = `${item.schema ?? ""} ${item.source} ${item.title} ${contentType ?? ""}`.toLowerCase();
  return hay.includes("screenpipe") && (hay.includes("ocr") || hay.includes("screen ocr"));
}

function cleanFocusTitle(value?: string) {
  const cleaned = (value ?? "Activity")
    .replace(/\s*·\s*continued$/i, "")
    .replace(/\s+-\s+Google Chrome$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Activity";
}

function bucketLabelForIso(iso: string, buckets: TimelineBucket[]) {
  const time = Date.parse(iso);
  const bucket = buckets.find(candidate => {
    const start = Date.parse(candidate.start);
    const end = Date.parse(candidate.end);
    return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(time) && time >= start && time < end;
  });
  return bucket?.label ?? buckets[0]?.label ?? iso;
}

function formatSegmentRange(start: string, end: string) {
  const startLabel = timeOfDay(start);
  const endLabel = timeOfDay(end);
  return startLabel === endLabel ? endLabel : `${startLabel}-${endLabel}`;
}

function focusIcon(segment: FocusSegment) {
  if (segment.sourceClass === "screenpipe") return "◉";
  if (segment.sourceClass === "browser") return "↗";
  if (segment.sourceClass === "runtime") return "◆";
  if ((segment.app ?? "").toLowerCase().includes("cursor")) return "⌘";
  return "•";
}

function dominantSourceClass(items: TimelineItem[]) {
  const classes = top(items.map(sourceClass), 1);
  return classes[0] ?? "other";
}

function sourceShortLabel(item: TimelineItem) {
  const klass = sourceClass(item);
  if (klass === "screenpipe") return "Screenpipe";
  if (klass === "browser") return "Browser";
  if (klass === "runtime") return "Runtime";
  return item.source;
}

function durationMinutesBetween(start: string, end: string) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  return (endMs - startMs) / 60_000;
}

function durationMinutesFromItems(items: TimelineItem[]) {
  const explicit = maxNumberFromItems(items, "duration_minutes");
  if (explicit !== undefined && explicit > 0) return explicit;
  const dwell = maxNumberFromItems(items, "dwell_seconds");
  return dwell !== undefined && dwell > 0 ? dwell / 60 : undefined;
}

function maxNumberFromItems(items: TimelineItem[], key: string) {
  const values = items.map(item => Number(item.stats?.[key])).filter(Number.isFinite);
  return values.length ? Math.max(...values) : undefined;
}

function numberStatValue(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function uniqueValues<T extends string | number>(values: T[]) {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function domainFromUrl(url?: string) {
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

function readableDomain(domain?: string) {
  return domain?.replace(/^www\./, "");
}

function urlPathLabel(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/\/$/, "");
    return path && path !== "/" ? path.slice(0, 56) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTimelineUrl(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

function todayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: now.toISOString() };
}

function timelineRangeMinutes(range: { start: string; end: string }) {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 24 * 60;
  return Math.ceil((end - start) / 60_000);
}

function timelineUiRecordLimit(minutes: number, sourceFilter: SourceFilter, detailMode: DetailMode) {
  if (sourceFilter === "screenpipe") return detailMode === "debug" ? 300 : 160;
  if (detailMode === "debug") {
    const samplesPerMinute = sourceFilter === "runtime" ? 2 : sourceFilter === "browser" ? 10 : 18;
    return Math.min(4_000, Math.max(1_000, Math.ceil(minutes * samplesPerMinute)));
  }
  const samplesPerMinute = sourceFilter === "runtime" ? 1 : sourceFilter === "browser" ? 5 : 10;
  return Math.min(TIMELINE_DAY_RECORD_LIMIT, Math.max(300, Math.ceil(minutes * samplesPerMinute)));
}

function liveSyncWindowMinutes() {
  return 30;
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

function isAiSessionItem(item: TimelineItem) {
  const hay = `${item.source} ${item.schema ?? ""}`.toLowerCase();
  return hay.includes("ai_session") || hay.includes("codex") || hay.includes("claude-code");
}

function aiSessionWindowLabel(item: TimelineItem): string | undefined {
  const started = stringStat(item, "started_at");
  const ended = stringStat(item, "ended_at") ?? stringStat(item, "last_activity_at");
  if (!started && !ended) return undefined;
  if (started && ended) return `${timeOfDay(started)}-${timeOfDay(ended)}`;
  return timeOfDay(started ?? ended ?? "");
}

function numberStat(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringArrayStat(item: TimelineItem, key: string): string[] {
  const value = item.stats?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function detailCode(item: TimelineItem) {
  const stats = item.stats ?? {};
  return String(stats.browser_url ?? stats.project_path ?? stats.repo ?? stats.window_name ?? stats.source_path ?? "");
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

function viewFrameIdsOf(view: ContextViewSummary): Array<string | number> {
  const values: Array<string | number> = [];
  collectFrameIdsFrom(view.content, values);
  collectFrameIdsFrom(recordValue(view.content?.signals), values);
  collectFrameIdsFrom(recordValue(view.content?.attribution), values);
  const seen = new Set<string>();
  return values.filter(value => {
    const key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectFrameIdsFrom(record: Record<string, unknown> | undefined, values: Array<string | number>) {
  if (!record) return;
  const many = record.frame_ids;
  if (Array.isArray(many)) {
    for (const value of many) {
      if (typeof value === "string" || typeof value === "number") values.push(value);
    }
  }
  const one = record.frame_id;
  if (typeof one === "string" || typeof one === "number") values.push(one);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function screenshotCountOf(item: TimelineItem): number {
  const value = item.stats?.frame_count ?? item.stats?.screenshots;
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
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

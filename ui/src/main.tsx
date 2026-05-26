import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchActivityTimeline, fetchContextView, fetchViewFamilies, screenpipeFrameUrl, syncScreenpipe } from "./api";
import type { ActivityTimelineResponse, ContextViewSummary, RuntimeTickResponse, TimelineBucket, TimelineItem, ViewFamiliesResponse, ViewFamilySummary } from "./types";
import "./styles.css";

const POLL_MS = 15_000;
const DEFAULT_MINUTES = 180;
const VIEW_TYPE_ORDER = ["evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow", "memory"];
type SourceFilter = "screenpipe" | "browser" | "runtime" | "all";
type DetailMode = "activity" | "debug";
type ActiveTab = "timeline" | "views";
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
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [detailMode, setDetailMode] = useState<DetailMode>("activity");
  const [activeTab, setActiveTab] = useState<ActiveTab>("timeline");
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
      const next = await fetchActivityTimeline({ minutes, bucketMinutes: chooseBucket(minutes), includeLowLevelScreenpipe: true, dedupe: false, bucketItemLimit: false, summarizeHeartbeats: false, sourceFilter, mergeContinuous: true, mergeGapMinutes: 3 });
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
    <div className={`app-shell ${activeTab === "views" ? "views-mode" : ""}`}>
      <aside className="sidebar">
        <div className="workspace-title">
          <div className="workspace-icon">I</div>
          <div>
            <b>Info</b>
            <span>Local runtime</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="App navigation">
          <button className={`nav-item ${activeTab === "timeline" ? "active" : ""}`} onClick={() => setActiveTab("timeline")}><span>◷</span>Timeline</button>
          <button className={`nav-item ${activeTab === "views" ? "active" : ""}`} onClick={() => setActiveTab("views")}><span>◇</span>Views</button>
        </nav>
        <div className="sidebar-foot">
          <div className={`live-dot ${live ? "on" : ""}`} />
          <span>{live ? "Live sync" : "Paused"}</span>
        </div>
      </aside>

      <main className="page">
        <header className="page-header">
          <div>
            <div className="breadcrumb">Info / Screenpipe</div>
            <h1>{activeTab === "timeline" ? "Timeline" : "Memory Views"}</h1>
            <p>{activeTab === "timeline" ? "按时间整理最近 focus 的 app、网页和项目活动。" : "查看 Observation 压缩出来的 EvidenceView、ActivityView、IntentView、WorkflowView 和 MemoryView。"}</p>
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
            ) : (
              <button onClick={() => refreshViews(false)} disabled={viewsLoading}>{viewsLoading ? "Loading…" : "Reload Views"}</button>
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
        ) : (
          <MemoryViewsPanel response={viewFamilies} loading={viewsLoading && !viewFamilies} status={viewStatus} onInspect={setViewInspector} />
        )}
      </main>
      {activeTab === "views"
        ? <aside className="view-inspector"><ViewDetail view={viewInspector.view} loading={viewInspector.loading} /></aside>
        : <Inspector item={selectedItem} onClose={() => setSelectedItemId(null)} onOpenFrame={setPreviewFrame} />}
      <FrameLightbox preview={previewFrame} onClose={() => setPreviewFrame(null)} />
    </div>
  );
}

function ViewGraph({ families }: { families: ViewFamilySummary[] }) {
  const canonical = ["evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow", "memory"];
  const shown = families.filter(family => family.count > 0 || canonical.includes(family.family));
  return (
    <section className="view-graph" aria-label="Memory view graph">
      <div className="view-graph-head">
        <span>Memory Views</span>
        <b>Observation → EvidenceView → ActivityView → ProposalView → Resource/Intent/Workflow → MemoryView</b>
      </div>
      <div className="view-family-list">
        {shown.map(family => <ViewFamily key={family.family} family={family} />)}
      </div>
    </section>
  );
}

function ViewFamily({ family }: { family: ViewFamilySummary }) {
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
  const [selectedType, setSelectedType] = useState("intent");
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ContextViewSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const families = response?.families ?? [];
  const views = response?.views ?? [];
  const aiViews = views.filter(view => compilerId(view).startsWith("ai."));
  const tabs = useMemo(() => VIEW_TYPE_ORDER.map(type => {
    const typeViews = views.filter(view => view.view_type === type);
    const aiCount = typeViews.filter(view => compilerId(view).startsWith("ai.")).length;
    return { type, count: typeViews.length, aiCount };
  }), [views]);
  const selectedViews = useMemo(() => views
    .filter(view => view.view_type === selectedType)
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "")), [views, selectedType]);
  const selectedSummary = selectedViews.find(view => view.id === selectedViewId) ?? selectedViews[0];
  const activeView = selectedDetail?.id === selectedSummary?.id ? selectedDetail : selectedSummary;

  useEffect(() => {
    if (!views.length) return;
    const currentHasViews = views.some(view => view.view_type === selectedType);
    if (!currentHasViews) setSelectedType(tabs.find(tab => tab.count > 0)?.type ?? "intent");
  }, [views, selectedType, tabs]);

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

  if (loading) return <div className="empty-state">Loading memory views…</div>;
  return (
    <>
      <section className="status-row views-status">
        <Stat label="Active Views" value={views.length} />
        <Stat label="AI Views" value={aiViews.length} />
        <Stat label="Families" value={families.filter(family => family.count > 0).length} />
        <div className="status-text">{status}</div>
      </section>
      <section className="view-type-tabs" aria-label="View type tabs">
        {tabs.map(tab => (
          <button key={tab.type} className={tab.type === selectedType ? "active" : ""} onClick={() => {
            setSelectedType(tab.type);
            setSelectedViewId(null);
            setSelectedDetail(null);
          }}>
            <span>{viewFamilyLabel(tab.type)}</span>
            <b>{tab.count}</b>
            {tab.aiCount > 0 && <em>{tab.aiCount} AI</em>}
          </button>
        ))}
      </section>
      <section className="view-reader" aria-label="Selected memory views">
        <div className="view-list-panel">
          <div className="view-list-head">
            <div>
              <b>{viewFamilyLabel(selectedType)}</b>
              <span>{selectedViews.length} views</span>
            </div>
            <Tag>{viewTypePurpose(selectedType)}</Tag>
          </div>
          <div className="view-list-items">
            {selectedViews.length ? selectedViews.map(view => (
              <ViewListRow key={view.id} view={view} selected={view.id === selectedSummary?.id} onSelect={() => setSelectedViewId(view.id)} />
            )) : <div className="empty-inline">No {viewFamilyLabel(selectedType)} yet.</div>}
          </div>
        </div>
      </section>
    </>
  );
}

function ViewListRow({ view, selected, onSelect }: { view: ContextViewSummary; selected: boolean; onSelect: () => void }) {
  const kind = typeof view.content?.kind === "string" ? view.content.kind : view.view_type;
  const compiler = compilerId(view);
  return (
    <button className={`view-list-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="view-list-row-top">
        <span>{kind}</span>
        {typeof view.confidence === "number" && <b>{Math.round(view.confidence * 100)}%</b>}
      </div>
      <h3>{view.title || view.id}</h3>
      {view.summary && <p>{view.summary}</p>}
      <div className="view-list-row-meta">
        <span>{compiler || "compiler unknown"}</span>
        <span>{relativeTime(view.updated_at) || "—"}</span>
      </div>
    </button>
  );
}

function ViewDetail({ view, loading }: { view?: ContextViewSummary; loading: boolean }) {
  if (!view) return <article className="view-detail empty"><span>Select a view to inspect it.</span></article>;
  const kind = typeof view.content?.kind === "string" ? view.content.kind : view.view_type;
  const compiler = compilerId(view);
  return (
    <article className="view-detail">
      <div className="view-detail-header">
        <div>
          <span>{viewFamilyLabel(view.view_type)} · {kind}</span>
          <h2>{view.title || view.id}</h2>
        </div>
        {typeof view.confidence === "number" && <b>{Math.round(view.confidence * 100)}%</b>}
      </div>
      {view.summary && <p className="view-detail-summary">{view.summary}</p>}
      <dl className="view-detail-meta">
        <dt>compiler</dt><dd>{compiler || "unknown"}</dd>
        <dt>updated</dt><dd>{view.updated_at ? new Date(view.updated_at).toLocaleString() : "—"}</dd>
        <dt>source records</dt><dd>{sourceRecordCount(view)}</dd>
        <dt>source views</dt><dd>{sourceViewCount(view)}</dd>
        <dt>status</dt><dd>{view.status ?? "active"}</dd>
        <dt>stability</dt><dd>{view.stability ?? "—"}</dd>
      </dl>
      <section className="view-detail-section">
        <h3>View ID</h3>
        <code>{view.id}</code>
      </section>
      <section className="view-detail-section">
        <h3>Content</h3>
        {loading ? <div className="empty-inline">Loading full view…</div> : <pre>{JSON.stringify(view.content ?? {}, null, 2)}</pre>}
      </section>
    </article>
  );
}

function Timeline({ buckets, loading, sourceFilter, selectedItemId, onSelect, onOpenFrame }: { buckets: TimelineBucket[]; loading: boolean; sourceFilter: SourceFilter; selectedItemId: string | null; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
  if (loading) return <div className="empty-state">Loading timeline…</div>;
  if (!buckets.length) return <div className="empty-state">No {sourceFilterLabel(sourceFilter).toLowerCase()} items in this time window. Click Sync or widen the time range.</div>;
  return (
    <section className="timeline-list" aria-label="Activity timeline">
      {buckets.map(bucket => <Bucket key={bucket.label} bucket={bucket} selectedItemId={selectedItemId} onSelect={onSelect} onOpenFrame={onOpenFrame} />)}
    </section>
  );
}

function Bucket({ bucket, selectedItemId, onSelect, onOpenFrame }: { bucket: TimelineBucket; selectedItemId: string | null; onSelect: (id: string) => void; onOpenFrame: (preview: FramePreview) => void }) {
  return (
    <section className="bucket">
      <div className="bucket-heading">
        <time>{formatRange(bucket.start, bucket.end)}</time>
        <span>{bucket.count} items</span>
      </div>
      <div className="bucket-items">
        {bucket.items.map(item => <TimelineRow key={item.id} item={item} selected={item.id === selectedItemId} onSelect={() => onSelect(item.id)} onOpenFrame={onOpenFrame} />)}
      </div>
    </section>
  );
}

function TimelineRow({ item, selected, onSelect, onOpenFrame }: { item: TimelineItem; selected: boolean; onSelect: () => void; onOpenFrame: (preview: FramePreview) => void }) {
  const frameIds = frameIdsOf(item).slice(0, 3);
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
        {frameIds.length > 0 && (
          <div className="row-frames" aria-label="Screenpipe OCR screenshots">
            {frameIds.map(frameId => (
              <FrameThumb key={String(frameId)} frameId={frameId} title={item.title} onOpenFrame={onOpenFrame} />
            ))}
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
  const labels: Record<string, string> = {
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
    answer: "AnswerView",
  };
  return labels[family] ?? family;
}

function viewTypePurpose(type: string) {
  const labels: Record<string, string> = {
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
  const order = ["evidence", "visual_frame", "audio", "activity", "activity_block", "proposal", "resource", "intent", "workflow", "memory"];
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

function chooseBucket(minutes: number) {
  if (minutes <= 90) return 5;
  if (minutes <= 240) return 10;
  if (minutes <= 720) return 20;
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

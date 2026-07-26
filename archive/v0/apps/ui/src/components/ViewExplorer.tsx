import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchContextView, fetchViewFamilies, fetchViewsByType } from "../api";
import type { ContextViewSummary } from "../types";

const AGENT_SURFACE_VIEW_ORDER = ["state.surface", "work.focus_set", "project.current", "memory.daily", "memory.profile"];

export default function ViewExplorer({
  onInspect,
}: {
  onInspect?: (state: { view?: ContextViewSummary; loading: boolean }) => void;
}) {
  const [families, setFamilies] = useState<{ family: string; count: number }[]>([]);
  const [selectedType, setSelectedType] = useState<string>("state.surface");
  const [views, setViews] = useState<ContextViewSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ContextViewSummary | null>(null);
  const [filter, setFilter] = useState("");
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const filteredViews = useMemo(() => {
    const list = views.filter(v => v.view_type === selectedType);
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter(
      v =>
        v.title?.toLowerCase().includes(q) ||
        v.summary?.toLowerCase().includes(q) ||
        v.id.toLowerCase().includes(q)
    );
  }, [views, selectedType, filter]);

  const selectedSummary = filteredViews.find(v => v.id === selectedViewId) ?? filteredViews[0];
  const activeView = selectedDetail?.id === selectedSummary?.id ? selectedDetail : selectedSummary;

  const currentTypeCount = useMemo(() => {
    return families.find(f => f.family === selectedType)?.count ?? 0;
  }, [families, selectedType]);

  useEffect(() => { void loadFamilies(); }, []);

  useEffect(() => {
    if (!selectedType) return;
    let cancelled = false;
    setLoading(true);
    setStatus("");
    setError("");
    loadViews(selectedType)
      .then(result => {
        if (cancelled) return;
        setStatus(`${result.views?.length ?? 0} ${viewFamilyLabel(selectedType).toLowerCase()} loaded`);
      })
      .catch(err => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [selectedType]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) void loadMore();
    }, { root: null, rootMargin: "900px 0px", threshold: 0.01 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [filteredViews.length, selectedType, loading]);

  useEffect(() => {
    if (!selectedViewId) {
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    setDetailsLoading(true);
    fetchContextView(selectedViewId)
      .then(view => !cancelled && setSelectedDetail(view))
      .catch(() => !cancelled && setSelectedDetail(null))
      .finally(() => !cancelled && setDetailsLoading(false));
    return () => { cancelled = true; };
  }, [selectedViewId]);

  useEffect(() => { onInspect?.({ view: activeView, loading: detailsLoading }); }, [activeView, detailsLoading, onInspect]);

  async function loadFamilies() {
    setLoading(true);
    setError("");
    try {
      const res = await fetchViewFamilies();
      const list = res.families?.map(f => ({ family: f.family, count: f.count })) ?? [];
      const visible = orderViewFamilies(list).filter(f => f.count > 0);
      setFamilies(visible);
      setStatus(`${list.reduce((sum, f) => sum + f.count, 0)} views across ${list.filter(f => f.count > 0).length} families`);
      if (!selectedType || !list.find(f => f.family === selectedType && f.count > 0)) {
        setSelectedType(preferredViewFamily(visible));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadViews(viewType: string) {
    const result = await fetchViewsByType(viewType, { limit: 80 });
    setViews(prev => {
      const otherTypes = prev.filter(view => view.view_type !== viewType);
      return [...otherTypes, ...((result.views ?? []) as ContextViewSummary[])];
    });
    return result;
  }

  async function loadMore() {
    if (loading || filteredViews.length >= currentTypeCount) return;
    setLoading(true);
    setError("");
    try {
      const result = await fetchViewsByType(selectedType, { limit: 80, cursor: filteredViews[filteredViews.length - 1]?.updated_at });
      setViews(prev => {
        const map = new Map(prev.map(v => [v.id, v]));
        for (const v of (result.views ?? [] as ContextViewSummary[])) map.set(v.id, v);
        return [...map.values()];
      });
      setStatus(`${Math.min(currentTypeCount, filteredViews.length + (result.views?.length ?? 0))} of ${currentTypeCount} visible`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="vx-panel">
      <WorkbenchHeader
        eyebrow="Surface Explorer"
        title={viewFamilyLabel(selectedType)}
        summary={`${filteredViews.length} visible · ${currentTypeCount} total`}
        status={loading ? "Refreshing views..." : status || "Ready"}
        error={error}
        onRefresh={() => {
          void loadFamilies();
          if (selectedType) {
            void loadViews(selectedType)
              .then(result => setStatus(`${result.views?.length ?? 0} ${viewFamilyLabel(selectedType).toLowerCase()} loaded`))
              .catch(err => setError(err instanceof Error ? err.message : String(err)));
          }
        }}
        refreshLabel={loading ? "Loading..." : "Refresh"}
        refreshDisabled={loading}
      />
      <div className="vx-toolbar">
        <div className="vx-family-select">
          <select value={selectedType} onChange={e => { setSelectedType(e.target.value); setSelectedViewId(null); }} aria-label="View family">
            {families.map(f => (
              <option key={f.family} value={f.family}>{viewFamilyLabel(f.family)} ({f.count})</option>
            ))}
          </select>
        </div>
        <input className="vx-filter" placeholder="Filter by title, summary, or id..." value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter views" />
      </div>
      <div className="workbench-metrics" aria-label="View explorer metrics">
        <Metric label="Selected" value={activeView?.title || activeView?.id || "None"} />
        <Metric label="Updated" value={relativeTime(activeView?.updated_at)} />
        <Metric label={viewPrimaryMetricLabel(selectedType)} value={viewPrimaryMetricValue(activeView)} />
      </div>
      <div className="vx-list">
        {filteredViews.length === 0 && !loading
          ? <EmptyState title={`No ${viewFamilyLabel(selectedType)} views`} detail={filter ? "No views match the current filter." : "Refresh after the runtime writes this view family."} />
          : filteredViews.map(view => (
            <button
              key={view.id}
              className={`vx-row ${selectedViewId === view.id ? "selected" : ""}`}
              onClick={() => setSelectedViewId(view.id)}
            >
              <div className="vx-row-top">
                <span className="vx-row-type">{view.view_type}</span>
                {viewPrimaryRowBadge(view) && <b className="vx-row-confidence">{viewPrimaryRowBadge(view)}</b>}
              </div>
              <h4>{view.title || view.id}</h4>
              {view.summary && <p className="vx-row-summary">{view.summary}</p>}
              <div className="vx-row-meta">
                <span>{relativeTime(view.updated_at)}</span>
                <span>{view.status ?? "active"}</span>
                <span>{view.source_view_count ?? view.source_views?.length ?? view.source_record_count ?? view.source_records?.length ?? 0} sources</span>
              </div>
            </button>
          ))}
      </div>
      {filteredViews.length < currentTypeCount && (
        <div ref={loadMoreRef} className="load-more-sentinel">{loading ? "Loading more views..." : "Scroll to load more"}</div>
      )}
    </section>
  );
}

function WorkbenchHeader({
  eyebrow,
  title,
  summary,
  status,
  error,
  onRefresh,
  refreshLabel,
  refreshDisabled,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  status: string;
  error?: string;
  onRefresh: () => void;
  refreshLabel: string;
  refreshDisabled?: boolean;
}) {
  return (
    <div className="workbench-head">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{summary}</p>
      </div>
      <div className="workbench-head-actions">
        <div className={`workbench-status ${error ? "error" : ""}`}>{error || status}</div>
        <button className="secondary" onClick={onRefresh} disabled={refreshDisabled}>{refreshLabel}</button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="workbench-metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="workbench-empty">
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}

function viewFamilyLabel(family: string) {
  const labels: Record<string, string> = {
    "state.surface": "Current Surface",
    "work.focus_set": "Work Focus Set",
    "project.current": "Current Project",
    "memory.daily": "Daily Memory",
    "memory.profile": "Memory Profile",
    evidence: "Evidence",
    visual_frame: "Visual Frame",
    audio: "Audio",
    activity: "Activity",
    activity_block: "Activity Block",
    proposal: "Proposal",
    resource: "Resource",
    intent: "Intent",
    workflow: "Workflow",
    memory: "Memory",
    "memory.candidate": "Memory Candidate",
    "memory.gate": "Memory Gate",
    "project.current_context": "Project Context",
  };
  return labels[family] ?? family;
}

function orderViewFamilies(families: { family: string; count: number }[]) {
  return [...families].sort((a, b) => {
    const ai = AGENT_SURFACE_VIEW_ORDER.indexOf(a.family);
    const bi = AGENT_SURFACE_VIEW_ORDER.indexOf(b.family);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.family.localeCompare(b.family);
  });
}

function preferredViewFamily(families: { family: string; count: number }[]) {
  return AGENT_SURFACE_VIEW_ORDER.find(type => families.some(family => family.family === type && family.count > 0))
    ?? families.find(family => family.count > 0)?.family
    ?? "state.surface";
}

function isAgentSurfaceView(type: string) {
  return AGENT_SURFACE_VIEW_ORDER.includes(type);
}

function viewPrimaryMetricLabel(type: string) {
  return isAgentSurfaceView(type) ? "Sources" : "Confidence";
}

function viewPrimaryMetricValue(view?: ContextViewSummary) {
  if (!view) return "-";
  return isAgentSurfaceView(view.view_type)
    ? sourceSummary(view) ?? "-"
    : formatConfidence(view.confidence);
}

function viewPrimaryRowBadge(view: ContextViewSummary) {
  return isAgentSurfaceView(view.view_type)
    ? sourceSummary(view)
    : typeof view.confidence === "number"
      ? `${Math.round(view.confidence * 100)}%`
      : undefined;
}

function sourceSummary(view: ContextViewSummary) {
  const total = (view.source_record_count ?? view.source_records?.length ?? 0) + (view.source_view_count ?? view.source_views?.length ?? 0);
  if (total > 0) return `${total} source${total === 1 ? "" : "s"}`;
  return typeof view.compiler === "string" ? view.compiler : view.compiler?.id || "provenance";
}

function formatConfidence(value?: number) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "-";
}

function relativeTime(iso?: string) {
  if (!iso) return "-";
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "-";
  const s = Math.max(1, Math.round(delta / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

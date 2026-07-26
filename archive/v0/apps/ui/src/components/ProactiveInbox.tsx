import React, { useEffect, useMemo, useState } from "react";
import { fetchProactiveSuggestions } from "../api";
import type { ContextViewSummary } from "../types";

export default function ProactiveInbox({
  onInspect,
}: {
  onInspect?: (state: { view?: ContextViewSummary; loading: boolean }) => void;
}) {
  const [suggestions, setSuggestions] = useState<ContextViewSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, "applied" | "dismissed">>(() => ({}));

  useEffect(() => { void refresh(); }, []);

  const selected = useMemo(() => suggestions.find(s => s.id === selectedId), [suggestions, selectedId]);
  const pending = useMemo(() => suggestions.filter(suggestion => !resolved[suggestion.id]), [suggestions, resolved]);
  const highConfidence = useMemo(() => pending.filter(suggestion => (suggestion.confidence ?? 0) >= 0.75).length, [pending]);

  async function refresh() {
    setLoading(true);
    setStatus("Loading proactive suggestions...");
    setError("");
    try {
      const list = await fetchProactiveSuggestions();
      setSuggestions(list);
      setStatus(`${list.length} suggestions`);
      const nextSelected = selectedId && list.find(suggestion => suggestion.id === selectedId) ? selectedId : list[0]?.id ?? null;
      setSelectedId(nextSelected);
      const nextView = list.find(suggestion => suggestion.id === nextSelected);
      if (nextView) onInspect?.({ view: nextView, loading: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function markSuggestion(id: string, action: "applied" | "dismissed") {
    setResolved(prev => ({ ...prev, [id]: action }));
    setStatus(`${action === "applied" ? "Applied" : "Dismissed"} ${id}`);
  }

  return (
    <section className="pi-panel">
      <WorkbenchHeader
        eyebrow="Proactive Inbox"
        title={selected?.title || "Suggested Work"}
        summary={`${pending.length} pending · ${highConfidence} high confidence`}
        status={loading ? "Refreshing proactive tasks..." : status || "Ready"}
        error={error}
        onRefresh={() => void refresh()}
        refreshLabel={loading ? "Loading..." : "Refresh"}
        refreshDisabled={loading}
      />
      <div className="workbench-metrics" aria-label="Proactive inbox metrics">
        <Metric label="Selected Type" value={selected?.view_type ?? "-"} />
        <Metric label="Updated" value={relativeTime(selected?.updated_at)} />
        <Metric label="Confidence" value={formatConfidence(selected?.confidence)} />
        <Metric label="Sources" value={selected?.source_view_count ?? selected?.source_views?.length ?? selected?.source_record_count ?? selected?.source_records?.length ?? 0} />
      </div>
      <div className="pi-list">
        {pending.map(suggestion => (
          <article
            key={suggestion.id}
            className={`pi-row ${selectedId === suggestion.id ? "selected" : ""}`}
          >
            <button
              className="workbench-row-main"
              onClick={() => {
                setSelectedId(suggestion.id);
                onInspect?.({ view: suggestion, loading: false });
              }}
            >
              <div className="pi-row-top">
                <span className="pi-row-type">{taskLabel(suggestion.view_type)}</span>
                <b className="pi-row-confidence">{formatConfidence(suggestion.confidence)}</b>
              </div>
              <h4>{suggestion.title || suggestion.id}</h4>
              <p className="pi-row-summary">{suggestion.summary || "No summary."}</p>
              <div className="pi-row-meta">
                <span>{relativeTime(suggestion.updated_at)}</span>
                <span>{suggestion.status ?? "active"}</span>
                <span>{suggestion.source_view_count ?? suggestion.source_views?.length ?? suggestion.source_record_count ?? suggestion.source_records?.length ?? 0} sources</span>
              </div>
            </button>
            <div className="pi-actions">
              <button className="action-accept" onClick={() => markSuggestion(suggestion.id, "applied")}>Apply</button>
              <button className="action-dismiss" onClick={() => markSuggestion(suggestion.id, "dismissed")}>Dismiss</button>
            </div>
          </article>
        ))}
        {pending.length === 0 && !loading && <EmptyState title="No proactive tasks" detail={error ? "Fix the request error, then refresh." : "Applied and dismissed suggestions are cleared locally from this inbox."} />}
      </div>
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

function taskLabel(viewType: string) {
  const labels: Record<string, string> = {
    "advice.research": "Research Advice",
    "draft.writing_continuation": "Writing Draft",
    "opportunity.tool": "Tool Opportunity",
    "draft.tool_prototype": "Tool Prototype",
  };
  return labels[viewType] ?? viewType;
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

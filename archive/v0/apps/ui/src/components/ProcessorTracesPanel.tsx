import React, { useEffect, useMemo, useState } from "react";
import { fetchProcessorTraces } from "../api";
import type { ContextViewSummary } from "../types";

interface ProcessorTrace {
  id: string;
  event_type: string;
  actor: string;
  status: string;
  subject_type: string;
  subject_id: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

export default function ProcessorTracesPanel({
  onInspect,
}: {
  onInspect?: (state: { view?: ContextViewSummary; loading: boolean }) => void;
}) {
  const [traces, setTraces] = useState<ProcessorTrace[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  const selected = useMemo(() => traces.find(t => t.id === selectedId), [traces, selectedId]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return traces;
    const q = filter.toLowerCase();
    return traces.filter(t =>
      t.event_type.toLowerCase().includes(q) ||
      t.subject_id.toLowerCase().includes(q) ||
      t.actor.toLowerCase().includes(q)
    );
  }, [traces, filter]);
  const counts = useMemo(() => summarizeTraceStatuses(traces), [traces]);

  async function refresh() {
    setLoading(true);
    setStatus("Loading processor traces...");
    setError("");
    try {
      const events = await fetchProcessorTraces();
      setTraces(events);
      setStatus(`${events.length} traces`);
      setSelectedId(current => current && events.find(event => event.id === current) ? current : events[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="pt-panel">
      <WorkbenchHeader
        eyebrow="Processor Traces"
        title={selected?.event_type || "Runtime Events"}
        summary={`${filtered.length} visible · ${traces.length} recent events`}
        status={loading ? "Refreshing processor traces..." : status || "Ready"}
        error={error}
        onRefresh={() => void refresh()}
        refreshLabel={loading ? "Loading..." : "Refresh"}
        refreshDisabled={loading}
      />
      <div className="workbench-metrics" aria-label="Processor trace metrics">
        <Metric label="Completed" value={counts.completed} />
        <Metric label="Failed" value={counts.failed} />
        <Metric label="Started" value={counts.started} />
        <Metric label="Selected" value={selected?.subject_id ?? "-"} />
      </div>
      <div className="pt-toolbar">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter traces..." aria-label="Filter processor traces" />
      </div>
      <div className="pt-list">
        {filtered.map(trace => (
          <button
            key={trace.id}
            className={`pt-row ${selectedId === trace.id ? "selected" : ""}`}
            onClick={() => setSelectedId(trace.id)}
          >
            <div className="pt-row-top">
              <span className="pt-row-type">{trace.event_type}</span>
              <span className={`pt-row-status ${trace.status}`}>{trace.status}</span>
            </div>
            <p className="pt-row-subject">{trace.subject_type}: {trace.subject_id}</p>
            <p className="pt-row-actor">{trace.actor} · {formatDateTime(trace.created_at)}</p>
            {trace.payload && (
              <pre className="pt-payload">
                {JSON.stringify(trace.payload, null, 2)}
              </pre>
            )}
          </button>
        ))}
        {filtered.length === 0 && !loading && <EmptyState title="No processor traces found" detail={filter ? "No trace matches the current filter." : "Recent processor run events appear here after the runtime records them."} />}
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

function summarizeTraceStatuses(traces: ProcessorTrace[]) {
  return traces.reduce(
    (acc, trace) => {
      const key = trace.status as keyof typeof acc;
      if (key in acc) acc[key] += 1;
      return acc;
    },
    { completed: 0, failed: 0, started: 0 },
  );
}

function formatDateTime(iso: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso;
}

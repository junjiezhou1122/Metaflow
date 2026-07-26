import React, { useEffect, useMemo, useState } from "react";
import { fetchMemoryCandidates } from "../api";
import type { ContextViewSummary, MemoryCandidateContent } from "../types";

export default function MemoryReviewInbox({
  onInspect,
}: {
  onInspect?: (state: { view?: ContextViewSummary; loading: boolean }) => void;
}) {
  const [candidates, setCandidates] = useState<ContextViewSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, string>>(() => ({}));

  useEffect(() => { void refresh(); }, []);

  const selectedCandidate = useMemo(() => candidates.find(c => c.id === selectedId), [candidates, selectedId]);
  const filtered = useMemo(() => candidates.filter(c => !resolved[c.id] || resolved[c.id] === "pending"), [candidates, resolved]);
  const readyCount = useMemo(() => filtered.filter(candidateReadyForPromotion).length, [filtered]);

  async function refresh() {
    setLoading(true);
    setStatus("Loading memory candidates...");
    setError("");
    try {
      const list = await fetchMemoryCandidates();
      setCandidates(list);
      setStatus(`${list.length} candidates`);
      const nextSelected = selectedId && list.find(candidate => candidate.id === selectedId) ? selectedId : list[0]?.id ?? null;
      setSelectedId(nextSelected);
      const nextView = list.find(candidate => candidate.id === nextSelected);
      if (nextView) onInspect?.({ view: nextView, loading: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleAction(id: string, action: "accept" | "reject" | "promote") {
    setResolved(prev => ({ ...prev, [id]: action }));
    setStatus(`Marked ${id} as ${action}`);
  }

  return (
    <section className="mri-panel">
      <WorkbenchHeader
        eyebrow="Memory Review"
        title={selectedCandidate?.title || "Candidate Inbox"}
        summary={`${filtered.length} pending · ${readyCount} ready to promote`}
        status={loading ? "Refreshing memory candidates..." : status || "Ready"}
        error={error}
        onRefresh={() => void refresh()}
        refreshLabel={loading ? "Loading..." : "Refresh"}
        refreshDisabled={loading}
      />
      <div className="workbench-metrics" aria-label="Memory candidate metrics">
        <Metric label="Selected Kind" value={memoryContent(selectedCandidate).memory_kind ?? "-"} />
        <Metric label="Evidence" value={memoryContent(selectedCandidate).evidence_count ?? "-"} />
        <Metric label="Gate" value={memoryContent(selectedCandidate).gate_status ?? selectedCandidate?.status ?? "-"} />
        <Metric label="Confidence" value={formatConfidence(memoryContent(selectedCandidate).confidence ?? selectedCandidate?.confidence)} />
      </div>
      <div className="mri-list">
        {filtered.map(candidate => (
          <article
            key={candidate.id}
            className={`mri-row ${selectedId === candidate.id ? "selected" : ""}`}
          >
            <button
              className="workbench-row-main"
              onClick={() => {
                setSelectedId(candidate.id);
                onInspect?.({ view: candidate, loading: false });
              }}
            >
              <div className="mri-row-top">
                <span className="mri-row-type">{memoryContent(candidate).memory_kind ?? candidate.view_type}</span>
                <b className="mri-row-confidence">{formatConfidence(memoryContent(candidate).confidence ?? candidate.confidence)}</b>
              </div>
              <h4>{candidate.title || memoryContent(candidate).claim || candidate.id}</h4>
              <p className="mri-row-summary">{candidate.summary || memoryContent(candidate).claim || "No summary."}</p>
              <div className="mri-row-meta">
                <span>{memoryContent(candidate).evidence_count ?? 0} evidence</span>
                <span>{memoryContent(candidate).target_view_type ?? "target unknown"}</span>
                <span>{candidateReadyForPromotion(candidate) ? "ready" : "needs review"}</span>
              </div>
            </button>
            <div className="mri-actions">
              <button onClick={() => handleAction(candidate.id, "accept")} className="action-accept">Accept</button>
              <button onClick={() => handleAction(candidate.id, "reject")} className="action-reject">Reject</button>
              <button onClick={() => handleAction(candidate.id, "promote")} className="action-promote">Promote</button>
            </div>
          </article>
        ))}
        {filtered.length === 0 && !loading && <EmptyState title="No pending memory candidates" detail={error ? "Fix the request error, then refresh." : "Accepted, rejected, and promoted items are cleared locally from this review queue."} />}
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

function memoryContent(candidate?: ContextViewSummary): Partial<MemoryCandidateContent> {
  return (candidate?.content ?? {}) as Partial<MemoryCandidateContent>;
}

function candidateReadyForPromotion(candidate: ContextViewSummary) {
  const content = memoryContent(candidate);
  const policy = content.promotion_policy;
  if (!policy) return false;
  const confidence = content.confidence ?? candidate.confidence ?? 0;
  const evidenceCount = content.evidence_count ?? 0;
  return confidence >= policy.min_confidence && evidenceCount >= policy.min_evidence_count;
}

function formatConfidence(value?: number) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "-";
}

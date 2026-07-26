import React, { useEffect, useMemo, useState } from "react";
import { fetchProjectCurrentViews, fetchWorkFocusSetViews } from "../api";
import type { ContextViewSummary, WorkFocusLane } from "../types";

export default function ProjectDashboard({
  onInspect,
}: {
  onInspect?: (state: { view?: ContextViewSummary; loading: boolean }) => void;
}) {
  const [projects, setProjects] = useState<ContextViewSummary[]>([]);
  const [focusSets, setFocusSets] = useState<ContextViewSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  const selected = useMemo(() => projects.find(p => p.id === selectedId), [projects, selectedId]);
  const latestFocusSet = focusSets[0];
  const focusLanes = useMemo(() => activeFocusLanes(latestFocusSet), [latestFocusSet]);

  async function refresh() {
    setLoading(true);
    setStatus("Loading project dashboard...");
    setError("");
    try {
      const [p, w] = await Promise.all([
        fetchProjectCurrentViews(),
        fetchWorkFocusSetViews(),
      ]);
      setProjects(p);
      setFocusSets(w);
      setStatus(`${p.length} projects · ${w.length} focus sets`);
      const nextSelectedId = !selectedId || !p.find(pr => pr.id === selectedId) ? p[0]?.id ?? null : selectedId;
      setSelectedId(nextSelectedId);
      const nextSelected = p.find(pr => pr.id === nextSelectedId);
      if (nextSelected) {
        onInspect?.({ view: nextSelected, loading: false });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="pd-panel">
      <WorkbenchHeader
        eyebrow="Project Workbench"
        title={selected?.title || "Current Project"}
        summary={`${projects.length} projects · ${focusLanes.length} active lanes`}
        status={loading ? "Refreshing project and focus views..." : status || "Ready"}
        error={error}
        onRefresh={() => void refresh()}
        refreshLabel={loading ? "Loading..." : "Refresh"}
        refreshDisabled={loading}
      />
      <div className="workbench-metrics" aria-label="Project dashboard metrics">
        <Metric label="Focus" value={projectFocus(selected)} />
        <Metric label="Updated" value={relativeTime(selected?.updated_at)} />
        <Metric label="Open Questions" value={projectList(selected, "open_questions").length} />
        <Metric label="Next Actions" value={projectList(selected, "next_actions").length} />
      </div>
      <div className="pd-list">
        {projects.map(project => (
          <button key={project.id} className={`pd-row ${selectedId === project.id ? "selected" : ""}`} onClick={() => { setSelectedId(project.id); onInspect?.({ view: project, loading: false }); }}>
            <div className="pd-row-top">
              <span className="pd-row-type">{project.view_type}</span>
              <b className="pd-row-confidence">{sourceSummary(project)}</b>
            </div>
            <h4>{project.title || project.id}</h4>
            <p className="pd-row-summary">{project.summary || projectFocus(project) || "No summary."}</p>
            <div className="pd-row-meta">
              <span>{relativeTime(project.updated_at)}</span>
              <span>{projectList(project, "active_files").length} files</span>
              <span>{projectList(project, "next_actions").length} actions</span>
            </div>
            <ProjectDetails content={project.content} />
          </button>
        ))}
        {projects.length === 0 && !loading && <EmptyState title="No current project" detail={error ? "Fix the request error, then refresh." : "Project views appear here after local project capture runs."} />}
      </div>
      <FocusSetSection focusSets={focusSets} />
    </section>
  );
}

function ProjectDetails({ content }: { content: Record<string, unknown> | undefined }) {
  if (!content) return null;
  const decisions = (content.decisions ?? []) as string[];
  const questions = (content.open_questions ?? []) as string[];
  const actions = (content.next_actions ?? []) as string[];
  const files = (content.active_files ?? []) as string[];
  return (
    <div className="pd-details">
      {decisions.length > 0 && (
        <div className="pd-section">
          <span className="pd-section-title">Decisions</span>
          <ul>{decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
      {questions.length > 0 && (
        <div className="pd-section">
          <span className="pd-section-title">Open Questions</span>
          <ul>{questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      {actions.length > 0 && (
        <div className="pd-section">
          <span className="pd-section-title">Next Actions</span>
          <ul>{actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      {files.length > 0 && (
        <div className="pd-section">
          <span className="pd-section-title">Active Files</span>
          <ul>{files.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function FocusSetSection({ focusSets }: { focusSets: ContextViewSummary[] }) {
  const latest = focusSets[0];
  const lanes = activeFocusLanes(latest);
  return (
    <div className="pd-focus-sets">
      <div className="pd-focus-head">
        <div>
          <span>Focus Set</span>
          <h4>{latest?.title || "Work Focus"}</h4>
        </div>
        <b>{relativeTime(latest?.updated_at)}</b>
      </div>
      {lanes.length > 0 ? (
        <ul>
          {lanes.map(lane => (
            <li key={lane.lane_key}>
              <div>
                <b>{lane.label}</b>
                <span>{lane.lane_kind} · {laneEvidenceSummary(lane)}</span>
              </div>
              <strong>{Math.round(lane.attention_share * 100)}%</strong>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No active focus lanes" detail={latest ? "The latest focus set did not include active lanes." : "Focus lanes appear after work focus compilation runs."} />
      )}
    </div>
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

function activeFocusLanes(view?: ContextViewSummary) {
  return Array.isArray(view?.content?.active_lanes) ? (view.content.active_lanes as unknown as WorkFocusLane[]) : [];
}

function projectFocus(view?: ContextViewSummary) {
  const focus = view?.content?.focus;
  return typeof focus === "string" && focus.trim() ? focus : "-";
}

function projectList(view: ContextViewSummary | undefined, key: "open_questions" | "next_actions" | "active_files") {
  const value = view?.content?.[key];
  return Array.isArray(value) ? value : [];
}

function sourceSummary(view: ContextViewSummary) {
  const total = (view.source_record_count ?? view.source_records?.length ?? 0) + (view.source_view_count ?? view.source_views?.length ?? 0);
  if (total > 0) return `${total} source${total === 1 ? "" : "s"}`;
  return typeof view.compiler === "string" ? view.compiler : view.compiler?.id || "provenance";
}

function laneEvidenceSummary(lane: WorkFocusLane) {
  const records = lane.source_records?.length ?? 0;
  const routes = lane.candidate_route_ids?.length ?? 0;
  const parts = [];
  if (routes > 0) parts.push(`${routes} route${routes === 1 ? "" : "s"}`);
  if (records > 0) parts.push(`${records} source${records === 1 ? "" : "s"}`);
  return parts.join(" · ") || "provenance";
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

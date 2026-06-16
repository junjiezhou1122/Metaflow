import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_VIEW_FILTERS,
  buildViewQueryFromTab,
  feedbackTargetFromInput,
  formatAmbientViewResult,
  formatViewSubscriptionResult,
  viewKeyPoints,
  viewSummaryText,
} from "../../agent-task.js";
import metaflowLogoUrl from "../assets/brand/metaflow-flow-m-action.svg";
import "./styles.css";

type ChromeRuntimeHost = typeof globalThis & {
  chrome?: {
    runtime?: {
      sendMessage: (message: Record<string, unknown>) => Promise<any>;
    };
  };
};

type TabInfo = {
  title?: string;
  url?: string;
};

type VisitState = {
  visit_id?: string;
  dwell_seconds?: number;
  snapshot_count?: number;
  visitRecorded?: boolean;
};

type Settings = {
  endpoint?: string;
  captureStream?: boolean;
  snapshotOnVisit?: boolean;
  allowExternalLlm?: boolean;
  heartbeatSeconds?: number;
  viewPollSeconds?: number;
  agentRuntime?: string;
};

type View = {
  id?: string;
  title?: string;
  view_type?: string;
  updated_at?: string;
  summary?: string;
  content?: Record<string, any>;
  compiler?: { id?: string };
};

type ThreadEntry =
  | { type: "user_message"; id: string; content: string }
  | { type: "assistant_message"; id: string; content: string }
  | { type: "tool_call"; id: string; title: string; status: "running" | "complete" | "error"; content?: string };

const DEFAULT_SETTINGS: Required<Settings> = {
  endpoint: "http://localhost:3111/context/ingest",
  captureStream: true,
  snapshotOnVisit: true,
  allowExternalLlm: true,
  heartbeatSeconds: 15,
  viewPollSeconds: 6,
  agentRuntime: "claude_code",
};

function App() {
  const [tab, setTab] = useState<TabInfo>({});
  const [visit, setVisit] = useState<VisitState>({});
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [liveState, setLiveState] = useState("connecting");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState("Ready.");
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [viewQuery, setViewQuery] = useState("");
  const [viewScope, setViewScope] = useState<keyof typeof DEFAULT_VIEW_FILTERS>("related");
  const [viewLimit, setViewLimit] = useState(12);
  const [nextCursor, setNextCursor] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"ask" | "views" | "settings">("ask");
  const messageListRef = useRef<HTMLDivElement>(null);

  const currentViewQuery = useMemo(() => buildViewQueryFromTab(tab), [tab]);
  const domain = useMemo(() => domainFromUrl(tab.url), [tab.url]);
  const activeView = views.find(view => view.id === selectedViewId) ?? views[0];

  useEffect(() => {
    refreshStatus()
      .then(() => refreshViews(false))
      .catch(error => {
        setLiveState("error");
        const message = messageFromError(error);
        if (!message.includes("Chrome extension runtime is unavailable")) setResult(message);
      });
  }, []);

  useEffect(() => {
    const seconds = Math.max(3, Number(settings.viewPollSeconds || DEFAULT_SETTINGS.viewPollSeconds));
    const timer = window.setInterval(() => refreshViews(true).catch(() => undefined), seconds * 1000);
    return () => window.clearInterval(timer);
  }, [settings.viewPollSeconds, nextCursor, viewScope, viewLimit, viewQuery, currentViewQuery]);

  useEffect(() => {
    const node = messageListRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [entries]);

  async function send(message: Record<string, unknown>) {
    const runtime = (globalThis as ChromeRuntimeHost).chrome?.runtime;
    if (!runtime?.sendMessage) {
      throw new Error("Chrome extension runtime is unavailable.");
    }
    return await runtime.sendMessage(message);
  }

  async function refreshStatus() {
    const res = await send({ type: "get-current-status" });
    const nextTab = res.tab || {};
    const nextSettings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
    setTab(nextTab);
    setVisit(res.state || {});
    setSettings(nextSettings);
    setLiveState(res.ok ? "live" : "offline");
  }

  async function saveAndAnalyze() {
    setBusy(true);
    setResult("Saving page and waiting for generated Views...");
    const reason = question.trim();
    const toolId = `tool-${Date.now()}`;
    appendTool(toolId, "Save page and generate Views", "running");
    try {
      const res = await send({ type: "ambient-current-page", reason: reason || undefined });
      const formatted = formatAmbientViewResult(res);
      setResult(formatted);
      appendTool(toolId, "Save page and generate Views", res.ok === false ? "error" : "complete", summarizeToolResult(formatted));
      mergeViews((res.views || []).map((item: any) => item.view).filter(Boolean));
      await refreshStatus();
      await refreshViews(false);
    } catch (error) {
      const message = messageFromError(error);
      setResult(message);
      appendTool(toolId, "Save page and generate Views", "error", message);
    } finally {
      setBusy(false);
    }
  }

  async function askMetaflow() {
    const text = question.trim();
    if (!text || busy) return;

    setBusy(true);
    setQuestion("");
    setResult("Asking metaflow...");
    const now = Date.now();
    const userId = `user-${now}`;
    const assistantId = `assistant-${now}`;
    appendEntry({ type: "user_message", id: userId, content: text });
    appendEntry({ type: "assistant_message", id: assistantId, content: "Thinking..." });
    try {
      const context = await send({ type: "get-chat-page-context", question: text });
      if (!context?.ok) throw new Error(context?.error || "Could not prepare current page context.");
      const response = await fetch(String(context.endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context.body),
      });
      const res = await response.json().catch(() => ({}));
      if (!response.ok || !res.ok) throw new Error(res.error || `metaflow chat failed with HTTP ${response.status}`);
      const answer = formatChatAnswer(res);
      setResult(answer);
      setEntries(previous => previous.map(entry => entry.id === assistantId ? { ...entry, content: answer } : entry));
    } catch (error) {
      const message = messageFromError(error);
      setResult(message);
      setEntries(previous => previous.map(entry => entry.id === assistantId ? { ...entry, content: message } : entry));
    } finally {
      setBusy(false);
    }
  }

  async function refreshViews(useCursor = false) {
    const query = viewQuery.trim() || currentViewQuery;
    const res = await send({
      type: "poll-context-views",
      viewTypes: DEFAULT_VIEW_FILTERS[viewScope],
      cursor: useCursor ? nextCursor : undefined,
      query,
      limit: Number(viewLimit || 12),
      activeOnly: true,
    });
    setLiveState(res.ok ? "views live" : "views error");
    setResult(formatViewSubscriptionResult(res));
    if (!res.ok) return;
    if (!useCursor) setViews([]);
    mergeViews(res.views || []);
    setNextCursor(res.next_cursor || nextCursor);
  }

  async function saveSettings(patch: Settings) {
    const next = { ...settings, ...patch };
    setSettings(next);
    const res = await send({ type: "update-settings", settings: next });
    setResult(res.ok ? "Settings saved." : JSON.stringify(res, null, 2));
  }

  async function sendFeedback(type: string, value: string) {
    const target = feedbackTargetFromInput(selectedViewId, views, selectedViewId);
    if (!target.ok) {
      setResult(target.error || "No View selected for feedback.");
      return;
    }
    const view = target.view;
    const res = await send({
      type: "feedback-view",
      viewId: view.id,
      viewType: view.view_type,
      feedbackType: type,
      value,
      reason: question.trim() || undefined,
      payload: { query: viewQuery.trim() || currentViewQuery },
    });
    setResult(res.ok ? `Feedback recorded for ${view.view_type}: ${value}` : JSON.stringify(res, null, 2));
  }

  function appendEntry(entry: ThreadEntry) {
    setEntries(previous => [...previous, entry]);
  }

  function appendTool(id: string, title: string, status: "running" | "complete" | "error", content?: string) {
    setEntries(previous => {
      const index = previous.findIndex(entry => entry.type === "tool_call" && entry.id === id);
      const next: ThreadEntry = { type: "tool_call", id, title, status, content };
      if (index === -1) return [...previous, next];
      return previous.map((entry, entryIndex) => entryIndex === index ? next : entry);
    });
  }

  function mergeViews(nextViews: View[]) {
    setViews(previous => {
      const byId = new Map(previous.map(view => [view.id, view]));
      for (const view of nextViews) {
        if (view?.id) byId.set(view.id, view);
      }
      const merged = [...byId.values()].sort((a, b) => Date.parse(b.updated_at || "") - Date.parse(a.updated_at || ""));
      if (!selectedViewId && merged[0]?.id) setSelectedViewId(merged[0].id);
      return merged;
    });
  }

  return (
    <main className="panel-shell">
      <header className="shell-header">
        <button className="brand-lockup" onClick={() => setActiveTab("ask")}>
          <LogoMark className="brand-mark" />
          <span className="brand-name">
            meta<span>flow</span>
          </span>
        </button>

        <div className="connection-pill">
          <span className={`connection-dot ${liveState.includes("live") ? "is-live" : liveState === "error" ? "is-error" : ""}`} />
          <span>{liveState.includes("live") ? "Live" : liveState}</span>
          <span className="connection-meta">{domain || tab.title || "Current page"}</span>
        </div>

        <div className="shell-actions">
          <button onClick={() => refreshStatus()}>⟳</button>
          <button aria-label="更多">...</button>
        </div>
      </header>

      <nav className="tab-strip" aria-label="metaflow sections">
        <button className={activeTab === "ask" ? "active" : ""} onClick={() => setActiveTab("ask")}>Ask</button>
        <button className={activeTab === "views" ? "active" : ""} onClick={() => setActiveTab("views")}>Views</button>
        <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>Settings</button>
      </nav>

      <section className="shell-body">
        {activeTab === "ask" ? (
          <section className="chat-view" aria-label="AI 问答">
            <div className={`message-list ${entries.length ? "has-content" : ""}`} role="log" ref={messageListRef}>
              {entries.length ? entries.map(entry => <ThreadEntryView key={entry.id} entry={entry} />) : (
                <div className="conversation-empty">
                  <LogoMark className="empty-mark" />
                  <h2>Start a conversation</h2>
                  <p>Ask about the current page. Views and background polling stay in their own tab.</p>
                </div>
              )}
            </div>

            <div className="composer-dock">
              <div className="context-pill">
                <LogoMark className="metaflow-dot" />
                <span>{tab.title || "当前网页"}</span>
              </div>

              <div className="ask-box">
                <textarea
                  value={question}
                  onChange={event => setQuestion(event.target.value)}
                  placeholder="Ask anything"
                  onKeyDown={event => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      askMetaflow();
                    }
                  }}
                />
                <button onClick={askMetaflow} disabled={busy} aria-label="发送问题">↑</button>
              </div>

              <div className="composer-actions">
                <button onClick={saveAndAnalyze} disabled={busy}>保存并分析</button>
                <button onClick={askMetaflow} disabled={busy}>Ask metaflow</button>
              </div>
            </div>
          </section>
        ) : activeTab === "views" ? (
          <section className="insights-view" aria-label="实时洞察">
            <div className="insights-controls">
              <select value={viewScope} onChange={event => setViewScope(event.target.value as keyof typeof DEFAULT_VIEW_FILTERS)}>
                <option value="related">Related Views</option>
                <option value="agent">Agent analysis</option>
                <option value="writing">Writing assist</option>
                <option value="all">All View types</option>
              </select>
              <input value={viewLimit} type="number" min={3} max={40} onChange={event => setViewLimit(Number(event.target.value || 12))} />
              <input className="query-field" value={viewQuery} onChange={event => setViewQuery(event.target.value)} placeholder={currentViewQuery || "Search Views"} />
            </div>

            <div className="record-list">
              {views.length ? views.slice(0, 16).map(view => (
                <button
                  key={view.id}
                  className={`record-row ${view.id === activeView?.id ? "selected" : ""}`}
                  onClick={() => view.id && setSelectedViewId(view.id)}
                >
                  <div className="record-icon">{iconForView(view.view_type)}</div>
                  <div className="record-copy">
                    <div>
                      <b>{view.title || view.id}</b>
                      <span>{relativeTime(view.updated_at)}</span>
                    </div>
                    <p>{viewSummaryText(view) || view.view_type || "没有摘要。"}</p>
                  </div>
                </button>
              )) : (
                <div className="empty-state">当前没有新的 Views。保存并分析当前页面后会出现在这里。</div>
              )}
            </div>

            {activeView ? (
              <article className="detail-card">
                <div className="detail-head">
                  <div className="section-title compact">
                    <span>{activeView.view_type || "view"}</span>
                    <b>·</b>
                    <span>{relativeTime(activeView.updated_at)}</span>
                  </div>
                  <button onClick={() => sendFeedback("analysis.useful", "useful")}>有用</button>
                </div>
                <h3>{activeView.title || activeView.id}</h3>
                <p>{viewSummaryText(activeView) || "No summary."}</p>
                <div className="tag-row">
                  {viewKeyPoints(activeView, 3).map((point: string) => <span key={point}>{point}</span>)}
                  {activeView.compiler?.id ? <span>{activeView.compiler.id}</span> : null}
                </div>
              </article>
            ) : null}

            <div className="feedback-line">
              <button onClick={() => sendFeedback("analysis.useful", "useful")} disabled={!activeView}>有用</button>
              <button onClick={() => sendFeedback("analysis.dismissed", "dismissed")} disabled={!activeView}>忽略</button>
            </div>
          </section>
        ) : (
          <section className="settings-view" aria-label="设置">
            <div className="settings-grid">
              <label className="setting-row">
                <span>记录浏览器事件流</span>
                <input type="checkbox" checked={Boolean(settings.captureStream)} onChange={event => saveSettings({ captureStream: event.target.checked })} />
              </label>
              <label className="setting-row">
                <span>访问时截图</span>
                <input type="checkbox" checked={Boolean(settings.snapshotOnVisit)} onChange={event => saveSettings({ snapshotOnVisit: event.target.checked })} />
              </label>
              <label className="setting-row">
                <span>允许本地外部运行时</span>
                <input type="checkbox" checked={Boolean(settings.allowExternalLlm)} onChange={event => saveSettings({ allowExternalLlm: event.target.checked })} />
              </label>
              <label className="setting-field">
                <span>Heartbeat seconds</span>
                <input type="number" min={5} step={5} value={settings.heartbeatSeconds ?? DEFAULT_SETTINGS.heartbeatSeconds} onChange={event => saveSettings({ heartbeatSeconds: Number(event.target.value || 15) })} />
              </label>
              <label className="setting-field">
                <span>View poll seconds</span>
                <input type="number" min={3} step={1} value={settings.viewPollSeconds ?? DEFAULT_SETTINGS.viewPollSeconds} onChange={event => saveSettings({ viewPollSeconds: Number(event.target.value || 6) })} />
              </label>
              <label className="setting-field">
                <span>Agent runtime</span>
                <select value={settings.agentRuntime || DEFAULT_SETTINGS.agentRuntime} onChange={event => saveSettings({ agentRuntime: event.target.value })}>
                  <option value="claude_code">claude_code</option>
                  <option value="acp_stdio">acp_stdio</option>
                  <option value="local_mock">local_mock</option>
                </select>
              </label>
              <label className="setting-field">
                <span>Context endpoint</span>
                <input value={settings.endpoint || DEFAULT_SETTINGS.endpoint} onChange={event => saveSettings({ endpoint: event.target.value })} />
              </label>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function domainFromUrl(value?: string) {
  try {
    return new URL(value || "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function iconForView(type?: string) {
  if (type?.includes("writing") || type?.includes("draft")) return "✎";
  if (type?.includes("task") || type?.includes("agent")) return "✦";
  if (type?.includes("memory")) return "◇";
  return "▣";
}

function LogoMark({ className }: { className?: string }) {
  return <img className={className} src={metaflowLogoUrl} alt="metaflow" draggable={false} />;
}

function ThreadEntryView({ entry }: { entry: ThreadEntry }) {
  if (entry.type === "user_message") {
    return (
      <article className="thread-message thread-user">
        <div className="message-content">{entry.content}</div>
      </article>
    );
  }

  if (entry.type === "assistant_message") {
    return (
      <article className={`thread-message thread-assistant ${entry.content === "Thinking..." ? "pending" : ""}`}>
        <div className="message-content">{entry.content}</div>
      </article>
    );
  }

  return (
    <article className={`tool-entry ${entry.status}`}>
      <button type="button" className="tool-header">
        <span className="tool-icon">{entry.status === "running" ? "○" : entry.status === "error" ? "×" : "✓"}</span>
        <span className="tool-title">{entry.title}</span>
        <span className="tool-badge">{entry.status === "running" ? "Running" : entry.status === "error" ? "Error" : "Completed"}</span>
      </button>
      {entry.content ? <pre>{entry.content}</pre> : null}
    </article>
  );
}

function summarizeToolResult(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^0 new Views\.\s*/i, "")
    .trim()
    .slice(0, 240);
}

function formatChatAnswer(result: any) {
  if (result?.ok && typeof result.answer === "string" && result.answer.trim()) return result.answer.trim();
  if (typeof result?.error === "string" && result.error.trim()) return result.error.trim();
  return "metaflow did not return an answer.";
}

function relativeTime(value?: string) {
  if (!value) return "";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "";
  const seconds = Math.max(1, Math.round(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

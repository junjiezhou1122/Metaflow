import { DEFAULT_VIEW_FILTERS, buildViewQueryFromTab, feedbackTargetFromInput, formatAmbientViewResult, formatViewSubscriptionResult, viewKeyPoints, viewSummaryText } from "./agent-task.js";

const $ = (id) => document.getElementById(id);

let currentViewQuery = "";
let currentViews = [];
let selectedViewId = "";
let nextCursor = "";
let pollTimer;
let settings = {};

async function send(message) {
  return await chrome.runtime.sendMessage(message);
}

async function refresh() {
  const res = await send({ type: "get-current-status" });
  const tab = res.tab || {};
  const state = res.state || {};
  settings = res.settings || {};
  currentViewQuery = buildViewQueryFromTab(tab);

  $("pageTitle").textContent = tab.title || "No active tab";
  $("pageMeta").textContent = tab.url || "";
  $("visitMeta").textContent = `visit ${state.visit_id || "-"} | dwell ${state.dwell_seconds ?? 0}s | snapshots ${state.snapshot_count ?? 0} | recorded ${state.visitRecorded ? "yes" : "no"}`;
  $("liveState").textContent = res.ok ? "live" : "offline";
  $("viewQuery").placeholder = currentViewQuery || "Search Views";

  $("captureStream").checked = Boolean(settings.captureStream);
  $("snapshotOnVisit").checked = Boolean(settings.snapshotOnVisit);
  $("allowExternalLlm").checked = Boolean(settings.allowExternalLlm);
  $("heartbeatSeconds").value = settings.heartbeatSeconds ?? 15;
  $("viewPollSeconds").value = settings.viewPollSeconds ?? 6;
  $("agentRuntime").value = settings.agentRuntime ?? "claude_code";
  $("endpoint").value = settings.endpoint ?? "http://localhost:3111/context/ingest";

  resetPolling();
}

async function saveAndAnalyze() {
  setBusy(true, "Saving page and waiting for generated Views...");
  const res = await send({ type: "ambient-current-page", reason: questionText() || undefined });
  $("result").textContent = formatAmbientViewResult(res);
  mergeViews((res.views || []).map(item => item.view).filter(Boolean));
  renderViews();
  await refresh();
  await refreshViews(false);
  setBusy(false);
}

async function askClaudeCode() {
  setBusy(true, "Submitting current page to Claude Code AgentTask...");
  const res = await send({
    type: "submit-agent-task-current-page",
    question: questionText(),
    runtime: $("agentRuntime").value || "claude_code",
  });
  $("result").textContent = formatAmbientViewResult(res);
  mergeViews((res.views || []).map(item => item.view).filter(Boolean));
  renderViews();
  await refreshViews(false);
  setBusy(false);
}

async function refreshViews(useCursor = false) {
  const scope = $("viewScope").value;
  const query = $("viewQuery").value.trim() || currentViewQuery;
  const res = await send({
    type: "poll-context-views",
    viewTypes: DEFAULT_VIEW_FILTERS[scope],
    cursor: useCursor ? nextCursor : undefined,
    query,
    limit: Number($("viewLimit").value || 12),
    activeOnly: true,
  });
  $("liveState").textContent = res.ok ? "views live" : "views error";
  $("result").textContent = formatViewSubscriptionResult(res);
  if (res.ok) {
    if (!useCursor) currentViews = [];
    mergeViews(res.views || []);
    nextCursor = res.next_cursor || nextCursor;
  }
  renderViews();
}

async function sendFeedback(type, value) {
  const target = feedbackTargetFromInput(selectedViewId, currentViews, selectedViewId);
  if (!target.ok) {
    $("result").textContent = target.error;
    return;
  }
  const view = target.view;
  const res = await send({
    type: "feedback-view",
    viewId: view.id,
    viewType: view.view_type,
    feedbackType: type,
    value,
    reason: questionText() || undefined,
    payload: { query: $("viewQuery").value.trim() || currentViewQuery },
  });
  $("result").textContent = res.ok ? `Feedback recorded for ${view.view_type}: ${value}` : JSON.stringify(res, null, 2);
}

function mergeViews(views) {
  const byId = new Map(currentViews.map(view => [view.id, view]));
  for (const view of views) {
    if (view?.id) byId.set(view.id, view);
  }
  currentViews = [...byId.values()].sort((a, b) => Date.parse(b.updated_at || "") - Date.parse(a.updated_at || ""));
  if (!selectedViewId && currentViews[0]?.id) selectedViewId = currentViews[0].id;
}

function renderViews() {
  const container = $("views");
  container.textContent = "";
  if (!currentViews.length) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No Views yet. Save, ask, or broaden the query.";
    container.append(empty);
    return;
  }
  for (const view of currentViews.slice(0, 24)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `view-card ${view.id === selectedViewId ? "selected" : ""}`;
    button.addEventListener("click", () => {
      selectedViewId = view.id;
      renderViews();
    });

    const top = document.createElement("div");
    top.className = "view-top";
    top.append(textEl("span", view.view_type || "view"));
    top.append(textEl("span", relativeTime(view.updated_at)));

    const title = textEl("h2", view.title || view.id);
    const summary = textEl("p", viewSummaryText(view) || "No summary.");
    const tags = document.createElement("div");
    tags.className = "tags";
    for (const point of viewKeyPoints(view, 3)) tags.append(tag(point));
    if (view.compiler?.id) tags.append(tag(view.compiler.id));

    button.append(top, title, summary, tags);
    container.append(button);
  }
}

async function saveSettings() {
  settings = {
    captureStream: $("captureStream").checked,
    snapshotOnVisit: $("snapshotOnVisit").checked,
    allowExternalLlm: $("allowExternalLlm").checked,
    heartbeatSeconds: Number($("heartbeatSeconds").value || 15),
    viewPollSeconds: Number($("viewPollSeconds").value || 6),
    agentRuntime: $("agentRuntime").value || "claude_code",
    endpoint: $("endpoint").value,
  };
  await send({ type: "update-settings", settings });
  resetPolling();
}

function resetPolling() {
  clearInterval(pollTimer);
  const seconds = Math.max(3, Number($("viewPollSeconds").value || settings.viewPollSeconds || 6));
  pollTimer = setInterval(() => refreshViews(true).catch(() => undefined), seconds * 1000);
}

function setBusy(value, status) {
  $("save").disabled = value;
  $("ask").disabled = value;
  $("refreshViews").disabled = value;
  if (status) $("result").textContent = status;
}

function questionText() {
  return $("askQuestion").value.trim();
}

function textEl(tagName, text) {
  const el = document.createElement(tagName);
  el.textContent = text || "";
  return el;
}

function tag(text) {
  const el = document.createElement("span");
  el.className = "tag";
  el.textContent = String(text).slice(0, 48);
  return el;
}

function relativeTime(value) {
  if (!value) return "";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "";
  const seconds = Math.max(1, Math.round(delta / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

$("save").addEventListener("click", () => saveAndAnalyze().catch(error => {
  $("result").textContent = error?.message ?? String(error);
  setBusy(false);
}));
$("ask").addEventListener("click", () => askClaudeCode().catch(error => {
  $("result").textContent = error?.message ?? String(error);
  setBusy(false);
}));
$("refreshViews").addEventListener("click", () => refreshViews(false));
$("useful").addEventListener("click", () => sendFeedback("analysis.useful", "useful"));
$("dismiss").addEventListener("click", () => sendFeedback("analysis.dismissed", "dismissed"));
$("viewScope").addEventListener("change", () => refreshViews(false));
$("viewLimit").addEventListener("change", () => refreshViews(false));
$("viewQuery").addEventListener("change", () => refreshViews(false));

for (const button of document.querySelectorAll(".quick")) {
  button.addEventListener("click", () => {
    $("askQuestion").value = button.dataset.prompt || "";
    $("askQuestion").focus();
  });
}

for (const id of ["captureStream", "snapshotOnVisit", "allowExternalLlm", "heartbeatSeconds", "viewPollSeconds", "agentRuntime", "endpoint"]) {
  $(id).addEventListener("change", saveSettings);
}

refresh().then(() => refreshViews(false)).catch(error => {
  $("liveState").textContent = "error";
  $("result").textContent = error?.message ?? String(error);
});

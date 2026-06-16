import { agentTasksEndpointFromSettings, buildBrowserAgentTaskRequest, buildViewFeedbackRequest, contextChatEndpointFromSettings, contextIngestEndpointFromSettings, contextViewUrlFromSettings, contextViewsEndpointFromSettings, feedbackEndpointFromSettings, viewIdsFromAgentTaskResponse, viewIdsFromProcessedIngestResponse, writingAssistEndpointFromSettings } from "./agent-task.js";

const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:3111/context/ingest",
  captureStream: true,
  heartbeatSeconds: 15,
  snapshotOnVisit: true,
  allowExternalLlm: true,
  agentRuntime: "claude_code",
  viewPollSeconds: 6,
  snapshotTextLimit: 120000,
  excludedDomains: [
    "gmail.com",
    "mail.google.com",
    "icloud.com",
    "1password.com",
    "bitwarden.com",
    "paypal.com",
    "stripe.com"
  ]
};

const tabState = new Map();
let pendingSidepanelPrompt = null;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
  await enableSidePanelOnActionClick();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !chrome.sidePanel?.open) return;
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.id && tab.url) await ensureVisit(tab, "tab_activated");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    if (tab?.id && tab.url) await ensureVisit(tab, "page_loaded");
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = tabState.get(tabId);
  if (state) {
    await sendLifecycleEvent(state, "tab_closed").catch(() => undefined);
    tabState.delete(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {

    if (message?.type === "context.capture.browser_attention") {
      const tab = sender.tab ?? await getActiveTab();
      const result = await sendBrowserAttention(message.payload, message.kind, tab);
      sendResponse(result);
      return;
    }
    if (message?.type === "sidepanel.explain.selection" || message?.type === "sidepanel.run.selection_action") {
      const tab = sender.tab ?? await getActiveTab();
      pendingSidepanelPrompt = {
        type: "selection-action",
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        action: message.action ?? {
          id: "explain",
          label: "Explain",
          prompt: "Explain this selected text in plain language. Keep it concise, and mention the page context if it matters.",
        },
        payload: message.payload,
      };
      if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
      sendResponse({ ok: true, pending: pendingSidepanelPrompt });
      return;
    }
    if (message?.type === "sidepanel.consume-pending-prompt") {
      const pending = pendingSidepanelPrompt;
      pendingSidepanelPrompt = null;
      sendResponse({ ok: true, pending });
      return;
    }
    if (message?.type === "context.explain.selection") {
      const tab = sender.tab ?? await getActiveTab();
      const result = await explainSelection(message.payload, tab);
      sendResponse(result);
      return;
    }
    if (message?.type === "context.capture.writing_input") {
      const tab = sender.tab ?? await getActiveTab();
      const result = await sendWritingInput(message.payload, tab);
      sendResponse(result);
      return;
    }
    if (message?.type === "save-current-page") {
      const tab = await getActiveTab();
      const result = await captureSnapshot(tab, "manual_save", true, message.reason);
      sendResponse(result);
      return;
    }
    if (message?.type === "ambient-current-page") {
      const tab = await getActiveTab();
      const result = await ambientCurrentPage(tab, message.reason);
      sendResponse(result);
      return;
    }
    if (message?.type === "poll-context-views") {
      const result = await pollContextViews(message);
      sendResponse(result);
      return;
    }
    if (message?.type === "submit-agent-task-current-page") {
      const tab = await getActiveTab();
      const result = await submitAgentTaskForCurrentPage(tab, message);
      sendResponse(result);
      return;
    }
    if (message?.type === "ask-current-page") {
      const tab = await getActiveTab();
      const result = await askCurrentPage(tab, message);
      sendResponse(result);
      return;
    }
    if (message?.type === "get-chat-page-context") {
      const tab = await getActiveTab();
      const result = await buildAskCurrentPageContext(tab, message);
      sendResponse(result);
      return;
    }
    if (message?.type === "feedback-view") {
      const result = await postViewFeedback(message);
      sendResponse(result);
      return;
    }
    if (message?.type === "get-current-status") {
      const tab = await getActiveTab();
      if (tab?.id && tab.url) await ensureVisit(tab, "status_check");
      const state = tab?.id ? getTabState(tab.id, tab.url) : undefined;
      const settings = await getSettings();
      sendResponse({ ok: true, tab, state: summarizeState(state), settings });
      return;
    }
    if (message?.type === "update-settings") {
      await chrome.storage.local.set(message.settings ?? {});
      sendResponse({ ok: true, settings: await getSettings() });
      return;
    }
  })().catch(error => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true;
});

setInterval(async () => {
  const settings = await getSettings();
  if (!settings.captureStream) return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  for (const tab of tabs) {
    if (!tab?.id || !tab.url) continue;
    await ensureVisit(tab, "heartbeat_tick");
    await captureHeartbeat(tab).catch(() => undefined);
  }
}, DEFAULT_SETTINGS.heartbeatSeconds * 1000);

async function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

async function ensureVisit(tab, reason) {
  const settings = await getSettings();
  const state = getTabState(tab.id, tab.url);
  state.windowId = tab.windowId;
  state.settings = settings;
  if (!state.visitRecorded && settings.captureStream) {
    state.visitRecorded = true;
    const page = await collectFromTab(tab.id).catch(() => basicPageFromTab(tab));
    await sendVisit(page, state, reason);
    if (page.search) await sendSearchQuery(page, state).catch(() => undefined);
    if (settings.snapshotOnVisit) {
      await sendSnapshot(page, state, "initial_visit_snapshot", false).catch(() => undefined);
    }
  }
  return state;
}

async function captureHeartbeat(tab) {
  const state = getTabState(tab.id, tab.url);
  state.windowId = tab.windowId;
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id);
  const dwell_seconds = Math.round((Date.now() - state.startedAt) / 1000);
  const active_seconds = Math.round((Date.now() - state.activatedAt) / 1000);
  const record = baseRecord({
    schemaName: "observation.browser_page_heartbeat",
    page,
    state,
    contentText: undefined,
    acquisitionMode: "passive",
    reason: "periodic active tab heartbeat",
    importance: 0.2,
    payload: {
      visit_id: state.visitId,
      dwell_seconds,
      active_seconds,
      scroll_depth: page.scroll_depth,
      scroll_events: page.scroll_events,
      selection_count: page.selection_count,
      selected_text_length: page.selected_text?.length ?? 0,
      visible: true,
    },
  });
  return postRecord(record);
}

async function captureSnapshot(tab, reason, manual, manualSaveReason) {
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
  await ensureVisit(tab, "snapshot_requested");
  const state = getTabState(tab.id, tab.url);
  state.windowId = tab.windowId;
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id);
  return sendSnapshot(page, state, reason, manual, manualSaveReason);
}

async function ambientCurrentPage(tab, reason) {
  const startedAt = new Date().toISOString();
  if (!tab?.id || !tab.url) return { ok: false, stage: "active_tab", error: "no active tab", started_at: startedAt };

  const snapshot = await captureAmbientRequest(tab, reason || "Explore current page with Browser Ambient");
  const recordId = snapshot?.body?.id || snapshot?.body?.record?.id || snapshot?.body?.duplicate_of;
  if (!snapshot.ok || !recordId) {
    return {
      ok: false,
      stage: "capture_ambient_request",
      error: "ambient request failed or missing record id",
      started_at: startedAt,
      tab: { id: tab.id, title: tab.title, url: tab.url },
      snapshot,
    };
  }

  const writtenViews = viewIdsFromProcessedIngestResponse(snapshot.body);
  const views = await fetchViews(writtenViews);
  return {
    ok: Boolean(snapshot.ok && snapshot.body?.ok),
    stage: "done",
    started_at: startedAt,
    tab: { id: tab.id, title: tab.title, url: tab.url },
    record_id: recordId,
    written_views: writtenViews,
    views,
    snapshot,
    processing: snapshot.body?.processing,
    cascade_processing: snapshot.body?.cascade_processing,
  };
}

async function captureAmbientRequest(tab, reason) {
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
  await ensureVisit(tab, "ambient_requested");
  const state = getTabState(tab.id, tab.url);
  state.windowId = tab.windowId;
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id);
  const dwell_seconds = Math.round((Date.now() - state.startedAt) / 1000);
  const record = baseRecord({
    schemaName: "observation.browser_ambient_requested",
    page,
    state,
    contentText: page.text,
    acquisitionMode: "manual",
    reason,
    importance: 0.98,
    payload: {
      visit_id: state.visitId,
      canonical_url: page.metadata?.canonical_url,
      selected_text: page.selected_text,
      selected_text_length: page.selected_text?.length ?? 0,
      scroll_depth: page.scroll_depth,
      scroll_events: page.scroll_events,
      selection_count: page.selection_count,
      dwell_seconds,
      metadata: page.metadata,
      text_quality: page.text_quality,
      search: page.search,
      request: {
        kind: "ambient_explore",
        button_clicked: true,
        requested_at: new Date().toISOString(),
      },
    },
  });
  return postRecord(record, { process: true, cascadeViews: true });
}

async function captureAgentTaskQuestion(tab, question) {
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
  await ensureVisit(tab, "agent_task_requested");
  const state = getTabState(tab.id, tab.url);
  state.windowId = tab.windowId;
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id);
  const dwell_seconds = Math.round((Date.now() - state.startedAt) / 1000);
  const record = baseRecord({
    schemaName: "observation.browser_agent_task_requested",
    page,
    state,
    contentText: page.text,
    acquisitionMode: "manual",
    reason: question || "Ask Claude Code about the current browser page",
    importance: 0.99,
    payload: {
      visit_id: state.visitId,
      canonical_url: page.metadata?.canonical_url,
      selected_text: page.selected_text,
      selected_text_length: page.selected_text?.length ?? 0,
      scroll_depth: page.scroll_depth,
      scroll_events: page.scroll_events,
      selection_count: page.selection_count,
      dwell_seconds,
      metadata: page.metadata,
      text_quality: page.text_quality,
      search: page.search,
      request: {
        kind: "agent_task_question",
        question,
        requested_at: new Date().toISOString(),
      },
    },
  });
  return postRecord(record);
}

async function sendVisit(page, state, reason) {
  const record = baseRecord({
    schemaName: "observation.browser_page_visit",
    page,
    state,
    contentText: undefined,
    acquisitionMode: "passive",
    reason,
    importance: 0.15,
    payload: {
      visit_id: state.visitId,
      tab_id: state.tabId,
      window_id: state.windowId,
      opened_at: state.openedAt,
      transition_reason: reason,
      metadata: page.metadata,
    },
  });
  return postRecord(record);
}


async function sendSearchQuery(page, state) {
  if (!page.search?.query) return { ok: false, error: "no search query" };
  const record = baseRecord({
    schemaName: "observation.browser_search_query",
    page,
    state,
    contentText: page.search.query,
    acquisitionMode: "passive",
    reason: `search query on ${page.search.engine}`,
    importance: 0.65,
    payload: {
      visit_id: state.visitId,
      engine: page.search.engine,
      query: page.search.query,
      searched_at: page.search.searched_at,
      canonical_url: page.metadata?.canonical_url,
      metadata: page.metadata,
    },
  });
  return postRecord(record);
}

async function sendSnapshot(page, state, reason, manual, manualSaveReason) {
  const dwell_seconds = Math.round((Date.now() - state.startedAt) / 1000);
  const schemaName = manual ? "observation.browser_page_saved" : "observation.browser_page_snapshot";
  const record = baseRecord({
    schemaName,
    page,
    state,
    contentText: page.text,
    acquisitionMode: manual ? "manual" : "passive",
    reason,
    importance: manual ? 0.95 : 0.35,
    payload: {
      visit_id: state.visitId,
      canonical_url: page.metadata?.canonical_url,
      selected_text: page.selected_text,
      selected_text_length: page.selected_text?.length ?? 0,
      scroll_depth: page.scroll_depth,
      scroll_events: page.scroll_events,
      selection_count: page.selection_count,
      dwell_seconds,
      snapshot_reason: reason,
      metadata: page.metadata,
      text_quality: page.text_quality,
      search: page.search,
      manual_save_reason: manualSaveReason,
      reader_enrichment: manual,
    },
  });
  const result = await postRecord(record);
  if (result.ok) {
    state.snapshotCount += 1;
    state.lastSnapshotAt = Date.now();
  }
  return result;
}


async function sendBrowserAttention(payload, kind, tab) {
  if (!payload?.selected_text) return { ok: false, error: "missing selected_text" };
  const settings = await getSettings();
  const privacy = privacyForUrl(payload.url, settings);
  const schemaName = kind === "copied" ? "observation.browser_text_copied" : "observation.browser_text_selected";
  const record = {
    schema: { name: schemaName, version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: payload.domain, app: "chrome" },
    time: { observed_at: payload.selected_at ?? new Date().toISOString(), captured_at: new Date().toISOString() },
    content: { title: payload.title, url: payload.url, text: payload.selected_text },
    acquisition: { mode: "passive", actor: "user", reason: kind === "copied" ? "browser text copied" : "browser text selected" },
    signal: { importance: kind === "copied" ? 0.9 : 0.75, confidence: 0.95, status: "inbox" },
    privacy,
    payload: {
      ...payload,
      copied: kind === "copied",
      tab_id: tab?.id,
      window_id: tab?.windowId,
      attention_signal: kind,
      attention_weight: kind === "copied" ? 1.0 : 0.85,
    },
  };
  return postRecord(record);
}

async function sendWritingInput(payload, tab) {
  const text = String(payload?.text ?? "").trim();
  if (text.length < 12) return { ok: false, error: "writing text too short" };
  const settings = await getSettings();
  const url = payload?.url || tab?.url || "";
  const privacy = privacyForUrl(url, settings);
  if (privacy.retention === "do_not_store") return { ok: true, stored: false, reason: "privacy do_not_store" };
  const record = {
    schema: { name: "observation.editor.text_changed", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: payload?.domain, app: "chrome" },
    time: { observed_at: payload?.changed_at ?? new Date().toISOString(), captured_at: new Date().toISOString() },
    content: {
      title: payload?.title || tab?.title || "Browser writing input",
      url,
      text: text.slice(0, 4000),
    },
    acquisition: { mode: "passive", actor: "user", reason: "browser writing input changed" },
    signal: { importance: 0.78, confidence: 0.86, status: "inbox" },
    privacy,
    payload: {
      ...payload,
      text: text.slice(0, 4000),
      text_length: text.length,
      tab_id: tab?.id,
      window_id: tab?.windowId,
      writing_surface: "browser_inline",
    },
  };
  const posted = await postWritingAssistRecord(record);
  const writtenViews = viewIdsFromProcessedIngestResponse(posted.body);
  const views = Array.isArray(posted.body?.views)
    ? posted.body.views.map(view => ({ ok: true, status: posted.status, body: { view }, view, endpoint: posted.endpoint }))
    : await fetchViews(writtenViews);
  return {
    ok: Boolean(posted.ok && posted.body?.ok),
    schema: record.schema.name,
    record_id: posted.body?.id || posted.body?.record?.id || posted.body?.duplicate_of,
    written_views: writtenViews,
    views,
    posted,
  };
}

async function sendLifecycleEvent(state, event) {
  const record = {
    schema: { name: "observation.browser_lifecycle", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: state.domain, app: "chrome" },
    time: { observed_at: new Date().toISOString(), captured_at: new Date().toISOString() },
    content: { title: state.title, url: state.url },
    acquisition: { mode: "passive", actor: "user", reason: event },
    signal: { importance: 0.1, confidence: 0.9, status: "inbox" },
    privacy: state.privacy ?? privacyForUrl(state.url, await getSettings()),
    payload: {
      visit_id: state.visitId,
      event,
      dwell_seconds: Math.round((Date.now() - state.startedAt) / 1000),
    },
  };
  return postRecord(record);
}

function baseRecord({ schemaName, page, state, contentText, acquisitionMode, reason, importance, payload }) {
  const privacy = privacyForUrl(page.url, state.settings);
  state.privacy = privacy;
  state.title = page.title;
  state.domain = page.domain;
  return {
    schema: { name: schemaName, version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: page.domain, app: "chrome" },
    time: { observed_at: page.observed_at, captured_at: new Date().toISOString() },
    content: { title: page.title, url: page.url, text: contentText },
    acquisition: { mode: acquisitionMode, actor: "user", reason },
    signal: { importance, confidence: 0.9, status: schemaName === "observation.browser_page_saved" ? "accepted" : "inbox" },
    privacy,
    payload,
  };
}

async function postRecord(record, options = {}) {
  if (record.privacy?.retention === "do_not_store") {
    return { ok: true, stored: false, reason: "privacy do_not_store", schema: record.schema.name };
  }
  const settings = await getSettings();
  try {
    const endpoint = contextIngestEndpointFromSettings(settings, options);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body, schema: record.schema.name, endpoint };
  } catch (error) {
    const endpoint = contextIngestEndpointFromSettings(settings, options);
    return { ok: false, status: 0, error: error?.message ?? String(error), schema: record.schema.name, endpoint };
  }
}

async function postWritingAssistRecord(record) {
  if (record.privacy?.retention === "do_not_store") {
    return { ok: true, stored: false, reason: "privacy do_not_store", schema: record.schema.name };
  }
  const settings = await getSettings();
  const endpoint = writingAssistEndpointFromSettings(settings);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body, schema: record.schema.name, endpoint };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error), schema: record.schema.name, endpoint };
  }
}

async function fetchViews(viewIds) {
  const settings = await getSettings();
  const views = [];
  for (const id of viewIds) {
    const endpoint = contextViewUrlFromSettings(settings, id);
    try {
      const response = await fetch(endpoint);
      const body = await response.json().catch(() => ({}));
      views.push({ ok: response.ok, status: response.status, body, view: body.view, endpoint });
    } catch (error) {
      views.push({ ok: false, status: 0, error: error?.message ?? String(error), endpoint });
    }
  }
  return views;
}

async function pollContextViews(message) {
  const settings = await getSettings();
  const endpoint = contextViewsEndpointFromSettings(settings, {
    viewTypes: message.viewTypes,
    viewTypePrefix: message.viewTypePrefix,
    cursor: message.cursor,
    query: message.query,
    sourceRecordId: message.sourceRecordId,
    limit: message.limit ?? 8,
    activeOnly: message.activeOnly ?? true,
  });
  try {
    const response = await fetch(endpoint);
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && Boolean(body.ok), status: response.status, endpoint, ...body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error), endpoint };
  }
}

async function postViewFeedback(message) {
  if (!message.viewId || !message.feedbackType) return { ok: false, error: "viewId and feedbackType are required" };
  const settings = await getSettings();
  const endpoint = feedbackEndpointFromSettings(settings);
  const payload = buildViewFeedbackRequest({
    viewId: message.viewId,
    viewType: message.viewType,
    type: message.feedbackType,
    value: message.value,
    reason: message.reason,
    applicationId: message.applicationId || "browser.popup",
    payload: { surface: message.surface || "popup", ...(message.payload ?? {}) },
  });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && Boolean(body.ok), status: response.status, endpoint, payload, ...body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error), endpoint, payload };
  }
}

async function submitAgentTaskForCurrentPage(tab, message) {
  const startedAt = new Date().toISOString();
  const settings = await getSettings();
  const question = String(message?.question ?? "").trim();
  const capture = await captureAgentTaskQuestion(tab, question);
  const recordId = capture?.body?.id || capture?.body?.record?.id || capture?.body?.duplicate_of;
  if (!capture.ok || !recordId) {
    return { ok: false, stage: "capture_agent_task_source", started_at: startedAt, error: "agent task source capture failed or missing record id", capture };
  }

  const endpoint = agentTasksEndpointFromSettings(settings, { cascadeViews: true });
  const body = buildBrowserAgentTaskRequest({
    recordId,
    question,
    runtime: message?.runtime || settings.agentRuntime || "claude_code",
    title: pageTitleForAgentTask(tab, question),
    dryRun: Boolean(message?.dryRun),
  });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json().catch(() => ({}));
    const writtenViews = viewIdsFromAgentTaskResponse(responseBody);
    const views = await fetchViews(writtenViews);
    return {
      ok: response.ok && Boolean(responseBody.ok),
      stage: "done",
      status: response.status,
      endpoint,
      started_at: startedAt,
      record_id: recordId,
      written_views: writtenViews,
      views,
      request: body,
      result: responseBody.result,
      cascade_processing: responseBody.cascade_processing,
      body: responseBody,
      capture,
    };
  } catch (error) {
    return { ok: false, stage: "post_agent_task", status: 0, endpoint, started_at: startedAt, record_id: recordId, error: error?.message ?? String(error), request: body, capture };
  }
}

async function askCurrentPage(tab, message) {
  const context = await buildAskCurrentPageContext(tab, message);
  if (!context.ok) return context;
  try {
    const response = await fetch(context.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context.body),
    });
    const responseBody = await response.json().catch(() => ({}));
    return {
      ok: response.ok && Boolean(responseBody.ok),
      stage: "done",
      status: response.status,
      endpoint: context.endpoint,
      started_at: context.started_at,
      answer: responseBody.answer,
      sources: responseBody.sources,
      error: responseBody.error,
      runtime: responseBody.runtime,
      session_id: responseBody.session_id,
      stop_reason: responseBody.stop_reason,
      agent_info: responseBody.agent_info,
    };
  } catch (error) {
    return { ok: false, stage: "context_chat", status: 0, endpoint: context.endpoint, started_at: context.started_at, error: error?.message ?? String(error) };
  }
}

async function explainSelection(payload, tab) {
  if (!payload?.selected_text) return { ok: false, error: "missing selected_text" };
  const saved = await sendBrowserAttention({
    ...payload,
    explain_requested: true,
    requested_at: new Date().toISOString(),
  }, "selected", tab);
  const settings = await getSettings();
  const endpoint = contextChatEndpointFromSettings(settings);
  const body = {
    question: [
      "Explain the selected text in plain language.",
      "Keep it concise.",
      "If the page context matters, mention the connection.",
    ].join(" "),
    page_context: {
      title: payload.title || tab?.title,
      url: payload.url || tab?.url,
      domain: payload.domain,
      selected_text: payload.selected_text,
      text: payload.surrounding_text || payload.selected_text,
    },
    scope: {
      domain: payload.domain,
      app: "chrome",
    },
    limit: 6,
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json().catch(() => ({}));
    return {
      ok: response.ok && Boolean(responseBody.ok),
      status: response.status,
      endpoint,
      answer: responseBody.answer,
      error: responseBody.error,
      saved,
      runtime: responseBody.runtime,
      stop_reason: responseBody.stop_reason,
    };
  } catch (error) {
    return { ok: false, status: 0, endpoint, error: error?.message ?? String(error), saved };
  }
}

async function buildAskCurrentPageContext(tab, message) {
  const startedAt = new Date().toISOString();
  if (!tab?.id || !tab.url) return { ok: false, stage: "active_tab", error: "no active tab", started_at: startedAt };
  const settings = await getSettings();
  await ensureVisit(tab, "ask_current_page");
  const page = await collectFromTab(tab.id).catch(() => basicPageFromTab(tab));
  const endpoint = contextChatEndpointFromSettings(settings);
  const body = {
    question: String(message?.question ?? "").trim(),
    page_context: {
      title: page.title || tab.title,
      url: page.url || tab.url,
      domain: page.domain,
      text: page.text,
      selected_text: page.selected_text,
    },
    scope: {
      domain: page.domain,
      app: "chrome",
    },
    limit: 8,
  };
  if (!body.question) return { ok: false, stage: "validate", error: "question is required", started_at: startedAt };
  return { ok: true, stage: "prepared", started_at: startedAt, endpoint, body };
}

function pageTitleForAgentTask(tab, question) {
  const prefix = question ? question.slice(0, 72) : "Browser Claude Code analysis";
  return tab?.title ? `${prefix} · ${tab.title}`.slice(0, 140) : prefix;
}

async function collectFromTab(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "collect-page-context" });
}

function basicPageFromTab(tab) {
  const url = tab.url || "";
  let domain = "";
  try { domain = new URL(url).hostname; } catch {}
  return {
    title: tab.title || url,
    url,
    domain,
    text: "",
    selected_text: "",
    scroll_depth: 0,
    scroll_events: 0,
    selection_count: 0,
    observed_at: new Date().toISOString(),
    metadata: {},
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

function getTabState(tabId, url) {
  let state = tabState.get(tabId);
  if (!state || state.url !== url) {
    let domain = "";
    try { domain = new URL(url).hostname; } catch {}
    state = {
      tabId,
      windowId: undefined,
      url,
      domain,
      visitId: crypto.randomUUID(),
      openedAt: new Date().toISOString(),
      startedAt: Date.now(),
      activatedAt: Date.now(),
      visitRecorded: false,
      snapshotCount: 0,
      lastSnapshotAt: 0,
      settings: DEFAULT_SETTINGS,
    };
    tabState.set(tabId, state);
  }
  state.activatedAt = Date.now();
  return state;
}

function summarizeState(state) {
  if (!state) return undefined;
  return {
    tabId: state.tabId,
    url: state.url,
    visit_id: state.visitId,
    dwell_seconds: Math.round((Date.now() - state.startedAt) / 1000),
    snapshot_count: state.snapshotCount,
    lastSnapshotAt: state.lastSnapshotAt,
    visitRecorded: state.visitRecorded,
  };
}

function privacyForUrl(rawUrl, settings = DEFAULT_SETTINGS) {
  let u;
  try { u = new URL(rawUrl); } catch { return secretPrivacy(); }
  const host = u.hostname;
  const path = u.pathname;
  if (!["http:", "https:"].includes(u.protocol)) return secretPrivacy();
  if ((settings.excludedDomains ?? []).some(d => host === d || host.endsWith(`.${d}`))) return secretPrivacy();
  if (/(bank|pay|checkout|1password|bitwarden|lastpass|account|login|password|token|secret|oauth|auth|mail|gmail|icloud)/i.test(host + path)) {
    return secretPrivacy();
  }
  const isPublicish = !/(localhost|127\.0\.0\.1|\.local$)/i.test(host);
  return {
    level: isPublicish ? "private" : "workspace",
    retention: "normal",
    allow_embedding: true,
    allow_llm_summary: true,
    allow_external_llm: Boolean(settings.allowExternalLlm),
    allow_external_reader: isPublicish,
  };
}

function secretPrivacy() {
  return { level: "secret", retention: "do_not_store", allow_embedding: false, allow_llm_summary: false, allow_external_reader: false };
}

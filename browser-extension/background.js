const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:3111/context/ingest",
  captureStream: true,
  heartbeatSeconds: 15,
  snapshotOnVisit: true,
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

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
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
    if (message?.type === "save-current-page") {
      const tab = await getActiveTab();
      const result = await captureSnapshot(tab, "manual_save", true, message.reason);
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

async function postRecord(record) {
  if (record.privacy?.retention === "do_not_store") {
    return { ok: true, stored: false, reason: "privacy do_not_store", schema: record.schema.name };
  }
  const settings = await getSettings();
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body, schema: record.schema.name };
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
    allow_external_reader: isPublicish,
  };
}

function secretPrivacy() {
  return { level: "secret", retention: "do_not_store", allow_embedding: false, allow_llm_summary: false, allow_external_reader: false };
}

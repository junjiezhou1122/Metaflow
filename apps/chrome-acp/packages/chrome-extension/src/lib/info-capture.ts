import {
  browserAutomationEndpoint,
  browserDeliveriesEndpoint,
  browserExactViewEndpoint,
  browserInteractionEndpoint,
  buildBrowserAutomationEvent,
  buildBrowserDeliveryInteraction,
  type BrowserDeliveryAction,
} from "./ambient/browser-trigger";
import {
  browserCaptureEndpoint,
  buildBrowserCaptureEvent,
  deliverBrowserCaptureEvent,
  retryBrowserCaptureTransportFailure,
  SerializedBrowserCaptureOutbox,
  type BrowserCaptureEventPayload,
  type BrowserCaptureOutbox,
  type BrowserCaptureTransportFailure,
} from "./browser-capture";
import {
  browserNavigationIdentity,
  browserPolicyForUrl,
  classifyBrowserAttention,
  parsePersistedBrowserTabStates,
  resolveBrowserVisitState,
  type PersistedBrowserTabState,
} from "./browser-capture-state";
import {
  DEFAULT_INFO_CAPTURE_SETTINGS,
  resolveInfoCaptureSettings,
  resolveInfoCaptureSettingsUpdate,
  type InfoCaptureSettings,
} from "./info-capture-settings";
import {
  BrowserOperationAccessError,
  authorizedBrowserDaemonFetch,
  isValidOperationAuthToken,
} from "./operation-auth";
import { ensureTrustedOperationStorageAccess } from "./operation-auth-storage";
import {
  authorizeRuntimeMessageSender,
  projectRuntimeMessageResult,
} from "./runtime-sender-policy";

const DEFAULT_SETTINGS = DEFAULT_INFO_CAPTURE_SETTINGS;
type InfoSettings = InfoCaptureSettings;

type PageContext = {
  title?: string;
  url?: string;
  domain?: string;
  text?: string;
  selected_text?: string;
  scroll_depth?: number;
  scroll_events?: number;
  selection_count?: number;
  observed_at?: string;
  metadata?: Record<string, unknown>;
  text_quality?: Record<string, unknown>;
  search?: { engine?: string; query?: string; searched_at?: string };
  dom?: {
    github_repository?: boolean;
    repository_owner?: string;
    repository_name?: string;
    markers?: Record<string, unknown>;
  };
};

type TabState = PersistedBrowserTabState & {
  settings: InfoSettings;
};

const tabState = new Map<number, TabState>();
const BROWSER_CAPTURE_OUTBOX_KEY = "infoCaptureDeadLetters";
const BROWSER_TAB_STATE_KEY = "metaflow.browser_capture.tab_state.v1";
const BROWSER_CAPTURE_HEARTBEAT_ALARM = "metaflow.browser_capture.heartbeat";
const MAC_BROWSER_CONTEXT_ALARM = "metaflow.browser_context.poll";
let tabStateReady: Promise<void> | undefined;

let macBrowserContextPollRunning = false;

export async function installInfoCaptureDefaults() {
  await ensureTrustedOperationStorageAccess();
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof InfoSettings>;
  const existing = await chrome.storage.local.get(keys);
  await chrome.storage.local.set(resolveInfoCaptureSettings(existing));
}

export function startInfoCapture() {
  void ensureTabStateLoaded();
  void configureInfoCaptureAlarms();

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    await ensureTabStateLoaded();
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.id && tab.url) {
      getTabState(tab.id, tab.url, { markActivated: true });
      await ensureVisit(tab, "tab_activated");
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    await ensureTabStateLoaded();
    if (changeInfo.status === "complete" || changeInfo.url) {
      if (tab?.id && tab.url) {
        await ensureVisit(tab, "page_loaded");
      }
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ensureTabStateLoaded();
    const state = tabState.get(tabId);
    if (state) {
      await sendLifecycleEvent(state, "tab_closed").catch(error => {
        reportCaptureTaskFailure("tab_closed", error, { tab_id: tabId, visit_id: state.visitId });
      });
      tabState.delete(tabId);
      await persistTabStates();
    }
  });

  chrome.webNavigation.onCommitted.addListener(details => {
    void captureNavigation(details, "navigation_committed").catch(error => {
      reportCaptureTaskFailure("navigation_committed", error, { tab_id: details.tabId, url: details.url });
    });
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
    void captureNavigation(details, "navigation_history_state").catch(error => {
      reportCaptureTaskFailure("navigation_history_state", error, { tab_id: details.tabId, url: details.url });
    });
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === BROWSER_CAPTURE_HEARTBEAT_ALARM) {
      void runBrowserCaptureHeartbeat().catch(error => {
        reportCaptureTaskFailure("heartbeat_alarm", error, { alarm: alarm.name });
      });
    }
    if (alarm.name === MAC_BROWSER_CONTEXT_ALARM) void runMacBrowserContextPoll();
  });
}

async function configureInfoCaptureAlarms() {
  const settings = await getSettings();
  await chrome.alarms.create(BROWSER_CAPTURE_HEARTBEAT_ALARM, {
    periodInMinutes: Math.max(0.5, settings.heartbeatSeconds / 60),
  });
  await chrome.alarms.create(MAC_BROWSER_CONTEXT_ALARM, { periodInMinutes: 0.5 });
}

async function runBrowserCaptureHeartbeat() {
  const settings = await getSettings();
  if (!settings.captureStream) return;
  for (const tab of await getHeartbeatTabs()) {
    if (!tab.id || !tab.url) continue;
    await ensureVisit(tab, "heartbeat_tick");
    await captureHeartbeat(tab);
  }
}

function runMacBrowserContextPoll() {
  if (macBrowserContextPollRunning) return;
  macBrowserContextPollRunning = true;
  void pollMacBrowserContextRequests()
    .catch(error => console.error("[metaflow-ambient] Browser DOM bridge poll failed", error))
    .finally(() => { macBrowserContextPollRunning = false; });
}

async function pollMacBrowserContextRequests() {
  const settings = await getSettings();
  const response = await authenticatedBrowserDaemonFetch(
    settings,
    macBrowserContextRequestsEndpoint(settings.endpoint),
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`Browser DOM request poll failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  const requests = Array.isArray(body.requests) ? body.requests : [];
  for (const request of requests) {
    const requestId = requiredMessageText(request?.request_id, "request_id");
    try {
      const tab = await getActiveTab();
      if (!tab?.id || tab.windowId === undefined || !tab.url) throw new Error("no active Browser tab");
      const page = await collectFromTab(tab.id);
      if (!page.text?.trim() || !page.url || !page.title) throw new Error("active tab did not expose complete DOM context");
      await postMacBrowserContextResponse(settings, {
        request_id: requestId,
        status: "captured",
        captured_at: new Date().toISOString(),
        tab_id: tab.id,
        window_id: tab.windowId,
        url: page.url,
        title: page.title,
        text: page.text,
        ...(page.selected_text ? { selected_text: page.selected_text } : {}),
        dom: page.dom ?? {},
        metadata: page.metadata ?? {},
      });
    } catch (error) {
      await postMacBrowserContextResponse(settings, {
        request_id: requestId,
        status: "failed",
        code: "browser_dom_capture_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function postMacBrowserContextResponse(settings: InfoSettings, body: Record<string, unknown>) {
  const response = await authenticatedBrowserDaemonFetch(settings, macBrowserContextResponsesEndpoint(settings.endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(`Browser DOM response rejected: HTTP ${response.status} ${JSON.stringify(result)}`);
  }
}

function macBrowserContextRequestsEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = "/automation/v1/macos/browser-context-requests";
  url.search = "";
  return url.toString();
}

function macBrowserContextResponsesEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = "/automation/v1/macos/browser-context-responses";
  url.search = "";
  return url.toString();
}

export async function handleInfoCaptureMessage(message: any, sender: chrome.runtime.MessageSender) {
  const authorization = authorizeRuntimeMessageSender(message, sender);
  if (!authorization.ok) return authorization;
  await ensureTabStateLoaded();
  if (message?.type === "context.capture.browser_attention") {
    const tab = sender.tab ?? await getActiveTab();
    return projectRuntimeMessageResult(authorization, await sendBrowserAttention(message.payload, message.kind, tab));
  }
  if (message?.type === "context.explain.selection") {
    const tab = sender.tab ?? await getActiveTab();
    return explainSelection(message.payload, tab);
  }
  if (message?.type === "context.capture.writing_input") {
    const tab = sender.tab ?? await getActiveTab();
    return projectRuntimeMessageResult(
      authorization,
      await sendWritingInput(message.payload, tab, {
        allow_privileged_assist: authorization.principal !== "content-script",
      }),
    );
  }
  if (message?.type === "save-current-page") {
    const tab = await getActiveTab();
    return captureSnapshot(tab, "manual_save", true, message.reason);
  }
  if (message?.type === "ambient-current-page") {
    const tab = await getActiveTab();
    return submitBrowserAutomation({ ...message, reason_kind: "manual" }, tab);
  }
  if (message?.type === "feedback-view") {
    return projectRuntimeMessageResult(authorization, await postViewFeedback(message));
  }
  if (message?.type === "poll-ambient-deliveries") {
    return pollBrowserDeliveries(message);
  }
  if (message?.type === "ambient-delivery-interaction") {
    return postBrowserDeliveryInteraction(message);
  }
  if (message?.type === "get-ambient-exact-view") {
    return getAmbientExactView(message);
  }
  if (message?.type === "poll-context-views") {
    return pollContextViews(message);
  }
  if (message?.type === "list-ambient-tasks") {
    if (shouldUseAgentTasksEndpoint(message)) return pollAgentTasks(message);
    // Browser-side shorthand: list views that look like ambient task outputs.
    // We filter on view type prefixes produced by program.browser_ambient
    // (analysis.*) and the proactive ambient programs (advice.* / task.*).
    return pollContextViews({
      viewTypes: message.viewTypes,
      viewTypePrefix: message.viewTypePrefix ?? "analysis.",
      cursor: message.cursor,
      query: message.query,
      sourceRecordId: message.sourceRecordId,
      limit: message.limit ?? 30,
      activeOnly: message.activeOnly ?? false,
    });
  }
  if (message?.type === "agent-tasks") {
    return runAgentTasksAction(message);
  }
  if (message?.type === "agent-task-action") {
    return updateAgentTask(message);
  }
  if (message?.type === "trigger-ambient" || message?.type === "automation.browser.signal") {
    const tab = sender.tab ?? await getActiveTab();
    const result = await submitBrowserAutomation(
      message?.type === "trigger-ambient" ? { ...message, reason_kind: "manual" } : message,
      tab,
    );
    return projectRuntimeMessageResult(authorization, result);
  }
  if (message?.type === "youtube-comprehension-gap") {
    // Ingest a single comprehension gap record produced by the YouTube
    // content script. We process it through the cascade so the
    // language_learning program can pick it up in the same tick.
    const tab = sender.tab ?? await getActiveTab();
    if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
    const gap = message.gap;
    if (!gap?.video_id) return { ok: false, error: "gap missing video_id" };
    await ensureVisit(tab, "youtube_comprehension_gap");
    const state = getTabState(tab.id, tab.url);
    state.windowId = tab.windowId;
    state.settings = await getSettings();
    const page = await collectFromTab(tab.id).catch(error => {
      reportCaptureTaskFailure("youtube_gap_page_context", error, { tab_id: tab.id, url: tab.url });
      return basicPageFromTab(tab);
    });
    updateTabStateFromPage(state, page, state.settings);
    const record = legacyContextRecord({
      schemaName: "observation.youtube.comprehension_gap",
      page,
      state,
      contentText: undefined,
      acquisitionMode: "passive",
      reason: "User toggled captions repeatedly on a YouTube segment; treating it as a comprehension gap",
      importance: 0.7,
      payload: {
        gap,
        visit_id: state.visitId,
      },
    });
    return projectRuntimeMessageResult(
      authorization,
      await postLegacyRecord(record, { process: true, cascadeViews: true }),
    );
  }
  if (message?.type === "youtube-observation") {
    const tab = sender.tab ?? await getActiveTab();
    return projectRuntimeMessageResult(authorization, await sendYouTubeObservation(message, tab));
  }
  if (message?.type === "get-current-status") {
    const tab = await getActiveTab();
    if (tab?.id && tab.url) await ensureVisit(tab, "status_check");
    return {
      ok: true,
      tab,
      state: tab?.id ? summarizeState(tabState.get(tab.id)) : undefined,
      settings: publicInfoSettings(await getSettings()),
    };
  }
  if (message?.type === "update-info-capture-settings") {
    if (message.settings?.operationAuthToken !== undefined
      && !isValidOperationAuthToken(message.settings.operationAuthToken)) {
      return {
        ok: false,
        code: "operation_auth_token_invalid",
        error: "The resident daemon Operation token is invalid",
      };
    }
    if (message.settings?.operationAuthToken !== undefined) {
      await ensureTrustedOperationStorageAccess();
    }
    const settings = resolveInfoCaptureSettingsUpdate(await getSettings(), message.settings ?? {});
    await chrome.storage.local.set(settings);
    await configureInfoCaptureAlarms();
    return { ok: true, settings: publicInfoSettings(await getSettings()) };
  }
  if (message?.type === "retry-browser-capture") {
    return retryBrowserCaptureFailure(requiredMessageText(message.failure_id, "failure_id"));
  }
  if (message?.type === "list-browser-capture-failures") {
    return { ok: true, failures: await listBrowserCaptureFailures() };
  }
  return undefined;
}

async function ensureVisit(tab: chrome.tabs.Tab, reason: string, options: { allow_snapshot?: boolean } = {}) {
  if (!tab.id || !tab.url) return undefined;
  if (!shouldCaptureBrowserTab(tab)) return undefined;
  const settings = await getSettings();
  const state = getTabState(tab.id, tab.url, { windowId: tab.windowId });
  state.settings = settings;
  let page: PageContext | undefined;
  const loadPage = async () => {
    if (!page) {
      page = await collectFromTab(tab.id!).catch(error => {
        reportCaptureTaskFailure("visit_page_context", error, { tab_id: tab.id, url: tab.url });
        return basicPageFromTab(tab);
      });
      updateTabStateFromPage(state, page, settings);
    }
    return page;
  };
  if (!state.visitRecorded && settings.captureStream) {
    const currentPage = await loadPage();
    const visit = await sendVisit(currentPage, state, reason);
    if (visit.ok || visit.failure) {
      state.visitRecorded = true;
      await persistTabStates();
    }
    if (currentPage.search?.query) {
      await sendSearchQuery(currentPage, state).catch(error => {
        reportCaptureTaskFailure("search_query", error, { tab_id: tab.id, url: tab.url });
      });
    }
  }
  if (settings.captureStream
    && settings.snapshotOnVisit
    && !state.initialSnapshotRecorded
    && options.allow_snapshot !== false) {
    const snapshot = await sendSnapshot(await loadPage(), state, "initial_visit_snapshot", false);
    if (snapshot.ok || snapshot.failure) state.initialSnapshotRecorded = true;
  }
  await persistTabStates();
  return state;
}

async function captureHeartbeat(tab: chrome.tabs.Tab) {
  if (!tab.id || !tab.url) return { ok: false, error: "no active tab" };
  if (!shouldCaptureBrowserTab(tab)) return { ok: true, skipped: "ignored tab" };
  const state = getTabState(tab.id, tab.url, { windowId: tab.windowId });
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id);
  updateTabStateFromPage(state, page, state.settings);
  const occurredAt = page.observed_at ?? new Date().toISOString();
  return submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "interaction", "interaction_heartbeat", occurredAt),
    page: browserPage(page),
    content: {},
    facts: jsonFacts({
      visit_id: state.visitId,
      dwell_seconds: Math.round((Date.now() - state.startedAt) / 1000),
      active_seconds: Math.round((Date.now() - state.activatedAt) / 1000),
      scroll_depth: page.scroll_depth,
      scroll_events: page.scroll_events,
      selection_count: page.selection_count,
      selected_text_length: page.selected_text?.length ?? 0,
      attention_evidence: "chrome_focused_window_active_tab",
    }),
  });
}

async function captureSnapshot(tab: chrome.tabs.Tab | undefined, reason: string, manual: boolean, manualSaveReason?: string) {
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
  await ensureVisit(tab, "snapshot_requested");
  const state = getTabState(tab.id, tab.url, { windowId: tab.windowId });
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id);
  updateTabStateFromPage(state, page, state.settings);
  return sendSnapshot(page, state, reason, manual, manualSaveReason);
}

async function submitBrowserAutomation(message: any, tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab", code: "browser_tab_missing" };
  if (!shouldCaptureBrowserTab(tab)) return { ok: false, error: "tab is excluded from Browser Capture", code: "browser_tab_excluded" };
  const settings = await getSettings();
  const state = getTabState(tab.id, tab.url);
  state.windowId = tab.windowId;
  state.settings = settings;
  const page = await collectFromTab(tab.id);
  const privacy = privacyForUrl(page.url ?? tab.url, settings);
  const now = new Date().toISOString();
  let event;
  try {
    event = buildBrowserAutomationEvent({
      message,
      tab: { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title },
      page,
      visit_id: state.visitId,
      started_at_ms: state.startedAt,
      privacy,
      now,
      id_factory: () => crypto.randomUUID(),
    });
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await recordAutomationFailure({ event_id: message.event_id, navigation_id: message.navigation_id, url: page.url ?? tab.url }, browserAutomationEndpoint(settings.endpoint), failure);
    return { ok: false, status: 0, code: "browser_event_build_failed", error: failure };
  }
  const endpoint = browserAutomationEndpoint(settings.endpoint);
  try {
    const response = await authenticatedBrowserDaemonFetch(settings, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      await recordAutomationFailure(event, endpoint, `HTTP ${response.status}`, body);
      return { ok: false, status: response.status, endpoint, event_id: event.event_id, ...body };
    }
    return { ok: true, status: response.status, endpoint, event_id: event.event_id, ...body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAutomationFailure(event, endpoint, message);
    return { ok: false, status: 0, endpoint, event_id: event.event_id, error: message };
  }
}

async function pollBrowserDeliveries(message: any) {
  const settings = await getSettings();
  let endpoint: string;
  try {
    endpoint = browserDeliveriesEndpoint(settings.endpoint, {
      after: typeof message.after === "string" ? message.after : undefined,
      limit: message.limit === undefined ? undefined : Number(message.limit),
    });
  } catch (error) {
    return { ok: false, status: 0, code: "browser_delivery_query_invalid", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await authenticatedBrowserDaemonFetch(settings, endpoint);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      await recordAutomationFailure({}, endpoint, `HTTP ${response.status}`, body);
      return { ok: false, status: response.status, endpoint, ...body };
    }
    return { ok: true, status: response.status, endpoint, ...body };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await recordAutomationFailure({}, endpoint, failure);
    return { ok: false, status: 0, endpoint, error: failure };
  }
}

async function postBrowserDeliveryInteraction(message: any) {
  const settings = await getSettings();
  const endpoint = browserInteractionEndpoint(settings.endpoint);
  let interaction;
  try {
    interaction = buildBrowserDeliveryInteraction({
      request_id: requiredMessageText(message.request_id, "request_id"),
      delivery_id: requiredMessageText(message.delivery_id, "delivery_id"),
      action: browserDeliveryAction(message.action),
      snooze_until: typeof message.snooze_until === "string" ? message.snooze_until : undefined,
      correction: typeof message.correction === "string" ? message.correction : undefined,
      metadata: message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) ? message.metadata : {},
      now: new Date().toISOString(),
      id_factory: () => crypto.randomUUID(),
    });
  } catch (error) {
    return { ok: false, status: 0, code: "browser_interaction_invalid", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await authenticatedBrowserDaemonFetch(settings, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(interaction),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      await recordAutomationFailure(interaction, endpoint, `HTTP ${response.status}`, body);
      return { ok: false, status: response.status, endpoint, interaction_id: interaction.id, ...body };
    }
    return { ok: true, status: response.status, endpoint, interaction_id: interaction.id, ...body };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await recordAutomationFailure(interaction, endpoint, failure);
    return { ok: false, status: 0, endpoint, interaction_id: interaction.id, error: failure };
  }
}

async function getAmbientExactView(message: any) {
  const settings = await getSettings();
  const operationAuthToken = settings.operationAuthToken;
  if (!isValidOperationAuthToken(operationAuthToken)) {
    return {
      ok: false,
      status: 0,
      code: "operation_auth_configuration_required",
      error: "A valid resident daemon Operation token is required for exact View reads",
    };
  }
  let ref: { view_id: string; revision: number };
  try {
    ref = {
      view_id: requiredMessageText(message.view_id, "view_id"),
      revision: Number(message.revision),
    };
    browserExactViewEndpoint("http://127.0.0.1", ref);
  } catch (error) {
    return { ok: false, status: 0, code: "exact_view_ref_invalid", error: error instanceof Error ? error.message : String(error) };
  }
  const endpoint = browserExactViewEndpoint(settings.endpoint, ref);
  try {
    const response = await authenticatedBrowserDaemonFetch(settings, endpoint);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      await recordAutomationFailure({}, endpoint, `HTTP ${response.status}`, body);
      return { ok: false, status: response.status, endpoint, ...body };
    }
    return { ok: true, status: response.status, endpoint, view: body.view };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await recordAutomationFailure({}, endpoint, failure);
    return { ok: false, status: 0, endpoint, error: failure };
  }
}

function requiredMessageText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function browserDeliveryAction(value: unknown): BrowserDeliveryAction {
  if (value === "accept" || value === "dismiss" || value === "later" || value === "cancel" || value === "retry" || value === "correct") {
    return value;
  }
  throw new Error(`unsupported Browser Delivery action: ${String(value)}`);
}

async function sendVisit(page: PageContext, state: TabState, reason: string) {
  const tab = await chrome.tabs.get(state.tabId);
  const occurredAt = page.observed_at ?? state.openedAt;
  return submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "navigation", "navigation_opened", occurredAt),
    navigation: {
      navigation_id: state.visitId,
      transition: "opened",
      ...(state.documentId ? { document_id: state.documentId } : {}),
      frame_id: state.frameId ?? 0,
    },
    page: browserPage(page),
    content: {},
    facts: jsonFacts({
      visit_id: state.visitId,
      tab_id: state.tabId,
      window_id: state.windowId,
      opened_at: state.openedAt,
      transition_reason: reason,
      metadata: page.metadata,
    }),
  });
}

async function sendSearchQuery(page: PageContext, state: TabState) {
  if (!page.search?.query) return { ok: false, error: "no search query" };
  const tab = await chrome.tabs.get(state.tabId);
  const occurredAt = page.search.searched_at ?? page.observed_at ?? new Date().toISOString();
  return submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "interaction", "interaction_search", occurredAt),
    page: browserPage(page),
    content: {},
    facts: jsonFacts({
      visit_id: state.visitId,
      engine: page.search.engine,
      query: page.search.query,
      searched_at: page.search.searched_at,
      canonical_url: page.metadata?.canonical_url,
      metadata: page.metadata,
    }),
  });
}

async function sendSnapshot(page: PageContext, state: TabState, reason: string, manual: boolean, manualSaveReason?: string) {
  const tab = await chrome.tabs.get(state.tabId);
  const occurredAt = page.observed_at ?? new Date().toISOString();
  const result = await submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "page", manual ? "page_saved" : "page_snapshot", occurredAt, manual ? crypto.randomUUID() : undefined),
    page: browserPage(page),
    content: compactContent({ text: page.text, selected_text: page.selected_text }),
    facts: jsonFacts({
      visit_id: state.visitId,
      canonical_url: page.metadata?.canonical_url,
      selected_text: page.selected_text,
      selected_text_length: page.selected_text?.length ?? 0,
      scroll_depth: page.scroll_depth,
      scroll_events: page.scroll_events,
      selection_count: page.selection_count,
      dwell_seconds: Math.round((Date.now() - state.startedAt) / 1000),
      snapshot_reason: reason,
      metadata: page.metadata,
      text_quality: page.text_quality,
      search: page.search,
      manual_save_reason: manualSaveReason,
      user_intent: manual ? "save_current_page" : undefined,
      reader_enrichment: manual,
    }),
  });
  if (result.ok) {
    state.snapshotCount += 1;
    state.lastSnapshotAt = Date.now();
    await persistTabStates();
  }
  return result;
}

async function sendBrowserAttention(payload: any, kind: string, tab?: chrome.tabs.Tab) {
  if (!payload?.selected_text) return { ok: false, error: "missing selected_text" };
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
  await ensureVisit(tab, `browser_text_${kind}`);
  const settings = await getSettings();
  const state = getTabState(tab.id, tab.url, { windowId: tab.windowId });
  state.settings = settings;
  const occurredAt = typeof payload.selected_at === "string" ? payload.selected_at : new Date().toISOString();
  return submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "selection", kind === "copied" ? "copy" : "selection", occurredAt),
    page: browserPage({
      url: payload.url,
      title: payload.title,
      domain: payload.domain,
      metadata: { canonical_url: payload.canonical_url },
    }),
    content: { selected_text: String(payload.selected_text).trim() },
    facts: jsonFacts({
      ...payload,
      copied: kind === "copied",
      tab_id: tab?.id,
      window_id: tab?.windowId,
      attention_signal: kind,
      attention_weight: kind === "copied" ? 1.0 : 0.85,
    }),
    policy: browserPolicyForUrl(String(payload.url), {
      excluded_domains: settings.excludedDomains,
      allow_external_model: settings.allowExternalLlm,
    }),
  });
}

async function explainSelection(payload: any, tab?: chrome.tabs.Tab) {
  if (!payload?.selected_text) return { ok: false, error: "missing selected_text" };
  const saved = await sendBrowserAttention({
    ...payload,
    explain_requested: true,
    requested_at: new Date().toISOString(),
  }, "selected", tab);
  const settings = await getSettings();
  const endpoint = contextChatEndpoint(settings);
  const question = [
    "Explain the selected text in plain language.",
    "Keep it concise.",
    "If the page context matters, mention the connection.",
  ].join(" ");
  const body = {
    question,
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
    return { ok: false, status: 0, endpoint, error: error instanceof Error ? error.message : String(error), saved };
  }
}

async function sendWritingInput(
  payload: any,
  tab: chrome.tabs.Tab | undefined,
  options: { allow_privileged_assist: boolean },
) {
  const text = String(payload?.text ?? "").trim();
  if (text.length < 12) return { ok: false, error: "writing text too short" };
  const settings = await getSettings();
  const url = payload?.url || tab?.url || "";
  const privacy = privacyForUrl(url, settings);
  if (privacy.retention === "do_not_store") return { ok: true, stored: false, reason: "privacy do_not_store" };
  const record = {
    schema: { name: "observation.editor.text_changed", version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { domain: payload?.domain, app: "chrome" },
    time: { observed_at: payload?.changed_at ?? new Date().toISOString(), captured_at: new Date().toISOString() },
    content: { title: payload?.title || tab?.title || "Browser writing input", url, text: text.slice(0, 4000) },
    acquisition: { mode: "passive", actor: "user", reason: "browser writing input changed" },
    signal: { importance: 0.78, confidence: 0.86, status: "inbox" },
    privacy,
    payload: {
      ...payload,
      text: text.slice(0, 4000),
      full_text: String(payload?.full_text ?? "").slice(0, 8000) || undefined,
      page_context: sanitizeWritingPageContext(payload?.page_context),
      text_length: text.length,
      tab_id: tab?.id,
      window_id: tab?.windowId,
      writing_surface: "browser_inline",
    },
  };
  const posted = options.allow_privileged_assist
    ? await postWritingAssistRecord(record)
    : await postLegacyRecord(record);
  if (!options.allow_privileged_assist) {
    const captureResult = posted as Record<string, unknown>;
    return {
      ok: captureResult.ok === true,
      ...(typeof captureResult.status === "number" ? { status: captureResult.status } : {}),
      ...(typeof captureResult.stored === "boolean" ? { stored: captureResult.stored } : {}),
      ...(typeof captureResult.reason === "string" ? { reason: captureResult.reason } : {}),
    };
  }
  const writtenViews = viewIdsFromProcessedIngestResponse(posted.body);
  const views = Array.isArray(posted.body?.views)
    ? posted.body.views.map((view: any) => ({ ok: true, status: posted.status, body: { view }, view, endpoint: posted.endpoint }))
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

function sanitizeWritingPageContext(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const text = (key: string, limit: number) => {
    const raw = input[key];
    return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, limit) : undefined;
  };
  return {
    title: text("title", 300),
    url: text("url", 1000),
    domain: text("domain", 200),
    selected_text: text("selected_text", 2000),
    excerpt: text("excerpt", 6000),
    text_quality: typeof input.text_quality === "object" && input.text_quality ? input.text_quality : undefined,
  };
}

async function sendLifecycleEvent(state: TabState, event: string) {
  const occurredAt = new Date().toISOString();
  const tab = await chrome.tabs.get(state.tabId).catch(() => undefined);
  return submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "navigation", "navigation_lifecycle", occurredAt),
    navigation: {
      navigation_id: state.visitId,
      transition: "lifecycle",
      ...(state.documentId ? { document_id: state.documentId } : {}),
      frame_id: state.frameId ?? 0,
    },
    page: browserPage({ title: state.title, url: state.url, domain: state.domain }),
    content: {},
    facts: jsonFacts({
      visit_id: state.visitId,
      event,
      dwell_seconds: Math.round((Date.now() - state.startedAt) / 1000),
    }),
  });
}

async function sendYouTubeObservation(message: any, tab?: chrome.tabs.Tab) {
  if (!tab?.id || !tab.url) return { ok: false, error: "no active tab" };
  const schemaName = youtubeObservationSchema(message.schemaName);
  if (!schemaName) return { ok: false, error: "unsupported youtube observation schema" };
  await ensureVisit(tab, "youtube_observation");
  const state = getTabState(tab.id, tab.url, { windowId: tab.windowId });
  state.settings = await getSettings();
  const page = await collectFromTab(tab.id).catch(error => {
    reportCaptureTaskFailure("youtube_observation_page_context", error, { tab_id: tab.id, url: tab.url });
    return basicPageFromTab(tab);
  });
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  const text = youtubeObservationText(schemaName, payload);
  const action = schemaName === "observation.youtube.caption_fragment"
    ? "media_caption"
    : schemaName === "observation.youtube.caption_state"
      ? "media_caption_state"
      : schemaName === "observation.youtube.paused"
        ? "media_paused"
        : "media_played";
  const occurredAt = typeof payload.observed_at === "string"
    ? payload.observed_at
    : page.observed_at ?? new Date().toISOString();
  return submitBrowserCaptureEvent({
    ...await browserEventBase(state, tab, "media", action, occurredAt),
    page: browserPage({
      ...page,
      ...(typeof payload.video_url === "string" ? { url: payload.video_url } : {}),
      ...(typeof payload.video_title === "string" ? { title: payload.video_title } : {}),
    }),
    content: compactContent({
      text,
      media_id: typeof payload.video_id === "string" ? payload.video_id : undefined,
      media_url: typeof payload.video_url === "string" ? payload.video_url : page.url,
    }),
    facts: jsonFacts({
      ...payload,
      visit_id: state.visitId,
      tab_id: tab.id,
      window_id: tab.windowId,
    }),
  });
}

function youtubeObservationSchema(value: unknown): string | undefined {
  const schemaName = typeof value === "string" ? value : "";
  return [
    "observation.youtube.caption_state",
    "observation.youtube.caption_fragment",
    "observation.youtube.paused",
    "observation.youtube.played",
  ].includes(schemaName) ? schemaName : undefined;
}

function youtubeObservationText(schemaName: string, payload: Record<string, unknown>) {
  if (schemaName === "observation.youtube.caption_fragment") {
    return String(payload.caption_text ?? payload.subtitle_text ?? "").slice(0, 4000) || undefined;
  }
  if (schemaName === "observation.youtube.caption_state") {
    return `captions ${payload.enabled || payload.captions_enabled ? "enabled" : "disabled"}`;
  }
  if (schemaName === "observation.youtube.paused") return `paused at ${payload.current_time ?? payload.current_seconds ?? 0}`;
  if (schemaName === "observation.youtube.played") return `played from ${payload.current_time ?? payload.current_seconds ?? 0}`;
  return undefined;
}

async function captureNavigation(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  action: "navigation_committed" | "navigation_history_state",
) {
  await ensureTabStateLoaded();
  if (details.tabId < 0 || !details.documentId) {
    throw new Error(`${action} is missing tab or document identity`);
  }
  const tab = await chrome.tabs.get(details.tabId);
  if (!tab.id || tab.windowId === undefined || !shouldCaptureBrowserTab({ ...tab, url: details.url })) return;
  let state = details.frameId === 0
    ? getTabState(details.tabId, details.url, {
        windowId: tab.windowId,
        documentId: details.documentId,
        frameId: details.frameId,
    })
    : getTabState(details.tabId, tab.url ?? details.url, { windowId: tab.windowId });
  if (details.frameId === 0) {
    await ensureVisit(
      { ...tab, url: details.url },
      action,
      { allow_snapshot: action === "navigation_history_state" },
    );
    state = getTabState(details.tabId, details.url, {
      windowId: tab.windowId,
      documentId: details.documentId,
      frameId: details.frameId,
    });
  }
  state.settings = await getSettings();
  const occurredAt = new Date(details.timeStamp).toISOString();
  const navigationIdentity = browserNavigationIdentity({
    visit_id: state.visitId,
    action,
    document_id: details.documentId,
    frame_id: details.frameId,
    timestamp_ms: details.timeStamp,
  });
  const base = await browserEventBase(
    state,
    tab,
    "navigation",
    action,
    occurredAt,
    `${details.documentId}:${details.frameId}:${Math.trunc(details.timeStamp)}`,
  );
  return submitBrowserCaptureEvent({
    ...base,
    event_id: navigationIdentity.event_id,
    policy: browserPolicyForUrl(details.url, {
      excluded_domains: state.settings.excludedDomains,
      allow_external_model: state.settings.allowExternalLlm,
    }),
    browser: { ...base.browser, document_id: details.documentId, frame_id: details.frameId },
    navigation: {
      navigation_id: navigationIdentity.navigation_id,
      transition: action === "navigation_committed" ? "committed" : "history_state",
      document_id: details.documentId,
      frame_id: details.frameId,
      parent_frame_id: details.parentFrameId,
    },
    page: browserPage({ url: details.url, title: tab.title, domain: new URL(details.url).hostname }),
    content: {},
    facts: jsonFacts({
      transition_type: details.transitionType,
      transition_qualifiers: details.transitionQualifiers,
      frame_type: details.frameType,
    }),
  });
}

async function browserEventBase(
  state: TabState,
  tab: chrome.tabs.Tab | undefined,
  kind: BrowserCaptureEventPayload["kind"],
  action: BrowserCaptureEventPayload["action"],
  occurredAt: string,
  identitySuffix?: string,
) {
  const window = await chrome.windows.get(state.windowId).catch(() => undefined);
  const tabActive = Boolean(tab?.active);
  const windowFocused = Boolean(window?.focused);
  const attention = classifyBrowserAttention({
    tab_active: tabActive,
    window_focused: windowFocused,
    window_state: window?.state,
  });
  const eventIdentity = identitySuffix ?? `${state.visitId}:${action}:${occurredAt}`;
  return {
    version: 1 as const,
    event_id: `browser:${action}:${eventIdentity}`.slice(0, 240),
    kind,
    action,
    occurred_at: new Date(occurredAt).toISOString(),
    captured_at: new Date().toISOString(),
    source: { connector: "chrome-extension" as const, connection_id: "chrome:default" },
    browser: {
      tab_id: state.tabId,
      window_id: state.windowId,
      visit_id: state.visitId,
      attention,
      tab_active: tabActive,
      window_focused: windowFocused,
      ...(state.documentId ? { document_id: state.documentId } : {}),
      ...(state.frameId !== undefined ? { frame_id: state.frameId } : {}),
    },
    policy: browserPolicyForUrl(state.url, {
      excluded_domains: state.settings.excludedDomains,
      allow_external_model: state.settings.allowExternalLlm,
    }),
  };
}

function browserPage(page: PageContext): NonNullable<BrowserCaptureEventPayload["page"]> {
  if (!page.url) throw new Error("Browser Capture page URL is required");
  const url = new URL(page.url);
  const canonical = typeof page.metadata?.canonical_url === "string" && page.metadata.canonical_url
    ? new URL(page.metadata.canonical_url).toString()
    : undefined;
  return {
    url: url.toString(),
    ...(page.title?.trim() ? { title: page.title.trim().slice(0, 500) } : {}),
    domain: url.hostname,
    ...(canonical ? { canonical_url: canonical } : {}),
  };
}

function updateTabStateFromPage(state: TabState, page: PageContext, settings: InfoSettings) {
  if (page.url) {
    state.url = new URL(page.url).toString();
    state.domain = new URL(page.url).hostname;
  }
  state.title = page.title;
  state.privacy = privacyForUrl(page.url ?? state.url, settings);
}

function compactContent(input: BrowserCaptureEventPayload["content"]): BrowserCaptureEventPayload["content"] {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as BrowserCaptureEventPayload["content"];
}

function jsonFacts(input: Record<string, unknown>): BrowserCaptureEventPayload["facts"] {
  return JSON.parse(JSON.stringify(input)) as BrowserCaptureEventPayload["facts"];
}

async function submitBrowserCaptureEvent(input: unknown) {
  const settings = await getSettings();
  const event = buildBrowserCaptureEvent(input);
  const endpoint = browserCaptureEndpoint(settings.endpoint);
  const result = await deliverBrowserCaptureEvent({
    event,
    endpoint,
    outbox: chromeBrowserCaptureOutbox,
    fetch: (url, init) => authenticatedBrowserDaemonFetch(settings, url, init),
  });
  if (!result.ok) {
    console.error(JSON.stringify({
      component: "browser-capture-extension",
      event: "browser_capture.delivery_failed",
      event_id: event.event_id,
      endpoint,
      status: result.status,
      code: result.error?.code,
      attempts: result.failure?.attempts,
    }));
  }
  return {
    ...result,
    endpoint,
    event_id: event.event_id,
    action: event.action,
  };
}

function legacyContextRecord(input: {
  schemaName: string;
  page: PageContext;
  state: TabState;
  contentText?: string;
  acquisitionMode: "passive" | "manual";
  reason: string;
  importance: number;
  payload: Record<string, unknown>;
}) {
  const privacy = privacyForUrl(input.page.url, input.state.settings);
  input.state.privacy = privacy;
  input.state.title = input.page.title;
  input.state.domain = input.page.domain ?? "";
  return {
    schema: { name: input.schemaName, version: 1 },
    source: { type: "browser", connector: "chrome-acp" },
    scope: { domain: input.page.domain, app: "chrome" },
    time: { observed_at: input.page.observed_at, captured_at: new Date().toISOString() },
    content: { title: input.page.title, url: input.page.url, text: input.contentText },
    acquisition: { mode: input.acquisitionMode, actor: "user", reason: input.reason },
    signal: { importance: input.importance, confidence: 0.9, status: input.schemaName === "observation.browser_page_saved" ? "accepted" : "inbox" },
    privacy,
    payload: input.payload,
  };
}

async function postLegacyRecord(record: any, options: { process?: boolean; cascadeViews?: boolean } = {}) {
  if (record.privacy?.retention === "do_not_store") {
    return { ok: true, stored: false, reason: "privacy do_not_store", schema: record.schema.name };
  }
  const settings = await getSettings();
  const endpoint = contextIngestEndpoint(settings, options);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      await recordCaptureFailure(record, endpoint, `HTTP ${response.status}`, body);
    }
    return { ok: response.ok, status: response.status, body, schema: record.schema.name, endpoint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordCaptureFailure(record, endpoint, message);
    return { ok: false, status: 0, error: message, schema: record.schema.name, endpoint };
  }
}

const chromeBrowserCaptureOutbox: BrowserCaptureOutbox & { list(): Promise<BrowserCaptureTransportFailure[]> } = new SerializedBrowserCaptureOutbox({
  async read() {
    const stored = await chrome.storage.local.get(BROWSER_CAPTURE_OUTBOX_KEY);
    return stored[BROWSER_CAPTURE_OUTBOX_KEY];
  },
  async write(records) {
    await chrome.storage.local.set({ [BROWSER_CAPTURE_OUTBOX_KEY]: records });
  },
});

async function retryBrowserCaptureFailure(id: string) {
  const settings = await getSettings();
  const failure = (await listBrowserCaptureFailures()).find(item => item.id === id && item.status === "pending");
  if (!failure) throw new Error(`Pending Browser Capture transport failure is missing: ${id}`);
  const result = await retryBrowserCaptureTransportFailure({
    failure,
    outbox: chromeBrowserCaptureOutbox,
    fetch: (url, init) => authenticatedBrowserDaemonFetch(settings, url, init),
  });
  return { ...result, event_id: failure.event.event_id, failure_id: failure.id };
}

async function listBrowserCaptureFailures(): Promise<BrowserCaptureTransportFailure[]> {
  return chromeBrowserCaptureOutbox.list();
}

async function authenticatedBrowserDaemonFetch(
  settings: InfoSettings,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!isValidOperationAuthToken(settings.operationAuthToken)) {
    throw new BrowserOperationAccessError(
      "operation_auth_configuration_required",
      "A valid resident daemon Operation token is required",
    );
  }
  return authorizedBrowserDaemonFetch({
    endpoint: new URL(settings.endpoint).origin,
    token: settings.operationAuthToken,
    request: input,
    init,
  });
}

function reportCaptureTaskFailure(stage: string, error: unknown, details: Record<string, unknown>) {
  console.error(JSON.stringify({
    component: "browser-capture-extension",
    event: "browser_capture.task_failed",
    stage,
    error: error instanceof Error ? error.message : String(error),
    ...details,
  }));
}

async function recordCaptureFailure(record: any, endpoint: string, message: string, response?: unknown) {
  const failure = {
    id: crypto.randomUUID(),
    failed_at: new Date().toISOString(),
    endpoint,
    schema: record?.schema?.name,
    observed_at: record?.time?.observed_at,
    source_id: record?.source?.id,
    message,
    response,
  };
  console.error("[info-capture] ingest failed", failure);
  try {
    const stored = await chrome.storage.local.get("infoCaptureDeadLetters");
    const current = Array.isArray(stored.infoCaptureDeadLetters) ? stored.infoCaptureDeadLetters : [];
    await chrome.storage.local.set({ infoCaptureDeadLetters: [...current.slice(-99), failure] });
  } catch (error) {
    console.error("[info-capture] failed to persist dead letter", error, failure);
  }
}

async function recordAutomationFailure(event: any, endpoint: string, message: string, response?: unknown) {
  const failure = {
    id: crypto.randomUUID(),
    failed_at: new Date().toISOString(),
    endpoint,
    event_id: event?.event_id,
    navigation_id: event?.navigation_id,
    url: event?.url,
    message,
    response,
  };
  console.error("[info-capture] Browser Automation failed", failure);
  try {
    const stored = await chrome.storage.local.get("infoAutomationDeadLetters");
    const current = Array.isArray(stored.infoAutomationDeadLetters) ? stored.infoAutomationDeadLetters : [];
    await chrome.storage.local.set({ infoAutomationDeadLetters: [...current.slice(-99), failure] });
  } catch (error) {
    console.error("[info-capture] failed to persist Automation dead letter", error, failure);
  }
}

async function postWritingAssistRecord(record: any) {
  if (record.privacy?.retention === "do_not_store") {
    return { ok: true, stored: false, reason: "privacy do_not_store", schema: record.schema.name };
  }
  const settings = await getSettings();
  const endpoint = writingAssistEndpoint(settings);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body, schema: record.schema.name, endpoint };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), schema: record.schema.name, endpoint };
  }
}

async function fetchViews(viewIds: string[]) {
  const settings = await getSettings();
  const views = [];
  for (const id of viewIds) {
    const endpoint = contextViewEndpoint(settings, id);
    try {
      const response = await fetch(endpoint);
      const body = await response.json().catch(() => ({}));
      views.push({ ok: response.ok, status: response.status, body, view: body.view, endpoint });
    } catch (error) {
      views.push({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error), endpoint });
    }
  }
  return views;
}

async function pollContextViews(message: any) {
  const settings = await getSettings();
  const endpoint = contextViewsEndpoint(settings, {
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
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), endpoint };
  }
}

function shouldUseAgentTasksEndpoint(message: any) {
  const prefix = typeof message.viewTypePrefix === "string" ? message.viewTypePrefix : undefined;
  const types = Array.isArray(message.viewTypes) ? message.viewTypes : [];
  if (prefix === "agent." || prefix === "task.") return true;
  return types.some((type: unknown) => type === "agent.task_list" || type === "task.background_research");
}

async function pollAgentTasks(message: any) {
  const settings = await getSettings();
  const endpoint = agentTasksEndpoint(settings, { limit: message.limit ?? 8, refresh: message.refresh !== false });
  try {
    const response = await fetch(endpoint);
    const body = await response.json().catch(() => ({}));
    const taskList = body?.task_list ?? {};
    const taskViews = Array.isArray(taskList.items) ? taskList.items : [];
    return {
      ok: response.ok && Boolean(body.ok),
      status: response.status,
      endpoint,
      ...body,
      views: Array.isArray(body.views) ? body.views : [body.view, ...taskViews].filter(Boolean),
    };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), endpoint };
  }
}

async function runAgentTasksAction(message: any) {
  const settings = await getSettings();
  const endpoint = agentTasksEndpoint(settings);
  const request: Record<string, unknown> = {
    mode: message.mode === "process" || message.mode === "queue_and_process" ? message.mode : "queue",
  };
  if (typeof message.runtime === "string" && message.runtime.trim()) request.runtime = message.runtime.trim();
  if (typeof message.limit === "number" && Number.isFinite(message.limit)) request.limit = message.limit;
  if (typeof message.dryRun === "boolean") request.dry_run = message.dryRun;
  if (typeof message.write === "boolean") request.write = message.write;
  if (typeof message.autonomy === "string" && message.autonomy.trim()) request.autonomy = message.autonomy.trim();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && Boolean(body.ok), status: response.status, endpoint, request, ...body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), endpoint, request };
  }
}

async function updateAgentTask(message: any) {
  if (typeof message.taskId !== "string" || !message.taskId.trim()) return { ok: false, error: "taskId is required" };
  const settings = await getSettings();
  const endpoint = agentTaskActionEndpoint(settings, message.taskId);
  const request: Record<string, unknown> = {
    action: message.action === "retry" ? "retry" : message.action === "cancel" ? "cancel" : undefined,
  };
  if (!request.action) return { ok: false, error: "action must be cancel or retry" };
  if (typeof message.reason === "string" && message.reason.trim()) request.reason = message.reason.trim();
  request.actor = "chrome_acp";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && Boolean(body.ok), status: response.status, endpoint, request, ...body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), endpoint, request };
  }
}

async function postViewFeedback(message: any) {
  if (!message.viewId || !message.feedbackType) return { ok: false, error: "viewId and feedbackType are required" };
  const settings = await getSettings();
  const endpoint = feedbackEndpoint(settings);
  const payload = {
    type: message.feedbackType,
    application_id: message.applicationId || "chrome_acp",
    view_id: message.viewId,
    value: message.value,
    reason: message.reason,
    payload: {
      surface: message.surface || "chrome_acp",
      ...(message.viewType ? { target_view_type: message.viewType } : {}),
      ...(message.payload ?? {}),
    },
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && Boolean(body.ok), status: response.status, endpoint, payload, ...body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), endpoint, payload };
  }
}

async function collectFromTab(tabId: number): Promise<PageContext> {
  return await chrome.tabs.sendMessage(tabId, { type: "collect-page-context" }, { frameId: 0 });
}

function basicPageFromTab(tab: chrome.tabs.Tab): PageContext {
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
  const tabs = await getCurrentCandidateTabs();
  return tabs[0];
}

async function getHeartbeatTabs(): Promise<chrome.tabs.Tab[]> {
  return (await getCurrentCandidateTabs()).filter(shouldCaptureBrowserTab).slice(0, 1);
}

async function getCurrentCandidateTabs(): Promise<chrome.tabs.Tab[]> {
  const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (!focusedWindow?.focused || focusedWindow.state === "minimized" || focusedWindow.id === undefined) return [];
  return (await chrome.tabs.query({ active: true, windowId: focusedWindow.id }).catch(() => []))
    .filter(tab => tab?.id && tab.url)
    .sort((a, b) => tabCaptureScore(b) - tabCaptureScore(a));
}

function dedupeTabs(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
  const seen = new Set<number>();
  const result: chrome.tabs.Tab[] = [];
  for (const tab of tabs) {
    if (!tab?.id || seen.has(tab.id)) continue;
    seen.add(tab.id);
    result.push(tab);
  }
  return result;
}

function shouldCaptureBrowserTab(tab: chrome.tabs.Tab): boolean {
  const url = tab.url || "";
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (isMetaflowSelfUrl(parsed)) return false;
  if (isBrowserChromeNoiseUrl(parsed)) return false;
  return true;
}

function isMetaflowSelfUrl(url: URL): boolean {
  return ["localhost", "127.0.0.1"].includes(url.hostname) && ["5177", "5173"].includes(url.port);
}

function isBrowserChromeNoiseUrl(url: URL): boolean {
  const host = url.hostname;
  return host === "ogs.google.com"
    || host === "tpc.googlesyndication.com"
    || host.endsWith(".gstatic.com")
    || host.endsWith(".googleusercontent.com");
}

function tabCaptureScore(tab: chrome.tabs.Tab): number {
  const url = tab.url || "";
  const title = tab.title || "";
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch {}
  let score = 0;
  if (tab.active) score += 20;
  if (tab.highlighted) score += 5;
  if (parsed?.hostname.includes("youtube.com") && parsed.pathname === "/watch") score += 80;
  if (parsed?.hostname === "youtu.be") score += 70;
  if (title.trim()) score += 4;
  if (parsed && !isBrowserChromeNoiseUrl(parsed)) score += 6;
  if (parsed && isMetaflowSelfUrl(parsed)) score -= 200;
  return score;
}

async function getSettings(): Promise<InfoSettings> {
  await ensureTrustedOperationStorageAccess();
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof InfoSettings>;
  return resolveInfoCaptureSettings(await chrome.storage.local.get(keys));
}

export function publicInfoSettings(settings: InfoSettings) {
  const { operationAuthToken, ...publicSettings } = settings;
  return {
    ...publicSettings,
    operationAuthConfigured: isValidOperationAuthToken(operationAuthToken),
  };
}

function getTabState(
  tabId: number,
  url: string,
  options: { markActivated?: boolean; windowId?: number; documentId?: string; frameId?: number } = {},
): TabState {
  const now = Date.now();
  const resolved = resolveBrowserVisitState({
    existing: tabState.get(tabId),
    tab_id: tabId,
    window_id: options.windowId ?? tabState.get(tabId)?.windowId ?? 0,
    url,
    ...(options.documentId ? { document_id: options.documentId } : {}),
    ...(options.frameId !== undefined ? { frame_id: options.frameId } : {}),
    mark_activated: options.markActivated,
    now_ms: now,
    now_iso: new Date(now).toISOString(),
    id_factory: () => crypto.randomUUID(),
  });
  const state: TabState = { ...resolved.state, settings: tabState.get(tabId)?.settings ?? DEFAULT_SETTINGS };
  tabState.set(tabId, state);
  return state;
}

async function ensureTabStateLoaded() {
  if (!tabStateReady) {
    tabStateReady = (async () => {
      const stored = await chrome.storage.session.get(BROWSER_TAB_STATE_KEY);
      for (const persisted of parsePersistedBrowserTabStates(stored[BROWSER_TAB_STATE_KEY])) {
        tabState.set(persisted.tabId, { ...persisted, settings: DEFAULT_SETTINGS });
      }
    })();
  }
  await tabStateReady;
}

async function persistTabStates() {
  await chrome.storage.session.set({
    [BROWSER_TAB_STATE_KEY]: [...tabState.values()].map(({ settings: _settings, ...state }) => state),
  });
}

function summarizeState(state?: TabState) {
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

function privacyForUrl(rawUrl?: string, settings: InfoSettings = DEFAULT_SETTINGS) {
  let u: URL;
  try { u = new URL(rawUrl || ""); } catch { return secretPrivacy(); }
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

function contextIngestEndpoint(settings: InfoSettings, options: { process?: boolean; cascadeViews?: boolean }) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = "/context/ingest";
  url.search = "";
  if (options.process) url.searchParams.set("process", "true");
  if (options.cascadeViews) url.searchParams.set("cascade_views", "true");
  return url.toString();
}

function contextViewEndpoint(settings: InfoSettings, viewId: string) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = `/context/views/${encodeURIComponent(viewId)}`;
  url.search = "";
  return url.toString();
}

function writingAssistEndpoint(settings: InfoSettings) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = "/writing/assist";
  url.search = "";
  return url.toString();
}

function contextChatEndpoint(settings: InfoSettings) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = "/context/chat";
  url.search = "";
  return url.toString();
}

function contextViewsEndpoint(settings: InfoSettings, options: any = {}) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = "/context/views";
  url.search = "";
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (Array.isArray(options.viewTypes) && options.viewTypes.length) url.searchParams.set("view_types", options.viewTypes.join(","));
  if (options.viewTypePrefix) url.searchParams.set("view_type_prefix", options.viewTypePrefix);
  if (options.summaryOnly || options.viewTypePrefix) url.searchParams.set("summary_only", "true");
  if (options.activeOnly) url.searchParams.set("active_only", "true");
  if (options.cursor) url.searchParams.set("cursor", options.cursor);
  if (options.query) url.searchParams.set("query", options.query);
  if (options.sourceRecordId) url.searchParams.set("source_record_id", options.sourceRecordId);
  return url.toString();
}

function agentTasksEndpoint(settings: InfoSettings, options: any = {}) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = "/agent/tasks";
  url.search = "";
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.refresh) url.searchParams.set("refresh", "true");
  return url.toString();
}

function agentTaskActionEndpoint(settings: InfoSettings, taskId: string) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = `/agent/tasks/${encodeURIComponent(taskId)}`;
  url.search = "";
  return url.toString();
}

function feedbackEndpoint(settings: InfoSettings) {
  const url = new URL(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  url.pathname = "/feedback";
  url.search = "process=true";
  return url.toString();
}

function viewIdsFromProcessedIngestResponse(body: any) {
  const direct = Array.isArray(body?.written_views) ? body.written_views : [];
  const firstPass = Array.isArray(body?.processing?.runs)
    ? body.processing.runs.flatMap((run: any) => Array.isArray(run?.written_views) ? run.written_views : [])
    : [];
  const cascaded = Array.isArray(body?.cascade_processing)
    ? body.cascade_processing.flatMap((processing: any) =>
        Array.isArray(processing?.runs)
          ? processing.runs.flatMap((run: any) => Array.isArray(run?.written_views) ? run.written_views : [])
          : [],
      )
    : [];
  return [...new Set([...direct, ...firstPass, ...cascaded].filter((id): id is string => typeof id === "string" && Boolean(id)))];
}

export type BrowserAutomationMessage = {
  event_id?: unknown;
  navigation_id?: unknown;
  reason_kind?: unknown;
  dwell_ms?: unknown;
  scroll_depth?: unknown;
  scroll_events?: unknown;
  selection_count?: unknown;
  dom?: unknown;
};

export type BrowserAutomationPage = {
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
  dom?: unknown;
};

export type BrowserDeliveryAction = "accept" | "dismiss" | "later" | "cancel" | "retry" | "correct";

export function buildBrowserAutomationEvent(input: {
  message: BrowserAutomationMessage;
  tab: { id: number; windowId?: number; url: string; title?: string };
  page: BrowserAutomationPage;
  visit_id: string;
  started_at_ms: number;
  privacy: {
    level?: unknown;
    retention?: unknown;
    allow_external_llm?: unknown;
    allow_embedding?: unknown;
  };
  now: string;
  id_factory: () => string;
}) {
  const url = input.page.url ?? input.tab.url;
  const pageText = input.page.text?.trim();
  if (!pageText) throw new Error("current page has no capturable text");
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("Browser Automation event now must be a valid timestamp");
  const parsedUrl = new URL(url);
  const message = input.message;
  return {
    version: 1 as const,
    event_id: typeof message.event_id === "string" && message.event_id ? message.event_id : input.id_factory(),
    navigation_id: typeof message.navigation_id === "string" && message.navigation_id ? message.navigation_id : input.visit_id,
    tab_id: input.tab.id,
    window_id: input.tab.windowId,
    occurred_at: input.page.observed_at ?? input.now,
    captured_at: input.now,
    reason: automationReason(message.reason_kind),
    url,
    title: input.page.title ?? input.tab.title ?? url,
    domain: input.page.domain ?? parsedUrl.hostname,
    dwell_ms: nonNegativeInteger(message.dwell_ms, nowMs - input.started_at_ms),
    scroll_depth: boundedNumber(message.scroll_depth, input.page.scroll_depth ?? 0, 0, 1),
    scroll_events: nonNegativeInteger(message.scroll_events, input.page.scroll_events ?? 0),
    selection_count: nonNegativeInteger(message.selection_count, input.page.selection_count ?? 0),
    dom: normalizeAutomationDom(url, message.dom ?? input.page.dom),
    page: {
      text: pageText,
      ...(input.page.selected_text?.trim() ? { selected_text: input.page.selected_text.trim() } : {}),
      metadata: input.page.metadata ?? {},
      text_quality: input.page.text_quality ?? {},
    },
    source: { connector: "chrome-extension", connection_id: "chrome:default" },
    policy: {
      owner: "user:local",
      visibility: "private" as const,
      privacy: input.privacy.level === "secret" ? "sensitive" as const : "private" as const,
      retention: normalizedRetention(input.privacy.retention),
      allow_external_model: input.privacy.allow_external_llm === true,
      allow_embedding: input.privacy.allow_embedding === true,
      labels: [],
    },
  };
}

export function browserAutomationEndpoint(captureEndpoint: string): string {
  const url = new URL(captureEndpoint);
  url.pathname = "/automation/v1/browser-signals";
  url.search = "";
  return url.toString();
}

export function browserDeliveriesEndpoint(
  captureEndpoint: string,
  input: { after?: string; limit?: number } = {},
): string {
  const url = new URL(captureEndpoint);
  url.pathname = "/automation/v1/browser-deliveries";
  url.search = "";
  if (input.after) url.searchParams.set("after", input.after);
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("Browser delivery limit must be an integer between 1 and 1000");
    }
    url.searchParams.set("limit", String(input.limit));
  }
  return url.toString();
}

export function browserInteractionEndpoint(captureEndpoint: string): string {
  const url = new URL(captureEndpoint);
  url.pathname = "/automation/v1/browser-interactions";
  url.search = "";
  return url.toString();
}

export function browserExactViewEndpoint(captureEndpoint: string, ref: { view_id: string; revision: number }): string {
  if (!ref.view_id.trim()) throw new Error("exact View id is required");
  if (!Number.isInteger(ref.revision) || ref.revision < 1) throw new Error("exact View revision must be positive");
  const url = new URL(captureEndpoint);
  url.pathname = `/context/v1/views/${encodeURIComponent(ref.view_id)}`;
  url.search = "";
  url.searchParams.set("revision", String(ref.revision));
  return url.toString();
}

export function buildBrowserDeliveryInteraction(input: {
  request_id: string;
  delivery_id: string;
  action: BrowserDeliveryAction;
  snooze_until?: string;
  correction?: string;
  metadata?: Record<string, unknown>;
  now: string;
  id_factory: () => string;
}) {
  return {
    id: input.id_factory(),
    request_id: input.request_id,
    delivery_id: input.delivery_id,
    surface: "browser" as const,
    action: input.action,
    occurred_at: input.now,
    actor: "user:local",
    ...(input.snooze_until ? { snooze_until: input.snooze_until } : {}),
    ...(input.correction?.trim() ? { correction: input.correction.trim() } : {}),
    metadata: input.metadata ?? {},
  };
}

function automationReason(value: unknown): "dwell" | "selection" | "dom" | "manual" {
  return value === "dwell" || value === "selection" || value === "dom" ? value : "manual";
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : fallback;
  return Math.max(0, Math.round(Number.isFinite(number) ? number : fallback));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizedRetention(value: unknown): "do_not_store" | "session" | "normal" | "archive" {
  return value === "do_not_store" || value === "session" || value === "archive" ? value : "normal";
}

function normalizeAutomationDom(rawUrl: string, input: unknown) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const parsed = new URL(rawUrl);
  const path = parsed.pathname.split("/").filter(Boolean);
  const githubRepository = parsed.hostname === "github.com" && path.length >= 2 && value.github_repository === true;
  const markers = value.markers && typeof value.markers === "object" && !Array.isArray(value.markers)
    ? value.markers as Record<string, unknown>
    : {};
  return {
    github_repository: githubRepository,
    ...(githubRepository ? {
      repository_owner: typeof value.repository_owner === "string" && value.repository_owner ? value.repository_owner : path[0],
      repository_name: typeof value.repository_name === "string" && value.repository_name ? value.repository_name : path[1],
    } : {}),
    markers,
  };
}

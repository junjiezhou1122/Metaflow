import { createHash } from "node:crypto";
import {
  CaptureBatchSchema,
  ConnectorManifestSchema,
  ConnectorProtocolError,
  SourceConnectionSchema,
  type CaptureBatch,
  type ConnectorPort,
  type ConnectorRuntime,
  type RawViewCandidate,
  type SourceConnection,
} from "@info/capture";
import {
  canonicalJson,
  type JsonObject,
  type ViewSearchProjection,
  type ViewPolicy,
  type ViewRepresentation,
} from "@info/view";
import {
  BrowserAutomationEvidenceSchema,
  BrowserCaptureAdapterError,
  type BrowserCaptureEvent,
  type BrowserCapturedView,
  type BrowserCaptureSubmission,
  parseBrowserCaptureEvent,
} from "./contracts.js";

const BROWSER_SEARCH_PROJECTION: ViewSearchProjection = {
  version: 1,
  fields: [
    { path: "/name", category: "title" },
    { path: "/aliases/*", category: "url" },
    { path: "/representation/uri", category: "url" },
    { path: "/representation/value/page/title", category: "title" },
    { path: "/representation/value/page/url", category: "url" },
    { path: "/representation/value/page/canonical_url", category: "url" },
    { path: "/representation/value/content/text", category: "text" },
    { path: "/representation/value/content/selected_text", category: "text" },
    { path: "/representation/value/content/query", category: "text" },
    { path: "/representation/value/content/media_url", category: "url" },
    { path: "/time/observed_at", category: "timestamp" },
    { path: "/provenance/capture/connector", category: "provenance" },
    { path: "/provenance/capture/connection_id", category: "provenance" },
    { path: "/provenance/capture/source_id", category: "provenance" },
    { path: "/provenance/capture/source_kind", category: "provenance" },
  ],
};

function browserSchema(name: string) {
  return { name, version: 1 as const, mode: "freeform" as const, search_projection: BROWSER_SEARCH_PROJECTION };
}

export const BROWSER_CONNECTOR_MANIFEST = ConnectorManifestSchema.parse({
  id: "chrome-extension",
  version: "1.0.0",
  display_name: "Metaflow Chrome Extension",
  protocols: ["webhook"],
  capabilities: ["push", "page", "navigation", "selection", "media", "interaction"],
  delivery_kinds: ["push"],
  emitted_schemas: [
    browserSchema("capture.browser.page_snapshot"),
    browserSchema("capture.browser.save"),
    browserSchema("capture.browser.navigation"),
    browserSchema("capture.browser.selection"),
    browserSchema("capture.browser.media_caption_segment"),
    browserSchema("capture.browser.media_caption_state"),
    browserSchema("capture.browser.media_playback"),
    browserSchema("capture.browser.interaction"),
  ],
});

export class BrowserPushConnector implements ConnectorPort {
  readonly manifest = BROWSER_CONNECTOR_MANIFEST;

  async health(): Promise<{ capabilities: string[] }> {
    return { capabilities: [...this.manifest.capabilities] };
  }

  async *open(): AsyncIterable<CaptureBatch> {
    throw new ConnectorProtocolError("Browser Connector supports push delivery only");
  }
}

export function browserSourceConnection(input: {
  id?: string;
  privacy?: ViewPolicy;
} = {}): SourceConnection {
  return SourceConnectionSchema.parse({
    id: input.id ?? "chrome:default",
    connector_id: BROWSER_CONNECTOR_MANIFEST.id,
    connector_version: BROWSER_CONNECTOR_MANIFEST.version,
    display_name: "Chrome extension",
    enabled: true,
    delivery_kinds: ["push"],
    secret_refs: [],
    configuration: {},
    privacy: input.privacy ?? privatePolicy(),
  });
}

export class BrowserCaptureController {
  constructor(private readonly runtime: Pick<ConnectorRuntime, "submitBatch">) {}

  async submit(input: unknown): Promise<BrowserCaptureSubmission> {
    const event = parseBrowserCaptureEvent(input);
    const planned = browserCaptureBatch(event);
    const result = await this.runtime.submitBatch(planned.batch);
    const captured: BrowserCapturedView[] = [];
    const skipped: BrowserCaptureSubmission["skipped"] = [];
    result.receipts.forEach((receipt, index) => {
      const role = planned.roles[index];
      if (!role) throw new BrowserCaptureAdapterError("Browser Capture receipt has no matching role", "browser_capture_protocol_error");
      if (receipt.status === "stored") {
        captured.push({ role, ref: { view_id: receipt.view_id, revision: receipt.revision }, created: receipt.created });
      } else {
        skipped.push({ role, reason: receipt.reason });
      }
    });
    return {
      status: captured.length > 0 ? "stored" : "skipped",
      event_id: event.event_id,
      batch_id: planned.batch.id,
      captured_views: captured,
      skipped,
      checkpoint: result.checkpoint,
      replayed: result.replayed,
      transaction_id: result.transaction_id,
    };
  }

  async submitAutomationEvidence(input: unknown): Promise<{
    captured_views: Array<{ role: "current_page" | "current_selection"; ref: BrowserCapturedView["ref"]; created: boolean }>;
  }> {
    const evidence = BrowserAutomationEvidenceSchema.parse(input);
    const event = parseBrowserCaptureEvent({
      version: 1,
      event_id: evidence.event_id,
      kind: "page",
      action: "page_snapshot",
      occurred_at: evidence.occurred_at,
      captured_at: evidence.captured_at,
      source: { connector: "chrome-extension", connection_id: evidence.source.connection_id },
      browser: {
        tab_id: evidence.tab_id,
        window_id: evidence.window_id ?? 0,
        visit_id: evidence.navigation_id,
        attention: "focused",
        tab_active: true,
        window_focused: true,
        frame_id: 0,
      },
      page: {
        url: evidence.url,
        title: evidence.title,
        domain: evidence.domain,
        ...(typeof evidence.page.metadata.canonical_url === "string"
          ? { canonical_url: evidence.page.metadata.canonical_url }
          : {}),
      },
      content: {
        text: evidence.page.text,
        ...(evidence.page.selected_text ? { selected_text: evidence.page.selected_text } : {}),
      },
      facts: {
        navigation_id: evidence.navigation_id,
        tab_id: evidence.tab_id,
        ...(evidence.window_id !== undefined ? { window_id: evidence.window_id } : {}),
        reason: evidence.reason,
        dwell_ms: evidence.dwell_ms,
        scroll_depth: evidence.scroll_depth,
        scroll_events: evidence.scroll_events,
        selection_count: evidence.selection_count,
        dom: evidence.dom,
        text_quality: evidence.page.text_quality,
      },
      policy: evidence.policy,
    });
    const result = await this.submit(event);
    if (result.status !== "stored") {
      throw new BrowserCaptureAdapterError(
        "Browser Automation requires stored exact evidence",
        "browser_capture_protocol_error",
        { event_id: evidence.event_id, skipped: result.skipped },
      );
    }
    return {
      captured_views: result.captured_views.map(item => ({
        role: item.role === "selection" ? "current_selection" as const : "current_page" as const,
        ref: item.ref,
        created: item.created,
      })),
    };
  }
}

export async function configureBrowserCapture(input: {
  runtime: ConnectorRuntime;
  connector?: BrowserPushConnector;
  connection?: SourceConnection;
}): Promise<BrowserCaptureController> {
  const connector = input.connector ?? new BrowserPushConnector();
  const connection = input.connection ?? browserSourceConnection();
  input.runtime.registerConnector(connector);
  await input.runtime.registerConnection(connection);
  return new BrowserCaptureController(input.runtime);
}

export function browserCaptureBatch(event: BrowserCaptureEvent): {
  batch: CaptureBatch;
  roles: BrowserCapturedView["role"][];
} {
  const candidates = candidatesFor(event);
  const eventKey = digest(event.event_id);
  return {
    roles: candidates.map(item => item.role),
    batch: CaptureBatchSchema.parse({
      id: `browser-batch:${eventKey}`,
      idempotency_key: `browser-delivery:${eventKey}`,
      connector: { id: BROWSER_CONNECTOR_MANIFEST.id, version: BROWSER_CONNECTOR_MANIFEST.version },
      connection_id: event.source.connection_id,
      delivery: "push",
      sequence: Math.max(1, Date.parse(event.occurred_at)),
      candidates: candidates.map(item => item.candidate),
      created_at: event.captured_at,
      metadata: { event_id: event.event_id, kind: event.kind, action: event.action },
    }),
  };
}

function candidatesFor(event: BrowserCaptureEvent): Array<{
  role: BrowserCapturedView["role"];
  candidate: RawViewCandidate;
}> {
  const candidates: Array<{ role: BrowserCapturedView["role"]; candidate: RawViewCandidate }> = [
    { role: event.kind, candidate: candidateFor(event, event.kind) },
  ];
  if (event.action === "page_saved") {
    candidates.push({ role: "save", candidate: candidateFor(event, "save") });
  }
  if (event.kind === "page" && event.content.selected_text) {
    candidates.push({ role: "selection", candidate: candidateFor(event, "selection") });
  }
  return candidates;
}

function candidateFor(
  event: BrowserCaptureEvent,
  role: BrowserCapturedView["role"],
): RawViewCandidate {
  const stable = isStableBrowserSource(event, role);
  const sourceIdentity = stable ? stableSourceIdentity(event, role) : `event:${event.event_id}:${role}`;
  const schemaName = schemaNameFor(event, role);
  const body: JsonObject = {
    action: role === "selection" && event.kind === "page" ? "selection" : event.action,
    ...(event.page ? { page: event.page } : {}),
    browser: event.browser,
    ...(event.navigation ? { navigation: event.navigation } : {}),
    content: role === "selection"
      ? { selected_text: event.content.selected_text! }
      : role === "save"
        ? { ...(event.content.selected_text ? { selected_text: event.content.selected_text } : {}) }
      : event.content,
    facts: event.facts,
  };
  const hasPageText = role === "page" && Boolean(event.content.text);
  const representation: ViewRepresentation = role === "page" && !hasPageText
    ? {
        form: "external_reference" as const,
        kind: "web_page",
        uri: event.page!.canonical_url ?? event.page!.url,
        media_type: "text/html",
        metadata: { action: event.action, facts: event.facts, browser: event.browser },
      }
    : {
        form: "inline" as const,
        kind: role === "selection" ? "selection" : role === "save" ? "user_intent" : role,
        media_type: "application/json",
        value: body,
        metadata: role === "media" && event.content.media_url
          ? { external_media_ref: event.content.media_url }
          : {},
      };
  return {
    idempotency_key: `browser-candidate:${digest(event.event_id)}:${role}`,
    name: candidateName(event, role),
    purpose: `Captured Browser ${role} evidence`,
    aliases: event.page ? [event.page.canonical_url ?? event.page.url] : [],
    schema: browserSchema(schemaName),
    observed_at: event.occurred_at,
    captured_at: event.captured_at,
    source: {
      connector: BROWSER_CONNECTOR_MANIFEST.id,
      connection_id: event.source.connection_id,
      source_id: sourceIdentity,
      source_kind: sourceKindFor(event, role),
      identity: stable ? "stable_source" : "occurrence",
      assertion: "direct",
    },
    representation,
    policy: event.policy,
    relations: [],
    metadata: { browser_event_id: event.event_id, action: event.action },
  };
}

function stableSourceIdentity(event: BrowserCaptureEvent, role: BrowserCapturedView["role"]): string {
  if (role === "page") {
    if (!event.page) throw new BrowserCaptureAdapterError("page identity requires page context", "browser_capture_protocol_error");
    return `page:${digest(normalizedUrl(event.page.canonical_url ?? event.page.url))}`;
  }
  if (role !== "media") {
    throw new BrowserCaptureAdapterError(`unsupported stable Browser source role: ${role}`, "browser_capture_protocol_error");
  }
  const media = event.content.media_id ?? event.content.media_url ?? event.page?.canonical_url ?? event.page?.url;
  if (!media) throw new BrowserCaptureAdapterError("media identity is missing", "browser_capture_protocol_error");
  if (event.action === "media_caption") {
    const segment = String(event.facts.segment_id ?? `${String(event.facts.start_seconds ?? "")}:${String(event.facts.end_seconds ?? "")}`);
    return `media-caption:${digest(`${media}:${segment}`)}`;
  }
  if (event.action === "media_caption_state") return `media-caption-state:${digest(media)}`;
  throw new BrowserCaptureAdapterError(`${event.action} is occurrence media evidence`, "browser_capture_protocol_error");
}

function isStableBrowserSource(event: BrowserCaptureEvent, role: BrowserCapturedView["role"]): boolean {
  if (role === "page") return true;
  return role === "media" && (event.action === "media_caption" || event.action === "media_caption_state");
}

function schemaNameFor(event: BrowserCaptureEvent, role: BrowserCapturedView["role"]): string {
  if (role === "page") return "capture.browser.page_snapshot";
  if (role === "save") return "capture.browser.save";
  if (role !== "media") return `capture.browser.${role}`;
  if (event.action === "media_caption") return "capture.browser.media_caption_segment";
  if (event.action === "media_caption_state") return "capture.browser.media_caption_state";
  return "capture.browser.media_playback";
}

function sourceKindFor(event: BrowserCaptureEvent, role: BrowserCapturedView["role"]): string {
  if (role !== "media") return role;
  if (event.action === "media_caption") return "media_caption_segment";
  if (event.action === "media_caption_state") return "media_caption_state";
  return "media_playback";
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function candidateName(event: BrowserCaptureEvent, role: BrowserCapturedView["role"]): string {
  if (role === "selection") return `Selection from ${event.page?.title ?? event.page?.domain ?? "browser"}`;
  if (role === "page") return event.page?.title ?? event.page?.domain ?? "Browser page";
  if (role === "media") return event.page?.title ?? event.content.media_id ?? "Browser media";
  return `${event.page?.title ?? event.page?.domain ?? "Browser"} ${role}`;
}

function digest(value: unknown): string {
  const input = typeof value === "string" ? value : canonicalJson(value as never);
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function privatePolicy(): ViewPolicy {
  return {
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: true,
    labels: [],
  };
}

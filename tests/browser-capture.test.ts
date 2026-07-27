import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ViewRepositoryError } from "../packages/view/index.ts";
import { CaptureIngress, CaptureRuntimeError, ConnectorRuntime } from "../packages/capture/index.ts";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";
import {
  BrowserCaptureAdapterError,
  browserSourceConnection,
  configureBrowserCapture,
  parseBrowserCaptureEvent,
} from "../packages/adapters/browser-capture/index.ts";
import {
  browserCaptureEndpoint,
  buildBrowserCaptureEvent,
  deliverBrowserCaptureEvent,
  SerializedBrowserCaptureOutbox,
  type BrowserCaptureOutbox,
  type BrowserCaptureTransportFailure,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/browser-capture.ts";
import {
  browserNavigationIdentity,
  browserPolicyForUrl,
  classifyBrowserAttention,
  parsePersistedBrowserTabStates,
  resolveBrowserVisitState,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/browser-capture-state.ts";
import { createAmbientV1HttpHandler } from "../apps/ambient-daemon/http-handler.ts";
import { AmbientOperationAccess } from "../apps/ambient-daemon/operation-access.ts";

test("Browser Capture commits one atomic page/selection batch and advances stable page revisions", async () => {
  const repository = new SqliteViewRepository(":memory:");
  try {
    const ingress = new CaptureIngress({ repository });
    const runtime = new ConnectorRuntime(repository, ingress);
    const controller = await configureBrowserCapture({
      runtime,
      connection: browserSourceConnection({ id: "chrome:profile-1" }),
    });

    const first = await controller.submit(browserEvent());
    assert.equal(first.status, "stored");
    assert.deepEqual(first.captured_views.map(item => item.role), ["page", "selection"]);
    assert.equal(first.checkpoint.revision, 1);
    const page = first.captured_views.find(item => item.role === "page")!;
    const selection = first.captured_views.find(item => item.role === "selection")!;
    assert.equal(page.ref.revision, 1);
    assert.notEqual(page.ref.view_id, selection.ref.view_id);

    const second = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:page:2",
      occurred_at: "2026-07-26T11:00:01.000Z",
      captured_at: "2026-07-26T11:00:01.050Z",
      content: { text: "The page changed after a new commit." },
    });
    const revisedPage = second.captured_views.find(item => item.role === "page")!;
    assert.equal(revisedPage.ref.view_id, page.ref.view_id);
    assert.equal(revisedPage.ref.revision, 2);
    assert.equal((await repository.query({ schema_name: "capture.browser.selection", revisions: "all", limit: 10 })).length, 1);
    assert.deepEqual((await repository.query({ text: "page changed" })).map(view => view.id), [page.ref.view_id]);
    assert.deepEqual((await repository.query({ text: "open source coding agent" })).map(view => view.id), [selection.ref.view_id]);
    assert.deepEqual((await repository.query({ text: "github openai codex" })).map(view => view.schema.name).sort(), [
      "capture.browser.page_snapshot",
      "capture.browser.selection",
    ]);

    const replay = await controller.submit(browserEvent());
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.captured_views, first.captured_views);
    assert.equal(replay.checkpoint.revision, first.checkpoint.revision);

    await assert.rejects(
      controller.submit({ ...browserEvent(), content: { ...browserEvent().content, text: "Conflicting evidence" } }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "idempotency_conflict",
    );
  } finally {
    repository.close();
  }
});

test("Browser Capture distinguishes stable media state from playback occurrences and do_not_store", async () => {
  const repository = new SqliteViewRepository(":memory:");
  try {
    const ingress = new CaptureIngress({ repository });
    const runtime = new ConnectorRuntime(repository, ingress);
    const controller = await configureBrowserCapture({
      runtime,
      connection: browserSourceConnection({ id: "chrome:profile-1" }),
    });

    const navigation = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:navigation:1",
      kind: "navigation",
      action: "navigation_opened",
      content: {},
      navigation: { navigation_id: "navigation:opened:1", transition: "opened", frame_id: 0 },
    });
    const media = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:media:1",
      kind: "media",
      action: "media_played",
      content: { media_id: "youtube:dQw4w9WgXcQ", media_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
    const revisedMedia = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:media:2",
      kind: "media",
      action: "media_paused",
      content: { media_id: "youtube:dQw4w9WgXcQ", media_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      facts: { current_seconds: 42 },
    });
    const interaction = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:interaction:1",
      kind: "interaction",
      action: "interaction_heartbeat",
      content: {},
      facts: { active_seconds: 15, scroll_depth: 0.5 },
    });
    const skipped = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:private:1",
      content: { text: "Never persisted" },
      policy: { ...policy(), retention: "do_not_store" },
    });

    assert.equal(navigation.captured_views[0]?.role, "navigation");
    assert.equal(media.captured_views[0]?.role, "media");
    assert.notEqual(revisedMedia.captured_views[0]?.ref.view_id, media.captured_views[0]?.ref.view_id);
    assert.equal(revisedMedia.captured_views[0]?.ref.revision, 1);
    assert.equal(interaction.captured_views[0]?.role, "interaction");
    const mediaView = await repository.get(media.captured_views[0]!.ref);
    assert.equal(mediaView?.representation.form, "inline");
    assert.match(JSON.stringify(mediaView?.representation.metadata), /youtube\.com/);
    assert.equal(skipped.status, "skipped");
    assert.deepEqual(skipped.skipped, [{ role: "page", reason: "do_not_store" }]);
    assert.equal((await repository.query({ revisions: "all", limit: 20 })).length, 4);
  } finally {
    repository.close();
  }
});

test("Browser Capture gives caption segment and caption state stable but separate identities", async () => {
  const repository = new SqliteViewRepository(":memory:");
  try {
    const controller = await configureBrowserCapture({
      runtime: new ConnectorRuntime(repository, new CaptureIngress({ repository })),
      connection: browserSourceConnection({ id: "chrome:profile-1" }),
    });
    const caption = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:caption:1",
      kind: "media",
      action: "media_caption",
      content: { text: "First caption", media_id: "youtube:video-1", media_url: "https://www.youtube.com/watch?v=video-1" },
      facts: { segment_id: "segment:10:12", start_seconds: 10, end_seconds: 12 },
    });
    const captionRevision = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:caption:2",
      occurred_at: "2026-07-26T11:00:01.000Z",
      captured_at: "2026-07-26T11:00:01.050Z",
      kind: "media",
      action: "media_caption",
      content: { text: "Corrected caption", media_id: "youtube:video-1", media_url: "https://www.youtube.com/watch?v=video-1" },
      facts: { segment_id: "segment:10:12", start_seconds: 10, end_seconds: 12 },
    });
    const captionState = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:caption-state:1",
      kind: "media",
      action: "media_caption_state",
      content: { media_id: "youtube:video-1", media_url: "https://www.youtube.com/watch?v=video-1" },
      facts: { enabled: true },
    });
    assert.equal(captionRevision.captured_views[0]?.ref.view_id, caption.captured_views[0]?.ref.view_id);
    assert.equal(captionRevision.captured_views[0]?.ref.revision, 2);
    assert.notEqual(captionState.captured_views[0]?.ref.view_id, caption.captured_views[0]?.ref.view_id);
    assert.equal((await repository.get(caption.captured_views[0]!.ref))?.schema.name, "capture.browser.media_caption_segment");
    assert.equal((await repository.get(captionState.captured_views[0]!.ref))?.schema.name, "capture.browser.media_caption_state");
  } finally {
    repository.close();
  }
});

test("Browser manual save atomically commits page evidence and one independent intent occurrence", async () => {
  const repository = new SqliteViewRepository(":memory:");
  try {
    const controller = await configureBrowserCapture({
      runtime: new ConnectorRuntime(repository, new CaptureIngress({ repository })),
      connection: browserSourceConnection({ id: "chrome:profile-1" }),
    });
    const saved = await controller.submit({
      ...browserEvent(),
      event_id: "browser-event:manual-save:1",
      action: "page_saved",
      facts: { reason: "Use this for the English learning project", user_intent: "save_current_page" },
    });
    assert.deepEqual(saved.captured_views.map(item => item.role), ["page", "save", "selection"]);
    const page = saved.captured_views.find(item => item.role === "page")!;
    const intent = saved.captured_views.find(item => item.role === "save")!;
    assert.notEqual(page.ref.view_id, intent.ref.view_id);
    assert.equal((await repository.get(page.ref))?.schema.name, "capture.browser.page_snapshot");
    const intentView = await repository.get(intent.ref);
    assert.equal(intentView?.schema.name, "capture.browser.save");
    assert.equal(intentView?.provenance.capture?.identity, "occurrence");
    assert.equal((await repository.query({ revisions: "all", limit: 10 })).length, 3);
  } finally {
    repository.close();
  }
});

test("MV3 persisted visit state survives worker restart and attention distinguishes focused from open tabs", () => {
  const first = resolveBrowserVisitState({
    tab_id: 42,
    window_id: 7,
    url: "https://github.com/openai/codex",
    document_id: "document:github:1",
    frame_id: 0,
    now_ms: Date.parse("2026-07-26T11:00:00.000Z"),
    now_iso: "2026-07-26T11:00:00.000Z",
    id_factory: () => "visit:persisted",
  });
  const restored = parsePersistedBrowserTabStates(JSON.parse(JSON.stringify([first.state])))[0]!;
  const afterRestart = resolveBrowserVisitState({
    existing: restored,
    tab_id: 42,
    window_id: 7,
    url: "https://github.com/openai/codex",
    document_id: "document:github:1",
    frame_id: 0,
    now_ms: Date.parse("2026-07-26T11:01:00.000Z"),
    now_iso: "2026-07-26T11:01:00.000Z",
    id_factory: () => "visit:must-not-be-used",
  });
  const spaRoute = resolveBrowserVisitState({
    existing: afterRestart.state,
    tab_id: 42,
    window_id: 7,
    url: "https://github.com/openai/codex/issues",
    document_id: "document:github:1",
    frame_id: 0,
    now_ms: Date.parse("2026-07-26T11:02:00.000Z"),
    now_iso: "2026-07-26T11:02:00.000Z",
    id_factory: () => "visit:spa-route",
  });
  assert.equal(afterRestart.created, false);
  assert.equal(afterRestart.state.visitId, "visit:persisted");
  assert.equal(spaRoute.created, true);
  assert.equal(spaRoute.state.visitId, "visit:spa-route");
  assert.equal(classifyBrowserAttention({ tab_active: true, window_focused: true, window_state: "normal" }), "focused");
  assert.equal(classifyBrowserAttention({ tab_active: true, window_focused: false, window_state: "normal" }), "background");
  assert.equal(classifyBrowserAttention({ tab_active: false, window_focused: true, window_state: "normal" }), "open");
  const firstHistory = browserNavigationIdentity({
    visit_id: "visit:spa-route",
    action: "navigation_history_state",
    document_id: "document:github:1",
    frame_id: 0,
    timestamp_ms: 1000,
  });
  const nextHistory = browserNavigationIdentity({
    visit_id: "visit:spa-route",
    action: "navigation_history_state",
    document_id: "document:github:1",
    frame_id: 0,
    timestamp_ms: 2000,
  });
  assert.notEqual(firstHistory.event_id, nextHistory.event_id);
  assert.notEqual(firstHistory.navigation_id, nextHistory.navigation_id);
  const sensitiveFramePolicy = browserPolicyForUrl("https://accounts.example.com/oauth/token", {
    excluded_domains: [],
    allow_external_model: true,
  });
  assert.equal(sensitiveFramePolicy.retention, "do_not_store");
  assert.equal(sensitiveFramePolicy.allow_local_search, false);
});

test("Chrome Browser Capture uses MV3 alarms, SPA navigation events, and no legacy record normalizer", () => {
  const source = readFileSync(new URL("../apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts", import.meta.url), "utf8");
  const transport = readFileSync(new URL("../apps/chrome-acp/packages/chrome-extension/src/lib/browser-capture.ts", import.meta.url), "utf8");
  const adapterIndex = readFileSync(new URL("../packages/adapters/browser-capture/index.ts", import.meta.url), "utf8");
  const archivedServer = readFileSync(new URL("../packages/server/http-server.ts", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../apps/chrome-acp/packages/chrome-extension/manifest.json", import.meta.url), "utf8"));
  assert.match(source, /chrome\.alarms\.onAlarm/);
  assert.match(source, /chrome\.webNavigation\.onCommitted/);
  assert.match(source, /chrome\.webNavigation\.onHistoryStateUpdated/);
  assert.match(source, /initialSnapshotRecorded/);
  assert.match(source, /allow_snapshot: action === "navigation_history_state"/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(transport, /SCHEMA_TO_EVENT|observation\.browser_page_snapshot/);
  assert.doesNotMatch(adapterIndex, /legacy/);
  assert.doesNotMatch(archivedServer, /normalizeBrowserCapture|\/context\/v1\/observations/);
  assert.match(source, /url\.pathname = "\/context\/ingest"/);
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.permissions.includes("webNavigation"));
  assert.throws(() => buildBrowserCaptureEvent({
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    content: { url: "https://example.com" },
  }));
});

test("Browser Capture rejects malformed provider events before runtime admission", () => {
  assert.throws(
    () => parseBrowserCaptureEvent({ ...browserEvent(), page: { ...browserEvent().page, domain: "wrong.example" } }),
    (error: unknown) => error instanceof BrowserCaptureAdapterError && error.code === "invalid_browser_capture_event",
  );
  assert.throws(
    () => parseBrowserCaptureEvent({
      ...browserEvent(),
      kind: "navigation",
      action: "navigation_history_state",
      browser: { ...browserEvent().browser, document_id: "document:one", frame_id: 0 },
      navigation: { navigation_id: "navigation:spa:1", transition: "history_state", document_id: "document:two", frame_id: 0 },
    }),
    (error: unknown) => error instanceof BrowserCaptureAdapterError && error.code === "invalid_browser_capture_event",
  );
  assert.throws(
    () => parseBrowserCaptureEvent({
      ...browserEvent(),
      event_id: "browser-event:caption-without-identity",
      kind: "media",
      action: "media_caption",
      content: { text: "Ambiguous caption", media_id: "youtube:video-1" },
      facts: {},
    }),
    (error: unknown) => error instanceof BrowserCaptureAdapterError && error.code === "invalid_browser_capture_event",
  );
  assert.throws(
    () => parseBrowserCaptureEvent({
      ...browserEvent(),
      event_id: "browser-event:background-heartbeat",
      kind: "interaction",
      action: "interaction_heartbeat",
      browser: { ...browserEvent().browser, attention: "background", window_focused: false },
      content: {},
    }),
    (error: unknown) => error instanceof BrowserCaptureAdapterError && error.code === "invalid_browser_capture_event",
  );
});

test("Browser Capture storage exhaustion is observable in the shared Runtime dead letter", async () => {
  const base = new SqliteViewRepository(":memory:");
  const repository = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "commitCaptureBatch") {
        return async () => {
          throw new ViewRepositoryError(
            "forced Browser Capture storage failure",
            "storage_failure",
            { operation: "browser_capture_test" },
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const ingress = new CaptureIngress({ repository });
    const runtime = new ConnectorRuntime(repository, ingress);
    const controller = await configureBrowserCapture({ runtime });
    await assert.rejects(
      controller.submit({ ...browserEvent(), source: { connector: "chrome-extension", connection_id: "chrome:default" } }),
      (error: unknown) => error instanceof CaptureRuntimeError && error.code === "storage_failure",
    );
    const deadLetters = await repository.listCaptureDeadLetters("chrome:default", "pending");
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]?.batch.metadata.event_id, "browser-event:page:1");
    assert.equal((await repository.getCaptureTrace("chrome:default")).filter(item => item.type === "capture.retry_scheduled").length, 2);
  } finally {
    base.close();
  }
});

test("Chrome transport outbox retries the exact canonical Browser event", async () => {
  const event = buildBrowserCaptureEvent(browserEvent());
  const outbox = new MemoryOutbox();
  const endpoint = browserCaptureEndpoint("http://localhost:3111/context/v1/observations?process=true");
  const first = await deliverBrowserCaptureEvent({
    event,
    endpoint,
    outbox,
    fetch: async () => { throw new TypeError("server offline"); },
    now: () => "2026-07-26T11:00:02.000Z",
  });
  assert.equal(first.ok, false);
  assert.equal(first.failure?.attempts, 1);
  assert.equal(outbox.records[0]?.status, "pending");

  let deliveredBody = "";
  const replay = await deliverBrowserCaptureEvent({
    event: first.failure!.event,
    endpoint: first.failure!.endpoint,
    outbox,
    previous: first.failure,
    fetch: async (_url, init) => {
      deliveredBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, result: { replayed: false } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
    now: () => "2026-07-26T11:00:03.000Z",
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(JSON.parse(deliveredBody), event);
  assert.equal(outbox.records[0]?.status, "resolved");
  assert.equal(endpoint, "http://localhost:3111/capture/v1/browser-events");

  const retryableEvent = { ...event, event_id: "browser-event:http-503" };
  const retryable = await deliverBrowserCaptureEvent({
    event: retryableEvent,
    endpoint,
    outbox,
    fetch: async () => new Response(JSON.stringify({ ok: false, code: "browser_capture_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
    now: () => "2026-07-26T11:00:04.000Z",
  });
  assert.equal(retryable.ok, false);
  assert.equal(retryable.failure?.event.event_id, retryableEvent.event_id);
  assert.equal(retryable.failure?.error.http_status, 503);
  assert.equal(outbox.records.find(item => item.id === retryable.failure?.id)?.status, "pending");

  const rejected = await deliverBrowserCaptureEvent({
    event,
    endpoint,
    outbox,
    fetch: async () => new Response(JSON.stringify({ ok: false, code: "invalid_browser_capture_event" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "invalid_browser_capture_event");
  assert.equal(rejected.failure, undefined);
  assert.equal(outbox.records.length, 2);
});

test("Chrome transport outbox serializes concurrent failures without dropping pending events", async () => {
  let stored: BrowserCaptureTransportFailure[] = [];
  const outbox = new SerializedBrowserCaptureOutbox({
    async read() {
      return structuredClone(stored);
    },
    async write(records) {
      await new Promise(resolve => setTimeout(resolve, 5));
      stored = structuredClone(records);
    },
  });
  const endpoint = browserCaptureEndpoint("http://localhost:3111");
  const events = [
    buildBrowserCaptureEvent({ ...browserEvent(), event_id: "browser-event:offline:1" }),
    buildBrowserCaptureEvent({ ...browserEvent(), event_id: "browser-event:offline:2" }),
  ];
  await Promise.all(events.map(event => deliverBrowserCaptureEvent({
    event,
    endpoint,
    outbox,
    fetch: async () => { throw new TypeError("server offline"); },
    now: () => "2026-07-26T11:00:05.000Z",
  })));
  const pending = await outbox.list();
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(item => item.event.event_id).sort(), events.map(item => item.event_id).sort());
  assert.ok(pending.every(item => item.status === "pending"));
});

test("Chrome canonical event crosses HTTP and shared Runtime into one exact Raw View", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-browser-capture-http-smoke-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  try {
    const ingress = new CaptureIngress({ repository });
    const runtime = new ConnectorRuntime(repository, ingress);
    const controller = await configureBrowserCapture({ runtime });
    const handler = captureHttpHandler(controller);
    const event = buildBrowserCaptureEvent({
      ...browserEvent(),
      source: { connector: "chrome-extension", connection_id: "chrome:default" },
      content: { text: "Exact page text" },
    });

    const first = await httpRequest(handler, event);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const ref = first.body.result.captured_views[0].ref;
    const stored = await repository.get(ref);
    assert.equal(stored?.schema.name, "capture.browser.page_snapshot");
    assert.match(JSON.stringify(stored?.representation), /Exact page text/);

    const replay = await httpRequest(handler, event);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.result.replayed, true);
    assert.deepEqual(replay.body.result.captured_views[0].ref, ref);

    const conflict = await httpRequest(handler, {
      ...event,
      content: { ...event.content, text: "Changed under the same event id" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "idempotency_conflict");
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function captureHttpHandler(
  browserCapture: { submit(input: unknown): Promise<unknown> },
) {
  const automation = {
    async submit() { return {}; },
    listDeliveries() { return []; },
    async interact() { return {}; },
  };
  return createAmbientV1HttpHandler({
    browser_capture: browserCapture,
    browser_automation: automation,
    mac_automation: {
      ...automation,
      listBrowserContextRequests() { return []; },
      async respondBrowserContext() { return {}; },
    },
    inbox_automation: {
      listDeliveries() { return []; },
      async interact() { return {}; },
    },
    operations: {
      async handle() {
        throw new Error("Operation route is outside this Browser Capture smoke");
      },
    },
    operation_access: new AmbientOperationAccess("test-operation-auth-token-32-bytes"),
    observe() {},
  });
}

class MemoryOutbox implements BrowserCaptureOutbox {
  readonly records: BrowserCaptureTransportFailure[] = [];

  async put(failure: BrowserCaptureTransportFailure) {
    const index = this.records.findIndex(item => item.id === failure.id);
    if (index >= 0) this.records[index] = failure;
    else this.records.push(failure);
  }

  async resolve(id: string, resolvedAt: string) {
    const item = this.records.find(record => record.id === id);
    if (!item) throw new Error(`missing outbox record ${id}`);
    item.status = "resolved";
    item.resolved_at = resolvedAt;
  }
}

async function httpRequest(
  handler: ReturnType<typeof createAmbientV1HttpHandler>,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const req = Readable.from([JSON.stringify(body)]) as any;
  req.method = "POST";
  req.url = "/capture/v1/browser-events";
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    authorization: "Bearer test-operation-auth-token-32-bytes",
  };
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { raw = value; },
  };
  await handler(req, res);
  return { status, body: JSON.parse(raw) };
}

function browserEvent() {
  return {
    version: 1 as const,
    event_id: "browser-event:page:1",
    kind: "page" as const,
    action: "page_snapshot" as const,
    occurred_at: "2026-07-26T11:00:00.000Z",
    captured_at: "2026-07-26T11:00:00.050Z",
    source: { connector: "chrome-extension" as const, connection_id: "chrome:profile-1" },
    browser: {
      tab_id: 42,
      window_id: 7,
      visit_id: "visit:github:codex",
      attention: "focused" as const,
      tab_active: true,
      window_focused: true,
      document_id: "document:github:codex",
      frame_id: 0,
    },
    page: {
      url: "https://github.com/openai/codex#readme",
      canonical_url: "https://github.com/openai/codex",
      title: "openai/codex",
      domain: "github.com",
    },
    content: {
      text: "Codex is an open source coding agent.",
      selected_text: "open source coding agent",
    },
    facts: { tab_id: 42, navigation_id: "navigation:github:codex" },
    policy: policy(),
  };
}

function policy() {
  return {
    owner: "user:local",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  browserAutomationEndpoint,
  browserDeliveriesEndpoint,
  browserExactViewEndpoint,
  browserInteractionEndpoint,
  buildBrowserAutomationEvent,
  buildBrowserDeliveryInteraction,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/ambient/browser-trigger.ts";
import { AutomationDeliveryInteractionSchema } from "../packages/automation/index.ts";
import { parseBrowserPageEvent } from "../packages/adapters/browser-automation/index.ts";
import {
  BROWSER_OPERATION_WIRE_CONTRACT,
  BrowserOperationAccessError,
  isValidOperationAuthToken,
  negotiateBrowserOperationAccess,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/operation-auth.ts";
import {
  MF_WIRE_CONTRACT,
  doctorAuthenticationProof,
} from "@info/operation-surfaces";
import {
  OperationAuthStorageIsolationError,
  ensureTrustedOperationStorageAccess,
  readOperationAuthToken,
  writeOperationAuthToken,
  type OperationAuthStorageArea,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/operation-auth-storage.ts";
import { publicInfoSettings } from "../apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts";

class FakeLocalStorage implements OperationAuthStorageArea {
  readonly values: Record<string, unknown>;
  accessLevel = "TRUSTED_AND_UNTRUSTED_CONTEXTS";
  accessCalls = 0;
  setCalls = 0;
  removeCalls = 0;
  rejectIsolation = false;

  constructor(values: Record<string, unknown> = {}) {
    this.values = { ...values };
  }

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.filter(key => key in this.values).map(key => [key, this.values[key]]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    Object.assign(this.values, items);
  }

  async remove(keys: string | string[]): Promise<void> {
    this.removeCalls += 1;
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }

  async setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> {
    this.accessCalls += 1;
    if (this.rejectIsolation) throw new Error("isolation unavailable");
    this.accessLevel = options.accessLevel;
  }

  async untrustedGet(key: string): Promise<unknown> {
    return this.accessLevel === "TRUSTED_CONTEXTS" ? undefined : this.values[key];
  }
}

test("Chrome extension accepts only the canonical resident daemon bearer token grammar", () => {
  assert.equal(isValidOperationAuthToken("test-operation-auth-token-32-bytes"), true);
  assert.equal(isValidOperationAuthToken(`${"a".repeat(32)} `), false);
  assert.equal(isValidOperationAuthToken("short-token"), false);
});

test("Chrome extension isolates existing and new Operation tokens from untrusted contexts", async () => {
  const existingToken = "existing-operation-auth-token-32-bytes";
  const replacementToken = "replacement-operation-auth-token-32-bytes";
  const storage = new FakeLocalStorage({ operationAuthToken: existingToken });
  assert.equal(await storage.untrustedGet("operationAuthToken"), existingToken);

  assert.equal(await readOperationAuthToken(storage), existingToken);
  assert.equal(storage.accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(await storage.untrustedGet("operationAuthToken"), undefined);
  await writeOperationAuthToken(replacementToken, storage);
  assert.equal(await readOperationAuthToken(storage), replacementToken);
  assert.equal(await storage.untrustedGet("operationAuthToken"), undefined);
  assert.equal(storage.accessCalls, 1);

  const publicSettings = publicInfoSettings({
    endpoint: "http://localhost:3111",
    operationAuthToken: replacementToken,
    captureStream: true,
    heartbeatSeconds: 15,
    snapshotOnVisit: true,
    allowExternalLlm: true,
    snapshotTextLimit: 120000,
    excludedDomains: [],
  });
  assert.equal("operationAuthToken" in publicSettings, false);
  assert.equal(publicSettings.operationAuthConfigured, true);
});

test("Chrome extension clears legacy Operation tokens and fails closed when isolation is unavailable", async () => {
  const storage = new FakeLocalStorage({ operationAuthToken: "legacy-operation-auth-token-32-bytes" });
  storage.rejectIsolation = true;
  await assert.rejects(
    ensureTrustedOperationStorageAccess(storage),
    (error: unknown) => error instanceof OperationAuthStorageIsolationError,
  );
  assert.equal(storage.values.operationAuthToken, undefined);
  assert.equal(storage.removeCalls, 1);
  await assert.rejects(writeOperationAuthToken("replacement-operation-auth-token-32-bytes", storage));
  assert.equal(storage.setCalls, 0);
  assert.equal(storage.accessCalls, 1);

  const unsupported: OperationAuthStorageArea = {
    async get() { throw new Error("token must not be read"); },
    async set() { throw new Error("token must not be written"); },
    async remove() {},
  };
  await assert.rejects(
    readOperationAuthToken(unsupported),
    (error: unknown) => error instanceof OperationAuthStorageIsolationError,
  );
});

test("Chrome extension wire constants conform exactly to the canonical resident daemon contract", () => {
  assert.deepEqual(BROWSER_OPERATION_WIRE_CONTRACT, {
    protocol: MF_WIRE_CONTRACT.protocol,
    server: MF_WIRE_CONTRACT.server,
    authentication: { ...MF_WIRE_CONTRACT.authentication, challenge_scheme: "HMAC-SHA256" },
    catalog: MF_WIRE_CONTRACT.catalog,
    endpoints: MF_WIRE_CONTRACT.endpoints,
  });
});

test("macOS native wire constants cannot drift from the canonical resident daemon contract", () => {
  const source = readFileSync(new URL("../apps/mac/Sources/MetaflowMac/ResidentOperationAccessClient.swift", import.meta.url), "utf8");
  const swiftString = (name: string) => {
    const match = source.match(new RegExp(`static let ${name} = "([^"]+)"`, "u"));
    assert.ok(match, `missing Swift wire constant ${name}`);
    return match[1];
  };
  const swiftInteger = (name: string) => {
    const match = source.match(new RegExp(`static let ${name} = ([0-9]+)`, "u"));
    assert.ok(match, `missing Swift wire constant ${name}`);
    return Number(match[1]);
  };
  const operationsBlock = source.match(/static let operations = \[([\s\S]*?)\n    \]/u);
  assert.ok(operationsBlock, "missing Swift Operation allowlist");
  const swiftOperations = [...operationsBlock[1].matchAll(/"([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual({
    protocol: { name: swiftString("protocolName"), version: swiftInteger("protocolVersion") },
    server: { name: swiftString("serverName"), version: swiftString("serverVersion") },
    authentication: {
      source: swiftString("authenticationSource"),
      required: /static let authenticationRequired = true/u.test(source),
      scheme: swiftString("authenticationScheme"),
      challenge_scheme: swiftString("challengeScheme"),
    },
    catalog: {
      version: swiftInteger("catalogVersion"),
      fingerprint: swiftString("catalogFingerprint"),
      operations: swiftOperations,
    },
    endpoints: { operations: swiftString("operationsEndpoint"), mcp: swiftString("mcpEndpoint") },
  }, BROWSER_OPERATION_WIRE_CONTRACT);
});

test("Chrome extension proves the loopback daemon before exposing its Bearer token", async () => {
  const token = "test-operation-auth-token-32-bytes";
  const challenge = "a".repeat(64);
  const authorizations: Array<string | null> = [];
  const access = await negotiateBrowserOperationAccess({
    endpoint: "http://localhost:3111",
    token,
    challenge,
    fetch: async (input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      assert.equal(init?.credentials, "omit");
      const url = new URL(String(input));
      assert.equal(url.origin, "http://127.0.0.1:3111");
      assert.equal(url.pathname, "/metaflow/v1/doctor");
      assert.equal(url.searchParams.get("challenge"), challenge);
      return new Response(JSON.stringify({
        ok: true,
        protocol: BROWSER_OPERATION_WIRE_CONTRACT.protocol,
        server: { ...BROWSER_OPERATION_WIRE_CONTRACT.server, origin: url.origin },
        authentication: {
          ...BROWSER_OPERATION_WIRE_CONTRACT.authentication,
          challenge,
          proof: doctorAuthenticationProof(token, challenge, url.origin),
        },
        catalog: BROWSER_OPERATION_WIRE_CONTRACT.catalog,
        endpoints: BROWSER_OPERATION_WIRE_CONTRACT.endpoints,
      }), { status: 200, headers: { "x-metaflow-protocol-version": "1" } });
    },
  });
  assert.equal(access.origin, "http://127.0.0.1:3111");
  assert.deepEqual(authorizations, [null]);
});

test("Chrome extension rejects remote endpoints and exact-mimic impostors before token use", async () => {
  const token = "test-operation-auth-token-32-bytes";
  let requests = 0;
  await assert.rejects(
    negotiateBrowserOperationAccess({
      endpoint: "http://192.0.2.10:3111",
      token,
      fetch: async () => {
        requests += 1;
        throw new Error("must not fetch");
      },
    }),
    (error: unknown) => error instanceof BrowserOperationAccessError && error.code === "daemon_url_invalid",
  );
  assert.equal(requests, 0);

  const challenge = "b".repeat(64);
  await assert.rejects(
    negotiateBrowserOperationAccess({
      endpoint: "http://127.0.0.1:3111",
      token,
      challenge,
      fetch: async input => {
        requests += 1;
        const url = new URL(String(input));
        return new Response(JSON.stringify({
          ok: true,
          protocol: BROWSER_OPERATION_WIRE_CONTRACT.protocol,
          server: { ...BROWSER_OPERATION_WIRE_CONTRACT.server, origin: url.origin },
          authentication: {
            ...BROWSER_OPERATION_WIRE_CONTRACT.authentication,
            challenge,
            proof: "0".repeat(64),
          },
          catalog: BROWSER_OPERATION_WIRE_CONTRACT.catalog,
          endpoints: BROWSER_OPERATION_WIRE_CONTRACT.endpoints,
        }), { status: 200, headers: { "x-metaflow-protocol-version": "1" } });
      },
    }),
    (error: unknown) => error instanceof BrowserOperationAccessError && error.code === "daemon_credential_mismatch",
  );
  assert.equal(requests, 1);
});

test("Chrome extension CSP permits the canonicalized IPv4 loopback daemon origin", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("../apps/chrome-acp/packages/chrome-extension/manifest.json", import.meta.url),
    "utf8",
  )) as { content_security_policy?: { extension_pages?: string } };
  assert.match(manifest.content_security_policy?.extension_pages ?? "", /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/u);
});

test("Chrome content scripts obtain non-secret local settings through the trusted background", () => {
  const content = readFileSync(
    new URL("../apps/chrome-acp/packages/chrome-extension/src/content.ts", import.meta.url),
    "utf8",
  );
  const background = readFileSync(
    new URL("../apps/chrome-acp/packages/chrome-extension/src/background.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(content, /chrome\.storage\??\.local/u);
  assert.match(content, /type: "selection-actions\.get"/u);
  assert.match(background, /message\?\.type === "selection-actions\.get"/u);
  assert.match(background, /ensureTrustedOperationStorageAccess\(\)/u);
});

test("Chrome extension emits a Browser Automation event accepted by the backend contract", () => {
  const event = buildBrowserAutomationEvent({
    message: {
      event_id: "browser-event:github:codex:1",
      navigation_id: "navigation:github:codex:1",
      reason_kind: "dom",
      dwell_ms: 31_000,
      scroll_depth: 0.75,
      scroll_events: 4,
      selection_count: 1,
      dom: {
        github_repository: true,
        markers: { readme: true, language: "TypeScript" },
      },
    },
    tab: {
      id: 42,
      windowId: 7,
      url: "https://github.com/openai/codex",
      title: "openai/codex",
    },
    page: {
      text: "Codex is a coding agent.",
      selected_text: "coding agent",
      observed_at: "2026-07-26T10:00:30.000Z",
      metadata: { content_source: "document.body.innerText" },
      text_quality: { complete: true },
    },
    visit_id: "visit:github:codex:1",
    started_at_ms: 0,
    privacy: {
      level: "private",
      retention: "session",
      allow_external_llm: true,
      allow_embedding: false,
    },
    now: "2026-07-26T10:00:31.000Z",
    id_factory: () => "must-not-be-used",
  });

  const parsed = parseBrowserPageEvent(event);
  assert.equal(parsed.event_id, "browser-event:github:codex:1");
  assert.equal(parsed.reason, "dom");
  assert.equal(parsed.dom.github_repository, true);
  assert.equal(parsed.dom.repository_owner, "openai");
  assert.equal(parsed.dom.repository_name, "codex");
  assert.deepEqual(parsed.dom.markers, { readme: true, language: "TypeScript" });
  assert.equal(parsed.page.selected_text, "coding agent");
  assert.equal(parsed.policy.retention, "session");
  assert.equal(parsed.policy.allow_external_model, true);
});

test("Chrome extension derives dwell from the supplied event clock", () => {
  const event = buildBrowserAutomationEvent({
    message: { reason_kind: "manual" },
    tab: { id: 1, url: "https://example.com/article" },
    page: { text: "Deterministic replay." },
    visit_id: "visit:deterministic:1",
    started_at_ms: Date.parse("2026-07-26T09:59:30.000Z"),
    privacy: {},
    now: "2026-07-26T10:00:00.000Z",
    id_factory: () => "browser-event:deterministic:1",
  });
  assert.equal(event.dwell_ms, 30_000);
});

test("Chrome extension projects the Capture endpoint to the Browser Automation surface", () => {
  assert.equal(
    browserAutomationEndpoint("http://localhost:3111/context/v1/observations?process=true"),
    "http://localhost:3111/automation/v1/browser-signals",
  );
});

test("Chrome extension builds Browser delivery polling and interaction requests", () => {
  assert.equal(
    browserDeliveriesEndpoint("http://localhost:3111/context/v1/observations", {
      after: "2026-07-26T10:00:31.000Z",
      limit: 20,
    }),
    "http://localhost:3111/automation/v1/browser-deliveries?after=2026-07-26T10%3A00%3A31.000Z&limit=20",
  );
  assert.equal(
    browserInteractionEndpoint("http://localhost:3111/context/v1/observations"),
    "http://localhost:3111/automation/v1/browser-interactions",
  );
  assert.equal(
    browserExactViewEndpoint("http://localhost:3111/context/v1/observations", {
      view_id: "summary:github/openai/codex",
      revision: 2,
    }),
    "http://localhost:3111/context/v1/views/summary%3Agithub%2Fopenai%2Fcodex?revision=2",
  );

  const interaction = AutomationDeliveryInteractionSchema.parse(buildBrowserDeliveryInteraction({
    request_id: "delivery-request:github:1",
    delivery_id: "browser-delivery:delivery-request:github:1",
    action: "accept",
    metadata: { source: "ambient-card" },
    now: "2026-07-26T10:01:00.000Z",
    id_factory: () => "interaction:github:1",
  }));
  assert.equal(interaction.surface, "browser");
  assert.equal(interaction.actor, "user:local");
  assert.equal(interaction.action, "accept");
});

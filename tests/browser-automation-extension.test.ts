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
  authorizedBrowserDaemonFetch,
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
import {
  handleInfoCaptureMessage,
  publicInfoSettings,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts";
import {
  ALL_RUNTIME_MESSAGE_TYPES,
  CONTENT_SCRIPT_RUNTIME_MESSAGE_TYPES,
  PRIVILEGED_RUNTIME_MESSAGE_TYPES,
  TRUSTED_BACKGROUND_RUNTIME_SENDER,
  authorizeRuntimeMessageSender,
  projectRuntimeMessageResult,
} from "../apps/chrome-acp/packages/chrome-extension/src/lib/runtime-sender-policy.ts";
import { SidepanelPromptQueue } from "../apps/chrome-acp/packages/chrome-extension/src/lib/sidepanel-prompt-queue.ts";

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

test("Chrome runtime sender policy covers every Info handler branch and grants content scripts only declared capture interactions", () => {
  assert.equal(new Set(ALL_RUNTIME_MESSAGE_TYPES).size, ALL_RUNTIME_MESSAGE_TYPES.length);
  const source = readFileSync(
    new URL("../apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts", import.meta.url),
    "utf8",
  );
  const handledTypes = [...source.matchAll(/message\?\.type === "([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual(
    [...new Set(handledTypes)].sort(),
    [...CONTENT_SCRIPT_RUNTIME_MESSAGE_TYPES, ...PRIVILEGED_RUNTIME_MESSAGE_TYPES]
      .filter(type => ![
        "selection-actions.get",
        "language.caption_gap.recent",
        "language.caption_gap.sync",
        "sidepanel.explain.selection",
        "sidepanel.run.selection_action",
        "sidepanel.consume-pending-prompt",
      ].includes(type))
      .sort(),
  );

  const environment = {
    extensionId: "metaflow-extension-id",
    extensionRoot: "chrome-extension://metaflow-extension-id/",
  };
  const contentSender = {
    id: environment.extensionId,
    url: "https://hostile.example/frame",
    tab: { id: 41 },
  } as chrome.runtime.MessageSender;
  const trustedSender = {
    id: environment.extensionId,
    url: `${environment.extensionRoot}sidepanel.html`,
  } as chrome.runtime.MessageSender;

  for (const type of CONTENT_SCRIPT_RUNTIME_MESSAGE_TYPES) {
    assert.deepEqual(authorizeRuntimeMessageSender({ type }, contentSender, environment), {
      ok: true,
      principal: "content-script",
    });
  }
  for (const type of PRIVILEGED_RUNTIME_MESSAGE_TYPES) {
    assert.equal(authorizeRuntimeMessageSender({ type }, contentSender, environment).ok, false, type);
    assert.deepEqual(authorizeRuntimeMessageSender({ type }, trustedSender, environment), {
      ok: true,
      principal: "trusted-extension-page",
    });
  }
  assert.equal(authorizeRuntimeMessageSender({ type: "unknown-message" }, trustedSender, environment).ok, false);
  assert.deepEqual(authorizeRuntimeMessageSender(
    { type: "youtube-observation" },
    { ...TRUSTED_BACKGROUND_RUNTIME_SENDER, tab: { id: 41 } } as chrome.runtime.MessageSender,
    environment,
  ), { ok: true, principal: "trusted-background" });

  const contentAuthorization = authorizeRuntimeMessageSender(
    { type: "context.capture.writing_input" },
    contentSender,
    environment,
  );
  assert.equal(contentAuthorization.ok, true);
  if (!contentAuthorization.ok) throw new Error("content authorization unexpectedly failed");
  assert.deepEqual(projectRuntimeMessageResult(contentAuthorization, {
    ok: true,
    status: 200,
    record_id: "private-record-id",
    written_views: ["view:private"],
    views: [{ content: { secret: true } }],
    body: { private: true },
  }), { ok: true, status: 200 });
  assert.deepEqual(projectRuntimeMessageResult(
    authorizeRuntimeMessageSender({ type: "get-ambient-exact-view" }, trustedSender, environment) as {
      ok: true;
      principal: "trusted-extension-page";
    },
    { ok: true, view: { content: { private: true } } },
  ), { ok: true, view: { content: { private: true } } });
});

test("hostile content senders cannot queue selection prompts while trusted sidepanel pages can", async () => {
  const queue = new SidepanelPromptQueue();
  let openCalls = 0;
  const open = async () => { openCalls += 1; };
  const contentSender = {
    id: "metaflow-extension-id",
    url: "https://hostile.example/frame",
    tab: { id: 41 },
  } as chrome.runtime.MessageSender;
  const hostile = await queue.handle({
    type: "sidepanel.run.selection_action",
    action: { prompt: "exfiltrate private Views" },
    payload: { selected_text: "private" },
  }, { ok: true, principal: "content-script" }, contentSender, open);
  assert.deepEqual(hostile, {
    ok: false,
    code: "runtime_sender_forbidden",
    error: "The runtime sender is not authorized for this message type",
  });
  assert.equal(openCalls, 0);

  const trustedSender = {
    id: "metaflow-extension-id",
    url: "chrome-extension://metaflow-extension-id/sidepanel.html",
  } as chrome.runtime.MessageSender;
  const trusted = await queue.handle({
    type: "sidepanel.explain.selection",
    payload: { selected_text: "bounded selection" },
  }, { ok: true, principal: "trusted-extension-page" }, trustedSender, open) as any;
  assert.equal(trusted.ok, true);
  assert.equal(trusted.pending.payload.selected_text, "bounded selection");
  const consumed = await queue.handle(
    { type: "sidepanel.consume-pending-prompt" },
    { ok: true, principal: "trusted-extension-page" },
    trustedSender,
    open,
  ) as any;
  assert.equal(consumed.pending.id, trusted.pending.id);
});

test("hostile runtime senders cannot reach any privileged Info path or expose the Operation token", async () => {
  const previousChrome = Reflect.get(globalThis, "chrome");
  const previousFetch = globalThis.fetch;
  let storageCalls = 0;
  let networkCalls = 0;
  const forbiddenStorage = async () => {
    storageCalls += 1;
    throw new Error("privileged storage must not be reached");
  };
  Reflect.set(globalThis, "chrome", {
    runtime: {
      id: "metaflow-extension-id",
      getURL: (path: string) => `chrome-extension://metaflow-extension-id/${path}`,
    },
    storage: {
      local: { get: forbiddenStorage, set: forbiddenStorage, remove: forbiddenStorage },
      session: { get: forbiddenStorage, set: forbiddenStorage },
    },
  });
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network must not be reached");
  };

  try {
    const hostileSender = {
      id: "metaflow-extension-id",
      url: "https://hostile.example/frame",
      tab: { id: 41 },
    } as chrome.runtime.MessageSender;
    for (const type of PRIVILEGED_RUNTIME_MESSAGE_TYPES.filter(type => ![
      "language.caption_gap.sync",
      "sidepanel.consume-pending-prompt",
    ].includes(type))) {
      const response = await handleInfoCaptureMessage({
        type,
        view_id: "view:private",
        revision: 1,
        settings: { operationAuthToken: "attacker-controlled-operation-token" },
      }, hostileSender);
      assert.deepEqual(response, {
        ok: false,
        code: "runtime_sender_forbidden",
        error: "The runtime sender is not authorized for this message type",
      }, type);
    }
    assert.equal(storageCalls, 0);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousChrome === undefined) Reflect.deleteProperty(globalThis, "chrome");
    else Reflect.set(globalThis, "chrome", previousChrome);
  }
});

test("trusted extension pages retain nonce-proved exact View access", async () => {
  const previousChrome = Reflect.get(globalThis, "chrome");
  const previousFetch = globalThis.fetch;
  const token = "trusted-extension-operation-token-32-bytes";
  const endpoint = "http://127.0.0.1:3111";
  const authorizations: Array<string | null> = [];
  let requests = 0;
  const localStorage = {
    async setAccessLevel(options: { accessLevel: string }) {
      assert.equal(options.accessLevel, "TRUSTED_CONTEXTS");
    },
    async get() {
      return { endpoint, operationAuthToken: token };
    },
    async set() {},
    async remove() {},
  };
  Reflect.set(globalThis, "chrome", {
    runtime: {
      id: "metaflow-extension-id",
      getURL: (path: string) => `chrome-extension://metaflow-extension-id/${path}`,
    },
    storage: {
      local: localStorage,
      session: { async get() { return {}; } },
    },
  });
  globalThis.fetch = async (input, init) => {
    requests += 1;
    authorizations.push(new Headers(init?.headers).get("authorization"));
    const url = new URL(String(input));
    if (url.pathname === "/metaflow/v1/doctor") {
      const challenge = url.searchParams.get("challenge") ?? "";
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
    }
    assert.equal(url.pathname, "/context/v1/views/view%3Aprivate");
    assert.equal(url.searchParams.get("revision"), "1");
    return new Response(JSON.stringify({
      ok: true,
      view: { id: "view:private", revision: 1, content: { private: true } },
    }), { status: 200 });
  };

  try {
    const response = await handleInfoCaptureMessage({
      type: "get-ambient-exact-view",
      view_id: "view:private",
      revision: 1,
    }, {
      id: "metaflow-extension-id",
      url: "chrome-extension://metaflow-extension-id/sidepanel.html",
    });
    assert.deepEqual(response, {
      ok: true,
      status: 200,
      endpoint: "http://127.0.0.1:3111/context/v1/views/view%3Aprivate?revision=1",
      view: { id: "view:private", revision: 1, content: { private: true } },
    });
    assert.equal(requests, 2);
    assert.deepEqual(authorizations, [null, `Bearer ${token}`]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousChrome === undefined) Reflect.deleteProperty(globalThis, "chrome");
    else Reflect.set(globalThis, "chrome", previousChrome);
  }
});

test("content writing capture does not start privileged assist generation or exact View reads", async () => {
  const previousChrome = Reflect.get(globalThis, "chrome");
  const previousFetch = globalThis.fetch;
  const requestedPaths: string[] = [];
  const localStorage = {
    async setAccessLevel() {},
    async get() { return { endpoint: "http://127.0.0.1:3111" }; },
    async set() {},
    async remove() {},
  };
  Reflect.set(globalThis, "chrome", {
    runtime: {
      id: "metaflow-extension-id",
      getURL: (path: string) => `chrome-extension://metaflow-extension-id/${path}`,
    },
    storage: {
      local: localStorage,
      session: { async get() { return {}; } },
    },
  });
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    assert.equal(url.pathname, "/context/ingest");
    assert.equal(url.search, "");
    return new Response(JSON.stringify({
      ok: true,
      id: "record:writing:1",
      written_views: ["view:private-writing-result"],
    }), { status: 200 });
  };

  try {
    const response = await handleInfoCaptureMessage({
      type: "context.capture.writing_input",
      payload: {
        text: "A sufficiently long writing sample for capture.",
        url: "https://example.com/editor",
        domain: "example.com",
      },
    }, {
      id: "metaflow-extension-id",
      url: "https://example.com/editor",
      tab: { id: 51, windowId: 7, url: "https://example.com/editor", title: "Editor" },
    } as chrome.runtime.MessageSender);
    assert.deepEqual(response, { ok: true, status: 200 });
    assert.deepEqual(requestedPaths, ["/context/ingest"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousChrome === undefined) Reflect.deleteProperty(globalThis, "chrome");
    else Reflect.set(globalThis, "chrome", previousChrome);
  }
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

test("Chrome daemon clients obtain a fresh proof before every canonical private route", async () => {
  const token = "trusted-extension-operation-token-32-bytes";
  const endpoint = "http://127.0.0.1:3111";
  const privateRoutes = [
    ["POST", "/capture/v1/browser-events"],
    ["POST", "/automation/v1/browser-signals"],
    ["GET", "/automation/v1/browser-deliveries"],
    ["POST", "/automation/v1/browser-interactions"],
    ["GET", "/automation/v1/macos/browser-context-requests"],
    ["POST", "/automation/v1/macos/browser-context-responses"],
    ["GET", "/context/v1/views/view%3Aprivate?revision=1"],
  ] as const;
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ path: `${url.pathname}${url.search}`, authorization });
    if (url.pathname === "/metaflow/v1/doctor") {
      const challenge = url.searchParams.get("challenge") ?? "";
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
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  for (const [method, path] of privateRoutes) {
    const response = await authorizedBrowserDaemonFetch({
      endpoint,
      token,
      request: new URL(path, endpoint),
      init: { method },
      fetch: fetcher,
    });
    assert.equal(response.status, 200);
  }
  assert.equal(requests.length, privateRoutes.length * 2);
  for (let index = 0; index < privateRoutes.length; index += 1) {
    assert.match(requests[index * 2]!.path, /^\/metaflow\/v1\/doctor\?challenge=[0-9a-f]{64}$/u);
    assert.equal(requests[index * 2]!.authorization, null);
    assert.equal(requests[index * 2 + 1]!.path, privateRoutes[index]![1]);
    assert.equal(requests[index * 2 + 1]!.authorization, `Bearer ${token}`);
  }
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

test("Chrome content scripts cannot request prompt configuration or prompt submission routes", () => {
  const content = readFileSync(
    new URL("../apps/chrome-acp/packages/chrome-extension/src/content.ts", import.meta.url),
    "utf8",
  );
  const background = readFileSync(
    new URL("../apps/chrome-acp/packages/chrome-extension/src/background.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(content, /chrome\.storage\??\.local/u);
  assert.doesNotMatch(content, /selection-actions\.get|sidepanel\.(?:explain\.selection|run\.selection_action)/u);
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

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  AMBIENT_DAEMON_HOST,
  listenAmbientDaemon,
  parseTrustedOperationOrigins,
} from "../apps/ambient-daemon/index.ts";
import {
  DaemonOperationClient,
  DaemonWireError,
  METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  METAFLOW_OPERATION_CATALOG_VERSION,
  doctorAuthenticationProof,
} from "../packages/adapters/operation-surfaces/daemon.ts";
import { OPERATION_NAMES } from "@info/operations";
import { AmbientOperationAccess } from "../apps/ambient-daemon/operation-access.ts";
import { createAmbientV1HttpHandler } from "../apps/ambient-daemon/http-handler.ts";
import { validateOperationEnvelopeWire } from "../packages/adapters/operation-surfaces/wire-contract.ts";

const protocolHeaders = { "x-metaflow-protocol-version": "1" };
const operationAuthToken = "test-operation-auth-token-32-bytes";
const fixtureChallenge = "0".repeat(64);
const fixtureOrigin = "http://127.0.0.1:3111";
const doctor = {
  ok: true,
  protocol: { name: "metaflow-operations-http", version: 1 },
  server: { name: "ambient-daemon", version: "0.1.0", origin: fixtureOrigin },
  authentication: {
    source: "METAFLOW_AUTH_TOKEN",
    required: true,
    scheme: "Bearer",
    challenge_scheme: "HMAC-SHA256",
    challenge: fixtureChallenge,
    proof: doctorAuthenticationProof(operationAuthToken, fixtureChallenge, fixtureOrigin),
  },
  catalog: {
    version: METAFLOW_OPERATION_CATALOG_VERSION,
    fingerprint: METAFLOW_OPERATION_CATALOG_FINGERPRINT,
    operations: OPERATION_NAMES,
  },
  endpoints: { operations: "/metaflow/v1/operations/", mcp: "/mcp" },
} as const;

test("wire envelopes reject identifiers that canonical Operation parsing would normalize or bound", () => {
  for (const envelope of [
    { ok: true, request_id: " padded ", operation: "catalog.list", data: {} },
    { ok: true, request_id: "x".repeat(241), operation: "catalog.list", data: {} },
    {
      ok: false,
      request_id: "request:bounded",
      operation: "catalog.list",
      error: { code: " padded ", message: "failure", category: "internal", details: {} },
    },
  ]) {
    assert.throws(() => validateOperationEnvelopeWire(envelope, "catalog.list"));
  }
});

test("the canonical ambient listener binds only the explicit IPv4 loopback contract", async () => {
  assert.throws(
    () => parseTrustedOperationOrigins("file:///tmp/not-an-http-origin"),
    /exact HTTP\(S\) or Chrome extension origins/u,
  );
  const server = createServer((_request, response) => response.end("ok"));
  try {
    await listenAmbientDaemon(server, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, AMBIENT_DAEMON_HOST);
    assert.equal(address.family, "IPv4");
  } finally {
    await closeServer(server);
  }
});

test("production Operations routes reject browser origins and missing or wrong Bearer before principal-backed dispatch", async () => {
  const dispatched: string[] = [];
  const inertAutomation = {
    submit: async () => ({}),
    listDeliveries: () => [],
    interact: async () => ({}),
  };
  const handler = createAmbientV1HttpHandler({
    browser_capture: { submit: async () => ({}) },
    browser_automation: inertAutomation,
    mac_automation: {
      ...inertAutomation,
      listBrowserContextRequests: () => [],
      respondBrowserContext: () => ({}),
    },
    inbox_automation: {
      listDeliveries: () => [],
      interact: async () => ({}),
    },
    operation_access: new AmbientOperationAccess(operationAuthToken, [
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]),
    operations: {
      async handle(request) {
        dispatched.push(request.path);
        if (request.path.endsWith("/view.traverse")) throw new Error("trusted Operation fixture failed");
        const operation = request.path.slice(request.path.lastIndexOf("/") + 1) as (typeof OPERATION_NAMES)[number];
        return {
          status: 200,
          headers: protocolHeaders,
          body: { ok: true, request_id: "request:authorized", operation, data: {} },
        };
      },
    },
    observe: () => {},
  });
  const paths = [
    "/metaflow/v1/operations/view.get",
    "/metaflow/v1/operations/view.search",
    "/metaflow/v1/operations/capture.ingest",
    "/metaflow/v1/operations/privacy.forget.execute",
  ];
  const doctorResponse = await invokeHandler(
    handler,
    `/metaflow/v1/doctor?challenge=${fixtureChallenge}`,
    {},
    "GET",
  );
  assert.equal(doctorResponse.status, 200);
  assert.equal(doctorResponse.body.authentication.required, true);
  assert.equal(doctorResponse.body.authentication.scheme, "Bearer");
  assert.equal(doctorResponse.body.authentication.challenge_scheme, "HMAC-SHA256");
  assert.deepEqual(doctorResponse.body.catalog.operations, OPERATION_NAMES);
  for (const path of paths) {
    for (const authorization of [undefined, "arbitrary", "Bearer wrong-token"]) {
      const response = await invokeHandler(handler, path, { authorization });
      assert.equal(response.status, 401, `${path} accepted ${authorization ?? "missing auth"}`);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    const hostile = await invokeHandler(handler, path, {
      authorization: `Bearer ${operationAuthToken}`,
      origin: "https://hostile.example",
    });
    assert.equal(hostile.status, 403);
    assert.equal(hostile.body.code, "browser_origin_forbidden");
    assert.equal(hostile.headers["access-control-allow-origin"], undefined);
  }
  assert.deepEqual(dispatched, []);

  const trustedExtension = await invokeHandler(handler, paths[1]!, {
    authorization: `Bearer ${operationAuthToken}`,
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(trustedExtension.status, 200);
  assert.equal(
    trustedExtension.headers["access-control-allow-origin"],
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.notEqual(trustedExtension.headers["access-control-allow-origin"], "*");

  for (const authorization of [undefined, "Bearer stale-operation-token-at-least-32-bytes"]) {
    const trustedAuthFailure = await invokeHandler(handler, paths[1]!, {
      ...(authorization ? { authorization } : {}),
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    assert.equal(trustedAuthFailure.status, 401);
    assert.equal(
      trustedAuthFailure.headers["access-control-allow-origin"],
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.match(String(trustedAuthFailure.headers["www-authenticate"]), /^Bearer /u);
  }

  const trustedPreflight = await invokeHandler(handler, paths[1]!, {
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization, content-type, mcp-protocol-version",
  }, "OPTIONS");
  assert.equal(trustedPreflight.status, 204);
  assert.equal(
    trustedPreflight.headers["access-control-allow-origin"],
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.match(String(trustedPreflight.headers["access-control-allow-headers"]), /MCP-Protocol-Version/u);

  const hostilePreflight = await invokeHandler(handler, paths[1]!, {
    origin: "https://hostile.example",
    "access-control-request-method": "POST",
  }, "OPTIONS");
  assert.equal(hostilePreflight.status, 403);
  assert.equal(hostilePreflight.headers["access-control-allow-origin"], undefined);

  const excessivePreflight = await invokeHandler(handler, paths[1]!, {
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "access-control-request-method": "DELETE",
  }, "OPTIONS");
  assert.equal(excessivePreflight.status, 403);
  assert.equal(excessivePreflight.headers["access-control-allow-origin"], undefined);

  const authorized = await invokeHandler(handler, paths[0]!, {
    authorization: `Bearer ${operationAuthToken}`,
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(dispatched, [paths[1], paths[0]]);

  const trustedFailure = await invokeHandler(handler, "/metaflow/v1/operations/view.traverse", {
    authorization: `Bearer ${operationAuthToken}`,
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(trustedFailure.status, 500);
  assert.equal(
    trustedFailure.headers["access-control-allow-origin"],
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.notEqual(trustedFailure.headers["access-control-allow-origin"], "*");
});

test("DaemonOperationClient rejects non-loopback endpoints and impostors before an Operation request", async () => {
  assert.throws(
    () => new DaemonOperationClient({
      endpoint: new URL("http://127.0.0.1:3111"),
      token: `${"a".repeat(32)} `,
    }),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_token_invalid",
  );
  assert.throws(
    () => new DaemonOperationClient(new URL("http://192.0.2.10:3111")),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_url_invalid",
  );
  assert.throws(
    () => new DaemonOperationClient(new URL("http://[::1]:3111")),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_url_invalid",
  );
  assert.throws(
    () => new DaemonOperationClient(new URL("http://user:secret@127.0.0.1:3111")),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_url_invalid",
  );

  let unknownFetches = 0;
  const unknownClient = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: operationAuthToken,
    fetch: async () => {
      unknownFetches += 1;
      throw new Error("unknown Operation must not reach fetch");
    },
  });
  await assert.rejects(unknownClient.execute({ operation: "typo.operation", input: {} }, {}));
  assert.equal(unknownFetches, 0);

  const requests: string[] = [];
  const impostorAuthorization: Array<string | null> = [];
  const client = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: "must-not-reach-impostor-32-bytes",
    fetch: async (input, init) => {
      requests.push(String(input));
      impostorAuthorization.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({
        ...doctorForRequest("must-not-reach-impostor-32-bytes", input),
        server: { ...doctor.server, name: "impostor" },
      }), { status: 200, headers: protocolHeaders });
    },
  });
  await assert.rejects(
    client.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_server_mismatch",
  );
  assert.deepEqual(requests.map(value => new URL(value).pathname), ["/metaflow/v1/doctor"]);
  assert.deepEqual(impostorAuthorization, [null]);

  const exactMimicAuthorization: Array<string | null> = [];
  const exactMimic = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: "client-only-token-at-least-32-bytes",
    fetch: async (input, init) => {
      exactMimicAuthorization.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify(doctorForRequest(operationAuthToken, input)), { status: 200, headers: protocolHeaders });
    },
  });
  await assert.rejects(
    exactMimic.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_credential_mismatch",
  );
  assert.deepEqual(exactMimicAuthorization, [null]);

  let replacementRequest = 0;
  const replacementAuthorization: Array<string | null> = [];
  const replacementClient = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: operationAuthToken,
    fetch: async (input, init) => {
      replacementRequest += 1;
      replacementAuthorization.push(new Headers(init?.headers).get("authorization"));
      if (replacementRequest === 1) {
        return new Response(JSON.stringify(doctorForRequest(operationAuthToken, input)), { status: 200, headers: protocolHeaders });
      }
      return new Response(JSON.stringify({
        ...doctorForRequest(operationAuthToken, input),
        server: { ...doctor.server, origin: new URL(String(input)).origin, name: "replacement-listener" },
      }), { status: 200, headers: protocolHeaders });
    },
  });
  await replacementClient.negotiate();
  await assert.rejects(
    replacementClient.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_server_mismatch",
  );
  assert.deepEqual(replacementAuthorization, [null, null]);
});

test("DaemonOperationClient enforces timeout, token, protocol, status, and exact Operation", async () => {
  const timeoutClient = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    timeout_ms: 100,
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  });
  await assert.rejects(
    timeoutClient.negotiate(),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_unreachable",
  );

  const authorization: Array<string | null> = [];
  let request = 0;
  const client = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: "local-token-at-least-32-bytes-long",
    fetch: async (input, init) => {
      request += 1;
      authorization.push(new Headers(init?.headers).get("authorization"));
      if (request === 1) return new Response(JSON.stringify(doctorForRequest("local-token-at-least-32-bytes-long", input)), { status: 200, headers: protocolHeaders });
      return new Response(JSON.stringify({
        ok: true,
        request_id: "request:wrong-operation",
        operation: "view.get",
        data: {},
      }), { status: 200, headers: protocolHeaders });
    },
  });
  await assert.rejects(
    client.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_envelope_invalid",
  );
  assert.deepEqual(authorization, [null, "Bearer local-token-at-least-32-bytes-long"]);

  let statusRequest = 0;
  const statusClient = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: operationAuthToken,
    fetch: async input => {
      statusRequest += 1;
      if (statusRequest === 1) return new Response(JSON.stringify(doctorForRequest(operationAuthToken, input)), { status: 200, headers: protocolHeaders });
      return new Response(JSON.stringify({
        ok: true,
        request_id: "request:status-mismatch",
        operation: "catalog.list",
        data: [],
      }), { status: 502, headers: protocolHeaders });
    },
  });
  await assert.rejects(
    statusClient.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_status_mismatch",
  );

  let missingOperationRequest = 0;
  const missingOperationClient = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: operationAuthToken,
    fetch: async input => {
      missingOperationRequest += 1;
      if (missingOperationRequest === 1) {
        return new Response(JSON.stringify(doctorForRequest(operationAuthToken, input)), { status: 200, headers: protocolHeaders });
      }
      return new Response(JSON.stringify({
        ok: false,
        request_id: "request:missing-operation",
        error: { code: "operation_failed", message: "Missing correlation", category: "internal", details: {} },
      }), { status: 500, headers: protocolHeaders });
    },
  });
  await assert.rejects(
    missingOperationClient.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_envelope_invalid",
  );
});

test("the retained stdio MCP proxy exits without exposing tools when doctor identifies an impostor", async () => {
  const paths: string[] = [];
  const authorizations: Array<string | undefined> = [];
  let doctorResponse = (challenge: string, origin: string) => ({
    ...doctorFor("must-not-reach-impostor-32-bytes", challenge, origin),
    server: { ...doctor.server, origin, name: "impostor" },
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    paths.push(requestUrl.pathname);
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json", ...protocolHeaders });
    response.end(JSON.stringify(doctorResponse(
      requestUrl.searchParams.get("challenge") ?? "",
      localOrigin(request),
    )));
  });
  try {
    await listenAmbientDaemon(server, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await runProcess(process.execPath, [
      "--no-warnings",
      "--experimental-sqlite",
      "--import",
      "tsx",
      join(process.cwd(), "scripts/v1/operations-mcp.ts"),
    ], {
      ...process.env,
      METAFLOW_DAEMON_URL: `http://${AMBIENT_DAEMON_HOST}:${address.port}`,
      METAFLOW_AUTH_TOKEN: "must-not-reach-impostor-32-bytes",
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("must-not-reach-impostor"), false);
    assert.deepEqual(paths, ["/metaflow/v1/doctor"]);
    assert.deepEqual(authorizations, [undefined]);

    paths.length = 0;
    authorizations.length = 0;
    const emptyToken = await runProcess(process.execPath, [
      "--no-warnings",
      "--experimental-sqlite",
      "--import",
      "tsx",
      join(process.cwd(), "scripts/v1/operations-mcp.ts"),
    ], {
      ...process.env,
      METAFLOW_DAEMON_URL: `http://${AMBIENT_DAEMON_HOST}:${address.port}`,
      METAFLOW_AUTH_TOKEN: "",
    });
    assert.notEqual(emptyToken.status, 0);
    assert.equal(emptyToken.stdout, "");
    assert.deepEqual(paths, []);

    doctorResponse = (challenge, origin) => ({
      ...doctorFor("must-not-reach-impostor-32-bytes", challenge, origin),
      authentication: { ...doctorFor("must-not-reach-impostor-32-bytes", challenge, origin).authentication, required: false },
      server: { ...doctor.server, origin },
    });
    const authNotRequired = await runProcess(process.execPath, [
      "--no-warnings",
      "--experimental-sqlite",
      "--import",
      "tsx",
      join(process.cwd(), "scripts/v1/operations-mcp.ts"),
    ], {
      ...process.env,
      METAFLOW_DAEMON_URL: `http://${AMBIENT_DAEMON_HOST}:${address.port}`,
      METAFLOW_AUTH_TOKEN: "must-not-reach-impostor-32-bytes",
    });
    assert.notEqual(authNotRequired.status, 0);
    assert.deepEqual(paths, ["/metaflow/v1/doctor"]);
    assert.deepEqual(authorizations, [undefined]);
  } finally {
    await closeServer(server);
  }
});

test("the retained stdio MCP proxy rejects an unknown tool without an Operation request", async () => {
  const paths: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    paths.push(requestUrl.pathname);
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json", ...protocolHeaders });
    response.end(JSON.stringify(doctorFor(
      operationAuthToken,
      requestUrl.searchParams.get("challenge") ?? "",
      localOrigin(request),
    )));
  });
  try {
    await listenAmbientDaemon(server, 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--no-warnings",
        "--experimental-sqlite",
        "--import",
        "tsx",
        join(process.cwd(), "scripts/v1/operations-mcp.ts"),
      ],
      env: {
        ...process.env,
        METAFLOW_DAEMON_URL: `http://${AMBIENT_DAEMON_HOST}:${address.port}`,
        METAFLOW_AUTH_TOKEN: operationAuthToken,
      } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "unknown-operation-security", version: "0.1.0" });
    await client.connect(transport);
    try {
      await assert.rejects(
        client.callTool({ name: "metaflow_typo_operation", arguments: {} }),
        /Unknown Metaflow Operation tool/u,
      );
      assert.deepEqual(paths, ["/metaflow/v1/doctor"]);
      assert.deepEqual(authorizations, [undefined]);
    } finally {
      await client.close();
    }
  } finally {
    await closeServer(server);
  }
});

function doctorFor(token: string, challenge = fixtureChallenge, endpointOrigin = fixtureOrigin) {
  return {
    ...doctor,
    server: { ...doctor.server, origin: endpointOrigin },
    authentication: {
      ...doctor.authentication,
      challenge,
      proof: doctorAuthenticationProof(token, challenge, endpointOrigin),
    },
  };
}

function doctorForRequest(token: string, input: RequestInfo | URL) {
  const url = new URL(String(input));
  const challenge = url.searchParams.get("challenge") ?? "";
  return doctorFor(token, challenge, url.origin);
}

function localOrigin(request: import("node:http").IncomingMessage): string {
  return new URL(`http://127.0.0.1:${request.socket.localPort}`).origin;
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function invokeHandler(
  handler: (request: any, response: any) => Promise<void>,
  path: string,
  headers: {
    authorization?: string;
    origin?: string;
    "access-control-request-method"?: string;
    "access-control-request-headers"?: string;
  },
  method = "POST",
) {
  const request = Readable.from(["{}"]) as any;
  request.method = method;
  request.url = path;
  request.headers = { host: "127.0.0.1", "content-type": "application/json", ...headers };
  request.socket = { localAddress: "127.0.0.1", localPort: 3111 };
  let status = 0;
  let responseHeaders: Record<string, string> = {};
  let raw = "";
  const response = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
      status = nextStatus;
      responseHeaders = nextHeaders;
    },
    end(value: string) { raw = value; },
  };
  await handler(request, response);
  return { status, headers: responseHeaders, body: raw ? JSON.parse(raw) : undefined };
}

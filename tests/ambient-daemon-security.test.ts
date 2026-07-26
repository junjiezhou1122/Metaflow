import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  AMBIENT_DAEMON_HOST,
  listenAmbientDaemon,
} from "../apps/ambient-daemon/index.ts";
import {
  DaemonOperationClient,
  DaemonWireError,
} from "../packages/adapters/operation-surfaces/daemon.ts";

const protocolHeaders = { "x-metaflow-protocol-version": "1" };
const doctor = {
  ok: true,
  protocol: { name: "metaflow-operations-http", version: 1 },
  server: { name: "ambient-daemon", version: "0.1.0" },
  authentication: { source: "composition_principal", required: false },
  endpoints: { operations: "/metaflow/v1/operations/", mcp: "/mcp" },
} as const;

test("the canonical ambient listener binds only the explicit IPv4 loopback contract", async () => {
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

test("DaemonOperationClient rejects non-loopback endpoints and impostors before an Operation request", async () => {
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

  const requests: string[] = [];
  const impostorAuthorization: Array<string | null> = [];
  const client = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    token: "must-not-reach-impostor",
    fetch: async (input, init) => {
      requests.push(String(input));
      impostorAuthorization.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({
        ...doctor,
        server: { ...doctor.server, name: "impostor" },
      }), { status: 200, headers: protocolHeaders });
    },
  });
  await assert.rejects(
    client.execute({ operation: "catalog.list", input: {} }, {}),
    (error: unknown) => error instanceof DaemonWireError && error.code === "daemon_doctor_invalid",
  );
  assert.deepEqual(requests.map(value => new URL(value).pathname), ["/metaflow/v1/doctor"]);
  assert.deepEqual(impostorAuthorization, [null]);
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
    token: "local-token",
    fetch: async (_input, init) => {
      request += 1;
      authorization.push(new Headers(init?.headers).get("authorization"));
      if (request === 1) return new Response(JSON.stringify(doctor), { status: 200, headers: protocolHeaders });
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
  assert.deepEqual(authorization, [null, "Bearer local-token"]);

  let statusRequest = 0;
  const statusClient = new DaemonOperationClient({
    endpoint: new URL("http://127.0.0.1:3111"),
    fetch: async () => {
      statusRequest += 1;
      if (statusRequest === 1) return new Response(JSON.stringify(doctor), { status: 200, headers: protocolHeaders });
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
});

test("the retained stdio MCP proxy exits without exposing tools when doctor identifies an impostor", async () => {
  const paths: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    paths.push(new URL(request.url ?? "/", "http://localhost").pathname);
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json", ...protocolHeaders });
    response.end(JSON.stringify({ ...doctor, server: { ...doctor.server, name: "impostor" } }));
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
      METAFLOW_AUTH_TOKEN: "must-not-reach-impostor",
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
  } finally {
    await closeServer(server);
  }
});

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

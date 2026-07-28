import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  GrantOperationAuthorizer,
  OperationService,
  RepositoryViewReadAuthorizer,
  ViewQueryRegistry,
} from "@info/operations";
import { ScreenpipeFrameAssetResolver } from "@info/screenpipe-capture-adapter";
import { ScreenpipeTimelineQueryMethod } from "@info/screenpipe-derived-views";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  SCREENPIPE_TIMELINE_INDEX_SCHEMA,
  SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
  SCREENPIPE_TIMELINE_QUERY_PROFILE,
} from "@info/view-package-screenpipe-timeline";
import { SearchService } from "@info/search";
import { createServer as createViteServer } from "vite";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const HOST = "127.0.0.1";

const commandArguments = process.argv.slice(2);
if (commandArguments[0] === "--") commandArguments.shift();
const { values } = parseArgs({
  args: commandArguments,
  options: {
    database: { type: "string" },
    root: { type: "string" },
    port: { type: "string", default: "5193" },
  },
  strict: true,
  allowPositionals: false,
});
if (!values.database || !values.root) {
  throw new TypeError("view-explorer:real requires --database and exact --root=view_id@revision");
}
const sourcePath = resolve(values.database);
if (!existsSync(sourcePath)) throw new Error(`View Explorer database does not exist: ${sourcePath}`);
const rootRef = parseExactRef(values.root);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("View Explorer port must be a valid TCP port");

const temporaryDirectory = await mkdtemp(join(tmpdir(), "metaflow-view-explorer-real-"));
const snapshotPath = join(temporaryDirectory, "metaflow.sqlite");
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, snapshotPath);
} finally {
  source.close();
}

const views = new SqliteViewRepository(snapshotPath);
const exactRoot = await views.get(rootRef);
if (!exactRoot) {
  views.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw new Error(`Exact View does not exist in the database snapshot: ${values.root}`);
}
const reads = new RepositoryViewReadAuthorizer(views);
const unavailable = unavailablePort();
const search = new SearchService({
  authorization: reads,
  scope_source: views.search,
  descriptors: views.search,
  keyword: views.search,
  observer: { async record(event) {
    console.info(JSON.stringify({ component: "view-explorer-real-search", ...event }));
  } },
});
const operations = new OperationService({
  views,
  graph: views.search,
  search,
  view_reads: reads,
  view_queries: new ViewQueryRegistry([
    new ScreenpipeTimelineQueryMethod(views, {
      profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
      subject_schema: {
        name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name,
        version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version,
      },
      parameters: SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
    }),
  ]),
  transformations: unavailable,
  execution: unavailable,
  runs: unavailable,
  feedback: unavailable,
  privacy: unavailable,
  capture: unavailable,
  connector_onboarding: unavailable,
  capture_traces: unavailable,
  authoring: unavailable,
  authorization: new GrantOperationAuthorizer(),
  observer: { async record(event) {
    console.info(JSON.stringify({ component: "view-explorer-real", ...event }));
  } },
});

const explorerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDirectory = join(temporaryDirectory, "vite-cache");
await mkdir(cacheDirectory, { recursive: true });
const server = createServer();
const vite = await createViteServer({
  root: explorerRoot,
  cacheDir: cacheDirectory,
  logLevel: "error",
  appType: "spa",
  server: {
    middlewareMode: { server },
    ws: { server },
  },
});
const sessionToken = randomBytes(32).toString("base64url");
const sessionPath = `/__metaflow_view_session/${sessionToken}`;
const sessionCookie = `metaflow_view_session=${sessionToken}`;
let origin = "";
let screenpipeToken: string | undefined;
server.on("request", (request, response) => {
  void handle(request, response).catch(error => {
    console.error(JSON.stringify({
      component: "view-explorer-real",
      event: "request.failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : String(error),
    }));
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "view_explorer_real_request_failed" }));
  });
});

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(port, HOST, () => {
    server.off("error", reject);
    resolveListen();
  });
});
origin = `http://${HOST}:${port}`;
const destination = new URL(sessionPath, origin);
destination.searchParams.set("root", `${rootRef.view_id}@${rootRef.revision}`);
destination.searchParams.set("selected", `${rootRef.view_id}@${rootRef.revision}`);
console.log(JSON.stringify({
  component: "view-explorer-real",
  event: "server.ready",
  source_database: sourcePath,
  snapshot_database: snapshotPath,
  exact_root: rootRef,
  url: destination.toString(),
}));

let closing: Promise<void> | undefined;
function close(): Promise<void> {
  if (closing) return closing;
  closing = new Promise<void>((resolveClose, reject) => {
    server.closeAllConnections?.();
    server.close(error => error ? reject(error) : resolveClose());
  }).then(async () => {
    await vite.close();
    views.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  return closing;
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", origin || `http://${HOST}:${port}`);
  if (requestUrl.pathname === sessionPath) {
    response.writeHead(302, {
      location: `/?root=${encodeURIComponent(`${rootRef.view_id}@${rootRef.revision}`)}&selected=${encodeURIComponent(`${rootRef.view_id}@${rootRef.revision}`)}`,
      "set-cookie": `${sessionCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
      "cache-control": "no-store",
    });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/metaflow/v1/assets/screenpipe-frame-thumbnail") {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    if (!authorizeSessionRequest(request, response)) return;
    const ref = {
      view_id: requestUrl.searchParams.get("view_id") ?? "",
      revision: Number(requestUrl.searchParams.get("revision")),
    };
    const width = Number(requestUrl.searchParams.get("width") ?? 1_440);
    if (!ref.view_id || !Number.isInteger(ref.revision) || ref.revision < 1
      || !Number.isInteger(width) || width < 384 || width > 1_920) {
      writeProblem(response, 400, "screenpipe_asset_request_invalid", "An exact frame View and width from 384 through 1920 are required");
      return;
    }
    const [decision] = await reads.authorize({ principal: { id: "user:local" }, refs: [ref], purpose: "read" });
    if (decision?.status !== "allowed") {
      writeProblem(response, decision?.status === "missing" ? 404 : 403, decision?.code ?? "screenpipe_asset_forbidden", "Screenpipe frame View is not authorized");
      return;
    }
    const view = await views.get(ref);
    if (!view) throw new Error(`Authorized Screenpipe frame disappeared: ${ref.view_id}@${ref.revision}`);
    const connectionId = view.provenance.capture?.connection_id;
    if (!connectionId) throw new Error(`Screenpipe frame omitted Capture connection evidence: ${ref.view_id}@${ref.revision}`);
    const lifecycle = await views.getCaptureConnectionLifecycle(connectionId);
    if (!lifecycle) throw new Error(`Screenpipe frame connection is unavailable: ${connectionId}`);
    const asset = await new ScreenpipeFrameAssetResolver({
      connection: lifecycle.connection,
      secret_resolver: {
        async resolve(refValue) {
          const expected = lifecycle.connection.secret_refs.screenpipe_api_key;
          if (!expected || refValue.provider !== expected.provider || refValue.key !== expected.key || refValue.version !== expected.version) {
            throw new Error("Screenpipe asset requested an undeclared local secret reference");
          }
          screenpipeToken ??= readScreenpipeToken();
          return screenpipeToken;
        },
      },
    }).thumbnail(view, { width, quality: 90 }, AbortSignal.timeout(15_000));
    response.writeHead(200, {
      "content-type": asset.media_type,
      "content-length": String(asset.body.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
      ...(asset.etag ? { etag: asset.etag } : {}),
    });
    response.end(asset.body);
    return;
  }
  if (requestUrl.pathname.startsWith("/metaflow/v1/operations/")) {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const operation = decodeURIComponent(requestUrl.pathname.slice("/metaflow/v1/operations/".length));
    const requestId = `request:view-explorer-real:${randomUUID()}`;
    if (!request.headers.cookie?.split(/;\s*/u).includes(sessionCookie)) {
      writeOperationFailure(response, 401, {
        request_id: requestId,
        operation,
        code: "view_explorer_session_required",
        message: "View Explorer session expired; reopen the server launch URL",
      });
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin) {
      writeOperationFailure(response, 403, {
        request_id: requestId,
        operation,
        code: "view_explorer_origin_forbidden",
        message: "View Explorer rejected a cross-origin Operation request",
      });
      return;
    }
    const input = JSON.parse((await readBoundedBody(request)).toString("utf8"));
    const envelope = await operations.execute(
      { operation, input },
      { request_id: requestId, principal: { id: "user:local", grants: ["*"] } },
    );
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(envelope));
    return;
  }
  await new Promise<void>((resolveMiddleware, reject) => {
    const complete = () => {
      response.off("finish", complete);
      response.off("close", complete);
      resolveMiddleware();
    };
    response.once("finish", complete);
    response.once("close", complete);
    vite.middlewares(request, response, (error: unknown) => {
      response.off("finish", complete);
      response.off("close", complete);
      if (error) reject(error); else resolveMiddleware();
    });
  });
}

function authorizeSessionRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (!request.headers.cookie?.split(/;\s*/u).includes(sessionCookie)) {
    writeProblem(response, 401, "view_explorer_session_required", "View Explorer session expired; reopen the server launch URL");
    return false;
  }
  if (request.headers.origin && request.headers.origin !== origin) {
    writeProblem(response, 403, "view_explorer_origin_forbidden", "View Explorer rejected a cross-origin asset request");
    return false;
  }
  return true;
}

function writeProblem(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ ok: false, code, error: message }));
}

function readScreenpipeToken(): string {
  const result = spawnSync(process.env.SCREENPIPE_CLI ?? "screenpipe", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.error || result.signal || result.status !== 0) throw new Error("Unable to obtain the local Screenpipe API token");
  const token = result.stdout.trim();
  if (!token || /[\r\n]/u.test(token)) throw new Error("Screenpipe returned an invalid local API token");
  return token;
}

function writeOperationFailure(
  response: ServerResponse,
  status: 401 | 403,
  failure: { request_id: string; operation: string; code: string; message: string },
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({
    ok: false,
    request_id: failure.request_id,
    operation: failure.operation,
    error: {
      code: failure.code,
      message: failure.message,
      category: "forbidden",
      details: {},
    },
  }));
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    received += chunk.length;
    if (received > MAX_REQUEST_BYTES) throw new Error("View Explorer Operation request exceeded 2 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

function parseExactRef(value: string): { view_id: string; revision: number } {
  const separator = value.lastIndexOf("@");
  const viewId = value.slice(0, separator);
  const revision = Number(value.slice(separator + 1));
  if (!viewId || separator < 1 || !Number.isInteger(revision) || revision < 1) {
    throw new TypeError(`View Explorer root must be exact view_id@revision: ${value}`);
  }
  return { view_id: viewId, revision };
}

function unavailablePort(): never {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`Real View Explorer accessed an unrelated Operation dependency: ${String(property)}`);
    },
  }) as never;
}

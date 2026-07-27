import type { IncomingMessage, ServerResponse } from "node:http";
import {
  METAFLOW_HTTP_PROTOCOL_VERSION,
  type HttpOperationAdapter,
} from "@info/operation-surfaces";
import type { AmbientOperationAccess } from "./operation-access.js";

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

type HttpRequest = IncomingMessage;
type HttpResponse = ServerResponse;

type BrowserCaptureHttpPort = {
  submit(input: unknown): Promise<unknown>;
};

type AutomationHttpPort = {
  submit(input: unknown): Promise<unknown>;
  listDeliveries(input: { after?: string; limit?: number }): Promise<unknown> | unknown;
  interact(input: unknown): Promise<unknown>;
};

type MacAutomationHttpPort = AutomationHttpPort & {
  listBrowserContextRequests(): Promise<unknown> | unknown;
  respondBrowserContext(input: unknown): Promise<unknown> | unknown;
};

type InboxAutomationHttpPort = {
  listDeliveries(input: { after?: string; limit?: number }): Promise<unknown> | unknown;
  interact(input: unknown): Promise<unknown>;
};

export type AmbientV1HttpHandlerOptions = {
  browser_capture: BrowserCaptureHttpPort;
  browser_automation: AutomationHttpPort;
  mac_automation: MacAutomationHttpPort;
  inbox_automation: InboxAutomationHttpPort;
  operations: Pick<HttpOperationAdapter, "handle">;
  operation_access: Pick<AmbientOperationAccess, "authorize" | "authorizePreflight" | "doctor">;
  observe?: (event: AmbientHttpEvent, cause?: unknown) => void | Promise<void>;
};

export type AmbientHttpEvent = {
  type: "http.request_completed" | "http.request_failed";
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  code?: string;
};

export function createAmbientV1HttpHandler(options: AmbientV1HttpHandlerOptions) {
  assertMethod(options.browser_capture, "submit", "Browser Capture");
  for (const method of ["submit", "listDeliveries", "interact"] as const) {
    assertMethod(options.browser_automation, method, "Browser Automation");
    assertMethod(options.mac_automation, method, "macOS Automation");
  }
  assertMethod(options.mac_automation, "listBrowserContextRequests", "macOS Browser context bridge");
  assertMethod(options.mac_automation, "respondBrowserContext", "macOS Browser context bridge");
  assertMethod(options.inbox_automation, "listDeliveries", "Inbox Automation");
  assertMethod(options.inbox_automation, "interact", "Inbox Automation");
  assertMethod(options.operations, "handle", "Operation HTTP adapter");
  assertMethod(options.operation_access, "authorize", "Operation access");
  assertMethod(options.operation_access, "authorizePreflight", "Operation access");
  assertMethod(options.operation_access, "doctor", "Operation access");
  return async (request: HttpRequest, response: HttpResponse): Promise<void> => {
    const startedAt = Date.now();
    const method = request.method?.toUpperCase() ?? "GET";
    const requestUrl = request.url ?? "/";
    let path = requestUrl;
    let status = 500;
    let code: string | undefined;
    let failureCause: unknown;
    let operationResponseHeaders: Record<string, string> = {};
    try {
      const url = new URL(requestUrl, `http://${request.headers.host ?? "localhost"}`);
      path = url.pathname;
      if (method === "OPTIONS" && !isPrivilegedOperationPath(path)) {
        status = 204;
        return sendForPath(response, path, status, {});
      }
      if (method === "OPTIONS" && isPrivilegedOperationPath(path)) {
        const access = options.operation_access.authorizePreflight(request.headers);
        status = access.allowed ? 204 : access.status;
        if (!access.allowed) code = access.code;
        return sendForPath(
          response,
          path,
          status,
          access.allowed ? {} : problem(access.code, access.message),
          access.headers,
        );
      }
      if (method === "GET" && path === "/health") {
        status = 200;
        return sendForPath(response, path, status, { ok: true, architecture: "metaflow-v1" });
      }
      if (method === "GET" && path === "/metaflow/v1/doctor") {
        status = 200;
        return sendForPath(response, path, status, options.operation_access.doctor(
          operationEndpointOrigin(request),
          url.searchParams.get("challenge"),
        ), {
          "x-metaflow-protocol-version": String(METAFLOW_HTTP_PROTOCOL_VERSION),
        });
      }

      if (isPrivilegedOperationPath(path)) {
        const access = options.operation_access.authorize(request.headers);
        if (!access.allowed) {
          status = access.status;
          code = access.code;
          return sendForPath(response, path, status, problem(code, access.message), access.headers);
        }
        operationResponseHeaders = access.headers ?? {};
      }

      const exactView = path.match(/^\/context\/v1\/views\/([^/]+)$/);
      if (method === "GET" && exactView) {
        const revision = Number(url.searchParams.get("revision"));
        if (!Number.isInteger(revision) || revision < 1) {
          status = 400;
          code = "exact_view_revision_required";
          return sendForPath(response, path, status, problem(code, "A positive exact View revision is required"), operationResponseHeaders);
        }
        const viewId = decodeURIComponent(exactView[1]!);
        const operation = await options.operations.handle({
          method: "POST",
          path: "/metaflow/v1/operations/view.get",
          body: { ref: { view_id: viewId, revision } },
        });
        status = operation.status;
        if (operation.body.ok) return sendForPath(response, path, status, { ok: true, view: operation.body.data }, operationResponseHeaders);
        code = operation.body.error.code === "view_not_found" ? "exact_view_not_found" : operation.body.error.code;
        return sendForPath(response, path, status, problem(code, operation.body.error.message, operation.body.error.details), operationResponseHeaders);
      }

      if (method === "POST" && path === "/capture/v1/browser-events") {
        const result = await options.browser_capture.submit(await readJson(request));
        status = browserCaptureSuccessStatus(result);
        return sendForPath(response, path, status, { ok: true, result });
      }

      if (method === "POST" && path === "/automation/v1/browser-signals") {
        const result = await options.browser_automation.submit(await readJson(request));
        status = 200;
        return sendForPath(response, path, status, { ok: true, result });
      }
      if (method === "GET" && path === "/automation/v1/browser-deliveries") {
        const deliveries = await options.browser_automation.listDeliveries(deliveryQuery(url));
        status = 200;
        return sendForPath(response, path, status, { ok: true, deliveries });
      }
      if (method === "POST" && path === "/automation/v1/browser-interactions") {
        const result = await options.browser_automation.interact(await readJson(request));
        status = 200;
        return sendForPath(response, path, status, { ok: true, result });
      }

      if (method === "POST" && path === "/automation/v1/macos/voice-signals") {
        const result = await options.mac_automation.submit(await readJson(request));
        status = 200;
        return sendForPath(response, path, status, { ok: true, result });
      }
      if (method === "GET" && path === "/automation/v1/macos/deliveries") {
        const deliveries = await options.mac_automation.listDeliveries(deliveryQuery(url));
        status = 200;
        return sendForPath(response, path, status, { ok: true, deliveries });
      }
      if (method === "POST" && path === "/automation/v1/macos/interactions") {
        const result = await options.mac_automation.interact(await readJson(request));
        status = 200;
        return sendForPath(response, path, status, { ok: true, result });
      }
      if (method === "GET" && path === "/automation/v1/macos/browser-context-requests") {
        const requests = await options.mac_automation.listBrowserContextRequests();
        status = 200;
        return sendForPath(response, path, status, { ok: true, requests });
      }
      if (method === "POST" && path === "/automation/v1/macos/browser-context-responses") {
        const result = await options.mac_automation.respondBrowserContext(await readJson(request));
        status = 200;
        return sendForPath(response, path, status, { ok: true, result });
      }

      if (method === "GET" && path === "/automation/v1/inbox/deliveries") {
        const deliveries = await options.inbox_automation.listDeliveries(deliveryQuery(url));
        status = 200;
        return sendForPath(response, path, status, { ok: true, deliveries });
      }
      if (method === "POST" && path === "/automation/v1/inbox/interactions") {
        const result = await options.inbox_automation.interact(await readJson(request));
        status = 200;
        return sendForPath(response, path, status, { ok: true, result });
      }

      if (method === "POST" && path.startsWith("/metaflow/v1/operations/")) {
        const operation = await options.operations.handle({
          method,
          path,
          body: await readJson(request),
        });
        status = operation.status;
        return sendForPath(response, path, status, operation.body, {
          ...operation.headers,
          ...operationResponseHeaders,
        });
      }

      status = 404;
      code = "route_not_found";
      return sendForPath(response, path, status, problem(code, `No Metaflow v1 route for ${method} ${path}`));
    } catch (cause) {
      failureCause = cause;
      const failure = routeFailure(path, cause);
      status = failure.status;
      code = failure.code;
      sendForPath(
        response,
        path,
        status,
        problem(code, failure.message, failure.details),
        operationResponseHeaders,
      );
      return;
    } finally {
      await observe(options, {
        type: failureCause === undefined && status < 400 ? "http.request_completed" : "http.request_failed",
        method,
        path,
        status,
        duration_ms: Date.now() - startedAt,
        ...(code ? { code } : {}),
      }, failureCause);
    }
  };
}

function assertMethod(value: unknown, method: string, owner: string): void {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>)[method] !== "function") {
    throw new TypeError(`${owner} composition requires ${method}()`);
  }
}

function deliveryQuery(url: URL): { after?: string; limit?: number } {
  const after = url.searchParams.get("after") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  return {
    ...(after ? { after } : {}),
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
  };
}

async function readJson(request: HttpRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_JSON_BODY_BYTES) {
      const error = new Error(`JSON request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
      Object.assign(error, { code: "request_body_too_large" });
      throw error;
    }
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    const error = new Error("Request body must be valid JSON", { cause });
    Object.assign(error, { code: "invalid_json" });
    throw error;
  }
}

function send(
  response: HttpResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendForPath(
  response: HttpResponse,
  path: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const corsHeaders: Record<string, string> = isPrivilegedOperationPath(path) ? {} : {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Content-Type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  send(response, status, body, { ...corsHeaders, ...headers });
}

function isPrivilegedOperationPath(path: string): boolean {
  return path.startsWith("/metaflow/v1/operations/") || path.startsWith("/context/v1/views/");
}

function operationEndpointOrigin(request: HttpRequest): string {
  const address = request.socket.localAddress;
  const port = request.socket.localPort;
  if (address !== "127.0.0.1" || !Number.isInteger(port) || !port || port < 1 || port > 65_535) {
    const error = new Error("Doctor requires the canonical IPv4 loopback listener identity");
    Object.assign(error, { code: "daemon_listener_identity_invalid" });
    throw error;
  }
  return new URL(`http://127.0.0.1:${port}`).origin;
}

function problem(code: string, error: string, details?: unknown) {
  return { ok: false, code, error, ...(details === undefined ? {} : { details }) };
}

function browserCaptureSuccessStatus(result: unknown): 200 | 201 | 202 {
  if (!result || typeof result !== "object") return 200;
  const submission = result as {
    status?: unknown;
    replayed?: unknown;
    captured_views?: Array<{ created?: unknown }>;
  };
  if (submission.status === "skipped") return 202;
  if (submission.replayed !== true && submission.captured_views?.some(view => view.created === true)) return 201;
  return 200;
}

function routeFailure(path: string, cause: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  const code = errorCode(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  const details = errorDetails(cause);
  if (code === "request_body_too_large") return { status: 413, code, message, details };
  if (code === "invalid_json") return { status: 400, code, message, details };
  if (path === "/metaflow/v1/doctor" && code === "daemon_doctor_challenge_invalid") {
    return { status: 400, code, message, details };
  }
  if (path === "/capture/v1/browser-events") {
    return { status: browserCaptureHttpStatus(code), code, message, details };
  }
  if (path === "/automation/v1/browser-signals") {
    return { status: browserAutomationHttpStatus(code), code, message, details };
  }
  if (path === "/automation/v1/macos/voice-signals") {
    return { status: macAutomationHttpStatus(code), code, message, details };
  }
  if (path.endsWith("/interactions")) {
    return { status: code === "unknown_delivery" ? 404 : code === "trace_failed" ? 500 : 400, code, message, details };
  }
  if (path.endsWith("/deliveries")) {
    const surface = path.includes("/browser/") ? "browser" : path.includes("/macos/") ? "macos" : "inbox";
    return { status: 400, code: `invalid_${surface}_delivery_query`, message, details };
  }
  if (path === "/automation/v1/macos/browser-context-responses") {
    return { status: 400, code: "browser_context_response_rejected", message, details };
  }
  return { status: 500, code, message, details };
}

function browserAutomationHttpStatus(code: string): 400 | 409 | 422 | 500 {
  if (code === "invalid_browser_event") return 400;
  if (code === "required_evidence_not_stored") return 422;
  if (code === "idempotency_conflict" || code === "source_identity_conflict") return 409;
  return 500;
}

function browserCaptureHttpStatus(code: string): 400 | 409 | 429 | 500 {
  if (["invalid_browser_capture_event", "capture_validation_failed", "connector_mismatch", "unsupported_delivery"].includes(code)) return 400;
  if (["idempotency_conflict", "source_identity_conflict", "checkpoint_conflict", "connection_paused"].includes(code)) return 409;
  if (code === "backpressure") return 429;
  return 500;
}

function macAutomationHttpStatus(code: string): 400 | 403 | 409 | 422 | 504 | 500 {
  if (code === "invalid_macos_event") return 400;
  if (code === "accessibility_denied") return 403;
  if (code === "asr_failed" || code === "unknown_agent") return 422;
  if (code === "idempotency_conflict" || code === "source_identity_conflict") return 409;
  if (code === "browser_context_failed") return 504;
  return 500;
}

function errorCode(cause: unknown): string {
  if (!cause || typeof cause !== "object") return "internal_error";
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && code ? code : "internal_error";
}

function errorDetails(cause: unknown): unknown {
  if (!cause || typeof cause !== "object") return undefined;
  return (cause as { details?: unknown }).details;
}

async function observe(options: AmbientV1HttpHandlerOptions, event: AmbientHttpEvent, cause?: unknown): Promise<void> {
  if (options.observe) {
    await options.observe(event, cause);
    return;
  }
  const output = {
    component: "ambient-v1-http",
    ...event,
    ...(cause instanceof Error ? { cause: { name: cause.name, message: cause.message } } : {}),
  };
  console[event.type === "http.request_failed" ? "error" : "info"](JSON.stringify(output));
}

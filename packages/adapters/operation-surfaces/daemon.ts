import { z } from "zod";
import {
  OperationEnvelopeSchema,
  OperationRequestSchema,
  type OperationEnvelope,
  type OperationName,
} from "@info/operations";

export const METAFLOW_HTTP_PROTOCOL_NAME = "metaflow-operations-http" as const;
export const METAFLOW_HTTP_PROTOCOL_VERSION = 1 as const;
export const METAFLOW_AMBIENT_SERVER_NAME = "ambient-daemon" as const;
export const METAFLOW_AMBIENT_SERVER_VERSION = "0.1.0" as const;
export const DEFAULT_DAEMON_TIMEOUT_MS = 10_000;
export const OPERATION_HTTP_STATUS_BY_CATEGORY = {
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  failed_dependency: 502,
  internal: 500,
} as const;

export const MetaflowDaemonDoctorSchema = z.object({
  ok: z.literal(true),
  protocol: z.object({
    name: z.literal(METAFLOW_HTTP_PROTOCOL_NAME),
    version: z.literal(METAFLOW_HTTP_PROTOCOL_VERSION),
  }).strict(),
  server: z.object({
    name: z.literal(METAFLOW_AMBIENT_SERVER_NAME),
    version: z.literal(METAFLOW_AMBIENT_SERVER_VERSION),
  }).strict(),
  authentication: z.object({
    source: z.literal("composition_principal"),
    required: z.boolean(),
  }).strict(),
  endpoints: z.object({
    operations: z.literal("/metaflow/v1/operations/"),
    mcp: z.literal("/mcp"),
  }).strict(),
}).strict();

export type MetaflowDaemonDoctor = z.infer<typeof MetaflowDaemonDoctorSchema>;

export type DaemonOperationClientOptions = {
  endpoint: URL;
  fetch?: typeof fetch;
  timeout_ms?: number;
  token?: string;
};

export class DaemonWireError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DaemonWireError";
  }
}

export class DaemonOperationClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authorization?: string;
  private negotiated?: Promise<MetaflowDaemonDoctor>;

  constructor(options: DaemonOperationClientOptions);
  constructor(endpoint: URL, fetchImpl?: typeof fetch);
  constructor(optionsOrEndpoint: DaemonOperationClientOptions | URL, fetchImpl: typeof fetch = fetch) {
    const options = optionsOrEndpoint instanceof URL
      ? { endpoint: optionsOrEndpoint, fetch: fetchImpl }
      : optionsOrEndpoint;
    this.endpoint = parseLocalDaemonEndpoint(options.endpoint);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = parseDaemonTimeout(options.timeout_ms ?? DEFAULT_DAEMON_TIMEOUT_MS);
    if (options.token !== undefined) {
      if (!options.token.trim() || /[\r\n]/u.test(options.token)) {
        throw new DaemonWireError("daemon_token_invalid", "Daemon authentication token is invalid");
      }
      this.authorization = `Bearer ${options.token}`;
    }
  }

  negotiate(): Promise<MetaflowDaemonDoctor> {
    this.negotiated ??= this.fetchDoctor();
    return this.negotiated;
  }

  async execute(requestInput: unknown, _context: unknown): Promise<OperationEnvelope> {
    const request = OperationRequestSchema.parse(requestInput);
    const doctor = await this.negotiate();
    const url = new URL(`${doctor.endpoints.operations}${encodeURIComponent(request.operation)}`, this.endpoint);
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.input),
    }, true);
    this.assertProtocolHeader(response);
    const envelope = OperationEnvelopeSchema.parse(await responseJson(response));
    assertExpectedOperation(envelope, request.operation);
    const expectedStatus = operationHttpStatus(envelope);
    if (response.status !== expectedStatus) {
      throw new DaemonWireError(
        "daemon_status_mismatch",
        `Daemon returned HTTP ${response.status} for an Operation envelope requiring ${expectedStatus}`,
      );
    }
    return envelope;
  }

  private async fetchDoctor(): Promise<MetaflowDaemonDoctor> {
    const response = await this.request(new URL("/metaflow/v1/doctor", this.endpoint), { method: "GET" }, false);
    this.assertProtocolHeader(response);
    if (response.status !== 200) {
      throw new DaemonWireError("daemon_doctor_failed", `Daemon doctor returned HTTP ${response.status}`);
    }
    const parsed = MetaflowDaemonDoctorSchema.safeParse(await responseJson(response));
    if (!parsed.success) {
      throw new DaemonWireError("daemon_doctor_invalid", "Configured endpoint is not the compatible Metaflow resident daemon", {
        cause: parsed.error,
      });
    }
    if (parsed.data.authentication.required && !this.authorization) {
      throw new DaemonWireError("daemon_auth_required", "Daemon authentication is required");
    }
    return parsed.data;
  }

  private async request(url: URL, init: RequestInit, authenticated: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated && this.authorization) headers.set("authorization", this.authorization);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new DaemonWireError("daemon_unreachable", "Resident Metaflow daemon is unreachable", { cause });
    }
  }

  private assertProtocolHeader(response: Response): void {
    if (response.headers.get("x-metaflow-protocol-version") !== String(METAFLOW_HTTP_PROTOCOL_VERSION)) {
      throw new DaemonWireError("daemon_protocol_mismatch", "Daemon protocol version is incompatible");
    }
  }
}

export function parseLocalDaemonEndpoint(input: URL): URL {
  const endpoint = new URL(input.href);
  const loopback = endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "localhost";
  if (endpoint.protocol !== "http:"
    || !loopback
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
    throw new DaemonWireError(
      "daemon_url_invalid",
      "Daemon endpoint must be a credential-free loopback HTTP origin",
    );
  }
  endpoint.pathname = "/";
  return endpoint;
}

export function parseDaemonTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new DaemonWireError("daemon_timeout_invalid", "Daemon timeout must be an integer from 100 through 120000 milliseconds");
  }
  return value;
}

export function operationHttpStatus(envelope: OperationEnvelope): number {
  if (envelope.ok) return 200;
  return OPERATION_HTTP_STATUS_BY_CATEGORY[envelope.error.category];
}

function assertExpectedOperation(envelope: OperationEnvelope, expected: OperationName): void {
  if (envelope.operation !== expected) {
    throw new DaemonWireError("daemon_envelope_invalid", "Daemon returned the wrong Operation envelope");
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new DaemonWireError("daemon_response_invalid", "Daemon returned invalid JSON", { cause });
  }
}

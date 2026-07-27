import {
  OperationRequestSchema,
  type OperationEnvelope,
} from "@info/operations";
import {
  DEFAULT_DAEMON_TIMEOUT_MS,
  METAFLOW_HTTP_PROTOCOL_VERSION,
  OperationWireContractError,
  createDoctorChallenge,
  doctorAuthenticationProof,
  operationHttpStatus,
  validateDoctorWire,
  validateDaemonToken,
  validateOperationEnvelopeWire,
  type MetaflowDaemonDoctor,
} from "./wire-contract.js";

export {
  DEFAULT_DAEMON_TIMEOUT_MS,
  METAFLOW_AMBIENT_SERVER_NAME,
  METAFLOW_AMBIENT_SERVER_VERSION,
  METAFLOW_HTTP_PROTOCOL_NAME,
  METAFLOW_HTTP_PROTOCOL_VERSION,
  METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  METAFLOW_OPERATION_CATALOG_VERSION,
  OPERATION_HTTP_STATUS_BY_CATEGORY,
  createDoctorChallenge,
  doctorAuthenticationProof,
  operationHttpStatus,
} from "./wire-contract.js";
export type { MetaflowDaemonDoctor } from "./wire-contract.js";

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
  private readonly token?: string;

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
      let token: string;
      try {
        token = validateDaemonToken(options.token);
      } catch (cause) {
        if (cause instanceof OperationWireContractError) {
          throw new DaemonWireError(cause.code, cause.message, { cause });
        }
        throw cause;
      }
      this.authorization = `Bearer ${token}`;
      this.token = token;
    }
  }

  negotiate(): Promise<MetaflowDaemonDoctor> {
    return this.fetchDoctor();
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
    const responseBody = await responseJson(response);
    const envelope = await wire(() => validateOperationEnvelopeWire(responseBody, request.operation)) as OperationEnvelope;
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
    const challenge = createDoctorChallenge();
    const doctorUrl = new URL("/metaflow/v1/doctor", this.endpoint);
    doctorUrl.searchParams.set("challenge", challenge);
    const response = await this.request(doctorUrl, { method: "GET" }, false);
    this.assertProtocolHeader(response);
    if (response.status !== 200) {
      throw new DaemonWireError("daemon_doctor_failed", `Daemon doctor returned HTTP ${response.status}`);
    }
    const responseBody = await responseJson(response);
    const doctor = await wire(() => validateDoctorWire(responseBody, {
      challenge,
      endpoint_origin: this.endpoint.origin,
      ...(this.token ? { proof: doctorAuthenticationProof(this.token, challenge, this.endpoint.origin) } : {}),
    }));
    if (!this.authorization) {
      throw new DaemonWireError("daemon_auth_required", "Daemon authentication is required");
    }
    return doctor;
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
  if (endpoint.hostname === "localhost") endpoint.hostname = "127.0.0.1";
  endpoint.pathname = "/";
  return endpoint;
}

export function parseDaemonTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new DaemonWireError("daemon_timeout_invalid", "Daemon timeout must be an integer from 100 through 120000 milliseconds");
  }
  return value;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new DaemonWireError("daemon_response_invalid", "Daemon returned invalid JSON", { cause });
  }
}

async function wire<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof OperationWireContractError) {
      throw new DaemonWireError(cause.code, cause.message, { cause });
    }
    throw cause;
  }
}

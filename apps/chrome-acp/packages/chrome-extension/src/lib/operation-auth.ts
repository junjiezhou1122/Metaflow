const OPERATION_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{32,}=*$/u;

export const BROWSER_OPERATION_WIRE_CONTRACT = Object.freeze({
  protocol: { name: "metaflow-operations-http", version: 1 },
  server: { name: "ambient-daemon", version: "0.1.0" },
  authentication: { source: "METAFLOW_AUTH_TOKEN", required: true, scheme: "Bearer", challenge_scheme: "HMAC-SHA256" },
  catalog: {
    version: 1,
    fingerprint: "sha256:1c363c4ecb05e39def4e8aa7ae27957b0298d6c4405a1cc048de7bbdc767bcfc",
    operations: [
      "catalog.list",
      "capture.ingest",
      "view.get",
      "view.graph.project",
      "view.search",
      "view.search.reindex",
      "view.traverse",
      "view.tombstone",
      "transformation.submit",
      "transformation.get",
      "run.execute",
      "run.inspect",
      "run.cancel",
      "feedback.submit",
      "failure.inspect",
      "policy.decision.get",
      "privacy.forget.request",
      "privacy.forget.execute",
      "privacy.forget.inspect",
      "trace.read",
    ],
  },
  endpoints: { operations: "/metaflow/v1/operations/", mcp: "/mcp" },
});

const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;

export class BrowserOperationAccessError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserOperationAccessError";
  }
}

export function isValidOperationAuthToken(value: unknown): value is string {
  return typeof value === "string" && OPERATION_AUTH_TOKEN_PATTERN.test(value);
}

export function parseBrowserLocalDaemonEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new BrowserOperationAccessError("daemon_url_invalid", "Resident daemon endpoint is not a valid URL", { cause });
  }
  if (endpoint.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(endpoint.hostname)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
    throw new BrowserOperationAccessError(
      "daemon_url_invalid",
      "Resident daemon endpoint must be a credential-free loopback HTTP origin",
    );
  }
  if (endpoint.hostname === "localhost") endpoint.hostname = "127.0.0.1";
  endpoint.pathname = "/";
  return endpoint;
}

export async function negotiateBrowserOperationAccess(input: {
  endpoint: string;
  token: string;
  fetch?: typeof fetch;
  timeout_ms?: number;
  challenge?: string;
}): Promise<{ origin: string }> {
  if (!isValidOperationAuthToken(input.token)) {
    throw new BrowserOperationAccessError("daemon_token_invalid", "Resident daemon Operation token is invalid");
  }
  const endpoint = parseBrowserLocalDaemonEndpoint(input.endpoint);
  const timeoutMs = input.timeout_ms ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new BrowserOperationAccessError("daemon_timeout_invalid", "Resident daemon timeout is invalid");
  }
  const challenge = input.challenge ?? randomChallenge();
  if (!/^[0-9a-f]{64}$/u.test(challenge)) {
    throw new BrowserOperationAccessError("daemon_doctor_challenge_invalid", "Resident daemon doctor challenge is invalid");
  }
  const url = new URL("/metaflow/v1/doctor", endpoint);
  url.searchParams.set("challenge", challenge);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (cause) {
    throw new BrowserOperationAccessError("daemon_unreachable", "Resident daemon doctor is unreachable", { cause });
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) {
    throw new BrowserOperationAccessError("daemon_doctor_failed", `Resident daemon doctor returned HTTP ${response.status}`);
  }
  if (response.headers.get("x-metaflow-protocol-version") !== String(BROWSER_OPERATION_WIRE_CONTRACT.protocol.version)) {
    throw new BrowserOperationAccessError("daemon_protocol_mismatch", "Resident daemon protocol header is incompatible");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new BrowserOperationAccessError("daemon_response_invalid", "Resident daemon doctor returned invalid JSON", { cause });
  }
  await validateBrowserDoctor(body, { endpoint_origin: endpoint.origin, challenge, token: input.token });
  return { origin: endpoint.origin };
}

async function validateBrowserDoctor(
  input: unknown,
  expected: { endpoint_origin: string; challenge: string; token: string },
): Promise<void> {
  const body = exactRecord(input, ["ok", "protocol", "server", "authentication", "catalog", "endpoints"], "doctor response");
  if (body.ok !== true) fail("daemon_doctor_failed", "Resident daemon doctor reported failure");
  const protocol = exactRecord(body.protocol, ["name", "version"], "doctor protocol");
  if (protocol.name !== BROWSER_OPERATION_WIRE_CONTRACT.protocol.name
    || protocol.version !== BROWSER_OPERATION_WIRE_CONTRACT.protocol.version) {
    fail("daemon_protocol_mismatch", "Resident daemon protocol is incompatible");
  }
  const server = exactRecord(body.server, ["name", "version", "origin"], "doctor server");
  if (server.name !== BROWSER_OPERATION_WIRE_CONTRACT.server.name) fail("daemon_server_mismatch", "Configured endpoint is not the resident daemon");
  if (server.version !== BROWSER_OPERATION_WIRE_CONTRACT.server.version) fail("daemon_version_mismatch", "Resident daemon version is incompatible");
  if (server.origin !== expected.endpoint_origin) fail("daemon_origin_mismatch", "Resident daemon origin is incompatible");

  const authentication = exactRecord(
    body.authentication,
    ["source", "required", "scheme", "challenge_scheme", "challenge", "proof"],
    "doctor authentication",
  );
  const authContract = BROWSER_OPERATION_WIRE_CONTRACT.authentication;
  if (authentication.source !== authContract.source
    || authentication.required !== authContract.required
    || authentication.scheme !== authContract.scheme
    || authentication.challenge_scheme !== authContract.challenge_scheme
    || authentication.challenge !== expected.challenge
    || typeof authentication.proof !== "string"
    || !/^[0-9a-f]{64}$/u.test(authentication.proof)) {
    fail("daemon_auth_contract_mismatch", "Resident daemon authentication contract is incompatible");
  }

  const catalog = exactRecord(body.catalog, ["version", "fingerprint", "operations"], "doctor catalog");
  if (catalog.version !== BROWSER_OPERATION_WIRE_CONTRACT.catalog.version
    || catalog.fingerprint !== BROWSER_OPERATION_WIRE_CONTRACT.catalog.fingerprint
    || !Array.isArray(catalog.operations)
    || JSON.stringify(catalog.operations) !== JSON.stringify(BROWSER_OPERATION_WIRE_CONTRACT.catalog.operations)) {
    fail("daemon_catalog_mismatch", "Resident daemon Operation catalog is incompatible");
  }
  const endpoints = exactRecord(body.endpoints, ["operations", "mcp"], "doctor endpoints");
  if (endpoints.operations !== BROWSER_OPERATION_WIRE_CONTRACT.endpoints.operations
    || endpoints.mcp !== BROWSER_OPERATION_WIRE_CONTRACT.endpoints.mcp) {
    fail("daemon_doctor_invalid", "Resident daemon endpoints are incompatible");
  }
  const proof = await browserDoctorProof(expected.token, expected.challenge, expected.endpoint_origin);
  if (!constantTimeHexEqual(authentication.proof, proof)) {
    fail("daemon_credential_mismatch", "Resident daemon did not prove possession of the configured credential");
  }
}

async function browserDoctorProof(token: string, challenge: string, endpointOrigin: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `metaflow-doctor-v1:${challenge}:${endpointOrigin}:${BROWSER_OPERATION_WIRE_CONTRACT.catalog.fingerprint}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail("daemon_response_invalid", `${label} has unknown or missing fields`);
  }
  return value as Record<string, unknown>;
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function fail(code: string, message: string): never {
  throw new BrowserOperationAccessError(code, message);
}

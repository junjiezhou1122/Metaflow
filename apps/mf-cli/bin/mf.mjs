#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_VERSION = "0.1.0";
const PROTOCOL_NAME = "metaflow-operations-http";
const PROTOCOL_VERSION = 1;
const SERVER_NAME = "ambient-daemon";
const SERVER_VERSION = "0.1.0";
const OPERATION_NAMES = Object.freeze([
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
]);
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ERROR_CATEGORIES = new Set([
  "invalid_request",
  "forbidden",
  "not_found",
  "conflict",
  "failed_dependency",
  "internal",
]);
const HTTP_STATUS_BY_CATEGORY = Object.freeze({
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  failed_dependency: 502,
  internal: 500,
});
const EXIT_CODE_BY_CATEGORY = Object.freeze({
  invalid_request: 2,
  forbidden: 3,
  not_found: 4,
  conflict: 5,
  failed_dependency: 6,
  internal: 1,
});

export const MF_WIRE_CONTRACT = Object.freeze({
  protocol: { name: PROTOCOL_NAME, version: PROTOCOL_VERSION },
  server: { name: SERVER_NAME, version: SERVER_VERSION },
  endpoints: { operations: "/metaflow/v1/operations/", mcp: "/mcp" },
  operations: OPERATION_NAMES,
  http_status_by_category: HTTP_STATUS_BY_CATEGORY,
  exit_code_by_category: EXIT_CODE_BY_CATEGORY,
});

export async function runMfCli(argv, options = {}) {
  const environment = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  let command;
  try {
    const parsed = parseArguments(argv);
    command = parsed.command;
    const endpoint = daemonEndpoint(environment);
    const client = new MfDaemonClient({ endpoint, environment, fetchImpl });
    if (parsed.kind === "doctor") return await doctor(client, environment);
    if (parsed.kind === "help") return await operationHelp(client, parsed.command);
    const input = readInput(parsed.input, options.cwd ?? process.cwd());
    const envelope = await client.operation(parsed.command, input);
    return output(
      envelope,
      exitCode(envelope),
      envelope.ok ? "" : `mf: ${envelope.error.code}: ${envelope.error.message}\n`,
    );
  } catch (cause) {
    const failure = cliFailure(command, cause);
    return output(failure, exitCode(failure), `mf: ${failure.error.code}: ${failure.error.message}\n`);
  }
}

class MfDaemonClient {
  constructor({ endpoint, environment, fetchImpl }) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout(environment);
    const token = environment.METAFLOW_AUTH_TOKEN;
    if (token !== undefined && (!token.trim() || /[\r\n]/u.test(token))) {
      throw new CliError("daemon_token_invalid", "invalid_request", "Daemon authentication token is invalid");
    }
    this.authorization = token ? `Bearer ${token}` : undefined;
    this.negotiated = undefined;
  }

  async doctor() {
    this.negotiated ??= this.fetchDoctor();
    return this.negotiated;
  }

  async fetchDoctor() {
    const response = await this.request(new URL("/metaflow/v1/doctor", this.endpoint), { method: "GET" }, false);
    assertProtocolHeader(response);
    const body = await responseJson(response);
    if (response.status !== 200) throw responseFailure(response.status, body);
    const daemon = validateDoctor(body);
    if (daemon.authentication.required && !this.authorization) {
      throw new CliError("daemon_auth_required", "forbidden", "Daemon authentication is required");
    }
    return daemon;
  }

  async operation(operation, input) {
    await this.doctor();
    const response = await this.request(
      new URL(`/metaflow/v1/operations/${encodeURIComponent(operation)}`, this.endpoint),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      true,
    );
    assertProtocolHeader(response);
    const body = await responseJson(response);
    const envelope = validateOperationEnvelope(body, operation);
    const expectedStatus = envelope.ok ? 200 : HTTP_STATUS_BY_CATEGORY[envelope.error.category];
    if (response.status !== expectedStatus) {
      throw new CliError("daemon_status_mismatch", "failed_dependency", "Daemon HTTP status does not match its Operation envelope");
    }
    return envelope;
  }

  async request(url, init, authenticated) {
    const headers = new Headers(init.headers);
    if (authenticated && this.authorization) headers.set("authorization", this.authorization);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (cause) {
      throw new CliError("daemon_unreachable", "failed_dependency", "Resident Metaflow daemon is unreachable", {}, cause);
    }
  }
}

async function doctor(client, environment) {
  const daemon = await client.doctor();
  if (daemon.authentication.required && !environment.METAFLOW_AUTH_TOKEN) {
    throw new CliError("daemon_auth_required", "forbidden", "Daemon authentication is required");
  }
  const catalog = await client.operation("catalog.list", {});
  if (!catalog.ok) throw new CliError(
    catalog.error.code,
    catalog.error.category,
    `Daemon catalog check failed: ${catalog.error.message}`,
    catalog.error.details,
  );
  if (!Array.isArray(catalog.data)) {
    throw new CliError("daemon_catalog_invalid", "failed_dependency", "Daemon catalog response is invalid");
  }
  return output({
    ok: true,
    request_id: requestId(),
    command: "doctor",
    data: {
      cli: { name: "mf", version: CLI_VERSION },
      daemon,
      authentication: {
        client_source: environment.METAFLOW_AUTH_TOKEN ? "METAFLOW_AUTH_TOKEN" : "daemon_local",
        server_source: daemon.authentication.source,
        required: daemon.authentication.required,
      },
      operation_count: catalog.data.length,
    },
  }, 0);
}

async function operationHelp(client, operation) {
  const catalog = await client.operation("catalog.list", {});
  if (!catalog.ok) return output(catalog, exitCode(catalog));
  const entry = Array.isArray(catalog.data)
    ? catalog.data.find(value => isRecord(value) && value.name === operation)
    : undefined;
  if (!entry) throw new CliError("operation_not_found", "not_found", "Operation is not present in the daemon catalog");
  return output({ ok: true, request_id: requestId(), command: "help", data: entry }, 0);
}

function parseArguments(argv) {
  const args = [...argv];
  const jsonFlags = args.filter(value => value === "--json").length;
  if (jsonFlags > 1) throw new CliError("cli_arguments_invalid", "invalid_request", "--json may be provided only once");
  const filtered = args.filter(value => value !== "--json");
  const command = filtered.shift();
  if (!command) throw new CliError("cli_command_required", "invalid_request", "A command or Operation name is required");
  if (command === "doctor") {
    if (filtered.length > 0) throw new CliError("cli_arguments_invalid", "invalid_request", "doctor accepts no input");
    return { kind: "doctor", command };
  }
  if (filtered.length === 1 && filtered[0] === "--help") return { kind: "help", command };
  if (filtered.length === 0) return { kind: "operation", command, input: undefined };
  if (filtered.length !== 2 || filtered[0] !== "--input") {
    throw new CliError("cli_arguments_invalid", "invalid_request", "Use --input with one JSON value or @file path");
  }
  return { kind: "operation", command, input: filtered[1] };
}

function readInput(raw, cwd) {
  if (raw === undefined) return {};
  let source = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    if (!path) throw new CliError("cli_input_file_invalid", "invalid_request", "@file input requires a path");
    let size;
    try {
      const resolved = resolvePath(cwd, path);
      size = statSync(resolved, { throwIfNoEntry: true }).size;
      if (size > MAX_INPUT_BYTES) throw new CliError("cli_input_too_large", "invalid_request", "CLI input exceeds the fixed byte limit");
      source = readFileSync(resolved, "utf8");
      if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) {
        throw new CliError("cli_input_too_large", "invalid_request", "CLI input exceeds the fixed byte limit");
      }
    } catch (cause) {
      if (cause instanceof CliError) throw cause;
      throw new CliError("cli_input_file_unreadable", "invalid_request", "CLI input file could not be read", {}, cause);
    }
  } else if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
    throw new CliError("cli_input_too_large", "invalid_request", "CLI input exceeds the fixed byte limit");
  }
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new CliError("cli_input_invalid", "invalid_request", "CLI input must be valid JSON", {}, cause);
  }
}

function resolvePath(cwd, path) {
  if (path.startsWith("/")) return path;
  return `${cwd.replace(/\/$/u, "")}/${path}`;
}

function daemonEndpoint(environment) {
  const raw = environment.METAFLOW_DAEMON_URL
    ?? `http://127.0.0.1:${environment.CONTEXT_HTTP_PORT ?? "3111"}`;
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch (cause) {
    throw new CliError("daemon_url_invalid", "invalid_request", "METAFLOW_DAEMON_URL must be a valid HTTP URL", {}, cause);
  }
  if (endpoint.protocol !== "http:"
    || !new Set(["127.0.0.1", "localhost"]).has(endpoint.hostname)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
    throw new CliError("daemon_url_invalid", "invalid_request", "METAFLOW_DAEMON_URL must be a credential-free loopback HTTP origin");
  }
  return endpoint;
}

function timeout(environment) {
  const value = Number(environment.METAFLOW_DAEMON_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new CliError("daemon_timeout_invalid", "invalid_request", "METAFLOW_DAEMON_TIMEOUT_MS must be an integer from 100 through 120000");
  }
  return value;
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CliError("daemon_response_invalid", "failed_dependency", "Daemon returned invalid JSON", {}, cause);
  }
}

function validateDoctor(value) {
  requireKeys(value, ["ok", "protocol", "server", "authentication", "endpoints"], "doctor response");
  if (value.ok !== true) throw new CliError("daemon_doctor_failed", "failed_dependency", "Daemon doctor reported failure");
  requireKeys(value.protocol, ["name", "version"], "doctor protocol");
  if (value.protocol.name !== PROTOCOL_NAME || value.protocol.version !== PROTOCOL_VERSION) {
    throw new CliError("daemon_protocol_mismatch", "failed_dependency", "Daemon protocol version is incompatible");
  }
  requireKeys(value.server, ["name", "version"], "doctor server");
  if (value.server.name !== SERVER_NAME) {
    throw new CliError("daemon_server_mismatch", "failed_dependency", "Configured endpoint is not the Metaflow resident daemon");
  }
  if (value.server.version !== SERVER_VERSION) {
    throw new CliError("daemon_version_mismatch", "failed_dependency", "Daemon server version is incompatible");
  }
  requireKeys(value.authentication, ["source", "required"], "doctor authentication");
  requireKeys(value.endpoints, ["operations", "mcp"], "doctor endpoints");
  if (value.authentication.source !== "composition_principal"
    || typeof value.authentication.required !== "boolean") {
    throw new CliError("daemon_doctor_invalid", "failed_dependency", "Daemon doctor response is invalid");
  }
  if (value.endpoints.operations !== "/metaflow/v1/operations/" || value.endpoints.mcp !== "/mcp") {
    throw new CliError("daemon_doctor_invalid", "failed_dependency", "Daemon doctor endpoints are incompatible");
  }
  return value;
}

function validateOperationEnvelope(value, expectedOperation) {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.request_id !== "string") {
    throw new CliError("daemon_envelope_invalid", "failed_dependency", "Daemon Operation envelope is invalid");
  }
  if (value.ok) {
    requireKeys(value, ["ok", "request_id", "operation", "data"], "Operation success envelope");
    if (value.operation !== expectedOperation) throw new CliError("daemon_envelope_invalid", "failed_dependency", "Daemon returned the wrong Operation envelope");
  } else {
    const expectedKnownOperation = OPERATION_NAMES.includes(expectedOperation);
    const keys = value.operation === undefined
      ? ["ok", "request_id", "error"]
      : ["ok", "request_id", "operation", "error"];
    requireKeys(value, keys, "Operation failure envelope");
    if ((expectedKnownOperation && value.operation !== expectedOperation)
      || (!expectedKnownOperation && value.operation !== undefined && value.operation !== expectedOperation)) {
      throw new CliError("daemon_envelope_invalid", "failed_dependency", "Daemon returned the wrong Operation envelope");
    }
    requireKeys(value.error, ["code", "message", "category", "details"], "Operation error");
    if (typeof value.error.code !== "string" || typeof value.error.message !== "string"
      || !ERROR_CATEGORIES.has(value.error.category) || !isRecord(value.error.details)) {
      throw new CliError("daemon_envelope_invalid", "failed_dependency", "Daemon Operation error is invalid");
    }
  }
  return value;
}

function requireKeys(value, expected, label) {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new CliError("daemon_response_invalid", "failed_dependency", `${label} has unknown or missing fields`);
  }
}

function responseFailure(status, body) {
  if (status === 401 || status === 403) return new CliError("daemon_auth_failed", "forbidden", "Daemon authentication failed");
  return new CliError("daemon_doctor_failed", "failed_dependency", "Daemon doctor request failed", {
    status,
    response_code: isRecord(body) && typeof body.code === "string" ? body.code : "unknown",
  });
}

function assertProtocolHeader(response) {
  if (response.headers.get("x-metaflow-protocol-version") !== String(PROTOCOL_VERSION)) {
    throw new CliError("daemon_protocol_mismatch", "failed_dependency", "Daemon protocol version is incompatible");
  }
}

function cliFailure(operation, cause) {
  const error = cause instanceof CliError
    ? cause
    : new CliError("cli_internal_error", "internal", "mf failed unexpectedly", {}, cause);
  return {
    ok: false,
    request_id: requestId(),
    ...(operation && operation !== "doctor" ? { operation } : { command: operation ?? "mf" }),
    error: { code: error.code, message: error.message, category: error.category, details: error.details },
  };
}

function output(envelope, exit_code, stderr = "") {
  return { envelope, exit_code, stdout: `${JSON.stringify(envelope)}\n`, stderr };
}

function exitCode(envelope) {
  if (envelope.ok) return 0;
  return EXIT_CODE_BY_CATEGORY[envelope.error.category] ?? 1;
}

function requestId() {
  return `request:cli:${randomUUID()}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class CliError extends Error {
  constructor(code, category, message, details = {}, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CliError";
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMfCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exit_code;
}

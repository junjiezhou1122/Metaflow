// packages/adapters/operation-surfaces/wire-contract.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// packages/operations/names.ts
var OPERATION_NAMES = [
  "catalog.list",
  "connector.list",
  "connector.inspect",
  "capture.ingest",
  "capture.connection.list",
  "capture.connection.create",
  "capture.connection.check",
  "capture.connection.discover",
  "capture.connection.activate",
  "capture.connection.update",
  "capture.connection.pause",
  "capture.connection.run",
  "capture.dlq.list",
  "capture.dlq.replay",
  "view.get",
  "view.resolve.latest",
  "view.query",
  "view.graph.project",
  "view.search",
  "view.search.reindex",
  "view.traverse",
  "view.tombstone",
  "view.authoring.request",
  "view.authoring.propose",
  "view.authoring.inspect",
  "view.authoring.approve",
  "view.authoring.reject",
  "view.authoring.apply",
  "transformation.submit",
  "transformation.get",
  "run.execute",
  "run.inspect",
  "run.cancel",
  "feedback.submit",
  "feedback.apply",
  "failure.inspect",
  "policy.decision.get",
  "privacy.forget.request",
  "privacy.forget.execute",
  "privacy.forget.inspect",
  "trace.read"
];

// packages/adapters/operation-surfaces/wire-contract.ts
var METAFLOW_HTTP_PROTOCOL_NAME = "metaflow-operations-http";
var METAFLOW_HTTP_PROTOCOL_VERSION = 1;
var METAFLOW_AMBIENT_SERVER_NAME = "ambient-daemon";
var METAFLOW_AMBIENT_SERVER_VERSION = "0.1.0";
var METAFLOW_OPERATION_CATALOG_VERSION = 1;
var METAFLOW_OPERATION_CATALOG_FINGERPRINT = "sha256:397bb3defe5e6938efdfbd03f091170389f0b2f10c92adc409dead83f6aba1a5";
var DEFAULT_DAEMON_TIMEOUT_MS = 1e4;
var OPERATION_HTTP_STATUS_BY_CATEGORY = {
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  failed_dependency: 502,
  internal: 500
};
var OPERATION_EXIT_CODE_BY_CATEGORY = {
  invalid_request: 2,
  forbidden: 3,
  not_found: 4,
  conflict: 5,
  failed_dependency: 6,
  internal: 1
};
var MF_WIRE_CONTRACT = Object.freeze({
  protocol: { name: METAFLOW_HTTP_PROTOCOL_NAME, version: METAFLOW_HTTP_PROTOCOL_VERSION },
  server: { name: METAFLOW_AMBIENT_SERVER_NAME, version: METAFLOW_AMBIENT_SERVER_VERSION },
  authentication: { source: "METAFLOW_AUTH_TOKEN", required: true, scheme: "Bearer" },
  catalog: {
    version: METAFLOW_OPERATION_CATALOG_VERSION,
    fingerprint: METAFLOW_OPERATION_CATALOG_FINGERPRINT,
    operations: OPERATION_NAMES
  },
  endpoints: { operations: "/metaflow/v1/operations/", mcp: "/mcp" },
  operations: OPERATION_NAMES,
  http_status_by_category: OPERATION_HTTP_STATUS_BY_CATEGORY,
  exit_code_by_category: OPERATION_EXIT_CODE_BY_CATEGORY
});
var OperationWireContractError = class extends Error {
  constructor(code, message, category = "failed_dependency") {
    super(message);
    this.code = code;
    this.category = category;
    this.name = "OperationWireContractError";
  }
  code;
  category;
};
function createDoctorChallenge() {
  return randomBytes(32).toString("hex");
}
function doctorAuthenticationProof(tokenInput, challenge, endpointOrigin) {
  const token = validateDaemonToken(tokenInput);
  if (!isChallenge(challenge)) {
    throw new OperationWireContractError("daemon_doctor_challenge_invalid", "Daemon doctor challenge is invalid", "invalid_request");
  }
  return createHmac("sha256", token).update(`metaflow-doctor-v1:${challenge}:${endpointOrigin}:${METAFLOW_OPERATION_CATALOG_FINGERPRINT}`, "utf8").digest("hex");
}
function validateDaemonToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/-]{32,}=*$/u.test(value)) {
    throw new OperationWireContractError(
      "daemon_token_invalid",
      "Daemon authentication token must contain at least 32 RFC 6750 bearer characters",
      "invalid_request"
    );
  }
  return value;
}
function assertKnownOperation(value) {
  if (typeof value !== "string" || !OPERATION_NAMES.includes(value)) {
    throw new OperationWireContractError("operation_unknown", "Operation is not in the negotiated Metaflow catalog", "invalid_request");
  }
}
function validateDoctorWire(value, expected) {
  requireExactKeys(value, ["ok", "protocol", "server", "authentication", "catalog", "endpoints"], "doctor response");
  if (value.ok !== true) fail("daemon_doctor_failed", "Daemon doctor reported failure");
  requireExactKeys(value.protocol, ["name", "version"], "doctor protocol");
  if (value.protocol.name !== METAFLOW_HTTP_PROTOCOL_NAME || value.protocol.version !== METAFLOW_HTTP_PROTOCOL_VERSION) {
    fail("daemon_protocol_mismatch", "Daemon protocol version is incompatible");
  }
  requireExactKeys(value.server, ["name", "version", "origin"], "doctor server");
  if (value.server.name !== METAFLOW_AMBIENT_SERVER_NAME) fail("daemon_server_mismatch", "Configured endpoint is not the Metaflow resident daemon");
  if (value.server.version !== METAFLOW_AMBIENT_SERVER_VERSION) fail("daemon_version_mismatch", "Daemon server version is incompatible");
  if (value.server.origin !== expected.endpoint_origin) fail("daemon_origin_mismatch", "Daemon server origin is incompatible");
  requireExactKeys(value.authentication, ["source", "required", "scheme", "challenge_scheme", "challenge", "proof"], "doctor authentication");
  if (value.authentication.source !== "METAFLOW_AUTH_TOKEN" || value.authentication.required !== true || value.authentication.scheme !== "Bearer" || value.authentication.challenge_scheme !== "HMAC-SHA256" || value.authentication.challenge !== expected.challenge || !isSha256(value.authentication.proof)) {
    fail("daemon_auth_contract_mismatch", "Daemon authentication contract is incompatible");
  }
  if (expected.proof !== void 0) {
    const actual = Buffer.from(value.authentication.proof, "hex");
    const wanted = Buffer.from(expected.proof, "hex");
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      fail("daemon_credential_mismatch", "Daemon did not prove possession of the configured credential", "forbidden");
    }
  }
  requireExactKeys(value.catalog, ["version", "fingerprint", "operations"], "doctor catalog");
  if (value.catalog.version !== METAFLOW_OPERATION_CATALOG_VERSION || value.catalog.fingerprint !== METAFLOW_OPERATION_CATALOG_FINGERPRINT || !Array.isArray(value.catalog.operations) || JSON.stringify(value.catalog.operations) !== JSON.stringify(OPERATION_NAMES)) {
    fail("daemon_catalog_mismatch", "Daemon Operation catalog is incompatible");
  }
  requireExactKeys(value.endpoints, ["operations", "mcp"], "doctor endpoints");
  if (value.endpoints.operations !== "/metaflow/v1/operations/" || value.endpoints.mcp !== "/mcp") {
    fail("daemon_doctor_invalid", "Daemon doctor endpoints are incompatible");
  }
  return value;
}
function validateOperationEnvelopeWire(value, expectedOperation) {
  if (!isRecord(value) || typeof value.ok !== "boolean") fail("daemon_envelope_invalid", "Daemon Operation envelope is invalid");
  if (value.ok) {
    requireExactKeys(value, ["ok", "request_id", "operation", "data"], "Operation success envelope", "daemon_envelope_invalid");
    requireIdentifier(value.request_id, "request_id");
    if (value.operation !== expectedOperation) fail("daemon_envelope_invalid", "Daemon returned the wrong Operation envelope");
    requireJsonValue(value.data, "data");
  } else {
    requireExactKeys(value, ["ok", "request_id", "operation", "error"], "Operation failure envelope", "daemon_envelope_invalid");
    requireIdentifier(value.request_id, "request_id");
    if (value.operation !== expectedOperation) {
      fail("daemon_envelope_invalid", "Daemon returned the wrong Operation envelope");
    }
    requireExactKeys(value.error, ["code", "message", "category", "details"], "Operation error", "daemon_envelope_invalid");
    requireIdentifier(value.error.code, "error.code");
    if (typeof value.error.message !== "string" || !value.error.message.trim() || value.error.message.length > 2e3) {
      fail("daemon_envelope_invalid", "Daemon Operation error message is invalid");
    }
    if (typeof value.error.category !== "string" || !(value.error.category in OPERATION_HTTP_STATUS_BY_CATEGORY)) {
      fail("daemon_envelope_invalid", "Daemon Operation error category is invalid");
    }
    if (!isRecord(value.error.details)) fail("daemon_envelope_invalid", "Daemon Operation error details are invalid");
    requireJsonValue(value.error.details, "error.details");
  }
  return value;
}
function operationHttpStatus(envelope) {
  return envelope.ok ? 200 : OPERATION_HTTP_STATUS_BY_CATEGORY[envelope.error.category];
}
function operationExitCode(envelope) {
  return envelope.ok ? 0 : OPERATION_EXIT_CODE_BY_CATEGORY[envelope.error.category];
}
function requireIdentifier(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 240) {
    fail("daemon_envelope_invalid", `Daemon Operation ${label} is invalid`);
  }
}
function requireExactKeys(value, expected, label, code = "daemon_response_invalid") {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(code, `${label} has unknown or missing fields`);
  }
}
function requireJsonValue(value, label) {
  if (value === void 0 || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || typeof value === "number" && !Number.isFinite(value)) {
    fail("daemon_envelope_invalid", `Daemon Operation ${label} is not JSON`);
  }
  if (Array.isArray(value)) {
    for (const item of value) requireJsonValue(item, label);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) requireJsonValue(item, label);
  }
}
function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function isChallenge(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(code, message, category = "failed_dependency") {
  throw new OperationWireContractError(code, message, category);
}
export {
  DEFAULT_DAEMON_TIMEOUT_MS,
  METAFLOW_AMBIENT_SERVER_NAME,
  METAFLOW_AMBIENT_SERVER_VERSION,
  METAFLOW_HTTP_PROTOCOL_NAME,
  METAFLOW_HTTP_PROTOCOL_VERSION,
  METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  METAFLOW_OPERATION_CATALOG_VERSION,
  MF_WIRE_CONTRACT,
  OPERATION_EXIT_CODE_BY_CATEGORY,
  OPERATION_HTTP_STATUS_BY_CATEGORY,
  OPERATION_NAMES,
  OperationWireContractError,
  assertKnownOperation,
  createDoctorChallenge,
  doctorAuthenticationProof,
  operationExitCode,
  operationHttpStatus,
  validateDaemonToken,
  validateDoctorWire,
  validateOperationEnvelopeWire
};

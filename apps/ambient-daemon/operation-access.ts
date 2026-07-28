import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  METAFLOW_AMBIENT_SERVER_NAME,
  METAFLOW_AMBIENT_SERVER_VERSION,
  METAFLOW_HTTP_PROTOCOL_NAME,
  METAFLOW_HTTP_PROTOCOL_VERSION,
  METAFLOW_OPERATION_CATALOG_FINGERPRINT,
  METAFLOW_OPERATION_CATALOG_VERSION,
  createDoctorChallenge,
  doctorAuthenticationProof,
  validateDaemonToken,
} from "@info/operation-surfaces";
import { OPERATION_NAMES } from "@info/operations";

export type AmbientOperationAccessDecision = {
  allowed: true;
  headers?: Record<string, string>;
} | {
  allowed: false;
  status: 401 | 403;
  code: "operation_auth_required" | "operation_auth_invalid" | "browser_origin_forbidden";
  message: string;
  headers?: Record<string, string>;
};

export class AmbientOperationAccess {
  private readonly expectedDigest: Buffer;
  private readonly token: string;
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(token: string, trustedOrigins: readonly string[] = []) {
    token = validateDaemonToken(token);
    this.token = token;
    this.expectedDigest = bearerDigest(token);
    this.trustedOrigins = new Set(trustedOrigins.map(normalizeTrustedOperationOrigin));
  }

  doctor(endpointOrigin: string, challengeInput?: string | null) {
    const challenge = challengeInput ?? createDoctorChallenge();
    return {
      ok: true as const,
      protocol: { name: METAFLOW_HTTP_PROTOCOL_NAME, version: METAFLOW_HTTP_PROTOCOL_VERSION },
      server: {
        name: METAFLOW_AMBIENT_SERVER_NAME,
        version: METAFLOW_AMBIENT_SERVER_VERSION,
        origin: endpointOrigin,
      },
      authentication: {
        source: "METAFLOW_AUTH_TOKEN" as const,
        required: true as const,
        scheme: "Bearer" as const,
        challenge_scheme: "HMAC-SHA256" as const,
        challenge,
        proof: doctorAuthenticationProof(this.token, challenge, endpointOrigin),
      },
      catalog: {
        version: METAFLOW_OPERATION_CATALOG_VERSION,
        fingerprint: METAFLOW_OPERATION_CATALOG_FINGERPRINT,
        operations: OPERATION_NAMES,
      },
      endpoints: { operations: "/metaflow/v1/operations/" as const, mcp: "/mcp" as const },
    };
  }

  authorize(headers: IncomingHttpHeaders): AmbientOperationAccessDecision {
    const origin = trustedRequestOrigin(headers.origin, this.trustedOrigins);
    if (origin === false) {
      return {
        allowed: false,
        status: 403,
        code: "browser_origin_forbidden",
        message: "Browser-origin requests are not permitted on the local Operations transport",
      };
    }
    const authorization = headers.authorization;
    if (authorization === undefined) {
      return {
        allowed: false,
        status: 401,
        code: "operation_auth_required",
        message: "Bearer authentication is required",
        headers: authenticationFailureHeaders(origin),
      };
    }
    if (Array.isArray(authorization) || !authorization.startsWith("Bearer ")) {
      return invalidAuthorization(origin);
    }
    const token = authorization.slice("Bearer ".length);
    const actualDigest = bearerDigest(token);
    if (!token || !timingSafeEqual(actualDigest, this.expectedDigest)) return invalidAuthorization(origin);
    return { allowed: true, ...(origin ? { headers: corsHeaders(origin) } : {}) };
  }

  authorizePublic(headers: IncomingHttpHeaders): AmbientOperationAccessDecision {
    const origin = trustedRequestOrigin(headers.origin, this.trustedOrigins);
    if (origin === false) {
      return {
        allowed: false,
        status: 403,
        code: "browser_origin_forbidden",
        message: "Browser-origin requests are not permitted on the local Operations transport",
      };
    }
    return { allowed: true, ...(origin ? { headers: corsHeaders(origin) } : {}) };
  }

  authorizePreflight(
    headers: IncomingHttpHeaders,
    allowedMethods: readonly ("GET" | "POST" | "DELETE")[] = ["GET", "POST"],
  ): AmbientOperationAccessDecision {
    const origin = trustedRequestOrigin(headers.origin, this.trustedOrigins);
    if (!origin) {
      return {
        allowed: false,
        status: 403,
        code: "browser_origin_forbidden",
        message: "Browser-origin requests are not permitted on the local Operations transport",
      };
    }
    if (!isAllowedPreflightMethod(headers["access-control-request-method"], allowedMethods)
      || !hasOnlyAllowedPreflightHeaders(headers["access-control-request-headers"])) {
      return {
        allowed: false,
        status: 403,
        code: "browser_origin_forbidden",
        message: "Browser preflight exceeds the local Operations transport policy",
      };
    }
    return { allowed: true, headers: corsHeaders(origin, allowedMethods) };
  }
}

function isAllowedPreflightMethod(
  value: string | string[] | undefined,
  allowedMethods: readonly string[],
): boolean {
  return typeof value === "string" && allowedMethods.includes(value.toUpperCase());
}

function hasOnlyAllowedPreflightHeaders(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return false;
  const requested = value.split(",").map(header => header.trim().toLowerCase()).filter(Boolean);
  return requested.every(header => header === "authorization"
    || header === "content-type"
    || header === "mcp-protocol-version");
}

function trustedRequestOrigin(
  value: string | string[] | undefined,
  trustedOrigins: ReadonlySet<string>,
): string | false | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !trustedOrigins.has(value)) return false;
  return value;
}

function corsHeaders(origin: string, allowedMethods: readonly string[] = ["GET", "POST"]): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "access-control-allow-methods": [...allowedMethods, "OPTIONS"].join(","),
    vary: "Origin",
  };
}

export function normalizeTrustedOperationOrigin(value: string): string {
  if (/^chrome-extension:\/\/[a-p]{32}$/u.test(value)) return value;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch (cause) {
    throw new Error("Trusted Operation origins must be exact URL origins", { cause });
  }
  if (origin.origin !== value || !["http:", "https:"].includes(origin.protocol)) {
    throw new Error("Trusted Operation origins must be exact HTTP(S) or Chrome extension origins");
  }
  return value;
}

export function requireAmbientOperationToken(value: string | undefined): string {
  if (value === undefined) throw new Error("METAFLOW_AUTH_TOKEN is required for the resident Operations boundary");
  return validateDaemonToken(value);
}

function bearerDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function challengeHeaders(): Record<string, string> {
  return { "www-authenticate": "Bearer realm=\"metaflow-operations\"" };
}

function authenticationFailureHeaders(origin: string | undefined): Record<string, string> {
  return {
    ...challengeHeaders(),
    ...(origin ? corsHeaders(origin) : {}),
  };
}

function invalidAuthorization(origin?: string): AmbientOperationAccessDecision {
  return {
    allowed: false,
    status: 401,
    code: "operation_auth_invalid",
    message: "Bearer authentication is invalid",
    headers: authenticationFailureHeaders(origin),
  };
}

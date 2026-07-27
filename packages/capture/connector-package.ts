import { createHash, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJson, type JsonObject } from "@info/view";
import {
  CaptureIdentifierSchema,
  CaptureJsonObjectSchema,
  ConnectorManifestSchema,
  SecretReferenceSchema,
  type ConnectorManifest,
} from "./contracts.js";
import type { ConnectorPort } from "./runtime-contracts.js";

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ConnectorPermissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("network"), scope: z.string().url() }).strict(),
  z.object({ kind: z.literal("filesystem_read"), scope: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("webhook_receive"), scope: CaptureIdentifierSchema }).strict(),
]);

export const ConnectorCredentialSlotSchema = z.object({
  name: CaptureIdentifierSchema,
  required: z.boolean(),
  description: z.string().trim().min(1).max(500),
  accepted_providers: z.array(SecretReferenceSchema.shape.provider).min(1),
}).strict();

export const ConnectorConformanceEvidenceSchema = z.object({
  version: z.literal(2),
  report_digest: Sha256DigestSchema,
  verified_at: z.string().datetime({ offset: true }),
  capabilities: z.object({
    push: z.boolean(),
    pull: z.boolean(),
    stream: z.boolean(),
    reference: z.boolean(),
    incremental: z.boolean(),
  }).strict(),
}).strict();

export const ConnectorPackageDescriptorSchema = z.object({
  descriptor_version: z.literal(1),
  id: CaptureIdentifierSchema,
  version: z.string().trim().min(1),
  manifest: ConnectorManifestSchema,
  artifact: z.object({
    package_name: z.string().trim().min(1),
    export_name: z.string().trim().min(1),
    digest: z.object({ algorithm: z.literal("sha256"), value: Sha256DigestSchema }).strict(),
  }).strict(),
  runtime: z.object({
    abi: z.literal("metaflow.connector-port"),
    abi_version: z.number().int().positive(),
  }).strict(),
  publisher: z.object({ id: CaptureIdentifierSchema, key_id: CaptureIdentifierSchema }).strict(),
  signature: z.object({ algorithm: z.literal("ed25519"), value: z.string().min(1) }).strict().optional(),
  permissions: z.array(ConnectorPermissionSchema).default([]),
  credential_slots: z.array(ConnectorCredentialSlotSchema).default([]),
  configuration_schema: CaptureJsonObjectSchema,
  conformance: ConnectorConformanceEvidenceSchema,
}).strict().superRefine((descriptor, context) => {
  if (descriptor.id !== descriptor.manifest.id || descriptor.version !== descriptor.manifest.version) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Package identity must match its Connector manifest" });
  }
  for (const [field, values] of [
    ["permissions", descriptor.permissions.map(permission => canonicalJson(permission))],
    ["credential_slots", descriptor.credential_slots.map(slot => slot.name)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be unique` });
    }
  }
  const declared = descriptor.conformance.capabilities;
  for (const kind of ["push", "pull", "stream", "reference"] as const) {
    if (descriptor.manifest.delivery_kinds.includes(kind) !== declared[kind]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["conformance", "capabilities", kind], message: `Conformance ${kind} must match the manifest` });
    }
  }
});

export type ConnectorPackageDescriptor = z.infer<typeof ConnectorPackageDescriptorSchema>;
export type ConnectorPermission = z.infer<typeof ConnectorPermissionSchema>;

export const ExactConnectorPackageRefSchema = z.object({
  id: CaptureIdentifierSchema,
  version: z.string().trim().min(1),
  digest: Sha256DigestSchema,
}).strict();

export type ExactConnectorPackageRef = z.infer<typeof ExactConnectorPackageRefSchema>;

export type ConnectorDiscoveryResult = {
  items: JsonObject[];
  next_cursor?: JsonObject;
};

export type ConnectorPackageImplementation = {
  descriptor: ConnectorPackageDescriptor;
  connector: ConnectorPort;
  validateConfiguration(configuration: unknown): JsonObject;
  discover?(input: {
    connection: import("./contracts.js").SourceConnection;
    parameters: JsonObject;
    signal?: AbortSignal;
  }): Promise<ConnectorDiscoveryResult>;
};

export type ConnectorPackageArtifact = {
  descriptor: ConnectorPackageDescriptor;
  bytes: Uint8Array;
};

export interface ConnectorPackageArtifactPort {
  inspect(ref: ExactConnectorPackageRef): Promise<ConnectorPackageArtifact | undefined>;
  instantiate(artifact: ConnectorPackageArtifact): Promise<ConnectorPackageImplementation>;
}

export interface ConnectorPublisherKeyPort {
  publicKey(publisherId: string, keyId: string): Promise<string | Buffer | undefined>;
}

export class ConnectorPackageError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_connector_package"
      | "duplicate_connector_package"
      | "unknown_connector_package"
      | "ambiguous_connector_package"
      | "unsigned_connector_package"
      | "untrusted_connector_package"
      | "connector_artifact_mismatch"
      | "connector_abi_incompatible"
      | "connector_permission_denied",
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectorPackageError";
  }
}

export class ConnectorPackageCatalog {
  private readonly descriptors = new Map<string, ConnectorPackageDescriptor[]>();

  register(input: unknown): ConnectorPackageDescriptor {
    const parsed = ConnectorPackageDescriptorSchema.safeParse(input);
    if (!parsed.success) {
      throw new ConnectorPackageError("Connector Package descriptor failed validation", "invalid_connector_package", {
        issue_count: parsed.error.issues.length,
      }, { cause: parsed.error });
    }
    const descriptor = deepFreeze(parsed.data);
    const key = `${descriptor.id}@${descriptor.version}`;
    const existing = this.descriptors.get(key) ?? [];
    if (existing.some(item => item.artifact.digest.value === descriptor.artifact.digest.value)) {
      throw new ConnectorPackageError(`Duplicate Connector Package ${key}+${descriptor.artifact.digest.value}`, "duplicate_connector_package");
    }
    this.descriptors.set(key, [...existing, descriptor]);
    return descriptor;
  }

  list(): ConnectorPackageDescriptor[] {
    return [...this.descriptors.values()].flat().sort((left, right) =>
      left.id.localeCompare(right.id) || left.version.localeCompare(right.version) || left.artifact.digest.value.localeCompare(right.artifact.digest.value));
  }

  resolve(input: ExactConnectorPackageRef): ConnectorPackageDescriptor {
    const parsed = ExactConnectorPackageRefSchema.safeParse(input);
    if (!parsed.success) {
      throw new ConnectorPackageError("Exact Connector Package reference failed validation", "invalid_connector_package", {
        issue_count: parsed.error.issues.length,
      }, { cause: parsed.error });
    }
    const ref = parsed.data;
    const candidates = (this.descriptors.get(`${ref.id}@${ref.version}`) ?? [])
      .filter(item => item.artifact.digest.value === ref.digest);
    if (candidates.length === 0) {
      throw new ConnectorPackageError("Exact Connector Package is not registered", "unknown_connector_package", { package_id: ref.id, version: ref.version, digest: ref.digest });
    }
    if (candidates.length !== 1) {
      throw new ConnectorPackageError("Exact Connector Package resolution is ambiguous", "ambiguous_connector_package", { package_id: ref.id, version: ref.version, digest: ref.digest });
    }
    return candidates[0]!;
  }

  resolveVersion(id: string, version: string): ConnectorPackageDescriptor {
    const candidates = this.descriptors.get(`${id}@${version}`) ?? [];
    if (candidates.length === 0) {
      throw new ConnectorPackageError("Connector Package version is not registered", "unknown_connector_package", { package_id: id, version });
    }
    if (candidates.length !== 1) {
      throw new ConnectorPackageError("Connector Package version has multiple artifact digests; an exact digest is required", "ambiguous_connector_package", {
        package_id: id,
        version,
        candidate_count: candidates.length,
      });
    }
    return candidates[0]!;
  }
}

export class TrustedConnectorPackageLoader {
  constructor(private readonly options: {
    catalog: ConnectorPackageCatalog;
    artifacts: ConnectorPackageArtifactPort;
    publisher_keys: ConnectorPublisherKeyPort;
    allowed_permissions: readonly ConnectorPermission[];
    supported_abi_version: number;
  }) {}

  async load(ref: ExactConnectorPackageRef): Promise<ConnectorPackageImplementation> {
    const descriptor = this.options.catalog.resolve(ref);
    if (!descriptor.signature) {
      throw new ConnectorPackageError("Connector Package is unsigned", "unsigned_connector_package", { package_id: descriptor.id, version: descriptor.version });
    }
    if (descriptor.runtime.abi_version !== this.options.supported_abi_version) {
      throw new ConnectorPackageError("Connector Package Runtime ABI is incompatible", "connector_abi_incompatible", {
        required: descriptor.runtime.abi_version,
        supported: this.options.supported_abi_version,
      });
    }
    const allowed = new Set(this.options.allowed_permissions.map(permission => canonicalJson(permission)));
    const denied = descriptor.permissions.filter(permission => !allowed.has(canonicalJson(permission)));
    if (denied.length > 0) {
      throw new ConnectorPackageError("Connector Package requests permissions outside the host allowlist", "connector_permission_denied", { denied });
    }
    const inspected = await this.options.artifacts.inspect(ref);
    if (!inspected) throw new ConnectorPackageError("Connector Package artifact is unavailable", "unknown_connector_package", { package_id: ref.id, version: ref.version, digest: ref.digest });
    const artifact = { descriptor: inspected.descriptor, bytes: new Uint8Array(inspected.bytes) };
    const digest = createHash("sha256").update(artifact.bytes).digest("hex");
    if (digest !== descriptor.artifact.digest.value
      || canonicalJson(artifact.descriptor) !== canonicalJson(descriptor)) {
      throw new ConnectorPackageError("Loaded Connector artifact does not match its exact descriptor", "connector_artifact_mismatch");
    }
    const publicKey = await this.options.publisher_keys.publicKey(descriptor.publisher.id, descriptor.publisher.key_id);
    let trusted = false;
    try {
      trusted = publicKey !== undefined
        && verify(null, signaturePayload(descriptor), publicKey, Buffer.from(descriptor.signature.value, "base64"));
    } catch (error) {
      throw new ConnectorPackageError("Connector Package signature or publisher key is invalid", "untrusted_connector_package", {
        publisher_id: descriptor.publisher.id,
        key_id: descriptor.publisher.key_id,
      }, { cause: error });
    }
    if (!trusted) {
      throw new ConnectorPackageError("Connector Package signature is not trusted", "untrusted_connector_package", {
        publisher_id: descriptor.publisher.id,
        key_id: descriptor.publisher.key_id,
      });
    }
    const implementation = await this.options.artifacts.instantiate(artifact);
    if (canonicalJson(implementation.descriptor) !== canonicalJson(descriptor)
      || canonicalJson(implementation.connector.manifest) !== canonicalJson(descriptor.manifest)) {
      throw new ConnectorPackageError("Instantiated Connector does not match its exact descriptor", "connector_artifact_mismatch");
    }
    return implementation;
  }
}

export function connectorPackageSignaturePayload(descriptor: ConnectorPackageDescriptor): Buffer {
  return signaturePayload(descriptor);
}

function signaturePayload(descriptor: ConnectorPackageDescriptor): Buffer {
  const { signature: _signature, ...unsigned } = descriptor;
  return Buffer.from(canonicalJson(unsigned));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function connectorPackageRef(descriptor: ConnectorPackageDescriptor): ExactConnectorPackageRef {
  return { id: descriptor.id, version: descriptor.version, digest: descriptor.artifact.digest.value };
}

export function connectorManifest(descriptor: ConnectorPackageDescriptor): ConnectorManifest {
  return descriptor.manifest;
}

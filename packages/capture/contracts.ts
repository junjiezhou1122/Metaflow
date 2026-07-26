import { z } from "zod";
import {
  JsonValueSchema,
  ViewPolicySchema,
  ViewRelationTargetSchema,
  ViewRepresentationSchema,
  ViewSchemaRefSchema,
  type JsonValue,
} from "@info/view";

export const CaptureIdentifierSchema = z.string().trim().min(1).max(240);
export const CaptureTimestampSchema = z.string().datetime({ offset: true });
export const CaptureJsonObjectSchema = z.record(JsonValueSchema);

export const ConnectorTransportSchema = z.enum([
  "native_sdk",
  "rest",
  "filesystem",
  "stdio",
  "webhook",
  "mcp",
  "hosted",
]);

export const CaptureDeliveryKindSchema = z.enum([
  "push",
  "pull",
  "stream",
  "reference",
  "manual_import",
]);

export const SecretReferenceSchema = z.object({
  provider: z.enum(["keychain", "env", "vault", "onepassword", "custom"]),
  key: z.string().trim().min(1).max(500),
  version: z.string().trim().min(1).max(240).optional(),
}).strict();

export const ConnectorManifestSchema = z.object({
  id: CaptureIdentifierSchema,
  version: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  protocols: z.array(ConnectorTransportSchema).min(1),
  capabilities: z.array(CaptureIdentifierSchema).default([]),
  delivery_kinds: z.array(CaptureDeliveryKindSchema).min(1),
  emitted_schemas: z.array(ViewSchemaRefSchema).default([]),
}).strict();

export const SourceConnectionSchema = z.object({
  id: CaptureIdentifierSchema,
  connector_id: CaptureIdentifierSchema,
  connector_version: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  endpoint: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true),
  delivery_kinds: z.array(CaptureDeliveryKindSchema).min(1),
  secret_refs: z.array(SecretReferenceSchema).default([]),
  configuration: CaptureJsonObjectSchema.default({}),
  privacy: ViewPolicySchema.default({
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: true,
    labels: [],
  }),
}).strict().superRefine((connection, context) => {
  addSecretIssues(connection.configuration, ["configuration"], context);
  if (connection.endpoint) addSecretStringIssue(connection.endpoint, ["endpoint"], context);
  const kinds = new Set(connection.delivery_kinds);
  if (kinds.size !== connection.delivery_kinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery_kinds"], message: "Connection delivery kinds must be unique" });
  }
});

const RawViewCandidateShape = {
  idempotency_key: CaptureIdentifierSchema,
  name: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(2_000),
  aliases: z.array(z.string().trim().min(1).max(500)).default([]),
  schema: ViewSchemaRefSchema,
  observed_at: CaptureTimestampSchema.optional(),
  captured_at: CaptureTimestampSchema,
  source: z.object({
    connector: CaptureIdentifierSchema,
    connection_id: CaptureIdentifierSchema,
    source_id: CaptureIdentifierSchema,
    source_kind: CaptureIdentifierSchema,
    identity: z.enum(["stable_source", "occurrence"]),
    assertion: z.enum(["direct", "source_derived"]),
  }).strict(),
  representation: ViewRepresentationSchema,
  policy: ViewPolicySchema,
  relations: z.array(ViewRelationTargetSchema).default([]),
  metadata: CaptureJsonObjectSchema.default({}),
} as const;

export const RawViewCandidateSchema = z.object(RawViewCandidateShape).strict().superRefine((candidate, context) => {
  addSecretIssues(candidate.representation, ["representation"], context);
  addSecretIssues(candidate.metadata, ["metadata"], context);
});

// Compatibility name for existing v1 adapters. RawViewCandidate is canonical.
export const ObservationCandidateSchema = RawViewCandidateSchema;

export const CaptureCheckpointTransitionSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  previous: CaptureJsonObjectSchema,
  next: CaptureJsonObjectSchema,
}).strict();

export const CaptureBatchSchema = z.object({
  id: CaptureIdentifierSchema,
  idempotency_key: CaptureIdentifierSchema,
  connector: z.object({
    id: CaptureIdentifierSchema,
    version: z.string().trim().min(1),
  }).strict(),
  connection_id: CaptureIdentifierSchema,
  delivery: CaptureDeliveryKindSchema,
  sequence: z.number().int().positive(),
  candidates: z.array(RawViewCandidateSchema).min(1),
  checkpoint: CaptureCheckpointTransitionSchema.optional(),
  created_at: CaptureTimestampSchema,
  metadata: CaptureJsonObjectSchema.default({}),
}).strict().superRefine((batch, context) => {
  addSecretIssues(batch.metadata, ["metadata"], context);
  batch.candidates.forEach((candidate, index) => {
    if (candidate.source.connector !== batch.connector.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates", index, "source", "connector"], message: "Candidate connector must match its Capture Batch" });
    }
    if (candidate.source.connection_id !== batch.connection_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates", index, "source", "connection_id"], message: "Candidate connection must match its Capture Batch" });
    }
  });
});

export const CaptureRetryPolicySchema = z.object({
  id: CaptureIdentifierSchema,
  revision: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  retryable_codes: z.array(CaptureIdentifierSchema).default([]),
  non_retryable_codes: z.array(CaptureIdentifierSchema).default([]),
}).strict().superRefine((policy, context) => {
  const retryable = new Set(policy.retryable_codes);
  const nonRetryable = new Set(policy.non_retryable_codes);
  if (retryable.size !== policy.retryable_codes.length || nonRetryable.size !== policy.non_retryable_codes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Retry policy codes must be unique" });
  }
  for (const code of retryable) {
    if (nonRetryable.has(code)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Retry code ${code} cannot be both retryable and non-retryable` });
  }
});

export const CaptureSafeErrorSchema = z.object({
  code: CaptureIdentifierSchema,
  message: z.string().trim().min(1).max(1_000),
  stage: z.enum(["validation", "connector", "admission", "checkpoint", "storage", "runtime"]),
  retryable: z.boolean(),
  details: CaptureJsonObjectSchema.default({}),
}).strict().superRefine((error, context) => {
  addSecretStringIssue(error.message, ["message"], context);
  addSecretIssues(error.details, ["details"], context);
});

export const ConnectorHealthSchema = z.object({
  connection_id: CaptureIdentifierSchema,
  status: z.enum(["unknown", "healthy", "degraded", "unhealthy", "paused"]),
  observed_at: CaptureTimestampSchema,
  consecutive_failures: z.number().int().nonnegative(),
  capabilities: z.array(CaptureIdentifierSchema).default([]),
  last_success_at: CaptureTimestampSchema.optional(),
  last_error: CaptureSafeErrorSchema.optional(),
}).strict();

export const CaptureCheckpointSchema = z.object({
  connection_id: CaptureIdentifierSchema,
  revision: z.number().int().nonnegative(),
  cursor: CaptureJsonObjectSchema,
  updated_at: CaptureTimestampSchema,
}).strict();

export const CaptureTraceEventSchema = z.object({
  sequence: z.number().int().positive().optional(),
  connection_id: CaptureIdentifierSchema,
  batch_id: CaptureIdentifierSchema.optional(),
  attempt: z.number().int().positive().optional(),
  type: z.enum([
    "connection.registered",
    "connection.recovered",
    "connection.paused",
    "connection.resumed",
    "connector.health_checked",
    "capture.attempt_started",
    "capture.batch_committed",
    "capture.batch_replayed",
    "capture.attempt_failed",
    "capture.retry_scheduled",
    "capture.dead_lettered",
    "capture.dead_letter_replayed",
  ]),
  occurred_at: CaptureTimestampSchema,
  payload: CaptureJsonObjectSchema.default({}),
  error: CaptureSafeErrorSchema.optional(),
}).strict().superRefine((event, context) => addSecretIssues(event.payload, ["payload"], context));

export const CaptureDeadLetterSchema = z.object({
  id: CaptureIdentifierSchema,
  connection_id: CaptureIdentifierSchema,
  batch: CaptureBatchSchema,
  attempts: z.number().int().positive(),
  error: CaptureSafeErrorSchema,
  status: z.enum(["pending", "resolved"]),
  created_at: CaptureTimestampSchema,
  resolved_at: CaptureTimestampSchema.optional(),
}).strict();

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;
export type SourceConnection = z.infer<typeof SourceConnectionSchema>;
export type RawViewCandidate = z.infer<typeof RawViewCandidateSchema>;
export type ObservationCandidate = RawViewCandidate;
export type CaptureDeliveryKind = z.infer<typeof CaptureDeliveryKindSchema>;
export type CaptureBatch = z.infer<typeof CaptureBatchSchema>;
export type CaptureRetryPolicy = z.infer<typeof CaptureRetryPolicySchema>;
export type CaptureSafeError = z.infer<typeof CaptureSafeErrorSchema>;
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;
export type CaptureCheckpoint = z.infer<typeof CaptureCheckpointSchema>;
export type CaptureTraceEvent = z.infer<typeof CaptureTraceEventSchema>;
export type StoredCaptureTraceEvent = CaptureTraceEvent & { sequence: number };
export type CaptureDeadLetter = z.infer<typeof CaptureDeadLetterSchema>;

export type CaptureEvent = {
  type: "capture.started" | "capture.committed" | "capture.skipped" | "capture.failed";
  at: string;
  connector: string;
  connection_id: string;
  source_id: string;
  idempotency_key: string;
  view_id?: string;
  revision?: number;
  error?: { code: string; message: string };
};

export type IngestReceipt =
  | { status: "stored"; view_id: string; revision: number; created: boolean }
  | { status: "skipped"; reason: "do_not_store"; idempotency_key: string };

export class CaptureValidationError extends Error {
  readonly code = "capture_validation_failed";
  constructor(message: string, readonly issues: z.ZodIssue[]) {
    super(message);
    this.name = "CaptureValidationError";
  }
}

export class ConnectorProtocolError extends Error {
  readonly code = "connector_protocol_error";
  constructor(message: string, readonly details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorProtocolError";
  }
}

export class CaptureRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly stage: CaptureSafeError["stage"],
    readonly retryable: boolean,
    readonly details: Record<string, JsonValue> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CaptureRuntimeError";
  }
}

const SECRET_KEY = /^(?:password|passphrase|token|access_token|refresh_token|api_key|apikey|secret|client_secret|private_key|credential|credentials)$/i;
const SECRET_STRING = /(?:[?&](?:token|access_token|api_key|secret)=|:\/\/[^/@:\s]+:[^/@\s]+@)/i;

function addSecretIssues(value: unknown, path: Array<string | number>, context: z.RefinementCtx): void {
  if (typeof value === "string") return;
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => addSecretIssues(item, [...path, index], context));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: "Secret material must be represented by SourceConnection.secret_refs" });
      continue;
    }
    if (/^(?:uri|url|endpoint)$/i.test(key) && typeof nested === "string") {
      addSecretStringIssue(nested, [...path, key], context);
      continue;
    }
    addSecretIssues(nested, [...path, key], context);
  }
}

function addSecretStringIssue(value: string, path: Array<string | number>, context: z.RefinementCtx): void {
  if (SECRET_STRING.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "Inline credential material is forbidden" });
  }
}

import { z } from "zod";
import {
  ViewPolicySchema,
  ViewRelationTargetSchema,
  ViewRepresentationSchema,
  ViewSchemaRefSchema,
  canonicalJson,
  type JsonObject,
  type ViewPolicy,
  type ViewRepresentation,
  type ViewSchemaRef,
} from "@info/view";
import {
  CaptureBatchSchema,
  CaptureJsonObjectSchema,
  CaptureTimestampSchema,
  ConnectorManifestSchema,
  ConnectorProtocolError,
  RawViewCandidateSchema,
  NamedSecretReferencesSchema,
  SecretReferenceSchema,
  SourceConnectionSchema,
  type CaptureBatch,
  type CaptureDeliveryKind,
  type ConnectorManifest,
  type RawViewCandidate,
  type SourceConnection,
} from "./contracts.js";
import type { ConnectorPort } from "./runtime-contracts.js";

export const ConnectorCandidateSourceSchema = z.object({
  source_id: z.string().trim().min(1).max(240),
  source_kind: z.string().trim().min(1).max(240),
  identity: z.enum(["stable_source", "occurrence"]),
  assertion: z.enum(["direct", "source_derived"]).default("direct"),
}).strict();

export const ConnectorCandidateDraftSchema = z.object({
  idempotency_key: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(2_000),
  aliases: z.array(z.string().trim().min(1).max(500)).default([]),
  schema: ViewSchemaRefSchema,
  observed_at: CaptureTimestampSchema.optional(),
  captured_at: CaptureTimestampSchema.optional(),
  source: ConnectorCandidateSourceSchema,
  representation: ViewRepresentationSchema,
  policy: ViewPolicySchema.optional(),
  relations: z.array(ViewRelationTargetSchema).default([]),
  metadata: CaptureJsonObjectSchema.default({}),
}).strict();

export type ConnectorCandidateSource = z.infer<typeof ConnectorCandidateSourceSchema>;
export type ConnectorCandidateDraft = z.infer<typeof ConnectorCandidateDraftSchema>;

export type ConnectorKitErrorCode =
  | "invalid_connector_manifest"
  | "invalid_connection_configuration"
  | "connection_connector_mismatch"
  | "invalid_source_payload"
  | "connector_adapt_failed"
  | "invalid_candidate_draft"
  | "candidate_schema_not_declared"
  | "candidate_policy_weakened"
  | "duplicate_candidate_idempotency_key"
  | "unsupported_delivery";

export class ConnectorKitError extends Error {
  constructor(
    message: string,
    readonly code: ConnectorKitErrorCode,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectorKitError";
  }
}

export type ConnectorConnectionInput = {
  id: string;
  display_name: string;
  endpoint?: string;
  enabled?: boolean;
  delivery_kinds?: CaptureDeliveryKind[];
  secret_refs?: z.input<typeof NamedSecretReferencesSchema>;
  configuration?: unknown;
  privacy?: ViewPolicy;
  connector_package?: SourceConnection["connector_package"];
};

export type ConnectorAdaptContext<Configuration> = {
  connection: SourceConnection;
  configuration: Configuration;
  captured_at: string;
  stableSource(input: {
    source_id: string;
    source_kind: string;
    assertion?: "direct" | "source_derived";
  }): ConnectorCandidateSource;
  occurrence(input: {
    source_id: string;
    source_kind: string;
    assertion?: "direct" | "source_derived";
  }): ConnectorCandidateSource;
  externalReference(input: {
    kind: string;
    uri: string;
    media_type?: string;
    digest?: { algorithm: string; value: string };
    metadata?: JsonObject;
  }): ViewRepresentation;
  policy(overrides?: Partial<ViewPolicy>): ViewPolicy;
};

export type ConnectorKitDefinition<
  ConfigurationSchema extends z.ZodTypeAny,
  PayloadSchema extends z.ZodTypeAny,
> = {
  manifest: unknown;
  configuration_schema: ConfigurationSchema;
  payload_schema: PayloadSchema;
  adapt(
    payload: z.output<PayloadSchema>,
    context: ConnectorAdaptContext<z.output<ConfigurationSchema>>,
  ): readonly unknown[];
};

export type ConnectorBatchInput<Payload> = {
  connection: SourceConnection;
  payload: Payload;
  id: string;
  idempotency_key: string;
  delivery: CaptureDeliveryKind;
  sequence: number;
  created_at: string;
  captured_at?: string;
  checkpoint?: {
    expected_revision: number;
    previous: JsonObject;
    next: JsonObject;
  };
  metadata?: JsonObject;
};

export type ConnectorKit<Configuration, Payload> = {
  readonly manifest: ConnectorManifest;
  createConnection(input: ConnectorConnectionInput): SourceConnection;
  parsePayload(input: unknown): Payload;
  adapt(input: {
    connection: SourceConnection;
    payload: unknown;
    captured_at: string;
  }): RawViewCandidate[];
  createBatch(input: ConnectorBatchInput<Payload>): CaptureBatch;
};

export function defineConnectorKit<
  ConfigurationSchema extends z.ZodTypeAny,
  PayloadSchema extends z.ZodTypeAny,
>(
  definition: ConnectorKitDefinition<ConfigurationSchema, PayloadSchema>,
): ConnectorKit<z.output<ConfigurationSchema>, z.output<PayloadSchema>> {
  type Configuration = z.output<ConfigurationSchema>;
  type Payload = z.output<PayloadSchema>;
  const parsedManifest = ConnectorManifestSchema.safeParse(definition.manifest);
  if (!parsedManifest.success) {
    throw new ConnectorKitError(
      "Connector Kit manifest failed validation",
      "invalid_connector_manifest",
      { issue_count: parsedManifest.error.issues.length },
    );
  }
  const manifest = parsedManifest.data;
  assertUniqueDeclaredSchemas(manifest);

  function parseConfiguration(input: unknown): Configuration {
    const parsed = definition.configuration_schema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new ConnectorKitError(
        "Source Connection configuration failed validation",
        "invalid_connection_configuration",
        { issue_count: parsed.error.issues.length },
      );
    }
    const json = CaptureJsonObjectSchema.safeParse(parsed.data);
    if (!json.success) {
      throw new ConnectorKitError(
        "Source Connection configuration must normalize to a JSON object",
        "invalid_connection_configuration",
        { issue_count: json.error.issues.length },
      );
    }
    return parsed.data;
  }

  function assertConnection(input: SourceConnection): {
    connection: SourceConnection;
    configuration: Configuration;
  } {
    const connection = SourceConnectionSchema.parse(input);
    if (connection.connector_id !== manifest.id || connection.connector_version !== manifest.version) {
      throw new ConnectorKitError(
        `Connection ${connection.id} does not belong to ${manifest.id}@${manifest.version}`,
        "connection_connector_mismatch",
        { connection_id: connection.id },
      );
    }
    return { connection, configuration: parseConfiguration(connection.configuration) };
  }

  const kit: ConnectorKit<Configuration, Payload> = {
    manifest,

    createConnection(input) {
      const configuration = parseConfiguration(input.configuration);
      const connection = SourceConnectionSchema.safeParse({
        id: input.id,
        connector_id: manifest.id,
        connector_version: manifest.version,
        ...(input.connector_package ? { connector_package: input.connector_package } : {}),
        display_name: input.display_name,
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        enabled: input.enabled ?? true,
        delivery_kinds: input.delivery_kinds ?? manifest.delivery_kinds,
        secret_refs: NamedSecretReferencesSchema.parse(input.secret_refs ?? {}),
        configuration,
        ...(input.privacy ? { privacy: input.privacy } : {}),
      });
      if (!connection.success) {
        throw new ConnectorKitError(
          "Source Connection failed validation",
          "invalid_connection_configuration",
          { issue_count: connection.error.issues.length },
        );
      }
      const unsupported = connection.data.delivery_kinds.filter(kind => !manifest.delivery_kinds.includes(kind));
      if (unsupported.length > 0) {
        throw new ConnectorKitError(
          `Connection requests unsupported delivery kinds: ${unsupported.join(", ")}`,
          "unsupported_delivery",
          { delivery_kinds: unsupported },
        );
      }
      return connection.data;
    },

    parsePayload(input) {
      const payload = definition.payload_schema.safeParse(input);
      if (!payload.success) {
        throw new ConnectorKitError(
          "Connector source payload failed validation",
          "invalid_source_payload",
          { issue_count: payload.error.issues.length },
        );
      }
      return payload.data;
    },

    adapt(input) {
      const { connection, configuration } = assertConnection(input.connection);
      const payload = kit.parsePayload(input.payload);
      const context = createAdaptContext(connection, configuration, input.captured_at);
      let drafts: readonly unknown[];
      try {
        drafts = definition.adapt(payload, context);
      } catch (error) {
        if (error instanceof ConnectorKitError) throw error;
        throw new ConnectorKitError(
          "Connector Adapt function crashed",
          "connector_adapt_failed",
          {},
          { cause: error },
        );
      }
      if (!Array.isArray(drafts) || drafts.length === 0) {
        throw new ConnectorKitError(
          "Connector Adapt function must return at least one candidate draft",
          "invalid_candidate_draft",
        );
      }
      const candidates = drafts.map((draft, index) => {
        const parsedDraft = ConnectorCandidateDraftSchema.safeParse(draft);
        if (!parsedDraft.success) {
          throw new ConnectorKitError(
            `Connector candidate draft ${index} failed validation`,
            "invalid_candidate_draft",
            { candidate_index: index, issue_count: parsedDraft.error.issues.length },
          );
        }
        assertSchemaDeclared(manifest, parsedDraft.data.schema, index);
        const policy = parsedDraft.data.policy ?? context.policy();
        assertPolicyNotWeaker(connection.privacy, policy, index);
        return RawViewCandidateSchema.parse({
          ...parsedDraft.data,
          captured_at: parsedDraft.data.captured_at ?? input.captured_at,
          source: {
            connector: manifest.id,
            connection_id: connection.id,
            ...parsedDraft.data.source,
          },
          policy,
        });
      });
      const keys = candidates.map(candidate => candidate.idempotency_key);
      if (new Set(keys).size !== keys.length) {
        throw new ConnectorKitError(
          "Connector candidates must use unique idempotency keys within one source payload",
          "duplicate_candidate_idempotency_key",
        );
      }
      return candidates;
    },

    createBatch(input) {
      const { connection } = assertConnection(input.connection);
      if (!manifest.delivery_kinds.includes(input.delivery) || !connection.delivery_kinds.includes(input.delivery)) {
        throw new ConnectorKitError(
          `Delivery ${input.delivery} is not enabled for ${connection.id}`,
          "unsupported_delivery",
          { delivery: input.delivery, connection_id: connection.id },
        );
      }
      const candidates = kit.adapt({
        connection,
        payload: input.payload,
        captured_at: input.captured_at ?? input.created_at,
      });
      return CaptureBatchSchema.parse({
        id: input.id,
        idempotency_key: input.idempotency_key,
        connector: { id: manifest.id, version: manifest.version },
        connection_id: connection.id,
        delivery: input.delivery,
        sequence: input.sequence,
        candidates,
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        created_at: input.created_at,
        metadata: input.metadata ?? {},
      });
    },
  };

  return kit;
}

export function createPushConnectorPort(
  kit: Pick<ConnectorKit<unknown, unknown>, "manifest">,
): ConnectorPort {
  return {
    manifest: kit.manifest,
    async health() {
      return { capabilities: [...kit.manifest.capabilities] };
    },
    async *open(): AsyncIterable<CaptureBatch> {
      throw new ConnectorProtocolError(`${kit.manifest.display_name} supports push delivery only`);
    },
  };
}

export function secretReference(input: z.input<typeof SecretReferenceSchema>): z.output<typeof SecretReferenceSchema> {
  return SecretReferenceSchema.parse(input);
}

function createAdaptContext<Configuration>(
  connection: SourceConnection,
  configuration: Configuration,
  capturedAt: string,
): ConnectorAdaptContext<Configuration> {
  CaptureTimestampSchema.parse(capturedAt);
  const source = (
    identity: ConnectorCandidateSource["identity"],
    input: { source_id: string; source_kind: string; assertion?: "direct" | "source_derived" },
  ) => ConnectorCandidateSourceSchema.parse({
    ...input,
    identity,
    assertion: input.assertion ?? "direct",
  });
  return {
    connection,
    configuration,
    captured_at: capturedAt,
    stableSource: input => source("stable_source", input),
    occurrence: input => source("occurrence", input),
    externalReference: input => ViewRepresentationSchema.parse({
      form: "external_reference",
      kind: input.kind,
      uri: input.uri,
      ...(input.media_type ? { media_type: input.media_type } : {}),
      ...(input.digest ? { digest: input.digest } : {}),
      metadata: input.metadata ?? {},
    }),
    policy: overrides => {
      const policy = ViewPolicySchema.parse({ ...connection.privacy, ...(overrides ?? {}) });
      assertPolicyNotWeaker(connection.privacy, policy);
      return policy;
    },
  };
}

function assertUniqueDeclaredSchemas(manifest: ConnectorManifest): void {
  const schemas = manifest.emitted_schemas.map(schema => `${schema.name}@${schema.version}`);
  if (new Set(schemas).size !== schemas.length) {
    throw new ConnectorKitError(
      "Connector manifest contains duplicate emitted Schema identities",
      "invalid_connector_manifest",
    );
  }
}

function assertSchemaDeclared(manifest: ConnectorManifest, schema: ViewSchemaRef, candidateIndex: number): void {
  const declared = manifest.emitted_schemas.some(item => canonicalJson(item) === canonicalJson(schema));
  if (!declared) {
    throw new ConnectorKitError(
      `Candidate Schema ${schema.name}@${schema.version} is not declared by the Connector manifest`,
      "candidate_schema_not_declared",
      { candidate_index: candidateIndex, schema_name: schema.name, schema_version: schema.version },
    );
  }
}

function assertPolicyNotWeaker(base: ViewPolicy, candidate: ViewPolicy, candidateIndex?: number): void {
  const visibility = { public: 0, shared: 1, private: 2 } as const;
  const privacy = { public: 0, private: 1, sensitive: 2 } as const;
  const retention = { archive: 0, normal: 1, session: 2, do_not_store: 3 } as const;
  const weakened = candidate.owner !== base.owner
    || visibility[candidate.visibility] < visibility[base.visibility]
    || privacy[candidate.privacy] < privacy[base.privacy]
    || retention[candidate.retention] < retention[base.retention]
    || (!base.allow_external_model && candidate.allow_external_model)
    || (!base.allow_embedding && candidate.allow_embedding)
    || (base.allow_local_search === false && candidate.allow_local_search !== false)
    || base.labels.some(label => !candidate.labels.includes(label));
  if (weakened) {
    throw new ConnectorKitError(
      "Connector candidate policy cannot weaken its Source Connection policy",
      "candidate_policy_weakened",
      candidateIndex === undefined ? {} : { candidate_index: candidateIndex },
    );
  }
}

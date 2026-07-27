import { createHash } from "node:crypto";
import { Client, isFullPageOrDataSource, type SearchResponse } from "@notionhq/client";
import { z } from "zod";
import {
  CaptureRuntimeError,
  ConnectorManifestSchema,
  ConnectorProtocolError,
  SourceConnectionSchema,
  defineConnectorKit,
  type CaptureBatch,
  type ConnectorContext,
  type ConnectorDiscoveryResult,
  type ConnectorOpenRequest,
  type ConnectorPackageImplementation,
  type ConnectorPort,
  SecretReferenceSchema,
  type SourceConnection,
} from "@info/capture";
import { canonicalJson, type JsonObject } from "@info/view";

export const NOTION_CONNECTOR_MANIFEST = ConnectorManifestSchema.parse({
  id: "notion",
  version: "1.0.0",
  display_name: "Notion Capture",
  protocols: ["native_sdk"],
  capabilities: ["health", "discover", "incremental"],
  delivery_kinds: ["pull", "reference"],
  emitted_schemas: [{
    name: "capture.notion.object",
    version: 1,
    mode: "freeform",
    search_projection: {
      version: 1,
      fields: [
        { path: "/name", category: "title" },
        { path: "/aliases/*", category: "url" },
        { path: "/representation/value/title", category: "title" },
        { path: "/representation/value/url", category: "url" },
        { path: "/representation/value/plain_text", category: "text" },
        { path: "/representation/value/id", category: "identifier" },
        { path: "/representation/value/last_edited_time", category: "timestamp" },
      ],
    },
  }],
});

const NotionConfigurationSchema = z.object({
  page_size: z.number().int().min(1).max(100).default(50),
  max_pages_per_run: z.number().int().min(1).max(100).default(10),
}).strict();

const NotionObjectSchema = z.object({
  object: z.enum(["page", "data_source"]),
  id: z.string().uuid(),
  url: z.string().url().optional(),
  created_time: z.string().datetime({ offset: true }),
  last_edited_time: z.string().datetime({ offset: true }),
}).passthrough();

const NotionPagePayloadSchema = z.object({
  object: NotionObjectSchema,
}).strict();

export const NOTION_CONNECTOR_KIT = defineConnectorKit({
  manifest: NOTION_CONNECTOR_MANIFEST,
  configuration_schema: NotionConfigurationSchema,
  payload_schema: NotionPagePayloadSchema,
  adapt(payload, context) {
    const object = payload.object;
    const title = notionTitle(object);
    return [{
      idempotency_key: `notion:${object.id}:${object.last_edited_time}`,
      name: title || `Notion ${object.object} ${object.id}`,
      purpose: "Preserve one exact Notion source object for later View transformations",
      aliases: object.url ? [object.url] : [],
      schema: NOTION_CONNECTOR_MANIFEST.emitted_schemas[0]!,
      observed_at: object.last_edited_time,
      source: context.stableSource({ source_id: object.id, source_kind: `notion_${object.object}` }),
      representation: {
        form: "inline" as const,
        kind: "notion_source_object",
        media_type: "application/json",
        value: sanitizeNotionObject(object),
        metadata: { provider: "notion", media_policy: "external_references_only" },
      },
      metadata: { notion_object: object.object },
    }];
  },
});

type NotionClientPort = {
  users: { me(args: Record<string, never>): Promise<unknown> };
  search(args: { start_cursor?: string; page_size?: number }): Promise<SearchResponse>;
};

export type NotionSecretResolver = {
  resolve(reference: z.infer<typeof SecretReferenceSchema>): Promise<string>;
};

export class NotionCaptureConnector implements ConnectorPort {
  readonly manifest = NOTION_CONNECTOR_MANIFEST;

  constructor(private readonly options: {
    secret_resolver: NotionSecretResolver;
    client_factory?: (token: string) => NotionClientPort;
    now?: () => string;
  }) {}

  async health(connection: SourceConnection): Promise<{ capabilities: string[]; details: JsonObject }> {
    const client = await this.client(connection);
    const identity = await client.users.me({});
    return { capabilities: [...this.manifest.capabilities], details: { identity_type: notionIdentityType(identity) } };
  }

  async *open(connection: SourceConnection, request: ConnectorOpenRequest, context: ConnectorContext): AsyncIterable<CaptureBatch> {
    if (request.delivery !== "pull" && request.delivery !== "reference") {
      throw new ConnectorProtocolError(`Notion Connector does not support ${request.delivery}`);
    }
    const configuration = NotionConfigurationSchema.parse(connection.configuration);
    const client = await this.client(connection);
    let cursor = notionCheckpointCursor(request.checkpoint.cursor);
    let committedCursor = request.checkpoint.cursor;
    let emittedBatches = 0;
    for (let page = 0; page < configuration.max_pages_per_run; page += 1) {
      if (context.signal?.aborted) throw new CaptureRuntimeError("Notion capture was cancelled", "cancelled", "connector", false);
      const response = await client.search({ ...(cursor ? { start_cursor: cursor } : {}), page_size: configuration.page_size });
      const fullResults = response.results.filter(isFullPageOrDataSource);
      if (fullResults.length !== response.results.length) {
        throw new ConnectorProtocolError("Notion search returned a partial object that cannot advance an exact Capture checkpoint", {
          result_count: response.results.length,
          full_result_count: fullResults.length,
        });
      }
      const accepted = fullResults.map((item, index) => {
        const parsed = NotionObjectSchema.safeParse(item);
        if (!parsed.success) {
          throw new ConnectorProtocolError("Notion search returned a full object outside the supported source contract", {
            result_index: index,
            issue_count: parsed.error.issues.length,
          }, { cause: parsed.error });
        }
        return parsed.data;
      });
      const nextCursor = response.has_more ? response.next_cursor : null;
      if (accepted.length > 0) {
        const revision = request.checkpoint.revision + emittedBatches + 1;
        const nextCheckpointCursor = notionCursor(nextCursor);
        const pageEvidenceDigest = createHash("sha256").update(canonicalJson({
          objects: accepted.map(item => ({
            id: item.id,
            object: item.object,
            last_edited_time: item.last_edited_time,
          })),
          previous: committedCursor,
          next: nextCheckpointCursor,
        })).digest("hex");
        const batches = accepted.map((item, index) => NOTION_CONNECTOR_KIT.createBatch({
          connection,
          payload: { object: item },
          id: `notion:${connection.id}:${revision}:${index}`,
          idempotency_key: `notion:${connection.id}:page:${pageEvidenceDigest}`,
          delivery: request.delivery,
          sequence: revision,
          created_at: (this.options.now ?? (() => new Date().toISOString()))(),
          checkpoint: {
            expected_revision: revision - 1,
            previous: committedCursor,
            next: nextCheckpointCursor,
          },
          metadata: { provider_page: page + 1 },
        }));
        // One Capture Batch owns one checkpoint transition, so provider objects
        // are combined rather than advancing the same cursor multiple times.
        yield {
          ...batches[0]!,
          id: `notion:${connection.id}:page:${pageEvidenceDigest}`,
          idempotency_key: `notion:${connection.id}:page:${pageEvidenceDigest}`,
          candidates: batches.flatMap(batch => batch.candidates),
        };
        emittedBatches += 1;
        committedCursor = nextCheckpointCursor;
      }
      cursor = nextCursor ?? undefined;
      if (!response.has_more || !cursor) break;
    }
  }

  async discover(connection: SourceConnection, parameters: JsonObject = {}): Promise<ConnectorDiscoveryResult> {
    const configuration = NotionConfigurationSchema.parse(connection.configuration);
    const client = await this.client(connection);
    const pageSize = typeof parameters.limit === "number" ? Math.min(Math.max(Math.trunc(parameters.limit), 1), 100) : configuration.page_size;
    const response = await client.search({ page_size: pageSize });
    return {
      items: response.results.slice(0, pageSize).map(item => ({
        id: item.id,
        object: item.object,
        ...(item.object === "page" || item.object === "data_source" ? { title: notionTitle(item) } : {}),
        ...(item.object === "page" && "url" in item && item.url ? { url: item.url } : {}),
      })),
      ...(response.next_cursor ? { next_cursor: { notion: { start_cursor: response.next_cursor } } } : {}),
    };
  }

  private async client(connectionInput: SourceConnection): Promise<NotionClientPort> {
    const connection = SourceConnectionSchema.parse(connectionInput);
    const reference = connection.secret_refs.notion_token;
    if (!reference || Object.keys(connection.secret_refs).length !== 1) {
      throw new ConnectorProtocolError("Notion requires exactly the named notion_token SecretReference");
    }
    const token = await this.options.secret_resolver.resolve(reference);
    if (!token.trim()) throw new ConnectorProtocolError("Notion token resolution returned an empty value");
    return this.options.client_factory?.(token) ?? new Client({ auth: token });
  }
}

export function notionSourceConnection(input: {
  id?: string;
  display_name?: string;
  secret_ref: z.infer<typeof SecretReferenceSchema>;
  configuration?: z.input<typeof NotionConfigurationSchema>;
  privacy?: SourceConnection["privacy"];
  enabled?: boolean;
  package_ref?: SourceConnection["connector_package"];
}): SourceConnection {
  return NOTION_CONNECTOR_KIT.createConnection({
    id: input.id ?? "notion:default",
    display_name: input.display_name ?? "My Notion workspace",
    enabled: input.enabled ?? true,
    ...(input.package_ref ? { connector_package: input.package_ref } : {}),
    delivery_kinds: ["pull", "reference"],
    secret_refs: { notion_token: input.secret_ref },
    configuration: input.configuration ?? {},
    ...(input.privacy ? { privacy: input.privacy } : {}),
  });
}

export function notionConnectorPackageImplementation(input: {
  descriptor: ConnectorPackageImplementation["descriptor"];
  secret_resolver: NotionSecretResolver;
  client_factory?: (token: string) => NotionClientPort;
  now?: () => string;
}): ConnectorPackageImplementation {
  const connector = new NotionCaptureConnector(input);
  return {
    descriptor: input.descriptor,
    connector,
    validateConfiguration(configuration) {
      return NotionConfigurationSchema.parse(configuration);
    },
    discover: ({ connection, parameters }) => connector.discover(connection, parameters),
  };
}

function notionCheckpointCursor(cursor: JsonObject): string | undefined {
  const notion = cursor.notion;
  if (typeof notion !== "object" || notion === null || Array.isArray(notion)) return undefined;
  return typeof notion.start_cursor === "string" ? notion.start_cursor : undefined;
}

function notionCursor(cursor: string | null | undefined): JsonObject {
  return { notion: { ...(cursor ? { start_cursor: cursor } : {}), exhausted: !cursor } };
}

function notionTitle(object: Record<string, unknown>): string {
  const properties = object.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return "";
  for (const property of Object.values(properties)) {
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const candidate = property as { type?: unknown; title?: unknown };
    if (candidate.type !== "title" || !Array.isArray(candidate.title)) continue;
    return candidate.title.map(item => typeof item === "object" && item !== null && "plain_text" in item ? String(item.plain_text) : "").join("").trim();
  }
  return "";
}

function sanitizeNotionObject(object: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify({ ...object, title: notionTitle(object), plain_text: collectPlainText(object) })) as JsonObject;
}

function collectPlainText(value: unknown): string {
  const values: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return void item.forEach(visit);
    if (typeof item !== "object" || item === null) return;
    if ("plain_text" in item && typeof item.plain_text === "string") values.push(item.plain_text);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return values.join(" ").trim();
}

function notionIdentityType(value: unknown): string {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return "unknown";
  return value.type;
}

import { createHash } from "node:crypto";
import {
  CaptureBatchSchema,
  CaptureRuntimeError,
  ConnectorManifestSchema,
  SourceConnectionSchema,
  type CaptureBatch,
  type ConnectorOpenRequest,
  type ConnectorPort,
  type ConnectorRuntime,
  type RawViewCandidate,
  type SourceConnection,
} from "@info/capture";
import {
  JsonValueSchema,
  canonicalJson,
  type JsonObject,
  type JsonValue,
  type ViewPolicy,
  type ViewRepresentation,
  type ViewSearchProjection,
} from "@info/view";
import { z } from "zod";
import {
  SCREENPIPE_API_CONTRACT_VERSION,
  SCREENPIPE_ENGINE_VERSION_FAMILY,
  SCREENPIPE_MAX_OVERLAP_IDENTITIES,
  SCREENPIPE_MAX_OVERLAP_PAGES,
  SCREENPIPE_SEARCH_OVERLAP_MS,
  ScreenpipeActivitySummaryResponseSchema,
  ScreenpipeConnectionConfigurationSchema,
  ScreenpipeCursorSchema,
  ScreenpipeElementsResponseSchema,
  ScreenpipeHealthResponseSchema,
  ScreenpipeOpenParametersSchema,
  ScreenpipeSearchResponseSchema,
  type ScreenpipeActivitySummaryResponse,
  type ScreenpipeContentItem,
  type ScreenpipeElement,
  type ScreenpipeOpenParameters,
} from "./contracts.js";

type FetchLike = typeof fetch;
type SecretReference = SourceConnection["secret_refs"][string];
type SearchModality = "ocr" | "audio" | "input" | "accessibility";
type ScreenpipeCursor = z.infer<typeof ScreenpipeCursorSchema>;
type SearchWatermark = NonNullable<NonNullable<ScreenpipeCursor["screenpipe"]["search_watermarks"]>[SearchModality]>;

const SCREENPIPE_SEARCH_PROJECTION: ViewSearchProjection = {
  version: 1,
  fields: [
    { path: "/name", category: "title" },
    { path: "/aliases/*", category: "url" },
    { path: "/representation/value/item_type", category: "identifier" },
    { path: "/representation/value/content/text", category: "text" },
    { path: "/representation/value/content/transcription", category: "text" },
    { path: "/representation/value/content/text_content", category: "text" },
    { path: "/representation/value/content/app_name", category: "title" },
    { path: "/representation/value/content/window_name", category: "title" },
    { path: "/representation/value/content/window_title", category: "title" },
    { path: "/representation/value/content/browser_url", category: "url" },
    { path: "/representation/value/content/timestamp", category: "timestamp" },
    { path: "/representation/value/content/id", category: "identifier" },
    { path: "/representation/value/content/frame_id", category: "identifier" },
    { path: "/representation/value/content/chunk_id", category: "identifier" },
    { path: "/provenance/capture/connector", category: "provenance" },
    { path: "/provenance/capture/connection_id", category: "provenance" },
    { path: "/provenance/capture/source_id", category: "provenance" },
    { path: "/provenance/capture/source_kind", category: "provenance" },
  ],
};

function screenpipeSchema(name: string) {
  return { name, version: 1 as const, mode: "freeform" as const, search_projection: SCREENPIPE_SEARCH_PROJECTION };
}

export const SCREENPIPE_CONNECTOR_MANIFEST = ConnectorManifestSchema.parse({
  id: "screenpipe",
  version: "1.0.0",
  display_name: "Screenpipe REST Capture",
  protocols: ["rest"],
  capabilities: [
    "pull",
    "frame_ocr",
    "audio",
    "input",
    "ui_accessibility",
    "ui_element",
    "activity_summary",
    "external_media_reference",
  ],
  delivery_kinds: ["pull"],
  emitted_schemas: [
    screenpipeSchema("capture.screenpipe.frame_ocr"),
    screenpipeSchema("capture.screenpipe.audio"),
    screenpipeSchema("capture.screenpipe.input"),
    screenpipeSchema("capture.screenpipe.ui_accessibility"),
    screenpipeSchema("capture.screenpipe.ui_element"),
    screenpipeSchema("capture.screenpipe.activity_summary"),
  ],
});

export type ScreenpipeConnectorOptions = {
  fetch?: FetchLike;
  timeout_ms?: number;
  now?: () => string;
  secret_resolver?: ScreenpipeSecretResolver;
};

export interface ScreenpipeSecretResolver {
  resolve(ref: SecretReference): Promise<string>;
}

type NegotiatedConnection = {
  endpoint: string;
  engine_version: string;
  capabilities: string[];
};

export class ScreenpipeCaptureConnector implements ConnectorPort {
  readonly manifest = SCREENPIPE_CONNECTOR_MANIFEST;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly negotiated = new Map<string, NegotiatedConnection>();

  constructor(private readonly options: ScreenpipeConnectorOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeout_ms ?? 8_000;
    this.now = options.now ?? (() => new Date().toISOString());
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("Screenpipe timeout_ms must be a positive integer");
    }
  }

  async health(connection: SourceConnection, context: { signal?: AbortSignal }): Promise<{ capabilities: string[] }> {
    const endpoint = endpointFor(connection);
    const configuration = parseProviderContract(
      ScreenpipeConnectionConfigurationSchema,
      connection.configuration,
      "connection configuration",
    );
    const body = await this.requestJson(connection, endpoint, "/health", false, context.signal);
    const health = parseProviderContract(ScreenpipeHealthResponseSchema, body, "/health response");
    if (health.status_code >= 400 || health.status !== "healthy") {
      throw new CaptureRuntimeError(
        `Screenpipe health is ${health.status} (${health.status_code})`,
        "screenpipe_unhealthy",
        "connector",
        true,
        { status: health.status, status_code: health.status_code },
      );
    }
    if (!health.version) {
      throw new CaptureRuntimeError(
        "Screenpipe /health omitted its engine version",
        "screenpipe_version_missing",
        "connector",
        false,
        { supported_family: engineFamilyLabel() },
      );
    }
    assertSupportedEngineVersion(health.version);
    const declared = [...this.manifest.capabilities];
    const missing = configuration.required_capabilities.filter(capability => !declared.includes(capability));
    if (missing.length > 0) {
      throw new CaptureRuntimeError(
        "Screenpipe connection requires unsupported capabilities",
        "screenpipe_capability_mismatch",
        "connector",
        false,
        { missing, available: declared },
      );
    }
    const probed = await this.probeCapabilities(
      connection,
      endpoint,
      configuration.required_capabilities,
      context.signal,
    );
    const capabilities = [...new Set(["pull", "external_media_reference", ...probed])];
    this.negotiated.set(connection.id, { endpoint, engine_version: health.version, capabilities });
    return { capabilities };
  }

  async *open(
    connection: SourceConnection,
    request: ConnectorOpenRequest,
    context: { signal?: AbortSignal },
  ): AsyncIterable<CaptureBatch> {
    if (request.delivery !== "pull") {
      throw new CaptureRuntimeError(
        `Screenpipe does not support ${request.delivery} delivery`,
        "unsupported_delivery",
        "connector",
        false,
      );
    }
    const negotiated = this.negotiated.get(connection.id);
    if (!negotiated || negotiated.endpoint !== endpointFor(connection)) {
      throw new CaptureRuntimeError(
        "Screenpipe capture was opened before successful health/version negotiation",
        "screenpipe_not_negotiated",
        "connector",
        false,
      );
    }
    const parameters = parseOpenParameters(request.parameters);
    assertResourceCapability(parameters, negotiated.capabilities);
    const cursor = parseCursor(request.checkpoint.cursor);
    const capturedAt = this.now();
    const result = await this.fetchResource(connection, negotiated.endpoint, parameters, cursor, context.signal);
    if (result.candidates.length === 0) return;
    const fingerprint = digest({
      connection_id: connection.id,
      resource: parameters.resource,
      query: parameters.query,
      response_digest: result.response_digest,
      checkpoint_revision: request.checkpoint.revision,
    });
    yield CaptureBatchSchema.parse({
      id: `screenpipe-batch:${fingerprint}`,
      idempotency_key: `screenpipe-delivery:${fingerprint}`,
      connector: { id: this.manifest.id, version: this.manifest.version },
      connection_id: connection.id,
      delivery: "pull",
      sequence: request.checkpoint.revision + 1,
      candidates: result.candidates,
      checkpoint: {
        expected_revision: request.checkpoint.revision,
        previous: request.checkpoint.cursor,
        next: result.next_cursor,
      },
      created_at: capturedAt,
      metadata: {
        provider: "screenpipe",
        resource: parameters.resource,
        api_contract_version: SCREENPIPE_API_CONTRACT_VERSION,
        engine_version: negotiated.engine_version,
        response_digest: result.response_digest,
      },
    });
  }

  private async probeCapabilities(
    connection: SourceConnection,
    endpoint: string,
    required: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const capabilities: string[] = [];
    for (const capability of required) {
      if (capability === "pull" || capability === "external_media_reference") {
        capabilities.push(capability);
        continue;
      }
      if (capability === "frame_ocr" || capability === "audio" || capability === "input" || capability === "ui_accessibility") {
        const contentType = capability === "frame_ocr"
          ? "ocr"
          : capability === "ui_accessibility"
            ? "accessibility"
            : capability;
        const body = await this.requestJson(
          connection,
          endpoint,
          `/search?${queryString({ content_type: contentType, order: "ascending", limit: 1, offset: 0, include_frames: false, include_cloud: false, format: "json" })}`,
          true,
          signal,
        );
        const response = parseProviderContract(ScreenpipeSearchResponseSchema, body, `/search ${contentType} capability probe`);
        assertSearchModality(response.data, contentType);
        capabilities.push(capability);
        continue;
      }
      if (capability === "ui_element") {
        const body = await this.requestJson(connection, endpoint, "/elements?limit=1&offset=0&format=json", true, signal);
        parseProviderContract(ScreenpipeElementsResponseSchema, body, "/elements capability probe");
        capabilities.push(capability);
        continue;
      }
      if (capability === "activity_summary") {
        const end = this.now();
        const start = new Date(Date.parse(end) - 60_000).toISOString();
        const body = await this.requestJson(
          connection,
          endpoint,
          `/activity-summary?${queryString({ start_time: start, end_time: end })}`,
          true,
          signal,
        );
        parseProviderContract(ScreenpipeActivitySummaryResponseSchema, body, "/activity-summary capability probe");
        capabilities.push(capability);
      }
    }
    return [...new Set(capabilities)];
  }

  private async fetchResource(
    connection: SourceConnection,
    endpoint: string,
    parameters: ScreenpipeOpenParameters,
    cursor: ScreenpipeCursor,
    signal?: AbortSignal,
  ): Promise<{
    candidates: RawViewCandidate[];
    next_cursor: ScreenpipeCursor;
    response_digest: string;
  }> {
    const capturedAt = this.now();
    if (parameters.resource === "search") {
      const responses: Array<{
        content_type: SearchModality;
        items: ScreenpipeContentItem[];
        watermark?: SearchWatermark;
        page_digests: string[];
      }> = [];
      for (const contentType of parameters.query.content_types) {
        responses.push(await this.fetchSearchModality(
          connection,
          endpoint,
          contentType,
          parameters.query,
          cursor.screenpipe.search_watermarks?.[contentType],
          signal,
        ));
      }
      const responseDigest = digest(responses.map(response => ({
        content_type: response.content_type,
        page_digests: response.page_digests,
      })));
      const searchWatermarks = { ...cursor.screenpipe.search_watermarks };
      for (const response of responses) {
        if (response.watermark) searchWatermarks[response.content_type] = response.watermark;
      }
      return {
        candidates: responses.flatMap(({ items }) => items.map(item => (
          candidateFromSearchItem(item, connection, capturedAt, digest(item))
        ))),
        next_cursor: ScreenpipeCursorSchema.parse({
          screenpipe: { ...cursor.screenpipe, search_watermarks: searchWatermarks },
        }),
        response_digest: responseDigest,
      };
    }
    if (parameters.resource === "elements") {
      const offset = cursor.screenpipe.elements_offset ?? 0;
      const query = queryString({ ...parameters.query, offset, format: "json" });
      const body = await this.requestJson(connection, endpoint, `/elements?${query}`, true, signal);
      const response = parseProviderContract(ScreenpipeElementsResponseSchema, body, "/elements response");
      if (response.pagination.offset !== offset) {
        throw new CaptureRuntimeError(
          "Screenpipe /elements pagination offset does not match the requested checkpoint",
          "screenpipe_checkpoint_incompatible",
          "connector",
          false,
          { requested_offset: offset, response_offset: response.pagination.offset },
        );
      }
      const responseDigest = digest(response);
      return {
        candidates: response.data.map(item => candidateFromElement(item, connection, capturedAt, digest(item))),
        next_cursor: ScreenpipeCursorSchema.parse({
          screenpipe: { ...cursor.screenpipe, elements_offset: offset + response.data.length },
        }),
        response_digest: responseDigest,
      };
    }
    const query = queryString(parameters.query);
    const body = await this.requestJson(connection, endpoint, `/activity-summary?${query}`, true, signal);
    const response = parseProviderContract(ScreenpipeActivitySummaryResponseSchema, body, "/activity-summary response");
    const responseDigest = digest(response);
    return {
      candidates: [candidateFromActivity(response, parameters.query, connection, capturedAt, responseDigest)],
      next_cursor: ScreenpipeCursorSchema.parse({
        screenpipe: { ...cursor.screenpipe, last_activity_digest: responseDigest },
      }),
      response_digest: responseDigest,
    };
  }

  private async fetchSearchModality(
    connection: SourceConnection,
    endpoint: string,
    contentType: SearchModality,
    input: Extract<ScreenpipeOpenParameters, { resource: "search" }>["query"],
    previous: SearchWatermark | undefined,
    signal?: AbortSignal,
  ): Promise<{
    content_type: SearchModality;
    items: ScreenpipeContentItem[];
    watermark?: SearchWatermark;
    page_digests: string[];
  }> {
    const { content_types: _contentTypes, ...baseQuery } = input;
    const queryFingerprint = searchQueryFingerprint(input);
    if (previous && previous.query_fingerprint !== queryFingerprint) {
      throw new CaptureRuntimeError(
        "Screenpipe search selector changed after its modality checkpoint advanced",
        "screenpipe_checkpoint_scope_mismatch",
        "connector",
        false,
        { content_type: contentType },
      );
    }
    const startTime = effectiveSearchStart(input.start_time, previous?.observed_at);
    const known = new Set(previous?.seen.map(item => item.item_key) ?? []);
    const selected: ScreenpipeContentItem[] = [];
    const pageDigests: string[] = [];
    let offset = 0;
    let pages = 0;

    while (selected.length < input.limit) {
      if (pages >= SCREENPIPE_MAX_OVERLAP_PAGES) {
        throw new CaptureRuntimeError(
          "Screenpipe overlap scan exhausted its bounded page budget",
          "screenpipe_overlap_scan_exhausted",
          "connector",
          false,
          { content_type: contentType, pages, limit: input.limit },
        );
      }
      const query = queryString({
        ...baseQuery,
        ...(startTime ? { start_time: startTime } : {}),
        content_type: contentType,
        order: "ascending",
        offset,
        include_frames: false,
        include_cloud: false,
        format: "json",
      });
      const body = await this.requestJson(connection, endpoint, `/search?${query}`, true, signal);
      const response = parseProviderContract(ScreenpipeSearchResponseSchema, body, `/search ${contentType} response`);
      if (response.pagination.offset !== offset) {
        throw new CaptureRuntimeError(
          "Screenpipe /search pagination offset does not match the requested overlap scan",
          "screenpipe_checkpoint_incompatible",
          "connector",
          false,
          { content_type: contentType, requested_offset: offset, response_offset: response.pagination.offset },
        );
      }
      assertSearchModality(response.data, contentType);
      pages += 1;
      pageDigests.push(digest(response));
      for (const item of response.data) {
        const itemKey = searchItemKey(item);
        if (known.has(itemKey)) continue;
        known.add(itemKey);
        selected.push(item);
        if (selected.length === input.limit) break;
      }

      const nextOffset = offset + response.data.length;
      if (response.data.length === 0 || nextOffset >= response.pagination.total || selected.length === input.limit) break;
      if (nextOffset <= offset) {
        throw new CaptureRuntimeError(
          "Screenpipe overlap scan did not advance",
          "screenpipe_checkpoint_incompatible",
          "connector",
          false,
          { content_type: contentType, offset, returned: response.data.length },
        );
      }
      offset = nextOffset;
    }

    return {
      content_type: contentType,
      items: selected,
      watermark: advanceSearchWatermark(previous, selected, queryFingerprint),
      page_digests: pageDigests,
    };
  }

  private async requestJson(
    connection: SourceConnection,
    endpoint: string,
    path: string,
    protectedEndpoint: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Screenpipe request timed out")), this.timeoutMs);
    const url = new URL(path, `${endpoint}/`).toString();
    try {
      const authorization = protectedEndpoint ? await this.resolveAuthorization(connection) : undefined;
      const response = await this.fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(authorization ? { authorization } : {}),
        },
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        throw new CaptureRuntimeError(
          `Screenpipe ${new URL(url).pathname} returned HTTP ${response.status}`,
          "screenpipe_http_error",
          "connector",
          response.status === 408 || response.status === 503 || response.status === 504,
          {
            path: new URL(url).pathname,
            status: response.status,
            ...(retryAfter ? { retry_after: retryAfter } : {}),
          },
        );
      }
      const raw = await response.text();
      try {
        return raw.length > 0 ? JSON.parse(raw) : {};
      } catch (error) {
        throw new CaptureRuntimeError(
          `Screenpipe ${new URL(url).pathname} returned invalid JSON`,
          "screenpipe_invalid_json",
          "connector",
          false,
          { path: new URL(url).pathname },
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof CaptureRuntimeError) throw error;
      if (signal?.aborted) {
        throw new CaptureRuntimeError("Screenpipe request was cancelled", "cancelled", "connector", false, {}, { cause: error });
      }
      if (controller.signal.aborted) {
        throw new CaptureRuntimeError(
          "Screenpipe request timed out",
          "screenpipe_timeout",
          "connector",
          true,
          { path: new URL(url).pathname, timeout_ms: this.timeoutMs },
          { cause: error },
        );
      }
      throw new CaptureRuntimeError(
        "Screenpipe source is unavailable",
        "screenpipe_unavailable",
        "connector",
        true,
        { path: new URL(url).pathname },
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async resolveAuthorization(connection: SourceConnection): Promise<string | undefined> {
    const configuration = parseProviderContract(
      ScreenpipeConnectionConfigurationSchema,
      connection.configuration,
      "connection configuration",
    );
    if (configuration.authentication.mode === "none") {
      if (Object.keys(connection.secret_refs).length !== 0) {
        throw authConfigurationError("Screenpipe authentication mode none cannot declare secret references");
      }
      return undefined;
    }
    if (Object.keys(connection.secret_refs).length !== 1
      || canonicalJson(connection.secret_refs.screenpipe_api_key) !== canonicalJson(configuration.authentication.secret_ref)) {
      throw authConfigurationError("Screenpipe bearer authentication requires exactly its declared secret reference");
    }
    if (!this.options.secret_resolver) {
      throw authConfigurationError("Screenpipe bearer authentication requires a secret resolver");
    }
    let value: string;
    try {
      value = await this.options.secret_resolver.resolve(configuration.authentication.secret_ref);
    } catch {
      throw authConfigurationError("Screenpipe API key resolution failed");
    }
    if (!value.trim()) throw authConfigurationError("Screenpipe API key resolution returned an empty value");
    if (/\r|\n/.test(value)) throw authConfigurationError("Screenpipe API key contains invalid header characters");
    return `Bearer ${value.trim()}`;
  }
}

export function screenpipeSourceConnection(input: {
  id?: string;
  endpoint?: string;
  privacy?: ViewPolicy;
  required_capabilities?: string[];
  secret_refs?: SourceConnection["secret_refs"];
  authentication?: "none" | "bearer";
} = {}): SourceConnection {
  const secretRefs = input.secret_refs ?? {};
  const secretCount = Object.keys(secretRefs).length;
  const authentication = input.authentication ?? (secretCount === 1 ? "bearer" : "none");
  if (authentication === "bearer" && (secretCount !== 1 || !secretRefs.screenpipe_api_key)) {
    throw authConfigurationError("Screenpipe bearer authentication requires exactly one secret reference");
  }
  if (authentication === "none" && secretCount !== 0) {
    throw authConfigurationError("Screenpipe authentication mode none cannot declare secret references");
  }
  return SourceConnectionSchema.parse({
    id: input.id ?? "screenpipe:default",
    connector_id: SCREENPIPE_CONNECTOR_MANIFEST.id,
    connector_version: SCREENPIPE_CONNECTOR_MANIFEST.version,
    display_name: "Local Screenpipe",
    endpoint: input.endpoint ?? "http://127.0.0.1:3030",
    enabled: true,
    delivery_kinds: ["pull"],
    secret_refs: secretRefs,
    configuration: {
      api_contract_version: SCREENPIPE_API_CONTRACT_VERSION,
      required_capabilities: input.required_capabilities ?? [
        "frame_ocr",
        "audio",
        "input",
        "ui_accessibility",
        "ui_element",
      ],
      authentication: authentication === "bearer"
        ? { mode: "bearer", secret_ref: secretRefs.screenpipe_api_key }
        : { mode: "none" },
    },
    privacy: input.privacy ?? privatePolicy(),
  });
}

export async function configureScreenpipeCapture(input: {
  runtime: ConnectorRuntime;
  connector?: ScreenpipeCaptureConnector;
  connection?: SourceConnection;
}): Promise<{ connector: ScreenpipeCaptureConnector; connection: SourceConnection }> {
  const connector = input.connector ?? new ScreenpipeCaptureConnector();
  const connection = input.connection ?? screenpipeSourceConnection();
  input.runtime.registerConnector(connector);
  await input.runtime.registerConnection(connection);
  return { connector, connection };
}

function candidateFromSearchItem(
  item: ScreenpipeContentItem,
  connection: SourceConnection,
  capturedAt: string,
  responseDigest: string,
): RawViewCandidate {
  const details = searchItemDetails(item, connection);
  const value = JsonValueSchema.parse({
    provider: "screenpipe",
    api_contract_version: SCREENPIPE_API_CONTRACT_VERSION,
    item_type: item.type,
    content: item.content,
  });
  return rawCandidate({
    connection,
    capturedAt,
    observedAt: details.observed_at,
    sourceId: details.source_id,
    sourceKind: details.source_kind,
    identity: details.identity,
    assertion: "direct",
    schemaName: details.schema_name,
    name: details.name,
    aliases: details.aliases,
    representation: {
      form: "inline",
      kind: details.representation_kind,
      media_type: "application/json",
      value,
      metadata: details.external_media ? { external_media: details.external_media } : {},
    },
    responseDigest,
    metadata: { screenpipe_item_type: item.type },
  });
}

function candidateFromElement(
  element: ScreenpipeElement,
  connection: SourceConnection,
  capturedAt: string,
  responseDigest: string,
): RawViewCandidate {
  return rawCandidate({
    connection,
    capturedAt,
    sourceId: `element:${element.id}`,
    sourceKind: "ui_element",
    identity: "stable_source",
    assertion: "direct",
    schemaName: "capture.screenpipe.ui_element",
    name: compactName([element.role, element.text ?? undefined], `Screenpipe UI element ${element.id}`),
    aliases: [],
    representation: {
      form: "inline",
      kind: "screenpipe_ui_element",
      media_type: "application/json",
      value: JsonValueSchema.parse({
        provider: "screenpipe",
        api_contract_version: SCREENPIPE_API_CONTRACT_VERSION,
        item_type: "Element",
        content: element,
      }),
      metadata: {},
    },
    responseDigest,
    metadata: { frame_id: element.frame_id, element_source: element.source },
  });
}

function candidateFromActivity(
  summary: ScreenpipeActivitySummaryResponse,
  query: Extract<ScreenpipeOpenParameters, { resource: "activity" }>["query"],
  connection: SourceConnection,
  capturedAt: string,
  responseDigest: string,
): RawViewCandidate {
  const sourceId = `activity:${digest({ start_time: query.start_time, end_time: query.end_time, app_name: query.app_name ?? null })}`;
  return rawCandidate({
    connection,
    capturedAt,
    observedAt: normalizedTimestamp(summary.time_range.end, query.end_time),
    sourceId,
    sourceKind: "activity_summary",
    identity: "stable_source",
    assertion: "source_derived",
    schemaName: "capture.screenpipe.activity_summary",
    name: `Screenpipe activity ${query.start_time} to ${query.end_time}`,
    aliases: [],
    representation: {
      form: "inline",
      kind: "screenpipe_activity_summary",
      media_type: "application/json",
      value: JsonValueSchema.parse({
        provider: "screenpipe",
        api_contract_version: SCREENPIPE_API_CONTRACT_VERSION,
        item_type: "ActivitySummary",
        query,
        content: summary,
      }),
      metadata: {},
    },
    responseDigest,
    metadata: { source_derivation: "screenpipe:/activity-summary" },
  });
}

type RawCandidateInput = {
  connection: SourceConnection;
  capturedAt: string;
  observedAt?: string;
  sourceId: string;
  sourceKind: string;
  identity: "stable_source" | "occurrence";
  assertion: "direct" | "source_derived";
  schemaName: string;
  name: string;
  aliases: string[];
  representation: ViewRepresentation;
  responseDigest: string;
  metadata: JsonObject;
};

function rawCandidate(input: RawCandidateInput): RawViewCandidate {
  const contentDigest = digest({
    connection_id: input.connection.id,
    source_id: input.sourceId,
    representation: input.representation,
  });
  return {
    idempotency_key: `screenpipe-candidate:${contentDigest}`,
    name: input.name.slice(0, 500),
    purpose: `Captured Screenpipe ${input.sourceKind} evidence`,
    aliases: input.aliases,
    schema: screenpipeSchema(input.schemaName),
    ...(input.observedAt ? { observed_at: input.observedAt } : {}),
    captured_at: input.capturedAt,
    source: {
      connector: SCREENPIPE_CONNECTOR_MANIFEST.id,
      connection_id: input.connection.id,
      source_id: input.sourceId,
      source_kind: input.sourceKind,
      identity: input.identity,
      assertion: input.assertion,
    },
    representation: input.representation,
    relations: [],
    policy: input.connection.privacy,
    metadata: {
      ...input.metadata,
      screenpipe_api_contract: SCREENPIPE_API_CONTRACT_VERSION,
      response_digest: input.responseDigest,
    },
  };
}

function searchItemDetails(item: ScreenpipeContentItem, connection: SourceConnection): {
  observed_at: string;
  source_id: string;
  source_kind: string;
  identity: "stable_source" | "occurrence";
  schema_name: string;
  representation_kind: string;
  name: string;
  aliases: string[];
  external_media?: JsonValue;
} {
  if (item.type === "OCR") {
    return {
      observed_at: item.content.timestamp,
      source_id: `frame:${item.content.frame_id}`,
      source_kind: "frame_ocr",
      identity: "stable_source",
      schema_name: "capture.screenpipe.frame_ocr",
      representation_kind: "screenpipe_frame_ocr",
      name: compactName([item.content.app_name, item.content.window_name], `Screenpipe frame ${item.content.frame_id}`),
      aliases: item.content.browser_url ? [item.content.browser_url] : [],
      external_media: {
        kind: "screenpipe_frame",
        uri: `screenpipe://${encodeURIComponent(connection.id)}/frame/${item.content.frame_id}`,
      },
    };
  }
  if (item.type === "Audio") {
    return {
      observed_at: item.content.timestamp,
      source_id: `audio:${digest({
        chunk_id: item.content.chunk_id,
        offset_index: item.content.offset_index,
        timestamp: item.content.timestamp,
        start_time: item.content.start_time,
        end_time: item.content.end_time,
      })}`,
      source_kind: "audio",
      identity: "stable_source",
      schema_name: "capture.screenpipe.audio",
      representation_kind: "screenpipe_audio_transcription",
      name: compactName([item.content.speaker_label ?? undefined, item.content.device_name], `Screenpipe audio ${item.content.chunk_id}`),
      aliases: [],
      external_media: {
        kind: "screenpipe_audio_chunk",
        uri: `screenpipe://${encodeURIComponent(connection.id)}/audio/${item.content.chunk_id}`,
      },
    };
  }
  if (item.type === "UI") {
    return {
      observed_at: item.content.timestamp,
      source_id: `ui:${item.content.id}`,
      source_kind: "ui_accessibility",
      identity: "stable_source",
      schema_name: "capture.screenpipe.ui_accessibility",
      representation_kind: "screenpipe_ui_accessibility",
      name: compactName([item.content.app_name, item.content.window_name], `Screenpipe UI ${item.content.id}`),
      aliases: item.content.browser_url ? [item.content.browser_url] : [],
    };
  }
  if (item.type === "Input") {
    return {
      observed_at: item.content.timestamp,
      source_id: `input:${item.content.id}`,
      source_kind: "input",
      identity: "stable_source",
      schema_name: "capture.screenpipe.input",
      representation_kind: "screenpipe_input",
      name: compactName([item.content.app_name ?? undefined, item.content.event_type], `Screenpipe input ${item.content.id}`),
      aliases: item.content.browser_url ? [item.content.browser_url] : [],
    };
  }
  const _exhaustive: never = item;
  throw new TypeError(`Unsupported Screenpipe item ${String(_exhaustive)}`);
}

function parseOpenParameters(parameters: Record<string, unknown>): ScreenpipeOpenParameters {
  const value = Object.keys(parameters).length === 0 ? { resource: "search", query: {} } : parameters;
  const parsed = ScreenpipeOpenParametersSchema.safeParse(value);
  if (!parsed.success) throw schemaError("open parameters", parsed.error);
  return parsed.data;
}

function parseCursor(value: JsonObject): ScreenpipeCursor {
  if (Object.keys(value).length === 0) return { screenpipe: {} };
  try {
    return ScreenpipeCursorSchema.parse(value);
  } catch (error) {
    throw schemaError("checkpoint cursor", error);
  }
}

function effectiveSearchStart(requested: string | undefined, watermark: string | undefined): string | undefined {
  if (!watermark) return requested;
  const overlapStart = new Date(Date.parse(watermark) - SCREENPIPE_SEARCH_OVERLAP_MS).toISOString();
  if (!requested) return overlapStart;
  return Date.parse(requested) > Date.parse(overlapStart) ? requested : overlapStart;
}

function searchItemKey(item: ScreenpipeContentItem): string {
  return digest({ type: item.type, content: item.content });
}

function searchQueryFingerprint(input: Extract<ScreenpipeOpenParameters, { resource: "search" }>["query"]): string {
  const { content_types: _ContentTypes, limit: _limit, ...selector } = input;
  return digest(selector);
}

function advanceSearchWatermark(
  previous: SearchWatermark | undefined,
  selected: ScreenpipeContentItem[],
  queryFingerprint: string,
): SearchWatermark | undefined {
  if (selected.length === 0) return previous;
  const observed = selected.map(item => ({
    observed_at: item.content.timestamp,
    item_key: searchItemKey(item),
  }));
  const watermark = [previous?.observed_at, ...observed.map(item => item.observed_at)]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
  const cutoff = Date.parse(watermark) - SCREENPIPE_SEARCH_OVERLAP_MS;
  const retained = new Map<string, { observed_at: string; item_key: string }>();
  for (const item of [...(previous?.seen ?? []), ...observed]) {
    if (Date.parse(item.observed_at) >= cutoff) retained.set(item.item_key, item);
  }
  const seen = [...retained.values()].sort((left, right) => (
    left.observed_at.localeCompare(right.observed_at) || left.item_key.localeCompare(right.item_key)
  ));
  if (seen.length > SCREENPIPE_MAX_OVERLAP_IDENTITIES) {
    throw new CaptureRuntimeError(
      "Screenpipe overlap identity checkpoint exceeded its bounded capacity",
      "screenpipe_overlap_checkpoint_exhausted",
      "connector",
      false,
      { retained_identities: seen.length, maximum: SCREENPIPE_MAX_OVERLAP_IDENTITIES },
    );
  }
  return { observed_at: watermark, query_fingerprint: queryFingerprint, seen };
}

function parseProviderContract<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw schemaError(label, parsed.error);
  return parsed.data;
}

function schemaError(label: string, error: unknown): CaptureRuntimeError {
  const issues = error instanceof z.ZodError
    ? error.issues.slice(0, 10).map(issue => ({ path: issue.path.join("."), code: issue.code, message: issue.message }))
    : [];
  return new CaptureRuntimeError(
    `Screenpipe ${label} is incompatible with the pinned provider contract`,
    "screenpipe_schema_incompatible",
    "connector",
    false,
    { issue_count: error instanceof z.ZodError ? error.issues.length : 0, issues },
    { cause: error },
  );
}

function authConfigurationError(message: string): CaptureRuntimeError {
  return new CaptureRuntimeError(message, "screenpipe_auth_configuration", "connector", false);
}

function assertSupportedEngineVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new CaptureRuntimeError(
      "Screenpipe engine version is not valid SemVer",
      "screenpipe_incompatible_version",
      "connector",
      false,
      { actual_version: version, supported_family: engineFamilyLabel() },
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SCREENPIPE_ENGINE_VERSION_FAMILY.major || minor !== SCREENPIPE_ENGINE_VERSION_FAMILY.minor) {
    throw new CaptureRuntimeError(
      `Screenpipe engine ${version} is outside supported family ${engineFamilyLabel()}`,
      "screenpipe_incompatible_version",
      "connector",
      false,
      { actual_version: version, supported_family: engineFamilyLabel() },
    );
  }
}

function engineFamilyLabel(): string {
  return `${SCREENPIPE_ENGINE_VERSION_FAMILY.major}.${SCREENPIPE_ENGINE_VERSION_FAMILY.minor}.x`;
}

function assertResourceCapability(parameters: ScreenpipeOpenParameters, capabilities: string[]): void {
  const required = parameters.resource === "search"
    ? parameters.query.content_types.map(contentType => (
        contentType === "ocr" ? "frame_ocr" : contentType === "accessibility" ? "ui_accessibility" : contentType
      ))
    : [parameters.resource === "elements" ? "ui_element" : "activity_summary"];
  const missing = required.filter(capability => !capabilities.includes(capability));
  if (missing.length > 0) {
    throw new CaptureRuntimeError(
      `Screenpipe resource ${parameters.resource} was not negotiated`,
      "screenpipe_capability_mismatch",
      "connector",
      false,
      { resource: parameters.resource, missing },
    );
  }
}

function assertSearchModality(
  items: ScreenpipeContentItem[],
  contentType: "ocr" | "audio" | "input" | "accessibility" | string,
): void {
  const expectedType = contentType === "ocr"
    ? "OCR"
    : contentType === "audio"
      ? "Audio"
      : contentType === "input"
        ? "Input"
        : "UI";
  const unexpected = items.find(item => item.type !== expectedType);
  if (unexpected) {
    throw new CaptureRuntimeError(
      `Screenpipe ${contentType} query returned unexpected ${unexpected.type} content`,
      "screenpipe_schema_incompatible",
      "connector",
      false,
      { requested_content_type: contentType, returned_type: unexpected.type },
    );
  }
}

function endpointFor(connection: SourceConnection): string {
  if (!connection.endpoint) {
    throw new CaptureRuntimeError("Screenpipe connection requires an endpoint", "screenpipe_endpoint_missing", "connector", false);
  }
  let url: URL;
  try {
    url = new URL(connection.endpoint);
  } catch (error) {
    throw new CaptureRuntimeError("Screenpipe endpoint is not a valid URL", "screenpipe_endpoint_invalid", "connector", false, {}, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CaptureRuntimeError("Screenpipe endpoint must use HTTP or HTTPS", "screenpipe_endpoint_invalid", "connector", false, { protocol: url.protocol });
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function normalizedTimestamp(value: string, fallback: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? new Date(fallback).toISOString() : new Date(timestamp).toISOString();
}

function compactName(parts: Array<string | undefined>, fallback: string): string {
  const value = parts.filter((part): part is string => Boolean(part?.trim())).join(" - ");
  return value || fallback;
}

function digest(value: unknown): string {
  const json = JsonValueSchema.parse(value) as JsonValue;
  return createHash("sha256").update(canonicalJson(json)).digest("hex").slice(0, 32);
}

function privatePolicy(): ViewPolicy {
  return {
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: true,
    labels: [],
  };
}

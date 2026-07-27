import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createPushConnectorPort,
  defineConnectorKit,
  type CommitCaptureBatchResult,
  type ConnectorRuntime,
  type SourceConnection,
} from "@info/capture";

export const ClipboardConnectionConfigurationSchema = z.object({
  device_id: z.string().trim().min(1).max(240),
}).strict();

export const ClipboardSourcePayloadSchema = z.object({
  event_id: z.string().trim().min(1).max(240),
  change_count: z.number().int().nonnegative(),
  occurred_at: z.string().datetime({ offset: true }),
  captured_at: z.string().datetime({ offset: true }),
  source_app: z.string().trim().min(1).max(500).optional(),
  formats: z.array(z.string().trim().min(1).max(240)).default([]),
  content: z.object({
    text: z.string().optional(),
    html: z.string().optional(),
    file_urls: z.array(z.string().url()).default([]),
  }).strict(),
}).strict().superRefine((payload, context) => {
  if (payload.content.text === undefined
    && payload.content.html === undefined
    && payload.content.file_urls.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "Clipboard payload must contain text, HTML, or a file reference",
    });
  }
  if (new Set(payload.formats).size !== payload.formats.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["formats"],
      message: "Clipboard formats must be unique",
    });
  }
});

export type ClipboardSourcePayload = z.infer<typeof ClipboardSourcePayloadSchema>;

const CLIPBOARD_EVENT_SCHEMA = {
  name: "capture.clipboard.event",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    required: ["event_id", "change_count", "occurred_at", "captured_at", "formats", "content"],
    properties: {
      event_id: { type: "string" },
      change_count: { type: "integer", minimum: 0 },
      occurred_at: { type: "string" },
      captured_at: { type: "string" },
      source_app: { type: "string" },
      formats: { type: "array", items: { type: "string" }, uniqueItems: true },
      content: {
        type: "object",
        properties: {
          text: { type: "string" },
          html: { type: "string" },
          file_urls: { type: "array", items: { type: "string" } },
        },
        required: ["file_urls"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/source_app", category: "title" },
      { path: "/representation/value/content/text", category: "text" },
      { path: "/representation/value/content/html", category: "text" },
      { path: "/representation/value/content/file_urls/*", category: "url" },
      { path: "/representation/value/event_id", category: "identifier" },
      { path: "/representation/value/occurred_at", category: "timestamp" },
      { path: "/provenance/capture/source_id", category: "provenance" },
    ],
  },
} as const;

const CLIPBOARD_FILE_SCHEMA = {
  name: "capture.clipboard.file_reference",
  version: 1,
  mode: "freeform",
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/aliases/*", category: "url" },
      { path: "/representation/uri", category: "url" },
      { path: "/provenance/capture/source_id", category: "provenance" },
    ],
  },
} as const;

export const CLIPBOARD_CONNECTOR_KIT = defineConnectorKit({
  manifest: {
    id: "macos-clipboard",
    version: "1.0.0",
    display_name: "macOS Clipboard",
    protocols: ["native_sdk"],
    capabilities: ["push", "text", "html", "file_reference"],
    delivery_kinds: ["push"],
    emitted_schemas: [CLIPBOARD_EVENT_SCHEMA, CLIPBOARD_FILE_SCHEMA],
  },
  configuration_schema: ClipboardConnectionConfigurationSchema,
  payload_schema: ClipboardSourcePayloadSchema,
  adapt(payload, context) {
    const sourceApp = payload.source_app ?? "Unknown application";
    const fileUrls = payload.content.file_urls ?? [];
    const candidates: unknown[] = [{
      idempotency_key: candidateKey(context.connection.id, payload.event_id, "event"),
      name: `Clipboard event from ${sourceApp}`,
      purpose: "Preserve one source-native clipboard change for later user-directed transformations",
      aliases: payload.source_app ? [payload.source_app] : [],
      schema: CLIPBOARD_EVENT_SCHEMA,
      observed_at: payload.occurred_at,
      captured_at: payload.captured_at,
      source: context.occurrence({
        source_id: `clipboard:${payload.event_id}`,
        source_kind: "clipboard_event",
      }),
      representation: {
        form: "inline",
        kind: "clipboard_source_payload",
        media_type: "application/json",
        value: payload,
        metadata: {},
      },
      metadata: {
        device_id: context.configuration.device_id,
        change_count: payload.change_count,
      },
    }];

    fileUrls.forEach((uri, index) => {
      candidates.push({
        idempotency_key: candidateKey(context.connection.id, payload.event_id, `file:${index}`),
        name: `Clipboard file ${index + 1} from ${sourceApp}`,
        purpose: "Retain an external reference to a clipboard file without fetching or copying it",
        aliases: [uri],
        schema: CLIPBOARD_FILE_SCHEMA,
        observed_at: payload.occurred_at,
        captured_at: payload.captured_at,
        source: context.occurrence({
          source_id: `clipboard:${payload.event_id}:file:${index}`,
          source_kind: "clipboard_file_reference",
        }),
        representation: context.externalReference({
          kind: "clipboard_file_reference",
          uri,
          media_type: "application/octet-stream",
          metadata: { clipboard_event_id: payload.event_id, index },
        }),
        relations: [],
        metadata: { device_id: context.configuration.device_id, clipboard_event_id: payload.event_id, index },
      });
    });

    return candidates;
  },
});

export function clipboardSourceConnection(input: {
  id?: string;
  display_name?: string;
  device_id?: string;
  privacy?: SourceConnection["privacy"];
  secret_refs?: SourceConnection["secret_refs"];
} = {}): SourceConnection {
  return CLIPBOARD_CONNECTOR_KIT.createConnection({
    id: input.id ?? "clipboard:local",
    display_name: input.display_name ?? "Local clipboard",
    delivery_kinds: ["push"],
    secret_refs: input.secret_refs ?? {},
    configuration: { device_id: input.device_id ?? "mac:local" },
    ...(input.privacy ? { privacy: input.privacy } : {}),
  });
}

export class ClipboardCaptureController {
  constructor(
    private readonly runtime: Pick<ConnectorRuntime, "submitBatch">,
    readonly connection: SourceConnection,
  ) {}

  async submit(input: unknown): Promise<CommitCaptureBatchResult> {
    const payload = CLIPBOARD_CONNECTOR_KIT.parsePayload(input);
    const eventDigest = digest(`${this.connection.id}:${payload.event_id}`);
    return this.runtime.submitBatch(CLIPBOARD_CONNECTOR_KIT.createBatch({
      connection: this.connection,
      payload,
      id: `clipboard-batch:${eventDigest}`,
      idempotency_key: `clipboard-delivery:${eventDigest}`,
      delivery: "push",
      sequence: Math.max(1, Date.parse(payload.occurred_at)),
      created_at: payload.captured_at,
      captured_at: payload.captured_at,
      metadata: {
        event_id: payload.event_id,
        change_count: payload.change_count,
        formats: payload.formats ?? [],
      },
    }));
  }
}

export async function configureClipboardCapture(input: {
  runtime: ConnectorRuntime;
  connection?: SourceConnection;
}): Promise<ClipboardCaptureController> {
  const connection = input.connection ?? clipboardSourceConnection();
  input.runtime.registerConnector(createPushConnectorPort(CLIPBOARD_CONNECTOR_KIT));
  await input.runtime.registerConnection(connection);
  return new ClipboardCaptureController(input.runtime, connection);
}

function candidateKey(connectionId: string, eventId: string, role: string): string {
  return `clipboard-candidate:${digest(`${connectionId}:${eventId}:${role}`)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

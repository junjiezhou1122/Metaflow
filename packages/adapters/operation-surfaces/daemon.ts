import { z } from "zod";
import {
  OperationEnvelopeSchema,
  OperationRequestSchema,
  type OperationEnvelope,
} from "@info/operations";

export const METAFLOW_HTTP_PROTOCOL_NAME = "metaflow-operations-http" as const;
export const METAFLOW_HTTP_PROTOCOL_VERSION = 1 as const;
export const METAFLOW_AMBIENT_SERVER_NAME = "ambient-daemon" as const;
export const METAFLOW_AMBIENT_SERVER_VERSION = "0.1.0" as const;

export const MetaflowDaemonDoctorSchema = z.object({
  ok: z.literal(true),
  protocol: z.object({
    name: z.literal(METAFLOW_HTTP_PROTOCOL_NAME),
    version: z.literal(METAFLOW_HTTP_PROTOCOL_VERSION),
  }).strict(),
  server: z.object({
    name: z.literal(METAFLOW_AMBIENT_SERVER_NAME),
    version: z.literal(METAFLOW_AMBIENT_SERVER_VERSION),
  }).strict(),
  authentication: z.object({
    source: z.literal("composition_principal"),
    required: z.boolean(),
  }).strict(),
  endpoints: z.object({
    operations: z.literal("/metaflow/v1/operations/"),
    mcp: z.literal("/mcp"),
  }).strict(),
}).strict();

export type MetaflowDaemonDoctor = z.infer<typeof MetaflowDaemonDoctorSchema>;

export class DaemonOperationClient {
  constructor(
    private readonly endpoint: URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async execute(requestInput: unknown, _context: unknown): Promise<OperationEnvelope> {
    const request = OperationRequestSchema.parse(requestInput);
    const url = new URL(`/metaflow/v1/operations/${encodeURIComponent(request.operation)}`, this.endpoint);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.input),
    });
    return OperationEnvelopeSchema.parse(await response.json());
  }
}

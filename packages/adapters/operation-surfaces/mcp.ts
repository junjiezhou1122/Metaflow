import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  OPERATION_DESCRIPTIONS,
  OPERATION_EFFECTS,
  OPERATION_INPUT_JSON_SCHEMAS,
  OPERATION_NAMES,
  OperationEnvelopeSchema,
  type OperationContextProvider,
  type OperationName,
  type OperationService,
} from "@info/operations";
import { JsonValueSchema, type JsonObject } from "@info/view";

export type OperationMcpServerOptions = {
  service: Pick<OperationService, "execute">;
  context: OperationContextProvider;
  name?: string;
  version?: string;
};

export function operationMcpToolName(operation: OperationName): string {
  return `metaflow_${operation.replaceAll(".", "_")}`;
}

const OPERATIONS_BY_TOOL = new Map(OPERATION_NAMES.map(operation => [operationMcpToolName(operation), operation]));

// MCP requires an object at the root; oneOf carries the canonical discriminated envelope.
export const OperationMcpOutputJsonSchema: JsonObject = JsonValueSchema.parse({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: {
        ok: { const: true },
        request_id: { type: "string", minLength: 1 },
        operation: { type: "string", enum: OPERATION_NAMES },
        data: {},
      },
      required: ["ok", "request_id", "operation", "data"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ok: { const: false },
        request_id: { type: "string", minLength: 1 },
        operation: { type: "string", enum: OPERATION_NAMES },
        error: {
          type: "object",
          properties: {
            code: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1, maxLength: 2_000 },
            category: {
              type: "string",
              enum: ["invalid_request", "forbidden", "not_found", "conflict", "failed_dependency", "internal"],
            },
            details: { type: "object", additionalProperties: true },
          },
          required: ["code", "message", "category", "details"],
          additionalProperties: false,
        },
      },
      required: ["ok", "request_id", "error"],
      additionalProperties: false,
    },
  ],
}) as JsonObject;

export function createOperationMcpServer(options: OperationMcpServerOptions): Server {
  const server = new Server({
    name: options.name ?? "metaflow-v1-operations",
    version: options.version ?? "0.1.0",
  }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: OPERATION_NAMES.map(operation => ({
      name: operationMcpToolName(operation),
      title: operation,
      description: OPERATION_DESCRIPTIONS[operation],
      inputSchema: OPERATION_INPUT_JSON_SCHEMAS[operation] as any,
      outputSchema: OperationMcpOutputJsonSchema as any,
      annotations: {
        readOnlyHint: OPERATION_EFFECTS[operation] === "read",
        destructiveHint: OPERATION_EFFECTS[operation] === "destructive",
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const operation = OPERATIONS_BY_TOOL.get(request.params.name);
    if (!operation) throw new McpError(ErrorCode.InvalidParams, `Unknown Metaflow Operation tool: ${request.params.name}`);
    const input = request.params.arguments ?? {};
    const context = await options.context({ transport: "mcp", operation });
    const envelope = OperationEnvelopeSchema.parse(await options.service.execute({ operation, input }, context));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
      structuredContent: envelope,
      isError: !envelope.ok,
    };
  });

  return server;
}

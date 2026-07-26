import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OPERATION_DESCRIPTIONS,
  OPERATION_EFFECTS,
  OPERATION_NAMES,
  OperationErrorSchema,
  OperationEnvelopeSchema,
  OperationInputSchemas,
  OperationNameSchema,
  type OperationContextProvider,
  type OperationName,
  type OperationService,
} from "@info/operations";
import { IdentifierSchema, JsonValueSchema } from "@info/view";

export const OperationMcpOutputSchema = z.object({
  ok: z.boolean(),
  request_id: IdentifierSchema,
  operation: OperationNameSchema.optional(),
  data: JsonValueSchema.optional(),
  error: OperationErrorSchema.optional(),
}).strict();

export type OperationMcpServerOptions = {
  service: Pick<OperationService, "execute">;
  context: OperationContextProvider;
  name?: string;
  version?: string;
};

export function operationMcpToolName(operation: OperationName): string {
  return `metaflow_${operation.replaceAll(".", "_")}`;
}

export function createOperationMcpServer(options: OperationMcpServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? "metaflow-v1-operations",
    version: options.version ?? "0.1.0",
  });
  for (const operation of OPERATION_NAMES) {
    registerOperationTool(server, operation, options);
  }
  return server;
}

function registerOperationTool(
  server: McpServer,
  operation: OperationName,
  options: OperationMcpServerOptions,
): void {
  server.registerTool(operationMcpToolName(operation), {
    title: operation,
    description: OPERATION_DESCRIPTIONS[operation],
    inputSchema: OperationInputSchemas[operation] as any,
    outputSchema: OperationMcpOutputSchema,
    annotations: {
      readOnlyHint: OPERATION_EFFECTS[operation] === "read",
      destructiveHint: OPERATION_EFFECTS[operation] === "destructive",
    },
  }, async (input: unknown) => {
    const context = await options.context({ transport: "mcp", operation });
    const envelope = OperationEnvelopeSchema.parse(await options.service.execute({ operation, input }, context));
    OperationMcpOutputSchema.parse(envelope);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
      structuredContent: envelope,
      isError: !envelope.ok,
    };
  });
}

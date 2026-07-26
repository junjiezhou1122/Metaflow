import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOperationMcpServer } from "@info/operation-surfaces";
import type { OperationService } from "@info/operations";

export function createAmbientMcpHttpHandler(service: OperationService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const server = createOperationMcpServer({
      service,
      context: () => ({
        request_id: `request:mcp:${randomUUID()}`,
        principal: { id: "user:local", grants: ["*"] },
      }),
      name: "metaflow-ambient-operations",
      version: "0.1.0",
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(JSON.stringify({
        component: "ambient-mcp-http",
        event: "mcp.request_failed",
        method: request.method,
        path: request.url,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Metaflow MCP request failed" },
          id: null,
        }));
      }
    } finally {
      await closeMcpResource("transport", () => transport.close());
      await closeMcpResource("server", () => server.close());
    }
  };
}

async function closeMcpResource(resource: string, close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (error) {
    console.error(JSON.stringify({
      component: "ambient-mcp-http",
      event: "mcp.close_failed",
      resource,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

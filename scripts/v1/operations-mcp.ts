import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonOperationClient, createOperationMcpServer } from "@info/operation-surfaces";

const endpoint = new URL(process.env.METAFLOW_DAEMON_URL ?? `http://127.0.0.1:${process.env.CONTEXT_HTTP_PORT ?? "3111"}`);
const operations = new DaemonOperationClient(endpoint);
const server = createOperationMcpServer({
  service: operations,
  context: () => ({
    request_id: `request:mcp:${randomUUID()}`,
    principal: { id: "user:local", grants: ["*"] },
  }),
});

const close = async () => {
  await server.close();
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  await close();
  throw error;
}

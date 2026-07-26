import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOperationMcpServer } from "@info/operation-surfaces";
import { AcpStdioAgentRuntimeAdapter } from "@info/agent-runtime-adapter";
import { createAmbientDaemonComposition } from "../../apps/ambient-daemon/composition.js";

const command = process.env.AGENT_TASK_ACP_COMMAND;
if (!command) throw new Error("AGENT_TASK_ACP_COMMAND is required; the v1 MCP server does not use a mock Operator fallback");

const composition = await createAmbientDaemonComposition({
  data_directory: process.env.METAFLOW_DATA_DIR ?? "data/ambient-v1",
  agent_runtime: new AcpStdioAgentRuntimeAdapter({
    id: process.env.AGENT_TASK_ACP_RUNTIME_ID ?? "acp_stdio",
    command,
    args: process.env.AGENT_TASK_ACP_ARGS?.split(" ").filter(Boolean) ?? [],
  }),
});
const server = createOperationMcpServer({
  service: composition.operationService,
  context: () => ({
    request_id: `request:mcp:${randomUUID()}`,
    principal: { id: "user:local", grants: ["*"] },
  }),
});

const close = async () => {
  await server.close();
  composition.close();
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  await close();
  throw error;
}

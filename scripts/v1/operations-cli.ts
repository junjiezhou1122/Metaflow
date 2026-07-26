import { randomUUID } from "node:crypto";
import { CliOperationAdapter } from "@info/operation-surfaces";
import { AcpStdioAgentRuntimeAdapter } from "@info/agent-runtime-adapter";
import { createAmbientDaemonComposition } from "../../apps/ambient-daemon/composition.js";

const command = process.env.AGENT_TASK_ACP_COMMAND;
if (!command) throw new Error("AGENT_TASK_ACP_COMMAND is required; the v1 CLI does not use a mock Operator fallback");

const composition = await createAmbientDaemonComposition({
  data_directory: process.env.METAFLOW_DATA_DIR ?? "data/ambient-v1",
  agent_runtime: new AcpStdioAgentRuntimeAdapter({
    id: process.env.AGENT_TASK_ACP_RUNTIME_ID ?? "acp_stdio",
    command,
    args: process.env.AGENT_TASK_ACP_ARGS?.split(" ").filter(Boolean) ?? [],
  }),
});

try {
  const cli = new CliOperationAdapter(composition.operationService, () => ({
    request_id: `request:cli:${randomUUID()}`,
    principal: { id: "user:local", grants: ["*"] },
  }));
  const result = await cli.invoke(process.argv.slice(2));
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exit_code;
} finally {
  composition.close();
}

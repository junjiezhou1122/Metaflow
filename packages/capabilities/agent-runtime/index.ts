export * from "./types.js";
export * from "./mock-runtime.js";
export * from "./cli-json-runtime.js";
export * from "./acp/content.js";
export * from "./acp/stdio-runtime.js";
export * from "./providers/mcp-provider.js";
export * from "./providers/info-context-provider.js";
export * from "./outputs/view-output.js";

import { AcpStdioAgentRuntimeAdapter } from "./acp/stdio-runtime.js";
import { createClaudeCodeRuntime } from "./cli-json-runtime.js";
import { MockAgentRuntimeAdapter } from "./mock-runtime.js";
import type { AgentRuntimeAdapter, AgentRuntimeSelection } from "./types.js";

export function createDefaultAgentRuntimeAdapter(runtime: string): AgentRuntimeSelection {
  if (runtime === "local_mock") return { runtime, adapter: new MockAgentRuntimeAdapter() };
  if (runtime === "claude_code") return { runtime, adapter: createClaudeCodeRuntime() };
  if (runtime === "acp_stdio") {
    const command = process.env.AGENT_TASK_ACP_COMMAND;
    if (!command) return { runtime, reason: "AGENT_TASK_ACP_COMMAND is required for acp_stdio runtime" };
    return {
      runtime,
      adapter: new AcpStdioAgentRuntimeAdapter({
        id: "acp_stdio",
        command,
        args: parseArgs(process.env.AGENT_TASK_ACP_ARGS),
      }),
    };
  }
  return { runtime, reason: `agent runtime adapter not available: ${runtime}` };
}

export function createAgentRuntimeRegistry(adapters: AgentRuntimeAdapter[]): Map<string, AgentRuntimeAdapter> {
  return new Map(adapters.map(adapter => [adapter.id, adapter]));
}

function parseArgs(value: string | undefined): string[] {
  return value ? value.split(" ").filter(Boolean) : [];
}

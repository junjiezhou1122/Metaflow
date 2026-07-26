import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "../packages/adapters/agent-runtime/types.ts";

test("Ambient daemon exposes the shared Metaflow Operations catalog over Streamable HTTP MCP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-ambient-mcp-"));
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    agent_runtime: new UnusedAgentRuntime(),
  });
  const server = createServer((request, response) => {
    void composition.mcpHandler(request, response);
  });
  const client = new Client({ name: "metaflow-ambient-mcp-test", version: "0.1.0" });

  try {
    const port = await listen(server);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);

    assert.ok(names.includes("metaflow_catalog_list"));
    assert.ok(names.includes("metaflow_run_execute"));
    assert.ok(names.includes("metaflow_view_get"));
    assert.ok(names.every(name => name.startsWith("metaflow_")));

    const catalog = await client.callTool({ name: "metaflow_catalog_list", arguments: {} });
    assert.equal(catalog.isError, false);
    assert.equal((catalog.structuredContent as { ok?: boolean })?.ok, true);
    assert.match(JSON.stringify(catalog.structuredContent), /run\.execute/);
  } finally {
    await client.close().catch(() => undefined);
    await closeServer(server);
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class UnusedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "acp_stdio";
  readonly kind = "acp_stdio" as const;

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      modes: ["invoke" as const],
      supportsDryRun: false,
      supportsCancel: false,
      supportsPermissionRequests: false,
      supportsProgress: false,
      supportsMcpServers: true,
    };
  }

  async submit(_task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    throw new Error("Agent runtime must not be invoked by MCP catalog.list");
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP test server did not bind a TCP port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

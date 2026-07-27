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

test("Ambient daemon exposes the shared Operations catalog and authoring worker over Streamable HTTP MCP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-ambient-mcp-"));
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    agent_runtime: new AuthoringAgentRuntime(),
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
    assert.ok(names.includes("metaflow_view_authoring_apply"));
    assert.ok(names.every(name => name.startsWith("metaflow_")));

    const catalog = await client.callTool({ name: "metaflow_catalog_list", arguments: {} });
    assert.equal(catalog.isError, false);
    assert.equal((catalog.structuredContent as { ok?: boolean })?.ok, true);
    assert.match(JSON.stringify(catalog.structuredContent), /run\.execute/);

    const requested = operationData(await client.callTool({
      name: "metaflow_view_authoring_request",
      arguments: {
        view_id: "view:ambient:mcp:authoring:request",
        expected_revision: 0,
        artifact_kind: "view_package",
        prompt: "Use the registered Application Space View Package",
        source_views: [],
        policy: {
          owner: "user:local",
          visibility: "private",
          privacy: "private",
          retention: "normal",
          allow_external_model: true,
          allow_embedding: false,
          allow_local_search: true,
          labels: ["authoring"],
        },
        trace_id: "trace:ambient:mcp:authoring",
        idempotency_key: "ambient:mcp:authoring:request",
        created_at: "2026-07-27T10:00:00.000Z",
      },
    }));
    const proposed = operationData(await client.callTool({
      name: "metaflow_view_authoring_propose",
      arguments: {
        request: exactRef(requested),
        proposal_view_id: "view:ambient:mcp:authoring:proposal",
        expected_revision: 0,
        idempotency_key: "ambient:mcp:authoring:proposal",
        failure_receipt_view_id: "view:ambient:mcp:authoring:proposal-failure",
        created_at: "2026-07-27T10:00:01.000Z",
      },
    }));
    const proposalDigest = (proposed.representation as any).value.artifact_digest as string;
    const approved = operationData(await client.callTool({
      name: "metaflow_view_authoring_approve",
      arguments: {
        proposal: exactRef(proposed),
        proposal_digest: proposalDigest,
        decision_view_id: "view:ambient:mcp:authoring:decision",
        expected_revision: 0,
        idempotency_key: "ambient:mcp:authoring:decision",
        created_at: "2026-07-27T10:00:02.000Z",
      },
    }));
    const receipt = operationData(await client.callTool({
      name: "metaflow_view_authoring_apply",
      arguments: {
        decision: exactRef(approved),
        receipt_view_id: "view:ambient:mcp:authoring:receipt",
        expected_revision: 0,
        idempotency_key: "ambient:mcp:authoring:apply",
        created_at: "2026-07-27T10:00:03.000Z",
      },
    }));
    assert.deepEqual((receipt.representation as any).value.target, {
      kind: "view_package",
      id: "view-package.application-space",
      version: 1,
      manifest_digest: (proposed.representation as any).value.artifact.package.manifest_digest,
    });
  } finally {
    await client.close().catch(() => undefined);
    await closeServer(server);
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class AuthoringAgentRuntime implements AgentRuntimeAdapter {
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

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    if (task.outputContract.mode !== "schema_value") {
      throw new Error("Ambient MCP authoring test only permits schema_value Agent work");
    }
    return {
      ok: true,
      reason: "deterministic registered View Package proposal",
      schemaValue: {
        kind: "view_package",
        package: { id: "view-package.application-space", version: 1 },
      },
    };
  }
}

function operationData(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const envelope = result.structuredContent as { ok?: boolean; error?: unknown; data?: Record<string, any> } | undefined;
  assert.equal(envelope?.ok, true, JSON.stringify(envelope?.error));
  assert.ok(envelope?.data);
  return envelope.data;
}

function exactRef(view: Record<string, any>) {
  return { view_id: view.id as string, revision: view.revision as number };
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

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcpStdioAgentRuntimeAdapter,
  MockAgentRuntimeAdapter,
  buildAgentTaskPromptBlocks,
  normalizeAgentTaskOutput,
  parseAgentTaskOutput,
  httpMcpServer,
  type AgentRuntimeEvent,
} from "@info/capabilities";

test("MockAgentRuntimeAdapter returns structured agent task output", async () => {
  const adapter = new MockAgentRuntimeAdapter();
  const result = await adapter.submit({
    id: "task:mock",
    runtime: "local_mock",
    goal: "Analyze mock context.",
    outputContract: { viewType: "analysis.mock_agent_task" },
  }, {
    signal: {
      object_type: "observation.github.issue",
      text_preview: "Mock issue context should become a summary.",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output?.summary.includes("Mock issue context"), true);
  assert.deepEqual(result.output?.key_points?.slice(0, 2), [
    "Agent runtime: local_mock",
    "Output View type: analysis.mock_agent_task",
  ]);
});

test("AgentTask output parser rejects action-oriented fields", () => {
  assert.throws(
    () => normalizeAgentTaskOutput({ summary: "Looks good", next_actions: ["edit files"] }),
    /unsupported agent output field: next_actions/,
  );
  assert.deepEqual(parseAgentTaskOutput(JSON.stringify({ result: "```json\n{\"summary\":\"Ok\",\"confidence\":0.7}\n```" })), {
    summary: "Ok",
    analysis: undefined,
    key_points: undefined,
    confidence: 0.7,
    views: undefined,
    raw: { summary: "Ok", confidence: 0.7 },
  });
});

test("AgentTask output parser accepts optional evidence Views without treating them as tools", () => {
  const output = normalizeAgentTaskOutput({
    summary: "Agent used its own reader skill and returned evidence.",
    views: [{
      view_type: "extraction.reader_snapshot",
      title: "Reader snapshot",
      summary: "Readable article text.",
      content: { url: "https://example.com/article", text: "Readable article text." },
      confidence: 0.8,
    }],
  });

  assert.equal(output.views?.[0].view_type, "extraction.reader_snapshot");
  assert.equal(output.views?.[0].content?.url, "https://example.com/article");
  assert.throws(
    () => normalizeAgentTaskOutput({ summary: "Bad", views: [{ view_type: "derived.reader_snapshot" }] }),
    /record-like prefix/,
  );
});

test("buildAgentTaskPromptBlocks maps Info task boundary to ACP text content", () => {
  const blocks = buildAgentTaskPromptBlocks({
    task: {
      id: "task:prompt",
      runtime: "acp_stdio",
      goal: "Analyze context through ACP.",
      contextPack: { markdown: "# Context\nImportant context." },
      outputContract: { viewType: "analysis.acp_agent_task" },
      constraints: { views_only: true },
    },
    signal: { object_type: "observation.browser_page_snapshot" },
    contextSources: [{ id: "record:1", kind: "record", uri: "context://records/record:1" }],
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /Return only JSON/);
  assert.match(blocks[0].text, /analysis\.acp_agent_task/);
  assert.match(blocks[0].text, /context:\/\/records\/record:1/);
});

test("AcpStdioAgentRuntimeAdapter initializes, creates a session, injects MCP servers, and reads structured output", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-info-acp-runtime-test-"));
  const script = join(dir, "fake-acp-agent.mjs");
  writeFileSync(script, fakeAcpAgentSource());
  chmodSync(script, 0o755);
  const events: AgentRuntimeEvent[] = [];
  const adapter = new AcpStdioAgentRuntimeAdapter({
    id: "acp_stdio_test",
    command: process.execPath,
    args: [script],
    cwd: dir,
  });

  try {
    const result = await adapter.submit({
      id: "task:acp",
      runtime: "acp_stdio_test",
      goal: "Analyze through fake ACP agent.",
      cwd: dir,
      contextPack: { markdown: "# Context\nFake ACP context." },
      outputContract: { viewType: "analysis.acp_agent_task" },
    }, {
      signal: { object_type: "observation.local_project", project_path: dir },
      mcpServers: [httpMcpServer("browser", "http://127.0.0.1:9999/mcp")],
      events: { emit: event => events.push(event) },
    });

    assert.equal(result.ok, true);
    assert.equal(result.output?.summary, "Fake ACP agent completed task");
    assert.deepEqual(result.output?.key_points, ["mcp_servers:1"]);
    assert.equal(result.diagnostics?.session_id, "sess_fake");
    assert.equal(result.diagnostics?.mcp_server_count, 1);
    assert.ok(events.some(event => event.type === "runtime.initialized"));
    assert.ok(events.some(event => event.type === "runtime.session_created" && event.sessionId === "sess_fake"));
    assert.ok(events.some(event => event.type === "runtime.prompt_update"));
    assert.ok(events.some(event => event.type === "runtime.prompt_complete"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAcpAgentSource(): string {
  return `
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let connection;
let lastMcpServerCount = 0;
const agent = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {} }
      },
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
      authMethods: []
    };
  },
  async newSession(params) {
    lastMcpServerCount = params.mcpServers.length;
    return { sessionId: "sess_fake" };
  },
  async prompt(params) {
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: JSON.stringify({
            summary: "Fake ACP agent completed task",
            analysis: "Prompt blocks: " + params.prompt.length,
            key_points: ["mcp_servers:" + lastMcpServerCount],
            confidence: 0.82
          })
        }
      }
    });
    return { stopReason: "end_turn" };
  },
  async cancel() {},
  async closeSession() { return {}; },
  async authenticate() {}
};

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
connection = new AgentSideConnection(() => agent, ndJsonStream(input, output));
await connection.closed;
`;
}

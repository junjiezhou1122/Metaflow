import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcpStdioAgentRuntimeAdapter,
  CliJsonAgentRuntimeAdapter,
  MockAgentRuntimeAdapter,
  buildAgentHandoff,
  buildAgentTaskPromptBlocks,
  normalizeAgentTaskOutput,
  normalizeAgentSchemaValue,
  parseAgentTaskOutput,
  parseAgentSchemaValue,
  httpMcpServer,
  type AgentRuntimeEvent,
} from "@info/agent-runtime-adapter";

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

test("MockAgentRuntimeAdapter fails explicitly when schema_value is not implemented", async () => {
  const result = await new MockAgentRuntimeAdapter().submit({
    id: "task:mock-schema-value",
    goal: "Create a plan.",
    outputContract: {
      mode: "schema_value",
      viewType: "learning.daily_plan",
      schema: { name: "learning.daily_plan", version: 1, mode: "freeform" },
    },
  }, { signal: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not implement schema_value/);
  assert.equal(result.output, undefined);
  assert.equal(result.schemaValue, undefined);
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

test("schema_value output parser preserves arbitrary JSON and rejects non-JSON values", () => {
  const value = {
    headline: "Daily English plan",
    tags: ["reading", "listening"],
    sessions: 2,
  };
  assert.deepEqual(normalizeAgentSchemaValue(value), value);
  assert.deepEqual(
    parseAgentSchemaValue(JSON.stringify({ result: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` })),
    value,
  );
  assert.equal(parseAgentSchemaValue(JSON.stringify("plain string value")), "plain string value");
  assert.throws(() => parseAgentSchemaValue("not-json"), /JSON/);
  assert.throws(() => normalizeAgentSchemaValue({ headline: undefined }), /JSON-compatible/);
  assert.throws(() => normalizeAgentSchemaValue(new Date()), /JSON-compatible/);
  assert.throws(() => normalizeAgentSchemaValue(Array(1)), /JSON-compatible/);
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

test("buildAgentTaskPromptBlocks maps simple handoff to ACP text content", () => {
  const blocks = buildAgentTaskPromptBlocks({
    task: {
      id: "task:prompt",
      runtime: "acp_stdio",
      prompt: "What does this have to do with our project?",
      goal: "compat fallback",
      currentContext: {
        voice: { transcript: "这跟我们项目有什么关系？" },
        screen: { app: "Safari", title: "Interesting repo", url: "https://github.com/example/repo" },
        app: { name: "Safari", window_title: "Interesting repo", project_path: "/tmp/info" },
      },
      viewTools: [{ name: "mf search", kind: "cli", command: "pnpm", args: ["mf", "views", "search"] }],
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
  assert.match(blocks[0].text, /Use your installed skills/);
  assert.match(blocks[0].text, /CURRENT CONTEXT/);
  assert.match(blocks[0].text, /这跟我们项目有什么关系/);
  assert.match(blocks[0].text, /AVAILABLE VIEW TOOLS/);
  assert.match(blocks[0].text, /mf search/);
  assert.match(blocks[0].text, /analysis\.acp_agent_task/);
  assert.match(blocks[0].text, /context:\/\/records\/record:1/);
  assert.doesNotMatch(blocks[0].text, /Use the provided task and Context Pack/);
});

test("schema_value prompt requests the frozen Schema instead of the legacy AgentTaskOutput shape", () => {
  const blocks = buildAgentTaskPromptBlocks({
    task: {
      id: "task:schema-value-prompt",
      goal: "Create today's learning plan.",
      outputContract: {
        mode: "schema_value",
        viewType: "learning.daily_plan",
        schema: {
          name: "learning.daily_plan",
          version: 1,
          mode: "strict",
          json_schema: {
            type: "object",
            required: ["headline", "tags"],
            properties: {
              headline: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    signal: {},
  });
  assert.equal(blocks[0]?.type, "text");
  if (blocks[0]?.type !== "text") throw new Error("expected text prompt block");
  assert.match(blocks[0].text, /complete JSON value must satisfy the frozen output Schema/);
  assert.match(blocks[0].text, /learning\.daily_plan/);
  assert.doesNotMatch(blocks[0].text, /key_points/);
  assert.doesNotMatch(blocks[0].text, /optional views array/);
});

test("CLI schema_value mode unwraps the command envelope without legacy output coercion", async () => {
  const adapter = new CliJsonAgentRuntimeAdapter({
    id: "schema-value-cli",
    command: process.execPath,
    buildArgs() {
      return ["-e", "process.stdout.write(JSON.stringify({result:JSON.stringify({headline:'Daily English plan',tags:['reading']})}))"];
    },
  });
  const result = await adapter.submit({
    id: "task:schema-value-cli",
    goal: "Create a plan.",
    outputContract: {
      mode: "schema_value",
      viewType: "learning.daily_plan",
      schema: { name: "learning.daily_plan", version: 1, mode: "freeform" },
    },
  }, { signal: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.schemaValue, { headline: "Daily English plan", tags: ["reading"] });
  assert.equal(result.output, undefined);
});

test("buildAgentHandoff derives current context and default View tools from a signal", () => {
  const handoff = buildAgentHandoff({
    task: {
      id: "task:handoff",
      runtime: "cli_json",
      goal: "Summarize this.",
      cwd: "/Users/junjie/info",
      outputContract: { viewType: "analysis.agent_task" },
    },
    signal: {
      object_id: "record:1",
      object_type: "observation.browser_page_snapshot",
      object_kind: "observation",
      app: "Chrome",
      title: "Agent Runtime notes",
      url: "https://example.com/runtime",
      text_preview: "Current page talks about agent runtime adapters.",
      project_path: "/Users/junjie/info",
    },
  });

  assert.equal(handoff.prompt, "Summarize this.");
  assert.equal(handoff.currentContext.screen?.app, "Chrome");
  assert.equal(handoff.currentContext.screen?.url, "https://example.com/runtime");
  assert.equal(handoff.currentContext.app?.project_path, "/Users/junjie/info");
  assert.ok(handoff.viewTools.some(tool => tool.kind === "cli"));
  assert.ok(handoff.viewTools.some(tool => tool.kind === "mcp"));
});

test("AcpStdioAgentRuntimeAdapter initializes, creates a session, injects MCP servers, and reads structured output", async () => {
  const dir = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-runtime-test-"));
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

test("ACP schema_value mode returns arbitrary JSON without requiring summary", async () => {
  const dir = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-schema-value-test-"));
  const script = join(dir, "fake-acp-agent.mjs");
  writeFileSync(script, fakeAcpAgentSource());
  chmodSync(script, 0o755);
  const adapter = new AcpStdioAgentRuntimeAdapter({
    id: "acp_schema_value_test",
    command: process.execPath,
    args: [script],
    cwd: dir,
  });

  try {
    const result = await adapter.submit({
      id: "task:acp-schema-value",
      goal: "SCHEMA_VALUE_OUTPUT",
      outputContract: {
        mode: "schema_value",
        viewType: "learning.daily_plan",
        schema: { name: "learning.daily_plan", version: 1, mode: "freeform" },
      },
    }, { signal: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schemaValue, {
      headline: "Daily English plan",
      tags: ["reading", "listening"],
    });
    assert.equal(result.output, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP schema_value mode never accepts one valid fragment as the complete message", async () => {
  const dir = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-schema-fragment-test-"));
  const script = join(dir, "fake-acp-agent.mjs");
  writeFileSync(script, fakeAcpAgentSource());
  chmodSync(script, 0o755);
  const adapter = new AcpStdioAgentRuntimeAdapter({
    id: "acp_schema_fragment_test",
    command: process.execPath,
    args: [script],
    cwd: dir,
  });

  try {
    const result = await adapter.submit({
      id: "task:acp-schema-fragment",
      goal: "INVALID_FRAGMENTED_SCHEMA_VALUE",
      outputContract: {
        mode: "schema_value",
        viewType: "learning.daily_plan",
        schema: { name: "learning.daily_plan", version: 1, mode: "freeform" },
      },
    }, { signal: {} });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no valid schema_value/);
    assert.equal(result.schemaValue, undefined);

    const stale = await adapter.submit({
      id: "task:acp-schema-stale-message",
      goal: "FINAL_SCHEMA_MESSAGE_INVALID",
      outputContract: {
        mode: "schema_value",
        viewType: "learning.daily_plan",
        schema: { name: "learning.daily_plan", version: 1, mode: "freeform" },
      },
    }, { signal: {} });
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /no valid schema_value/);
    assert.equal(stale.schemaValue, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent ACP reuses one process, closes every session, and survives invalid Agent output", async () => {
  const dir = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-persistent-test-"));
  const script = join(dir, "fake-persistent-acp-agent.mjs");
  writeFileSync(script, fakePersistentAcpAgentSource());
  chmodSync(script, 0o755);
  const adapter = new AcpStdioAgentRuntimeAdapter({
    id: "acp_persistent_test",
    command: process.execPath,
    args: [script],
    cwd: dir,
    lifecycle: "persistent",
  });

  try {
    const warmed = await adapter.warmup();
    const first = await adapter.submit(agentTask("task:persistent:first", "FIRST"), runtimeContext());
    const invalid = await adapter.submit(agentTask("task:persistent:invalid", "INVALID_OUTPUT"), runtimeContext());
    const third = await adapter.submit(agentTask("task:persistent:third", "THIRD"), runtimeContext());

    assert.equal(first.ok, true);
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason, /no valid AgentTaskOutput/);
    assert.equal(third.ok, true);
    assert.equal(warmed.process_reused, false);
    assert.equal(first.diagnostics?.process_reused, true);
    assert.equal(first.diagnostics?.process_id, warmed.process_id);
    assert.equal(third.diagnostics?.process_reused, true);
    assert.equal(third.diagnostics?.process_id, first.diagnostics?.process_id);
    assert.notEqual(third.diagnostics?.session_id, first.diagnostics?.session_id);
    assert.deepEqual(third.output?.key_points, ["mcp_servers:1", "closed_sessions:2"]);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent ACP cancellation targets the active session without killing the resident process", async () => {
  const dir = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-cancel-test-"));
  const script = join(dir, "fake-persistent-acp-agent.mjs");
  writeFileSync(script, fakePersistentAcpAgentSource());
  chmodSync(script, 0o755);
  const events: AgentRuntimeEvent[] = [];
  const adapter = new AcpStdioAgentRuntimeAdapter({
    id: "acp_persistent_cancel_test",
    command: process.execPath,
    args: [script],
    cwd: dir,
    lifecycle: "persistent",
  });

  try {
    const pending = adapter.submit(agentTask("task:persistent:cancel", "WAIT_FOR_CANCEL"), {
      ...runtimeContext(),
      events: { emit: event => events.push(event) },
    });
    await waitFor(() => events.some(event => event.type === "runtime.session_created"));
    await adapter.cancel("task:persistent:cancel");
    const cancelled = await pending;
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.output?.summary, "cancelled:sess_1");

    const next = await adapter.submit(agentTask("task:persistent:after-cancel", "AFTER_CANCEL"), runtimeContext());
    assert.equal(next.ok, true);
    assert.equal(next.diagnostics?.process_id, cancelled.diagnostics?.process_id);
    assert.equal(next.diagnostics?.process_reused, true);
  } finally {
    await adapter.close();
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
    const prompt = JSON.stringify(params.prompt);
    if (prompt.includes("INVALID_FRAGMENTED_SCHEMA_VALUE")) {
      for (const text of ['{"headline":', '1']) {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
      }
      return { stopReason: "end_turn" };
    }
    if (prompt.includes("FINAL_SCHEMA_MESSAGE_INVALID")) {
      for (const [messageId, text] of [
        ["07bb2e35-7d88-4753-b11d-35497fd54dd7", '{"stale":true}'],
        ["38137f00-6871-44c4-84cd-336af66982ce", '{"final":'],
      ]) {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text }
          }
        });
      }
      return { stopReason: "end_turn" };
    }
    const value = prompt.includes("SCHEMA_VALUE_OUTPUT")
      ? { headline: "Daily English plan", tags: ["reading", "listening"] }
      : {
          summary: "Fake ACP agent completed task",
          analysis: "Prompt blocks: " + params.prompt.length,
          key_points: ["mcp_servers:" + lastMcpServerCount],
          confidence: 0.82
        };
    const output = "\`\`\`json\\n" + JSON.stringify(value) + "\\n\`\`\`";
    const messageId = "5df32762-6f85-4ec5-8f4f-fcad7842b734";
    for (const [index, text] of [output.slice(0, 17), output.slice(17, 61), output.slice(61)].entries()) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text }
        }
      });
      if (index < 2) {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "usage_update", used: index + 1, size: 100 }
        });
      }
    }
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

function fakePersistentAcpAgentSource(): string {
  return `
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let connection;
let sessionCount = 0;
let closedSessions = 0;
const mcpCounts = new Map();
const waiting = new Map();
const cancelled = new Set();

async function emitOutput(sessionId, output) {
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify(output) }
    }
  });
}

const agent = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {} }
      },
      agentInfo: { name: "fake-persistent-acp-agent", version: "0.0.1" },
      authMethods: []
    };
  },
  async newSession(params) {
    const sessionId = "sess_" + (++sessionCount);
    mcpCounts.set(sessionId, params.mcpServers.length);
    return { sessionId };
  },
  async prompt(params) {
    const text = JSON.stringify(params.prompt);
    if (text.includes("WAIT_FOR_CANCEL")) {
      if (!cancelled.has(params.sessionId)) {
        await new Promise(resolve => waiting.set(params.sessionId, resolve));
      }
      await emitOutput(params.sessionId, {
        summary: "cancelled:" + params.sessionId,
        key_points: ["cancel_targeted"],
        confidence: 1
      });
      return { stopReason: "cancelled" };
    }
    if (text.includes("INVALID_OUTPUT")) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "not valid AgentTaskOutput" }
        }
      });
      return { stopReason: "end_turn" };
    }
    await emitOutput(params.sessionId, {
      summary: "completed:" + params.sessionId,
      key_points: [
        "mcp_servers:" + mcpCounts.get(params.sessionId),
        "closed_sessions:" + closedSessions
      ],
      confidence: 1
    });
    return { stopReason: "end_turn" };
  },
  async cancel(params) {
    cancelled.add(params.sessionId);
    waiting.get(params.sessionId)?.();
    waiting.delete(params.sessionId);
  },
  async closeSession() {
    closedSessions += 1;
    return {};
  },
  async authenticate() {}
};

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
connection = new AgentSideConnection(() => agent, ndJsonStream(input, output));
await connection.closed;
`;
}

function agentTask(id: string, goal: string) {
  return {
    id,
    runtime: "acp_persistent_test",
    goal,
    outputContract: { viewType: "analysis.acp_agent_task" },
  };
}

function runtimeContext() {
  return {
    signal: { object_type: "observation.local_project" },
    mcpServers: [httpMcpServer("metaflow", "http://127.0.0.1:3111/mcp")],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

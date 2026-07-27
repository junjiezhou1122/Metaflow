import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AcpStdioAgentRuntimeAdapter,
  AgentExecutionAdapter,
  CliJsonAgentRuntimeAdapter,
  MockAgentRuntimeAdapter,
  type AgentRuntimeAdapter,
  type AgentRuntimeContext,
  type AgentTaskRequest,
  type AgentTaskResult,
} from "../packages/adapters/agent-runtime/index.ts";
import type {
  AgentOperatorEvent,
  AgentOperatorInvocation,
} from "@info/execution";

test("one frozen Agent Operator invocation crosses mock, CLI, and ACP adapters", async () => {
  const fixturePrefix = fileURLToPath(new URL("../packages/adapters/agent-runtime/.tmp-agent-execution-", import.meta.url));
  const directory = mkdtempSync(fixturePrefix);
  const acpScript = join(directory, "fake-acp-agent.mjs");
  writeFileSync(acpScript, fakeAcpAgentSource());
  chmodSync(acpScript, 0o755);

  const runtimes: AgentRuntimeAdapter[] = [
    new MockAgentRuntimeAdapter(),
    new CliJsonAgentRuntimeAdapter({
      id: "codex",
      command: process.execPath,
      buildArgs(_task, prompt) {
        return [
          "-e",
          "const p=process.argv[1];process.stdout.write(JSON.stringify({summary:p.includes('view:selection:1')&&p.includes('总结当前选择')?'CLI handoff ok':'CLI handoff missing context'}))",
          prompt,
        ];
      },
    }),
    new AcpStdioAgentRuntimeAdapter({
      id: "acp_test",
      command: process.execPath,
      args: [acpScript],
      cwd: directory,
    }),
  ];
  const bridge = new AgentExecutionAdapter({ runtimes, default_runtime: "local_mock" });

  try {
    for (const runtime of ["local_mock", "codex", "acp_test"]) {
      const events: AgentOperatorEvent[] = [];
      const result = await bridge.execute(invocation({ runtime_override: runtime }), {
        events: { emit: event => events.push(event) },
      });
      assert.equal(result.status, "succeeded", `${runtime}: ${JSON.stringify(result)}`);
      if (result.status === "succeeded") {
        const candidate = result.candidate as { summary: string };
        if (runtime !== "local_mock") assert.match(candidate.summary, /handoff ok/i);
      }
      const selected = events.find(event => event.type === "agent.runtime_selected");
      assert.equal(selected?.runtime, runtime);
      assert.equal(selected?.correlation_id, "occurrence:ambient:1");
      assert.equal(selected?.run_id, "run:ambient:1");
      assert.equal(selected?.payload?.selection, "explicit_override");
      assert.equal(events.some(event => event.type === "agent.completed"), true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configured default selection is observable", async () => {
  const bridge = new AgentExecutionAdapter({ runtimes: [new MockAgentRuntimeAdapter()], default_runtime: "local_mock" });
  const events: AgentOperatorEvent[] = [];
  const result = await bridge.execute(invocation(), { events: { emit: event => events.push(event) } });
  assert.equal(result.status, "succeeded");
  const selected = events.find(event => event.type === "agent.runtime_selected");
  assert.equal(selected?.runtime, "local_mock");
  assert.equal(selected?.payload?.selection, "configured_default");
});

test("permission and progress events retain Transformation Run correlation", async () => {
  const runtime = new PermissionRuntime();
  const bridge = new AgentExecutionAdapter({ runtimes: [runtime], default_runtime: runtime.id });
  const events: AgentOperatorEvent[] = [];
  const permissionCalls: unknown[] = [];
  const result = await bridge.execute(invocation({ runtime_override: runtime.id }), {
    events: { emit: event => events.push(event) },
    permissions: {
      async request(input) {
        permissionCalls.push(input);
        return { decision: { outcome: "cancelled" } };
      },
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(permissionCalls.length, 1);
  for (const type of ["agent.permission_requested", "agent.progress"] as const) {
    const event = events.find(item => item.type === type);
    assert.equal(event?.correlation_id, "occurrence:ambient:1");
    assert.equal(event?.run_id, "run:ambient:1");
    assert.deepEqual(event?.transformation, { transformation_id: "transformation.ambient.ask", revision: 2 });
  }
});

test("unsupported background mode fails before runtime submission", async () => {
  const runtime = new CountingRuntime();
  const bridge = new AgentExecutionAdapter({ runtimes: [runtime], default_runtime: runtime.id });
  const result = await bridge.execute(invocation({ mode: "background" }));
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.failure.code, "unsupported_capability");
  assert.equal(runtime.submissions, 0);
});

test("schema_value mode never falls back to a legacy AgentTaskOutput result", async () => {
  const runtime = new CountingRuntime();
  const bridge = new AgentExecutionAdapter({ runtimes: [runtime], default_runtime: runtime.id });
  const result = await bridge.execute(invocation({
    output_contract: {
      mode: "schema_value",
      view_type: "learning.daily_plan",
      schema: { name: "learning.daily_plan", version: 1, mode: "freeform" },
    },
  }));
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failure.code, "runtime_failed");
    assert.match(result.failure.message, /no schema_value candidate output/);
  }
});

test("cancellation is routed to the active selected runtime", async () => {
  const runtime = new DeferredRuntime();
  const bridge = new AgentExecutionAdapter({ runtimes: [runtime], default_runtime: runtime.id });
  const current = invocation({ runtime_override: runtime.id });
  const execution = bridge.execute(current);
  await runtime.started;
  const cancelled = await bridge.cancel(current.invocation_id);
  assert.deepEqual(cancelled, { status: "cancelled", runtime: runtime.id });
  assert.equal(runtime.cancelledTask, current.invocation_id);
  const result = await execution;
  assert.equal(result.status, "failed");
});

function invocation(overrides: Partial<AgentOperatorInvocation> = {}): AgentOperatorInvocation {
  return {
    invocation_id: "agent-invocation:ambient:1",
    run_id: "run:ambient:1",
    correlation_id: "occurrence:ambient:1",
    transformation: { transformation_id: "transformation.ambient.ask", revision: 2 },
    mode: "invoke",
    prompt: "总结当前选择，并说明它和 Metaflow 的关系",
    current_context: {
      voice: { transcript: "总结当前选择" },
      screen: { app: "Safari", selected_text: "Ambient uses exact Views." },
    },
    inputs: [{
      role: "current_selection",
      views: [{
        ref: { view_id: "view:selection:1", revision: 1 },
        policy: viewPolicy(),
      }],
    }],
    view_tools: [
      { name: "mf views", kind: "cli", command: "pnpm", args: ["mf", "views", "search"] },
      { name: "Metaflow MCP", kind: "mcp", server: "metaflow" },
    ],
    output_contract: { view_type: "analysis.ambient_answer", title: "Ambient answer" },
    policy_snapshot: {
      autonomy: "suggest",
      allow_external_model: false,
      allow_network: false,
      allow_write: false,
    },
    ...overrides,
  };
}

function viewPolicy() {
  return {
    owner: "user:local",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: [],
  };
}

class CountingRuntime implements AgentRuntimeAdapter {
  readonly id = "counting";
  readonly kind = "mock" as const;
  submissions = 0;

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(): Promise<AgentTaskResult> {
    this.submissions += 1;
    return { ok: true, reason: "counted", output: { summary: "counted" } };
  }
}

class PermissionRuntime implements AgentRuntimeAdapter {
  readonly id = "permission-runtime";
  readonly kind = "acp_stdio" as const;

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      modes: ["invoke" as const],
      supportsPermissionRequests: true,
      supportsProgress: true,
    };
  }

  async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    const request = {
      sessionId: "session:test",
      toolCall: { toolCallId: "tool:1", title: "Read current View" },
      options: [{ optionId: "cancel", name: "Cancel", kind: "reject_once" }],
    } as Parameters<NonNullable<AgentRuntimeContext["permissions"]>["requestPermission"]>[0];
    await context.events?.emit({
      type: "runtime.permission_requested",
      runtime: this.id,
      taskId: task.id,
      sessionId: "session:test",
      request,
    });
    await context.permissions?.requestPermission(request);
    await context.events?.emit({
      type: "runtime.prompt_update",
      runtime: this.id,
      taskId: task.id,
      sessionId: "session:test",
      update: {
        sessionId: "session:test",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
      },
    });
    return { ok: true, reason: "permission handled", output: { summary: "done" } };
  }
}

class DeferredRuntime implements AgentRuntimeAdapter {
  readonly id = "deferred";
  readonly kind = "acp_stdio" as const;
  cancelledTask?: string;
  private start!: () => void;
  private finish!: (result: AgentTaskResult) => void;
  readonly started = new Promise<void>(resolve => { this.start = resolve; });
  private readonly result = new Promise<AgentTaskResult>(resolve => { this.finish = resolve; });

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const], supportsCancel: true };
  }

  async submit(): Promise<AgentTaskResult> {
    this.start();
    return this.result;
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelledTask = taskId;
    this.finish({ ok: false, reason: "cancelled" });
  }
}

function fakeAcpAgentSource(): string {
  return `
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
let connection;
const agent = {
  async initialize(params) {
    return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: "ambient-test", version: "1" }, authMethods: [] };
  },
  async newSession() { return { sessionId: "session:ambient" }; },
  async prompt(params) {
    const text = params.prompt.map(block => block.type === "text" ? block.text : "").join("\\n");
    const ok = text.includes("总结当前选择") && text.includes("view:selection:1");
    await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ summary: ok ? "ACP handoff ok" : "ACP handoff missing context" }) } } });
    return { stopReason: "end_turn" };
  },
  async cancel() {},
  async authenticate() {}
};
connection = new AgentSideConnection(() => agent, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
`;
}

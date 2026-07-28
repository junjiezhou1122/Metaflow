import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  AcpStdioAgentRuntimeAdapter,
  buildAgentConversationPromptBlocks,
  PiRpcConversationRuntimeAdapter,
  type AgentConversationRequest,
  type AgentConversationResult,
  type AgentConversationEvent,
  type AgentConversationRuntimeAdapter,
} from "@info/agent-runtime-adapter";
import {
  createDirectAssistHttpHandler,
  DirectAssistService,
} from "../apps/ambient-daemon/direct-assist.js";
import {
  createNativeAgentPermissionBroker,
  DirectAssistRuntimeRouter,
  selectNativeAgentPermission,
} from "../apps/ambient-daemon/direct-assist-runtime.js";

test("Ambient conversation prompt contains immediate context and the exact screen image", () => {
  const request: AgentConversationRequest = {
    id: "request:prompt",
    conversationId: "conversation:notch",
    message: "Summarize this screen",
    currentContext: assistRequest("request:prompt", "Summarize this screen").current_context,
    screenImage: {
      mimeType: "image/jpeg",
      data: Buffer.from("bounded jpeg fixture").toString("base64"),
    },
  };
  const blocks = buildAgentConversationPromptBlocks(request);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "text");
  const text = blocks[0]?.type === "text" ? blocks[0].text : "";
  assert.match(text, /Summarize this screen/);
  assert.match(text, /Exact selected text/);
  assert.ok(text.indexOf("USER MESSAGE:") < text.indexOf("CURRENT CONTEXT (supplemental and possibly unrelated):"));
  assert.match(text, /supplemental and possibly unrelated/);
  assert.match(text, /Answer this turn in the foreground/);
  assert.match(text, /Do not start a background Agent or Task/);
  assert.match(text, /unless the user explicitly asks/);
  assert.doesNotMatch(text, /AVAILABLE VIEW TOOLS/);
  assert.doesNotMatch(text, /AgentTaskOutput/);
  assert.doesNotMatch(text, /MCP/);
  assert.deepEqual(blocks[1], {
    type: "image",
    mimeType: "image/jpeg",
    data: request.screenImage?.data,
  });
});

test("Direct Assist selects an Agent-provided native allow option and logs the exact tool call", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-permission-test-"));
  const script = join(directory, "fake-conversation-acp-agent.mjs");
  writeFileSync(script, fakeConversationAcpAgentSource());
  chmodSync(script, 0o755);
  const runtime = new AcpStdioAgentRuntimeAdapter({
    id: "ambient_permission_test",
    command: process.execPath,
    args: [script],
    cwd: directory,
    lifecycle: "persistent",
  });
  const logs: Record<string, unknown>[] = [];

  try {
    const result = await runtime.converse({
      id: "request:permission",
      conversationId: "conversation:permission",
      message: "TOOL_PERMISSION",
    }, {
      permissions: createNativeAgentPermissionBroker(record => logs.push(record)),
    });

    assert.equal(result.ok, true);
    assert.match(result.text ?? "", /permission:always/);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.event, "acp.permission_selected");
    assert.equal(logs[0]?.selected_option_id, "always");
    assert.deepEqual((logs[0]?.tool_call as { toolCallId?: string })?.toolCallId, "tool-native-search");
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ACP conversation exposes native tool calls as diagnostics", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-tool-trace-test-"));
  const script = join(directory, "fake-conversation-acp-agent.mjs");
  writeFileSync(script, fakeConversationAcpAgentSource());
  chmodSync(script, 0o755);
  const runtime = new AcpStdioAgentRuntimeAdapter({
    id: "ambient_tool_trace_test",
    command: process.execPath,
    args: [script],
    cwd: directory,
    lifecycle: "persistent",
  });
  const diagnostics: string[] = [];

  try {
    const result = await runtime.converse({
      id: "request:tool-trace",
      conversationId: "conversation:tool-trace",
      message: "TOOL_PERMISSION",
    }, {
      permissions: createNativeAgentPermissionBroker(() => undefined),
      onEvent(event) {
        if (event.type === "diagnostic") diagnostics.push(event.event);
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(diagnostics, ["acp.tool_call", "acp.tool_call_update"]);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Direct Assist defaults to Claude ACP and starts Pi only when explicitly selected", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-pi-lazy-test-"));
  const script = join(directory, "fake-pi-rpc.mjs");
  const argvPath = join(directory, "argv.json");
  writeFileSync(script, fakePiRpcSource());
  chmodSync(script, 0o755);
  const acp = new RecordingConversationRuntime();
  const router = new DirectAssistRuntimeRouter({
    acp,
    pi: {
      command: script,
      defaultProvider: "fixture",
      defaultModel: "fixture-vision",
      thinking: "off",
      env: { PI_ARGV_OUTPUT: argvPath },
    },
  });

  try {
    const defaultResult = await router.converse({
      id: "request:default",
      conversationId: "conversation:router",
      message: "DEFAULT",
    });
    assert.equal(defaultResult.text, "answer:DEFAULT");
    assert.equal(existsSync(argvPath), false);

    const piResult = await router.converse({
      id: "request:pi",
      conversationId: "conversation:router",
      message: "PI",
      backend: { harness: "pi", provider: "fixture", model: "fixture-vision" },
    });
    assert.equal(piResult.ok, true);
    assert.equal(existsSync(argvPath), true);
  } finally {
    await router.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Direct Assist rejects an unconfigured Pi backend before starting a runtime", async () => {
  const router = new DirectAssistRuntimeRouter({
    acp: new RecordingConversationRuntime(),
    pi: {
      command: process.execPath,
      defaultProvider: "",
      defaultModel: "",
      thinking: "off",
    },
  });

  await assert.rejects(router.converse({
    id: "request:pi-unconfigured",
    conversationId: "conversation:router",
    message: "PI",
    backend: { harness: "pi" },
  }), /Pi provider must be selected explicitly or configured through METAFLOW_PI_PROVIDER/);
  await router.close();
});

test("Direct Assist fails closed when an ACP request offers no allow option", () => {
  assert.throws(() => selectNativeAgentPermission({
    sessionId: "session:no-allow",
    toolCall: {
      title: "Blocked tool",
      kind: "other",
      status: "pending",
      toolCallId: "tool:no-allow",
    },
    options: [{ kind: "reject_once", name: "Reject", optionId: "reject" }],
  }), /offered no allow option/);
});

test("Direct assist passes plain conversation input to one resident runtime", async () => {
  const runtime = new RecordingConversationRuntime();
  const service = new DirectAssistService(runtime, () => new Date("2026-07-26T08:00:00.000Z"));

  const first = await service.assist({
    ...assistRequest("request:first", "Summarize this"),
    agent: { harness: "pi" as const, provider: "fixture-provider", model: "fixture-model" },
  });
  const second = await service.assist(assistRequest("request:second", "Explain the selection"));

  assert.equal(first.text, "answer:Summarize this");
  assert.equal(second.text, "answer:Explain the selection");
  assert.equal(first.conversation_id, "metaflow-notch");
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[0]?.conversationId, "metaflow-notch");
  assert.equal(runtime.calls[0]?.currentContext?.screen?.selected_text, "Exact selected text");
  assert.equal(runtime.calls[0]?.currentContext?.app?.bundle_id, "com.apple.Safari");
  assert.equal(runtime.calls[0]?.screenImage?.mimeType, "image/jpeg");
  assert.deepEqual(runtime.calls[0]?.backend, { harness: "pi", provider: "fixture-provider", model: "fixture-model" });
});

test("persistent ACP conversation accepts plain text and reuses process and session without MCP", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-conversation-test-"));
  const script = join(directory, "fake-conversation-acp-agent.mjs");
  writeFileSync(script, fakeConversationAcpAgentSource());
  chmodSync(script, 0o755);
  const runtime = new AcpStdioAgentRuntimeAdapter({
    id: "ambient_conversation_test",
    command: process.execPath,
    args: [script],
    cwd: directory,
    lifecycle: "persistent",
  });

  try {
    const first = await runtime.converse({
      id: "request:one",
      conversationId: "conversation:stable",
      message: "FIRST TURN",
      screenImage: { mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") },
    });
    const second = await runtime.converse({
      id: "request:two",
      conversationId: "conversation:stable",
      message: "SECOND TURN",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.text, "plain:sess_1:turn:1:images:1:mcp:0");
    assert.equal(second.text, "plain:sess_1:turn:2:images:0:mcp:0");
    assert.equal(first.diagnostics?.process_reused, false);
    assert.equal(second.diagnostics?.process_reused, true);
    assert.equal(second.diagnostics?.process_id, first.diagnostics?.process_id);
    assert.equal(second.diagnostics?.session_id, first.diagnostics?.session_id);
    assert.equal(second.diagnostics?.session_reused, true);
    assert.equal(second.diagnostics?.mcp_server_count, 0);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent ACP process keeps concurrent conversation sessions independent", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-multi-conversation-test-"));
  const script = join(directory, "fake-conversation-acp-agent.mjs");
  writeFileSync(script, fakeConversationAcpAgentSource());
  chmodSync(script, 0o755);
  const runtime = new AcpStdioAgentRuntimeAdapter({
    id: "ambient_multi_conversation_test",
    command: process.execPath,
    args: [script],
    cwd: directory,
    lifecycle: "persistent",
  });

  try {
    const [first, second] = await Promise.all([
      runtime.converse({
        id: "request:conversation-one",
        conversationId: "conversation:one",
        message: "FIRST CONVERSATION",
      }),
      runtime.converse({
        id: "request:conversation-two",
        conversationId: "conversation:two",
        message: "SECOND CONVERSATION",
      }),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.diagnostics?.session_id, second.diagnostics?.session_id);
    assert.equal(first.diagnostics?.process_id, second.diagnostics?.process_id);
    assert.match(first.text ?? "", /turn:1/);
    assert.match(second.text ?? "", /turn:1/);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent ACP evicts an inactive conversation and resumes its exact session", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-session-eviction-test-"));
  const script = join(directory, "fake-conversation-acp-agent.mjs");
  writeFileSync(script, fakeConversationAcpAgentSource());
  chmodSync(script, 0o755);
  const runtime = new AcpStdioAgentRuntimeAdapter({
    id: "ambient_session_eviction_test",
    command: process.execPath,
    args: [script],
    cwd: directory,
    lifecycle: "persistent",
    maxPersistentConversations: 1,
    persistentConversationIdleMs: 60_000,
  });

  try {
    const first = await runtime.converse({
      id: "request:eviction:one",
      conversationId: "conversation:one",
      message: "FIRST",
    });
    await runtime.converse({
      id: "request:eviction:two",
      conversationId: "conversation:two",
      message: "SECOND",
    });
    const resumed = await runtime.converse({
      id: "request:eviction:three",
      conversationId: "conversation:one",
      message: "THIRD",
    });

    assert.equal(resumed.diagnostics?.session_id, first.diagnostics?.session_id);
    assert.equal(resumed.diagnostics?.session_resumed, true);
    assert.match(resumed.text ?? "", /turn:2/);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent ACP forwards conversation abort to session cancel", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-acp-cancel-test-"));
  const script = join(directory, "fake-conversation-acp-agent.mjs");
  const cancelMarker = join(directory, "cancelled.txt");
  const promptMarker = join(directory, "prompt-started.txt");
  writeFileSync(script, fakeConversationAcpAgentSource());
  chmodSync(script, 0o755);
  const runtime = new AcpStdioAgentRuntimeAdapter({
    id: "ambient_conversation_cancel_test",
    command: process.execPath,
    args: [script],
    cwd: directory,
    env: { ACP_CANCEL_MARKER: cancelMarker, ACP_PROMPT_MARKER: promptMarker },
    lifecycle: "persistent",
  });
  const controller = new AbortController();

  try {
    const pending = runtime.converse({
      id: "request:cancel",
      conversationId: "conversation:cancel",
      message: "WAIT_FOR_CANCEL",
    }, { signal: controller.signal });
    const promptDeadline = Date.now() + 5_000;
    while (!existsSync(promptMarker) && Date.now() < promptDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(existsSync(promptMarker), true, "fixture ACP prompt did not start");
    controller.abort(new Error("stream closed"));
    const result = await pending;
    const cancelDeadline = Date.now() + 5_000;
    while (!existsSync(cancelMarker) && Date.now() < cancelDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.equal(result.ok, false);
    assert.equal(existsSync(cancelMarker), true, "fixture ACP cancel was not invoked");
    assert.equal(readFileSync(cancelMarker, "utf8"), "sess_1");
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ambient direct HTTP returns structured success and ACP failure", async () => {
  const runtime = new RecordingConversationRuntime();
  const handler = createDirectAssistHttpHandler(new DirectAssistService(runtime));
  const success = await invoke(handler, assistRequest("request:http:ok", "Help me"));
  assert.equal(success.status, 200);
  assert.equal(success.body.ok, true);
  assert.equal((success.body.result as { text?: string }).text, "answer:Help me");

  runtime.failure = "ACP process exited";
  const failure = await invoke(handler, assistRequest("request:http:failed", "Try again"));
  assert.equal(failure.status, 502);
  assert.equal(failure.body.ok, false);
  assert.equal(failure.body.code, "agent_failed");
  assert.match(String(failure.body.error), /ACP process exited/);
});

test("Ambient direct HTTP streams Markdown deltas before the final result", async () => {
  const runtime = new RecordingConversationRuntime();
  runtime.deltas = ["**Meta", "flow**\n", "- ready"];
  const handler = createDirectAssistHttpHandler(new DirectAssistService(runtime));
  const response = await invokeStream(handler, assistRequest("request:http:stream", "Use Markdown"));

  assert.equal(response.status, 200);
  assert.match(response.contentType, /application\/x-ndjson/);
  const events = response.raw.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map(event => event.type), [
    "assistant_message_start",
    "assistant_message_delta",
    "assistant_message_delta",
    "assistant_message_delta",
    "assistant_message_done",
  ]);
  assert.equal(events.filter(event => event.type === "assistant_message_delta").map(event => event.delta).join(""), "**Metaflow**\n- ready");
  assert.equal(((events.at(-1)?.result as Record<string, unknown>)?.text), "answer:Use Markdown");
});

test("Ambient direct HTTP aborts runtime work when the streaming client disconnects", async () => {
  const runtime = new DisconnectAwareConversationRuntime();
  const handler = createDirectAssistHttpHandler(new DirectAssistService(runtime));
  const pending = invokeDisconnectedStream(handler, assistRequest("request:http:disconnect", "Keep researching"));

  await runtime.started;
  await pending;

  assert.equal(runtime.signal?.aborted, true);
  assert.equal(runtime.cancelled, true);
});

test("Ambient direct HTTP streams bounded tool activity without raw input", async () => {
  const runtime = new RecordingConversationRuntime();
  runtime.events = [
    { type: "text_delta", delta: "I will search first." },
    {
      type: "diagnostic",
      event: "acp.tool_call",
      details: {
        update: {
          toolCallId: "tool:web-search",
          title: "Search the web",
          kind: "search",
          status: "pending",
          toolName: "WebSearch",
          rawInput: { query: "private query that must stay server-side" },
        },
      },
    },
    {
      type: "diagnostic",
      event: "acp.tool_call_update",
      details: { update: { toolCallId: "tool:web-search", status: "completed" } },
    },
    { type: "text_delta", delta: "Final answer." },
  ];
  const handler = createDirectAssistHttpHandler(new DirectAssistService(runtime));
  const response = await invokeStream(handler, assistRequest("request:http:tools", "Search this"));

  assert.equal(response.status, 200);
  const events = response.raw.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map(event => event.type), [
    "assistant_message_start",
    "assistant_message_delta",
    "tool_activity",
    "tool_activity",
    "assistant_message_delta",
    "assistant_message_done",
  ]);
  const tools = events.filter(event => event.type === "tool_activity").map(event => event.tool as Record<string, unknown>);
  assert.deepEqual(tools, [
    {
      tool_call_id: "tool:web-search",
      title: "Search the web",
      kind: "search",
      status: "pending",
      tool_name: "WebSearch",
    },
    { tool_call_id: "tool:web-search", status: "completed" },
  ]);
  assert.doesNotMatch(response.raw, /private query/);
});

test("Ambient direct HTTP fails the stream when ACP tool activity has no id", async () => {
  const runtime = new RecordingConversationRuntime();
  runtime.events = [{
    type: "diagnostic",
    event: "acp.tool_call",
    details: { update: { title: "Broken search", status: "pending" } },
  }];
  const handler = createDirectAssistHttpHandler(new DirectAssistService(runtime));
  const response = await invokeStream(handler, assistRequest("request:http:bad-tool", "Search this"));

  const events = response.raw.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.at(-1)?.type, "assistant_message_error");
  assert.equal(events.at(-1)?.code, "invalid_tool_activity");
});

test("Pi RPC conversation streams exact image turns through one resident process", async () => {
  const directory = mkdtempSync(join(process.cwd(), "packages/adapters/agent-runtime/.tmp-pi-rpc-test-"));
  const script = join(directory, "fake-pi-rpc.mjs");
  const argvPath = join(directory, "argv.json");
  writeFileSync(script, fakePiRpcSource());
  chmodSync(script, 0o755);
  const runtime = new PiRpcConversationRuntimeAdapter({
    command: script,
    provider: "fixture",
    model: "fixture-vision",
    timeoutMs: 5_000,
    env: { PI_ARGV_OUTPUT: argvPath },
  });

  try {
    await runtime.warmup("conversation:pi");
    const deltas: string[] = [];
    const toolDiagnostics: AgentConversationEvent[] = [];
    const first = await runtime.converse({
      id: "request:pi:one",
      conversationId: "conversation:pi",
      message: "FIRST",
      screenImage: { mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") },
    }, { onEvent: event => {
      if (event.type === "text_delta") deltas.push(event.delta);
      else toolDiagnostics.push(event);
    } });
    const second = await runtime.converse({
      id: "request:pi:two",
      conversationId: "conversation:pi",
      message: "SECOND",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.text, "pi:turn:1:images:1");
    assert.equal(second.text, "pi:turn:2:images:0");
    assert.equal(deltas.join(""), first.text);
    assert.deepEqual(toolDiagnostics, [
      {
        type: "diagnostic",
        event: "pi.tool_execution_start",
        details: { update: {
          toolCallId: "pi-tool-1",
          title: "read",
          kind: "tool",
          status: "running",
          toolName: "read",
        } },
      },
      {
        type: "diagnostic",
        event: "pi.tool_execution_end",
        details: { update: {
          toolCallId: "pi-tool-1",
          title: "read",
          kind: "tool",
          status: "completed",
          toolName: "read",
        } },
      },
    ]);
    assert.equal(first.diagnostics?.process_id, second.diagnostics?.process_id);
    assert.equal(first.diagnostics?.process_reused, true);
    assert.equal(second.diagnostics?.process_reused, true);
    assert.equal(second.diagnostics?.provider, "fixture");
    assert.equal(second.diagnostics?.model, "fixture-vision");
    const argv = JSON.parse(readFileSync(argvPath, "utf8")) as string[];
    assert.equal(argv.some(value => value.startsWith("--no-")), false);
    assert.equal(argv.includes("--tools"), false);
    assert.equal(second.diagnostics?.tools, "pi_default");
    assert.equal(second.diagnostics?.skills_enabled, true);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ambient direct HTTP rejects malformed input before invoking ACP", async () => {
  const runtime = new RecordingConversationRuntime();
  const handler = createDirectAssistHttpHandler(new DirectAssistService(runtime));
  const result = await invoke(handler, { request_id: "bad", prompt: "", source: "voice", current_context: {} });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "invalid_assist_request");
  assert.equal(runtime.calls.length, 0);
});

class RecordingConversationRuntime implements AgentConversationRuntimeAdapter {
  readonly id = "recording_acp";
  readonly calls: AgentConversationRequest[] = [];
  failure?: string;
  deltas: string[] = [];
  events: AgentConversationEvent[] = [];

  async converse(request: AgentConversationRequest, context?: Parameters<AgentConversationRuntimeAdapter["converse"]>[1]): Promise<AgentConversationResult> {
    this.calls.push(request);
    if (this.failure) return { ok: false, reason: this.failure };
    if (this.events.length > 0) {
      for (const event of this.events) await context?.onEvent?.(event);
    } else {
      for (const delta of this.deltas) await context?.onEvent?.({ type: "text_delta", delta });
    }
    return {
      ok: true,
      reason: "resident ACP answered",
      text: `answer:${request.message}`,
      diagnostics: { lifecycle: "persistent_conversation", process_reused: this.calls.length > 1 },
    };
  }
}

class DisconnectAwareConversationRuntime implements AgentConversationRuntimeAdapter {
  readonly id = "disconnect_aware_acp";
  readonly started: Promise<void>;
  private markStarted!: () => void;
  signal?: AbortSignal;
  cancelled = false;

  constructor() {
    this.started = new Promise(resolve => { this.markStarted = resolve; });
  }

  async converse(
    _request: AgentConversationRequest,
    context?: Parameters<AgentConversationRuntimeAdapter["converse"]>[1],
  ): Promise<AgentConversationResult> {
    this.signal = context?.signal;
    this.markStarted();
    await new Promise<void>(resolve => {
      if (context?.signal?.aborted) {
        this.cancelled = true;
        resolve();
        return;
      }
      context?.signal?.addEventListener("abort", () => {
        this.cancelled = true;
        resolve();
      }, { once: true });
    });
    return { ok: false, reason: "client disconnected" };
  }
}

function assistRequest(request_id: string, prompt: string) {
  return {
    request_id,
    prompt,
    source: "typed" as const,
    current_context: {
      screen: {
        app: "Safari",
        title: "Ambient design",
        selected_text: "Exact selected text",
      },
      app: {
        name: "Safari",
        bundle_id: "com.apple.Safari",
        window_title: "Ambient design",
      },
    },
    screen_image: {
      mime_type: "image/jpeg" as const,
      data: Buffer.from("bounded jpeg fixture").toString("base64"),
    },
  };
}

async function invoke(
  handler: ReturnType<typeof createDirectAssistHttpHandler>,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string> };
  request.headers = { "content-type": "application/json" };
  let status = 0;
  let raw = "";
  const response = {
    writeHead(code: number) { status = code; },
    write(value: string) { raw += value; },
    end(value?: string) { if (value) raw += value; },
  };
  await handler(request as never, response as never);
  return { status, body: JSON.parse(raw) as Record<string, unknown> };
}

async function invokeStream(
  handler: ReturnType<typeof createDirectAssistHttpHandler>,
  body: unknown,
): Promise<{ status: number; contentType: string; raw: string }> {
  const request = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string> };
  request.headers = { "content-type": "application/json", accept: "application/x-ndjson" };
  let status = 0;
  let contentType = "";
  let raw = "";
  const response = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code;
      contentType = headers?.["content-type"] ?? "";
    },
    write(value: string) { raw += value; return true; },
    end(value?: string) { if (value) raw += value; },
  };
  await handler(request as never, response as never);
  return { status, contentType, raw };
}

async function invokeDisconnectedStream(
  handler: ReturnType<typeof createDirectAssistHttpHandler>,
  body: unknown,
): Promise<void> {
  const request = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string> };
  request.headers = { "content-type": "application/json", accept: "application/x-ndjson" };
  const response = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    writableEnded: boolean;
    writeHead(code: number, headers?: Record<string, string>): void;
    write(value: string): boolean;
    end(value?: string): void;
  };
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = () => undefined;
  response.write = () => !response.destroyed;
  response.end = () => { response.writableEnded = true; };

  const pending = handler(request as never, response as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  response.destroyed = true;
  response.emit("close");
  await pending;
}

function fakeConversationAcpAgentSource(): string {
  return `
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

let connection;
let sessionCount = 0;
const sessions = new Map();
const pendingPrompts = new Map();
const agent = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { image: true },
        loadSession: true,
        sessionCapabilities: { close: {} }
      },
      agentInfo: { name: "fake-conversation-acp-agent", version: "0.0.1" },
      authMethods: []
    };
  },
  async newSession(params) {
    const sessionId = "sess_" + (++sessionCount);
    sessions.set(sessionId, { turn: 0, mcp: params.mcpServers.length });
    return { sessionId };
  },
  async loadSession(params) {
    if (!sessions.has(params.sessionId)) throw new Error("unknown fixture session " + params.sessionId);
    return {};
  },
  async prompt(params) {
    const state = sessions.get(params.sessionId);
    state.turn += 1;
    const imageCount = params.prompt.filter(block => block.type === "image").length;
    const promptText = params.prompt.filter(block => block.type === "text").map(block => block.text).join("\\n");
    if (promptText.includes("WAIT_FOR_CANCEL")) {
      if (process.env.ACP_PROMPT_MARKER) writeFileSync(process.env.ACP_PROMPT_MARKER, params.sessionId);
      return await new Promise(resolve => pendingPrompts.set(params.sessionId, resolve));
    }
    let permission = "";
    if (promptText.includes("TOOL_PERMISSION")) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-native-search",
          title: "Native web search",
          kind: "search",
          status: "pending"
        }
      });
      const decision = await connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          title: "Native web search",
          kind: "search",
          status: "pending",
          toolCallId: "tool-native-search",
          content: [{ type: "content", content: { type: "text", text: "search exact query" } }]
        },
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "once" },
          { kind: "allow_always", name: "Always allow", optionId: "always" },
          { kind: "reject_once", name: "Reject", optionId: "reject" }
        ]
      });
      permission = ":permission:" + (decision.outcome.outcome === "selected" ? decision.outcome.optionId : "cancelled");
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-native-search",
          status: "completed"
        }
      });
    }
    const output = "plain:" + params.sessionId + ":turn:" + state.turn + ":images:" + imageCount + ":mcp:" + state.mcp + permission;
    for (const text of [output.slice(0, 12), output.slice(12)]) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
      });
    }
    return { stopReason: "end_turn" };
  },
  async cancel(params) {
    if (process.env.ACP_CANCEL_MARKER) writeFileSync(process.env.ACP_CANCEL_MARKER, params.sessionId);
    pendingPrompts.get(params.sessionId)?.({ stopReason: "cancelled" });
    pendingPrompts.delete(params.sessionId);
  },
  async closeSession() { return {}; },
  async authenticate() {}
};

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
connection = new AgentSideConnection(() => agent, ndJsonStream(input, output));
await connection.closed;
`;
}

function fakePiRpcSource(): string {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.PI_ARGV_OUTPUT) writeFileSync(process.env.PI_ARGV_OUTPUT, JSON.stringify(process.argv.slice(2)));
let buffer = "";
let turn = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: "get_state", success: true, data: {
        model: { id: "fixture-vision", provider: "fixture", input: ["text", "image"] },
        isStreaming: false
      }});
      continue;
    }
    if (command.type === "prompt") {
      turn += 1;
      send({ type: "response", id: command.id, command: "prompt", success: true });
      const text = "pi:turn:" + turn + ":images:" + (command.images?.length ?? 0);
      send({ type: "tool_execution_start", toolCallId: "pi-tool-" + turn, toolName: "read", args: { path: "private" } });
      send({ type: "tool_execution_end", toolCallId: "pi-tool-" + turn, toolName: "read", result: { content: [] }, isError: false });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(0, 8) } });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(8) } });
      send({ type: "agent_end", messages: [] });
    }
  }
});
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
`;
}

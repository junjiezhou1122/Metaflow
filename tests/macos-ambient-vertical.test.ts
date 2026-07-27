import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import { MacDeliveryMailbox } from "../packages/adapters/macos-automation/delivery.ts";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "../packages/adapters/agent-runtime/types.ts";

test("macOS push-to-talk freezes utterance and selected AX context, names Codex, delivers, and records feedback", () => withComposition(async ({ composition, agent }) => {
  const submitted = await request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent({
    requested_agent: "codex",
    selected_text: "This exact selected text must reach Codex.",
  }));
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.result.status, "invoked");
  assert.deepEqual(submitted.body.result.captured_views.map((item: any) => item.role), ["voice_utterance", "current_app"]);
  const invocation = submitted.body.result.invocations[0];
  assert.equal(invocation.status, "succeeded");
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]?.task.currentContext.voice?.transcript, "Codex explain the selected architecture boundary");
  assert.equal(agent.calls[0]?.task.currentContext.screen?.selected_text, "This exact selected text must reach Codex.");
  assert.equal(agent.calls[0]?.task.currentContext.app?.name, "TextEdit");

  const replay = await composition.execution.replay(invocation.run_id);
  assert.deepEqual(replay.run.frozen.runtime_override, {
    runtime: "codex",
    requested_by: "user",
    requested_name: "codex",
  });
  const trace = await composition.traces.query({ correlation_id: invocation.correlation_id });
  const accepted = trace.find(item => item.type === "automation.delivery_succeeded" && (item.payload as any).request_id.includes(":accepted:"));
  const result = trace.find(item => item.type === "automation.result_committed");
  assert.ok(accepted, "accepted progress was not delivered");
  assert.ok(result, "result commit was not traced");
  const releasedAt = Date.parse(submitted.body.result.signal.occurred_at);
  const releaseToAcceptedMs = Date.parse(accepted.occurred_at) - releasedAt;
  const releaseToResultMs = Date.parse(result.occurred_at) - releasedAt;
  assert.ok(releaseToAcceptedMs >= 0 && releaseToAcceptedMs <= 250, `accepted Delivery took ${releaseToAcceptedMs} ms`);
  assert.ok(releaseToResultMs >= releaseToAcceptedMs && releaseToResultMs <= 1_000, `result commit took ${releaseToResultMs} ms`);
  console.info(JSON.stringify({
    component: "macos-ambient-test",
    event: "push_to_talk.latency_measured",
    release_to_accepted_ms: releaseToAcceptedMs,
    release_to_result_ms: releaseToResultMs,
    clock: "deterministic_fixture",
  }));

  const deliveries = await request(composition.handler, "GET", "/automation/v1/macos/deliveries");
  assert.equal(deliveries.status, 200);
  assert.equal(deliveries.body.deliveries.length, 1);
  const card = deliveries.body.deliveries[0];
  assert.equal(card.request.phase, "result");
  const feedback = await request(composition.handler, "POST", "/automation/v1/macos/interactions", interaction(card, "accept"));
  assert.equal(feedback.status, 200);
  const feedbackView = await composition.views.get(feedback.body.result.feedback_view);
  assert.equal(feedbackView?.schema.name, "metaflow.automation.feedback");
}));

test("browser foreground uses the explicit Chrome DOM request bridge instead of AX text fallback", () => withComposition(async ({ composition, agent }) => {
  const pendingSubmission = request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent({
    app_name: "Google Chrome",
    bundle_identifier: "com.google.Chrome",
    selected_text: undefined,
  }));
  await waitFor(() => composition.browserContext.list().length === 1);
  const pending = await request(composition.handler, "GET", "/automation/v1/macos/browser-context-requests");
  assert.equal(pending.status, 200);
  assert.equal(pending.body.requests.length, 1);
  const requestId = pending.body.requests[0].request_id;
  const response = await request(composition.handler, "POST", "/automation/v1/macos/browser-context-responses", {
    request_id: requestId,
    status: "captured",
    captured_at: "2026-07-26T11:00:02.100Z",
    tab_id: 42,
    window_id: 7,
    url: "https://github.com/openai/codex",
    title: "openai/codex",
    text: "The full DOM text came from the Chrome extension bridge.",
    selected_text: "Chrome selection",
    dom: { github_repository: true },
    metadata: { content_source: "document.body.innerText" },
  });
  assert.equal(response.status, 200);
  const submitted = await pendingSubmission;
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.body.result.captured_views.map((item: any) => item.role), ["voice_utterance", "current_app", "current_page"]);
  assert.match(JSON.stringify(agent.calls[0]?.task.currentContext), /full DOM text came from the Chrome extension bridge/);
  assert.equal(agent.calls[0]?.task.currentContext.screen?.url, "https://github.com/openai/codex");
}));

test("denied Accessibility and ASR failure fail before Raw View admission", () => withComposition(async ({ composition }) => {
  const denied = await request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent({ accessibility_denied: true }));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "accessibility_denied");
  const asr = await request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent({ asr_failed: true, event_id: "mac-event:asr-failed", session_id: "mac-session:asr-failed" }));
  assert.equal(asr.status, 422);
  assert.equal(asr.body.code, "asr_failed");
  const raw = await composition.views.query({ role: "raw", revisions: "latest", limit: 100 });
  assert.equal(raw.length, 0);
}));

test("missing selection remains an explicit optional absence and does not select stale context", () => withComposition(async ({ composition, agent }) => {
  const submitted = await request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent({ selected_text: undefined }));
  assert.equal(submitted.status, 200);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]?.task.currentContext.screen?.selected_text, undefined);
  const sources = agent.calls[0]?.task.contextPack?.sources as Array<{ role: string; views: unknown[] }>;
  assert.deepEqual(sources.map(item => [item.role, item.views.length]), [
    ["voice_utterance", 1],
    ["current_app", 1],
    ["current_page", 0],
  ]);
}));

test("cancel interaction aborts the active shared Execution and commits a cancelled Failure View", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-macos-cancel-"));
  const agent = new BlockingAgentRuntime();
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: agent,
    now: () => new Date("2026-07-26T11:00:02.010Z"),
  });
  try {
    const pending = request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent());
    await agent.started;
    const deliveries = await request(composition.handler, "GET", "/automation/v1/macos/deliveries");
    const accepted = deliveries.body.deliveries[0];
    assert.equal(accepted.request.phase, "accepted");
    const cancelled = await request(composition.handler, "POST", "/automation/v1/macos/interactions", interaction(accepted, "cancel"));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.result.command.status, "handled");
    const completed = await pending;
    const invocation = completed.body.result.invocations[0];
    assert.equal(invocation.status, "failed");
    const replay = await composition.execution.replay(invocation.run_id);
    assert.equal(replay.run.status, "cancelled");
    assert.equal((await composition.views.get(replay.failure!.ref))?.schema.name, "metaflow.execution.failure");
  } finally {
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Agent and macOS Delivery failures remain separate observable facts", async () => {
  await withComposition(async ({ composition }) => {
    const failed = await request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent());
    const invocation = failed.body.result.invocations[0];
    assert.equal(invocation.status, "failed");
    const replay = await composition.execution.replay(invocation.run_id);
    assert.equal((await composition.views.get(replay.failure!.ref))?.schema.name, "metaflow.execution.failure");
  }, new FailingAgentRuntime());

  const directory = mkdtempSync(join(tmpdir(), "metaflow-macos-delivery-fail-"));
  const mailbox = new ThrowingMacMailbox();
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: new RecordingAgentRuntime(),
    mac_delivery_mailbox: mailbox,
    now: () => new Date("2026-07-26T11:00:02.010Z"),
  });
  try {
    const submitted = await request(composition.handler, "POST", "/automation/v1/macos/voice-signals", voiceEvent());
    const invocation = submitted.body.result.invocations[0];
    assert.equal(invocation.status, "succeeded");
    assert.ok(invocation.deliveries.every((item: any) => item.result.status === "failed"));
    const trace = await composition.traces.query({ correlation_id: invocation.correlation_id });
    assert.ok(trace.some(item => item.type === "automation.delivery_failed"));
    assert.ok(trace.some(item => item.type === "automation.result_committed"));
  } finally {
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class RecordingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "codex";
  readonly kind = "acp_stdio" as const;
  readonly calls: Array<{ task: AgentTaskRequest; context: AgentRuntimeContext }> = [];

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const], supportsDryRun: false, supportsCancel: true, supportsPermissionRequests: true, supportsProgress: true, supportsMcpServers: true };
  }

  async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    this.calls.push({ task, context });
    await context.events?.emit({ type: "runtime.start", runtime: this.id, taskId: task.id, payload: { fixture: "macos-ambient" } });
    return { ok: true, reason: "fixture completed", output: { answer: "Context-aware macOS response", runtime: this.id } };
  }

  async cancel() {}
}

class FailingAgentRuntime extends RecordingAgentRuntime {
  override async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    this.calls.push({ task, context });
    return { ok: false, reason: "forced Agent failure", diagnostics: { code: "forced_agent_failure" } };
  }
}

class BlockingAgentRuntime extends RecordingAgentRuntime {
  private resolveStarted!: () => void;
  readonly started = new Promise<void>(resolve => { this.resolveStarted = resolve; });
  private finish!: (result: AgentTaskResult) => void;

  override async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    this.calls.push({ task, context });
    this.resolveStarted();
    return new Promise(resolve => { this.finish = resolve; });
  }

  override async cancel() {
    this.finish({ ok: false, reason: "cancelled" });
  }
}

class ThrowingMacMailbox extends MacDeliveryMailbox {
  override async render(): Promise<{ delivery_id: string }> {
    throw new Error("forced macOS surface failure");
  }
}

async function withComposition(
  fn: (input: { composition: Awaited<ReturnType<typeof createAmbientDaemonComposition>>; agent: RecordingAgentRuntime }) => Promise<void>,
  suppliedAgent?: RecordingAgentRuntime,
) {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-macos-ambient-"));
  const agent = suppliedAgent ?? new RecordingAgentRuntime();
  let tick = Date.parse("2026-07-26T11:00:02.000Z");
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: agent,
    agent_aliases: { codex: agent.id },
    now: () => new Date(tick += 5),
  });
  try {
    await fn({ composition, agent });
  } finally {
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function voiceEvent(options: {
  event_id?: string;
  session_id?: string;
  app_name?: string;
  bundle_identifier?: string;
  selected_text?: string;
  requested_agent?: string;
  accessibility_denied?: boolean;
  asr_failed?: boolean;
} = {}) {
  const accessibility = options.accessibility_denied
    ? { status: "denied", code: "accessibility_permission_denied", message: "Accessibility is denied" }
    : {
        status: "trusted",
        app_name: options.app_name ?? "TextEdit",
        bundle_identifier: options.bundle_identifier ?? "com.apple.TextEdit",
        process_id: 4242,
        window_title: "Ambient architecture notes",
        role: "AXTextArea",
        ...(options.selected_text === undefined ? {} : { selected_text: options.selected_text }),
      };
  const speech = options.asr_failed
    ? { status: "failed", code: "recognition_failed", message: "forced ASR failure", started_at: "2026-07-26T11:00:00.000Z", ended_at: "2026-07-26T11:00:02.000Z" }
    : { status: "recognized", transcript: "Codex explain the selected architecture boundary", locale: "zh-CN", started_at: "2026-07-26T11:00:00.000Z", ended_at: "2026-07-26T11:00:02.000Z", confidence: 0.98 };
  return {
    version: 1,
    event_id: options.event_id ?? "mac-event:voice:1",
    session_id: options.session_id ?? "mac-session:voice:1",
    source: { connector: "metaflow-mac", connection_id: "macbook-junjie" },
    shortcut: { phase: "released", key_code: 49, modifiers: ["option"], pressed_at: "2026-07-26T11:00:00.000Z", released_at: "2026-07-26T11:00:02.000Z" },
    speech,
    accessibility,
    ...(options.requested_agent ? { requested_agent: options.requested_agent } : {}),
    captured_at: "2026-07-26T11:00:02.000Z",
    privacy: { owner: "user:local", visibility: "private", privacy: "private", retention: "normal", allow_external_model: true, allow_embedding: false, labels: ["ambient", "macos", "voice"] },
    metadata: { fixture: true },
  };
}

function interaction(card: any, action: string) {
  return {
    id: `interaction:macos:${action}:${Date.now()}`,
    request_id: card.request.id,
    delivery_id: card.delivery_id,
    surface: "macos",
    action,
    occurred_at: "2026-07-26T11:00:03.000Z",
    actor: "user:test",
    metadata: {},
  };
}

async function request(
  handler: (req: any, res: any) => Promise<void>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost",
    "content-type": "application/json",
    authorization: "Bearer test-operation-auth-token-32-bytes",
  };
  let status = 0;
  let raw = "";
  const res = { writeHead(code: number) { status = code; }, end(value: string) { raw = value; } };
  await handler(req, res);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

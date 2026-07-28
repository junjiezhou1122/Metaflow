import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import { exactViewRef } from "@info/view";
import {
  CodexHistoryCaptureConnector,
  codexHistorySourceConnection,
} from "@info/codex-history-capture-adapter";
import {
  OBSIDIAN_IDENTITY_POLICY,
  OBSIDIAN_PARSER_CONTRACT,
  OBSIDIAN_SECRET_POLICY,
  obsidianSourceConnection,
} from "@info/obsidian-capture-adapter";
import { buildBrowserAutomationEvent, buildBrowserDeliveryInteraction } from "../apps/chrome-acp/packages/chrome-extension/src/lib/ambient/browser-trigger.ts";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentTaskRequest,
  AgentTaskResult,
} from "../packages/adapters/agent-runtime/types.ts";

test("Browser trigger reaches ACP Execution, committed View, delivery, feedback, dedupe, and one trace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-ambient-daemon-"));
  const agent = new DeterministicAcpRuntime();
  const now = () => new Date("2026-07-26T10:00:31.000Z");
  const composition = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: agent,
    now,
  });
  try {
    const event = extensionEvent();
    const submitted = await request(composition.handler, "POST", "/automation/v1/browser-signals", event);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.ok, true);
    assert.equal(submitted.body.result.status, "invoked");
    assert.equal(submitted.body.result.captured_views.length, 1);
    const invocation = submitted.body.result.invocations[0];
    assert.equal(invocation.status, "succeeded");
    assert.equal(agent.calls.length, 1);

    const exactInputs = agent.calls[0]?.task.contextPack?.sources as Array<{ role: string; views: unknown[] }>;
    assert.deepEqual(exactInputs.map(binding => [binding.role, binding.views.length]), [
      ["current_page", 1],
      ["current_selection", 0],
    ]);
    assert.match(JSON.stringify(agent.calls[0]?.task.currentContext), /Codex is an open source coding agent/);

    const deliveries = await request(composition.handler, "GET", "/automation/v1/browser-deliveries");
    assert.equal(deliveries.status, 200);
    assert.equal(deliveries.body.deliveries.length, 1);
    const card = deliveries.body.deliveries[0];
    assert.equal(card.request.phase, "result");
    assert.deepEqual(card.request.views, invocation.output_views);

    const summaryRef = invocation.output_views[0];
    const summary = await request(
      composition.handler,
      "GET",
      `/context/v1/views/${encodeURIComponent(summaryRef.view_id)}?revision=${summaryRef.revision}`,
    );
    assert.equal(summary.status, 200);
    assert.equal(summary.body.view.schema.name, "summary.github.repository");
    assert.equal(summary.body.view.provenance.operator_run_id, invocation.run_id);
    assert.match(JSON.stringify(summary.body.view.representation), /Local-first coding agent summary/);

    const interaction = buildBrowserDeliveryInteraction({
      request_id: card.request.id,
      delivery_id: card.delivery_id,
      action: "accept",
      metadata: { source: "ambient-card" },
      now: "2026-07-26T10:01:00.000Z",
      id_factory: () => "interaction:ambient:accept:1",
    });
    const accepted = await request(composition.handler, "POST", "/automation/v1/browser-interactions", interaction);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.result.replayed, false);
    const feedbackRef = accepted.body.result.feedback_view;
    const feedback = await composition.views.get(feedbackRef);
    assert.equal(feedback?.schema.name, "metaflow.automation.feedback");
    assert.match(JSON.stringify(feedback?.representation), /\"action\":\"accept\"/);

    const duplicate = await request(composition.handler, "POST", "/automation/v1/browser-signals", event);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.result.invocations[0].status, "duplicate");
    assert.equal(agent.calls.length, 1);

    const laterSnapshot = await request(composition.handler, "POST", "/automation/v1/browser-signals", {
      ...event,
      event_id: "browser-event:github:codex:duplicate",
      captured_at: "2026-07-26T10:00:32.000Z",
      page: { ...event.page, text: `${event.page.text} One later DOM mutation.` },
    });
    assert.equal(laterSnapshot.status, 200);
    assert.equal(laterSnapshot.body.result.invocations[0].status, "skipped");
    assert.equal(laterSnapshot.body.result.invocations[0].reason, "cooldown");
    assert.equal(agent.calls.length, 1);

    const trace = await composition.traces.query({ correlation_id: invocation.correlation_id });
    const eventTypes = trace.map(item => item.type);
    for (const required of [
      "automation.occurrence_received",
      "automation.context_resolved",
      "automation.run_started",
      "automation.agent_event",
      "automation.result_committed",
      "automation.delivery_succeeded",
      "automation.feedback_recorded",
      "automation.occurrence_completed",
      "automation.occurrence_deduped",
      "automation.occurrence_rejected",
    ]) {
      assert.ok(eventTypes.includes(required as typeof eventTypes[number]), `missing ${required}: ${eventTypes.join(", ")}`);
    }
    assert.ok(trace.every(item => item.correlation_id === invocation.correlation_id));
    assert.deepEqual(trace.map(item => item.sequence), [...trace.map(item => item.sequence)].sort((a, b) => a - b));
    assert.ok(trace.filter(item => item.type === "automation.agent_event").every(item => item.run_id === invocation.run_id));
  } finally {
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ambient composition persists exact Transformation owners and projects canonical Operations across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-ambient-restart-"));
  const now = () => new Date("2026-07-26T10:10:00.000Z");
  const first = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: new DeterministicAcpRuntime(),
    now,
  });
  try {
    const transformation = await first.transformations.get({
      transformation_id: "transformation.github.repository_summary",
      revision: 1,
    });
    assert.equal(transformation?.name, "GitHub repository summary");
    const parserTransformation = await first.transformations.get({
      transformation_id: "transformation.parser.markdown",
      revision: 1,
    });
    assert.equal(parserTransformation?.operator.reference.kind, "function");
    assert.equal(parserTransformation?.operator.reference.kind === "function"
      ? parserTransformation.operator.reference.function_id
      : undefined, "parser.markdown");
    const catalog = await request(first.handler, "POST", "/metaflow/v1/operations/catalog.list", {});
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.ok, true);
    assert.equal(catalog.body.operation, "catalog.list");
    assert.ok(catalog.body.data.some((operation: { name: string }) => operation.name === "run.execute"));
  } finally {
    await first.close();
  }

  const restarted = await createAmbientDaemonComposition({
    data_directory: directory,
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: new DeterministicAcpRuntime(),
    now,
  });
  try {
    const transformation = await restarted.transformations.get({
      transformation_id: "transformation.github.repository_summary",
      revision: 1,
    });
    assert.equal(transformation?.revision, 1);
    assert.equal(transformation?.operator.reference.kind, "agent");
  } finally {
    await restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ambient composition registers and pulls explicit Codex and Obsidian Source Connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-ambient-sources-"));
  const codexHome = join(directory, "codex-home");
  const rolloutDirectory = join(codexHome, "sessions", "2026", "07", "27");
  const vaultRoot = join(directory, "vault");
  mkdirSync(rolloutDirectory, { recursive: true });
  mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
  mkdirSync(vaultRoot, { recursive: true });
  copyFileSync(
    join(process.cwd(), "tests", "fixtures", "codex-history", "minimal-session.jsonl"),
    join(rolloutDirectory, "rollout-synthetic.jsonl"),
  );
  copyFileSync(
    join(process.cwd(), "tests", "fixtures", "obsidian-vault", "plain.md"),
    join(vaultRoot, "plain.md"),
  );
  const codexConnection = codexHistorySourceConnection({
    id: "codex-history:composition",
    source_root: "both",
  });
  const obsidianConnection = obsidianSourceConnection({
    id: "obsidian:composition",
    configuration: {
      vault_id: "vault:composition",
      vault_root: vaultRoot,
      include: ["**/*.md"],
      max_file_bytes: 8_000_000,
      identity_policy: OBSIDIAN_IDENTITY_POLICY,
      parser_contract: OBSIDIAN_PARSER_CONTRACT,
      secret_policy: OBSIDIAN_SECRET_POLICY,
    },
  });
  const composition = await createAmbientDaemonComposition({
    data_directory: join(directory, "data"),
    operation_auth_token: "test-operation-auth-token-32-bytes",
    agent_runtime: new DeterministicAcpRuntime(),
    capture_sources: {
      codex_history: {
        connector: new CodexHistoryCaptureConnector({
          codex_home: codexHome,
          now: () => "2026-07-27T01:05:00.000Z",
        }),
        connection: codexConnection,
      },
      obsidian: { connections: [obsidianConnection] },
    },
    now: () => new Date("2026-07-27T01:05:00.000Z"),
  });
  try {
    assert.deepEqual(composition.captureSources.connection_ids, [
      "codex-history:composition",
      "obsidian:composition",
    ]);
    await composition.captureSources.pull(codexConnection.id);
    await composition.captureSources.pull(obsidianConnection.id);
    assert.equal((await composition.views.query({
      schema_name: "capture.codex.session",
      revisions: "latest",
      limit: 20,
    })).length, 1);
    assert.equal((await composition.views.query({
      schema_name: "capture.obsidian.document",
      revisions: "latest",
      limit: 20,
    })).length, 1);
    const source = (await composition.views.query({
      schema_name: "capture.obsidian.document",
      revisions: "latest",
      limit: 20,
    }))[0]!;
    const parserTransformation = await composition.transformations.get({
      transformation_id: "transformation.parser.markdown",
      revision: 1,
    });
    assert.ok(parserTransformation?.policy);
    const parsed = await composition.execution.execute({
      run_id: "run:ambient:obsidian-markdown-parser",
      correlation_id: "correlation:ambient:obsidian-markdown-parser",
      transformation: parserTransformation,
      access_policy: parserTransformation.policy,
      access_use: "local_execution",
      invocation_inputs: [{ role: "source", views: [exactViewRef(source)] }],
      idempotency_key: "ambient:obsidian-markdown-parser",
    });
    assert.equal(parsed.run.status, "succeeded");
    assert.equal(parsed.outputs[0]?.schema.name, "metaflow.view.fragment-set");
    assert.deepEqual(parsed.outputs[0]?.provenance.inputs, [exactViewRef(source)]);
    await assert.rejects(
      composition.captureSources.pull("obsidian:not-configured"),
      /not configured/,
    );
  } finally {
    await composition.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class DeterministicAcpRuntime implements AgentRuntimeAdapter {
  readonly id = "acp_stdio";
  readonly kind = "acp_stdio" as const;
  readonly calls: Array<{ task: AgentTaskRequest; context: AgentRuntimeContext }> = [];

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      modes: ["invoke" as const],
      supportsDryRun: false,
      supportsCancel: false,
      supportsPermissionRequests: false,
      supportsProgress: true,
      supportsMcpServers: false,
    };
  }

  async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    this.calls.push({ task, context });
    await context.events?.emit({
      type: "runtime.start",
      runtime: this.id,
      taskId: task.id,
      payload: { fixture: "ambient-daemon-vertical" },
    });
    return {
      ok: true,
      reason: "deterministic ACP fixture completed",
      output: {
        summary: "Local-first coding agent summary",
        key_points: ["Installs as a CLI", "Uses frozen Browser evidence"],
        confidence: 0.99,
      },
      diagnostics: { runtime: this.id, fixture: true },
    };
  }
}

function extensionEvent() {
  return buildBrowserAutomationEvent({
    message: {
      event_id: "browser-event:github:codex:1",
      navigation_id: "navigation:github:codex:1",
      reason_kind: "manual",
      dom: {
        github_repository: true,
        markers: { repository_header: true, readme: true },
      },
    },
    tab: {
      id: 42,
      windowId: 7,
      url: "https://github.com/openai/codex",
      title: "openai/codex",
    },
    page: {
      text: "Codex is an open source coding agent. Install it as a CLI and use it in your terminal.",
      observed_at: "2026-07-26T10:00:30.000Z",
      metadata: { content_source: "document.body.innerText" },
      text_quality: { complete: true, characters: 86 },
    },
    visit_id: "visit:github:codex:1",
    started_at_ms: Date.parse("2026-07-26T09:59:30.000Z"),
    privacy: {
      level: "private",
      retention: "normal",
      allow_external_llm: true,
      allow_embedding: false,
    },
    now: "2026-07-26T10:00:31.000Z",
    id_factory: () => "must-not-be-used",
  });
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
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { raw = value; },
  };
  await handler(req, res);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

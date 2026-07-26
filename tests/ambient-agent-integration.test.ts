import test from "node:test";
import assert from "node:assert/strict";
import {
  AutomationRuntime,
  createAutomationAgentTraceBridge,
  parseAutomationDefinition,
  parseAutomationView,
  parseTriggerSignal,
  type AutomationOccurrenceRepository,
  type OccurrenceReservation,
} from "../packages/automation/index.ts";
import {
  AgentExecutionAdapter,
  MockAgentRuntimeAdapter,
} from "../packages/adapters/agent-runtime/index.ts";
import type { AgentOperatorInvocation } from "@info/execution";
import { parseView } from "@info/view";

test("push-to-talk Automation hands current voice/screen context to the shared Agent Adapter", async () => {
  const automation = macVoiceAutomation();
  const signal = parseTriggerSignal({
    id: "signal:mac:voice:1",
    kind: "user",
    source: "mac",
    event: "push_to_talk.released",
    occurred_at: "2026-07-26T09:00:00.000Z",
    idempotency_key: "shortcut:option-space:press-17",
    evidence: [
      { view_id: "view:voice:17", revision: 1 },
      { view_id: "view:ax-selection:17", revision: 1 },
    ],
    payload: {
      voice_transcript: "把当前选中的内容总结一下，并告诉我和 Metaflow 有什么关系",
      language: "zh-CN",
      selected_text: "Ambient should invoke expensive work only after a declared trigger.",
      app: "Safari",
      bundle_id: "com.apple.Safari",
      window_title: "Ambient Runtime design",
      url: "https://example.com/ambient-runtime",
      project_path: "/Users/junjie/info",
    },
  });
  const events: string[] = [];
  const delivered: Array<{ phase: string; surface: string; views: unknown[] }> = [];
  const occurrences = new SingleOccurrenceRepository();
  const voiceView = capturedView({
    id: "view:voice:17",
    schema: "capture.voice.utterance",
    value: { transcript: signal.payload.voice_transcript },
  });
  const selectionView = capturedView({
    id: "view:ax-selection:17",
    schema: "capture.local_app.selection",
    value: { selected_text: signal.payload.selected_text },
  });
  let agentInvocation: AgentOperatorInvocation | undefined;
  let targetDeliverySurfaces: string[] = [];
  const agentEvents: string[] = [];
  const agent = new AgentExecutionAdapter({
    runtimes: [new MockAgentRuntimeAdapter()],
    default_runtime: "local_mock",
  });

  const runtime = new AutomationRuntime({
    occurrences,
    context: {
      async resolve() {
        return {
          bindings: [
            { role: "voice", required: true, views: [voiceView] },
            { role: "current_screen", required: true, views: [selectionView] },
          ],
          disclosed_views: signal.evidence,
          attempts: [],
        };
      },
    },
    events: { emit: event => { events.push(event.type); } },
    target: {
      async execute(request, context) {
        const payload = request.occurrence.payload;
        if (request.target.kind !== "transformation") throw new Error("test requires a Transformation target");
        targetDeliverySurfaces = request.requested_delivery.map(delivery => delivery.surface);
        agentInvocation = {
          invocation_id: `agent:${request.correlation_id}`,
          run_id: "run:ambient:voice:1",
          correlation_id: request.correlation_id,
          transformation: {
            transformation_id: request.target.transformation_id,
            revision: request.target.revision,
          },
          mode: "invoke",
          prompt: String(payload.voice_transcript),
          cwd: String(payload.project_path),
          current_context: {
            voice: {
              transcript: String(payload.voice_transcript),
              language: String(payload.language),
              audio_view_ref: "view:voice:17@1",
            },
            screen: {
              app: String(payload.app),
              title: String(payload.window_title),
              url: String(payload.url),
              selected_text: String(payload.selected_text),
              view_ref: "view:ax-selection:17@1",
            },
            app: {
              name: String(payload.app),
              bundle_id: String(payload.bundle_id),
              window_title: String(payload.window_title),
              project_path: String(payload.project_path),
            },
          },
          inputs: request.context.bindings.map(binding => ({
            role: binding.role,
            views: binding.views.map(view => ({
              ref: { view_id: view.id, revision: view.revision },
              policy: view.policy,
            })),
          })),
          view_tools: [
            { name: "mf views", kind: "cli", command: "pnpm", args: ["mf", "views", "search"] },
            { name: "Metaflow MCP", kind: "mcp", server: "metaflow" },
          ],
          output_contract: {
            view_type: "analysis.ambient_answer",
            title: "Ambient answer",
            purpose: "Answer a push-to-talk request using exact current context.",
          },
          policy_snapshot: {
            autonomy: "suggest",
            allow_external_model: request.policy_snapshot.allow_external_model,
            allow_network: false,
            allow_write: false,
          },
        };
        const traceBridge = createAutomationAgentTraceBridge({
          correlation_id: request.correlation_id,
          trace: context.trace,
        });
        const result = await agent.execute(agentInvocation, {
          events: {
            emit: async event => {
              agentEvents.push(event.type);
              await traceBridge.emit(event);
            },
          },
        });
        assert.equal(result.status, "succeeded");
        if (result.status === "succeeded") {
          assert.match((result.candidate as { summary: string }).summary, /把当前选中的内容总结一下/);
        }
        return {
          status: "succeeded",
          run_id: "run:ambient:voice:1",
          output_views: [{ view_id: "view:ambient-answer:1", revision: 1 }],
        };
      },
    },
    delivery: {
      async deliver(request) {
        delivered.push({ phase: request.phase, surface: request.surface, views: request.views });
        return { status: "delivered", delivery_id: `notch:${request.phase}:1` };
      },
    },
    now: () => new Date("2026-07-26T09:00:00.050Z"),
  });

  const result = await runtime.invoke({ automation, signal });
  assert.equal(result.status, "succeeded");
  assert.equal((agentInvocation?.current_context.voice as { transcript?: string })?.transcript, "把当前选中的内容总结一下，并告诉我和 Metaflow 有什么关系");
  assert.equal((agentInvocation?.current_context.screen as { selected_text?: string })?.selected_text, "Ambient should invoke expensive work only after a declared trigger.");
  assert.equal((agentInvocation?.current_context.screen as { url?: string })?.url, "https://example.com/ambient-runtime");
  assert.equal((agentInvocation?.current_context.app as { project_path?: string })?.project_path, "/Users/junjie/info");
  assert.ok(agentInvocation?.view_tools.some(tool => tool.kind === "cli"));
  assert.ok(agentInvocation?.view_tools.some(tool => tool.kind === "mcp"));
  assert.deepEqual(agentInvocation?.inputs.map(input => input.views.map(view => view.ref)), [
    [{ view_id: "view:voice:17", revision: 1 }],
    [{ view_id: "view:ax-selection:17", revision: 1 }],
  ]);
  assert.deepEqual(targetDeliverySurfaces, ["notch"]);
  assert.equal(agentEvents.includes("agent.runtime_selected"), true);
  assert.equal(agentEvents.includes("agent.completed"), true);
  assert.deepEqual(delivered.map(item => `${item.surface}:${item.phase}`), ["notch:accepted", "notch:result"]);
  assert.deepEqual(delivered[1]?.views, [{ view_id: "view:ambient-answer:1", revision: 1 }]);
  assert.equal(events.includes("automation.result_committed"), true);
});

function macVoiceAutomation() {
  const definition = parseAutomationDefinition({
    version: 1,
    trigger: {
      id: "mac-push-to-talk",
      kind: "user",
      source: "mac",
      event: "push_to_talk.released",
    },
    target: { kind: "transformation", transformation_id: "transformation.ambient.ask", revision: 1 },
    input_mapping: [
      {
        role: "voice",
        required: true,
        sources: [{ kind: "trigger_evidence", schema_name: "capture.voice.utterance", source: "mac" }],
      },
      {
        role: "current_screen",
        required: true,
        sources: [
          { kind: "trigger_evidence", schema_name: "capture.local_app.selection", source: "mac" },
          { kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "chrome-extension" },
        ],
      },
    ],
    delivery: [{
      surface: "notch",
      urgency: "glance",
      show_progress: true,
      expires_after_ms: 120000,
      actions: ["dismiss", "cancel", "retry", "correct"],
    }],
    limits: { dedupe_window_ms: 0, cooldown_ms: 0, max_concurrency: 1, timeout_ms: 60000 },
  });
  return parseAutomationView(parseView({
    id: "automation:mac-push-to-talk",
    revision: 1,
    name: "Ask Metaflow from the current macOS context",
    purpose: "Invoke the ambient ask Transformation with exact voice and screen evidence",
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: {
        type: "object",
        required: ["version", "enabled", "trigger", "target"],
        properties: {
          version: { const: 1 },
          enabled: { type: "boolean" },
          trigger: { type: "object" },
          target: { type: "object" },
        },
      },
    },
    role: "derived",
    time: { created_at: "2026-07-26T08:59:00.000Z" },
    representation: { form: "inline", kind: "automation", media_type: "application/json", value: definition },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    provenance: { inputs: [], actor: "user" },
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      labels: [],
    },
  }));
}

function capturedView(input: { id: string; schema: string; value: Record<string, unknown> }) {
  return parseView({
    id: input.id,
    revision: 1,
    name: input.schema,
    purpose: "Exact trigger-time evidence for the Ambient invocation",
    schema: { name: input.schema, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: "2026-07-26T09:00:00.000Z", created_at: "2026-07-26T09:00:00.000Z" },
    representation: { form: "inline", kind: "json", value: input.value },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    provenance: {
      inputs: [],
      actor: "mac",
      capture: {
        connector: "mac",
        connection_id: "mac:local",
        source_id: input.id,
        source_kind: input.schema,
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      labels: [],
    },
  });
}

class SingleOccurrenceRepository implements AutomationOccurrenceRepository {
  private value?: { key: string; correlation_id: string; status: "reserved" | "succeeded" | "failed" };

  async reserve(input: { idempotency_key: string; correlation_id: string }): Promise<OccurrenceReservation> {
    if (this.value) {
      return {
        created: false,
        reason: "duplicate",
        correlation_id: this.value.correlation_id,
        status: this.value.status,
      };
    }
    this.value = { key: input.idempotency_key, correlation_id: input.correlation_id, status: "reserved" };
    return { created: true };
  }

  async finalize(input: {
    idempotency_key: string;
    correlation_id: string;
    status: "succeeded" | "failed";
  }): Promise<void> {
    assert.equal(this.value?.key, input.idempotency_key);
    assert.equal(this.value?.correlation_id, input.correlation_id);
    this.value = { key: input.idempotency_key, correlation_id: input.correlation_id, status: input.status };
  }
}

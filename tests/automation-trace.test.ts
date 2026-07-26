import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutomationContextResolutionError,
  AutomationContextResolver,
  AutomationDeliveryCoordinator,
  AutomationFeedbackViewService,
  AutomationRuntime,
  AutomationRuntimeError,
  InMemoryAutomationTraceStore,
  parseAutomationDefinition,
  parseAutomationTraceEvent,
  parseAutomationView,
  parseTriggerSignal,
  type AutomationOccurrenceRepository,
  type AutomationSurfaceRenderer,
  type AutomationTargetResult,
  type OccurrenceReservation,
} from "../packages/automation/index.ts";
import {
  SqliteAutomationDeliveryLedger,
  SqliteAutomationOccurrenceRepository,
  SqliteAutomationTraceStore,
} from "../packages/adapters/automation-sqlite/index.ts";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";

test("one durable timeline links trigger, policy, Agent, Delivery, and Feedback across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-trace-"));
  const automationDb = join(directory, "automation.sqlite");
  const views = new SqliteViewRepository(join(directory, "views.sqlite"));
  const occurrences = new SqliteAutomationOccurrenceRepository(automationDb);
  const deliveryLedger = new SqliteAutomationDeliveryLedger(automationDb);
  const trace = new SqliteAutomationTraceStore(automationDb);
  const commands = new Set<string>();
  try {
    const automationCommit = await views.commit({ draft: automationDraft(), expected_revision: 0 });
    const evidenceCommit = await views.commit({ draft: viewDraft("view:browser:trace", "capture.browser.page_snapshot", "raw"), expected_revision: 0 });
    await views.commit({ draft: viewDraft("view:summary:trace", "analysis.page_summary", "derived"), expected_revision: 0 });
    const automation = parseAutomationView(automationCommit.view);
    const renderer = new TraceRenderer();
    const delivery = new AutomationDeliveryCoordinator({
      renderers: [renderer],
      ledger: deliveryLedger,
      events: trace,
      feedback: new AutomationFeedbackViewService(views),
      commands: {
        async handle(input) {
          commands.add(input.idempotency_key);
          return { status: "handled", command_id: `command:${input.interaction.id}` };
        },
      },
      now: () => new Date("2026-07-26T12:00:04.000Z"),
    });
    const context = new AutomationContextResolver({
      views,
      authorizer: {
        async authorize(input) {
          return {
            allowed: true,
            decision_id: `policy:allow:${input.view.id}@${input.view.revision}`,
            reason: "Automation policy permits local Agent disclosure",
          };
        },
      },
    });
    const runtime = new AutomationRuntime({
      occurrences,
      context,
      delivery,
      events: trace,
      target: {
        async execute(request, execution) {
          const agentBase = {
            invocation_id: `agent:${request.correlation_id}`,
            run_id: "run:trace:1",
            transformation: { transformation_id: "transformation.page.summary", revision: 1 },
            runtime: "codex-acp",
          };
          await execution.trace({
            ...agentBase,
            type: "agent.runtime_selected",
            occurred_at: "2026-07-26T12:00:01.000Z",
            payload: { selection: "explicit_override", mode: "invoke" },
          });
          await execution.trace({
            ...agentBase,
            type: "agent.completed",
            occurred_at: "2026-07-26T12:00:02.000Z",
          });
          return {
            status: "succeeded",
            run_id: "run:trace:1",
            output_views: [{ view_id: "view:summary:trace", revision: 1 }],
          };
        },
      },
      now: () => new Date("2026-07-26T12:00:03.000Z"),
    });
    const signal = traceSignal(evidenceCommit.view.id, evidenceCommit.view.revision);
    const result = await runtime.invoke({ automation, signal });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    const delivered = result.deliveries.find(item => item.request.phase === "result")?.result;
    assert.equal(delivered?.status, "delivered");
    if (delivered?.status !== "delivered") return;
    await delivery.interact({
      interaction: {
        id: "interaction:trace:accept",
        request_id: result.deliveries[0]!.request.id,
        delivery_id: delivered.delivery_id,
        surface: "notch",
        action: "accept",
        occurred_at: "2026-07-26T12:00:05.000Z",
        actor: "user:local",
      },
      policy: viewPolicy(),
    });

    trace.close();
    const reopened = new SqliteAutomationTraceStore(automationDb);
    try {
      const timeline = await reopened.query({ correlation_id: result.correlation_id });
      assert.deepEqual(timeline.map(event => event.type), [
        "automation.occurrence_received",
        "automation.occurrence_reserved",
        "automation.context_resolved",
        "automation.run_started",
        "automation.agent_event",
        "automation.agent_event",
        "automation.result_committed",
        "automation.delivery_attempted",
        "automation.delivery_succeeded",
        "automation.occurrence_completed",
        "automation.feedback_recorded",
      ]);
      assert.equal(timeline.every(event => event.correlation_id === result.correlation_id), true);
      assert.equal(timeline.every(event => event.automation.view_id === "automation:trace" && event.automation.revision === 1), true);
      assert.deepEqual(timeline[0]?.payload.evidence, [{ view_id: "view:browser:trace", revision: 1 }]);
      const contextEvent = timeline.find(event => event.type === "automation.context_resolved");
      const attempts = contextEvent?.payload.attempts as Array<{ authorized: unknown[] }>;
      assert.deepEqual(contextEvent?.payload.disclosed_views, [{ view_id: "view:browser:trace", revision: 1 }]);
      assert.deepEqual(attempts[0]?.authorized, [{
        ref: { view_id: "view:browser:trace", revision: 1 },
        decision_id: "policy:allow:view:browser:trace@1",
        reason: "Automation policy permits local Agent disclosure",
      }]);
      const agentEvent = timeline.find(event => event.type === "automation.agent_event");
      assert.equal(agentEvent?.source, "agent");
      assert.equal(agentEvent?.run_id, "run:trace:1");
      assert.equal(agentEvent?.payload.runtime, "codex-acp");
      const deliveryEvent = timeline.find(event => event.type === "automation.delivery_succeeded");
      assert.equal((deliveryEvent?.payload.result as { status?: string }).status, "delivered");
      const feedbackEvent = timeline.at(-1);
      assert.equal(feedbackEvent?.payload.action, "accept");
      assert.deepEqual(feedbackEvent?.payload.feedback_view, { view_id: "automation-feedback:interaction:trace:accept", revision: 1 });
      assert.equal(commands.size, 1);
      assert.equal(timeline.every((event, index) => index === 0 || event.sequence > timeline[index - 1]!.sequence), true);
    } finally {
      reopened.close();
    }
  } finally {
    trace.close();
    deliveryLedger.close();
    occurrences.close();
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("context, execution, validation, commit, and delivery failures retain distinct stages and codes", async () => {
  const cases: Array<{
    name: string;
    context?: Error;
    target?: AutomationTargetResult;
    delivery?: Error;
    expectedType: string;
    stage: string;
    code: string;
    result: "throws" | "failed" | "succeeded";
  }> = [
    {
      name: "context",
      context: new AutomationContextResolutionError("required page missing", "required_context_missing", "current_page", []),
      expectedType: "automation.context_failed",
      stage: "context",
      code: "required_context_missing",
      result: "throws",
    },
    {
      name: "execution",
      target: failedTarget("execution", "operator_failed"),
      expectedType: "automation.execution_failed",
      stage: "execution",
      code: "operator_failed",
      result: "failed",
    },
    {
      name: "validation",
      target: failedTarget("validation", "output_contract_rejected"),
      expectedType: "automation.execution_failed",
      stage: "validation",
      code: "output_contract_rejected",
      result: "failed",
    },
    {
      name: "commit",
      target: failedTarget("commit", "view_commit_conflict"),
      expectedType: "automation.execution_failed",
      stage: "commit",
      code: "view_commit_conflict",
      result: "failed",
    },
    {
      name: "delivery",
      delivery: new Error("notch renderer crashed"),
      expectedType: "automation.delivery_failed",
      stage: "delivery",
      code: "delivery_failed",
      result: "succeeded",
    },
  ];

  for (const item of cases) {
    const trace = new InMemoryAutomationTraceStore(() => new Date("2026-07-26T13:00:00.000Z"));
    const runtime = runtimeForFailure(item, trace);
    if (item.result === "throws") {
      await assert.rejects(runtime.invoke({ automation: testAutomation(), signal: traceSignal("view:evidence", 1) }));
    } else {
      const result = await runtime.invoke({ automation: testAutomation(), signal: traceSignal("view:evidence", 1) });
      assert.equal(result.status, item.result, item.name);
    }
    const correlation = "automation-occurrence:automation:trace:1:trace-trigger:signal:trace:1";
    const timeline = await trace.query({ correlation_id: correlation });
    const failure = timeline.find(event => event.type === item.expectedType)?.failure;
    assert.equal(failure?.stage, item.stage, item.name);
    assert.equal(failure?.code, item.code, item.name);
    if (item.result === "failed") assert.deepEqual(failure?.failure_view, { view_id: `failure:${item.code}`, revision: 1 });
  }
});

test("reservation and finalization failures are observable while trace persistence fails fast", async () => {
  const reservationTrace = new InMemoryAutomationTraceStore();
  const reservationRuntime = runtimeWithOccurrences({
    async reserve() { throw new Error("database unavailable"); },
    async finalize() { throw new Error("not reached"); },
  }, reservationTrace);
  await assert.rejects(
    reservationRuntime.invoke({ automation: testAutomation(), signal: traceSignal("view:evidence", 1) }),
    (error: unknown) => error instanceof AutomationRuntimeError && error.code === "occurrence_reservation_failed",
  );
  const correlation = "automation-occurrence:automation:trace:1:trace-trigger:signal:trace:1";
  const reservationFailure = (await reservationTrace.query({ correlation_id: correlation })).at(-1)?.failure;
  assert.equal(reservationFailure?.stage, "occurrence");
  assert.equal(reservationFailure?.code, "occurrence_reservation_failed");

  const finalizationTrace = new InMemoryAutomationTraceStore();
  const finalizationRuntime = runtimeWithOccurrences({
    async reserve() { return { created: true }; },
    async finalize() { throw new Error("finalization write failed"); },
  }, finalizationTrace);
  await assert.rejects(
    finalizationRuntime.invoke({ automation: testAutomation(), signal: traceSignal("view:evidence", 1) }),
    (error: unknown) => error instanceof AutomationRuntimeError && error.code === "occurrence_finalize_failed",
  );
  const finalizationFailure = (await finalizationTrace.query({ correlation_id: correlation })).at(-1)?.failure;
  assert.equal(finalizationFailure?.stage, "finalization");
  assert.equal(finalizationFailure?.code, "occurrence_finalize_failed");

  const traceFailureRuntime = runtimeWithOccurrences(new MemoryOccurrences(), {
    emit() { throw new Error("trace disk full"); },
  });
  await assert.rejects(
    traceFailureRuntime.invoke({ automation: testAutomation(), signal: traceSignal("view:evidence", 1) }),
    (error: unknown) => error instanceof AutomationRuntimeError && error.code === "trace_persistence_failed",
  );
});

test("retry and alternatives require an explicit parent attempt link", async () => {
  const trace = new InMemoryAutomationTraceStore();
  const runtime = runtimeWithOccurrences(new MemoryOccurrences(), trace);
  const first = await runtime.invoke({ automation: testAutomation(), signal: traceSignal("view:evidence", 1) });
  assert.equal(first.status, "succeeded");
  const retrySignal = traceSignal("view:evidence", 1);
  const retry = await runtime.invoke({
    automation: testAutomation(),
    signal: retrySignal,
    attempt: {
      id: "attempt:retry:1",
      parent_attempt_id: `${first.status === "succeeded" ? first.correlation_id : "unknown"}:attempt:0`,
      reason: "retry",
    },
  });
  assert.equal(retry.status, "succeeded");
  if (retry.status !== "succeeded") return;
  assert.notEqual(retry.correlation_id, first.status === "succeeded" ? first.correlation_id : "");
  assert.match(retry.correlation_id, /:attempt:attempt:retry:1$/);
  const linked = (await trace.query({ correlation_id: retry.correlation_id }))
    .find(event => event.type === "automation.attempt_linked");
  assert.equal(linked?.attempt_id, "attempt:retry:1");
  assert.equal(linked?.parent_attempt_id, `${first.status === "succeeded" ? first.correlation_id : "unknown"}:attempt:0`);
  assert.equal(linked?.payload.reason, "retry");
});

test("strict trace events reject unstructured failures and orphan parent attempts", () => {
  assert.throws(() => parseAutomationTraceEvent({
    type: "automation.context_failed",
    occurred_at: "2026-07-26T13:00:00.000Z",
    correlation_id: "correlation:test",
    automation: { view_id: "automation:test", revision: 1 },
  }), /structured failure/);
  assert.throws(() => parseAutomationTraceEvent({
    type: "automation.attempt_linked",
    occurred_at: "2026-07-26T13:00:00.000Z",
    correlation_id: "correlation:test",
    automation: { view_id: "automation:test", revision: 1 },
    parent_attempt_id: "attempt:parent",
  }), /parent_attempt_id requires attempt_id/);
});

class TraceRenderer implements AutomationSurfaceRenderer {
  readonly surface = "notch";
  readonly capacity = "single" as const;
  private count = 0;

  async render() {
    this.count += 1;
    return { delivery_id: `notch:${this.count}` };
  }

  async withdraw() {}
}

class MemoryOccurrences implements AutomationOccurrenceRepository {
  private readonly values = new Set<string>();

  async reserve(input: { idempotency_key: string; correlation_id: string }): Promise<OccurrenceReservation> {
    if (this.values.has(input.idempotency_key)) {
      return { created: false, reason: "duplicate", correlation_id: input.correlation_id, status: "succeeded" };
    }
    this.values.add(input.idempotency_key);
    return { created: true };
  }

  async finalize() {}
}

function runtimeForFailure(
  item: { context?: Error; target?: AutomationTargetResult; delivery?: Error },
  trace: InMemoryAutomationTraceStore,
) {
  return new AutomationRuntime({
    occurrences: new MemoryOccurrences(),
    context: {
      async resolve() {
        if (item.context) throw item.context;
        return { bindings: [], disclosed_views: [], attempts: [] };
      },
    },
    target: {
      async execute() {
        return item.target ?? {
          status: "succeeded",
          run_id: "run:failure-case",
          output_views: [{ view_id: "view:result", revision: 1 }],
        };
      },
    },
    delivery: {
      async deliver() {
        if (item.delivery) throw item.delivery;
        return { status: "delivered", delivery_id: "delivery:failure-case" };
      },
    },
    events: trace,
    now: () => new Date("2026-07-26T13:00:00.000Z"),
  });
}

function runtimeWithOccurrences(occurrences: AutomationOccurrenceRepository, events: { emit(event: any): void | Promise<void> }) {
  return new AutomationRuntime({
    occurrences,
    context: { async resolve() { return { bindings: [], disclosed_views: [], attempts: [] }; } },
    target: {
      async execute() {
        return { status: "succeeded", run_id: "run:trace", output_views: [{ view_id: "view:result", revision: 1 }] };
      },
    },
    delivery: { async deliver() { return { status: "delivered", delivery_id: "delivery:trace" }; } },
    events,
    now: () => new Date("2026-07-26T13:00:00.000Z"),
  });
}

function failedTarget(stage: "execution" | "validation" | "commit", code: string): AutomationTargetResult {
  return {
    status: "failed",
    run_id: `run:${code}`,
    failure_view: { view_id: `failure:${code}`, revision: 1 },
    failure: { stage, code, message: `${code} failure` },
  };
}

function testAutomation() {
  return parseAutomationView({
    ...automationDraft(),
    revision: 1,
  });
}

function automationDraft() {
  const definition = parseAutomationDefinition({
    version: 1,
    trigger: { id: "trace-trigger", kind: "event", source: "browser", event: "page" },
    target: { kind: "transformation", transformation_id: "transformation.page.summary", revision: 1 },
    input_mapping: [{
      role: "current_page",
      required: true,
      sources: [{ kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "browser" }],
    }],
    delivery: [{ surface: "notch", urgency: "glance", actions: ["accept", "dismiss"] }],
  });
  return {
    ...viewDraft("automation:trace", "metaflow.automation", "derived"),
    name: "Trace Automation",
    purpose: "Verify the complete Ambient correlation timeline",
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict" as const,
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    representation: { form: "inline" as const, kind: "automation", media_type: "application/json", value: definition },
  };
}

function traceSignal(viewId: string, revision: number) {
  return parseTriggerSignal({
    id: "signal:trace:1",
    kind: "event",
    source: "browser",
    event: "page",
    occurred_at: "2026-07-26T12:00:00.000Z",
    idempotency_key: "trace:1",
    evidence: [{ view_id: viewId, revision }],
    payload: { url: "https://github.com/openai/codex" },
  });
}

function viewDraft(id: string, schema: string, role: "raw" | "derived") {
  return {
    id,
    name: schema,
    purpose: "Automation trace test fixture",
    schema: { name: schema, version: 1, mode: "freeform" as const },
    role,
    time: { created_at: "2026-07-26T11:59:00.000Z" },
    representation: { form: "inline" as const, kind: "json", value: { id } },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" as const } },
    },
    provenance: {
      inputs: [],
      actor: "test",
      ...(role === "raw" ? {
        capture: {
          connector: "browser",
          connection_id: "browser:local",
          source_id: id,
          source_kind: schema,
          identity: "occurrence" as const,
          assertion: "direct" as const,
        },
      } : {}),
    },
    policy: viewPolicy(),
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

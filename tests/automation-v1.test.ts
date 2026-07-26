import test from "node:test";
import assert from "node:assert/strict";
import {
  AutomationRuntime,
  AutomationRuntimeError,
  AutomationContextResolutionError,
  AutomationValidationError,
  TriggerNotMatchedError,
  createTriggerOccurrence,
  matchTrigger,
  parseAutomationDefinition,
  parseAutomationView,
  parseTriggerSignal,
  type AutomationDeliveryRequest,
  type AutomationDeliveryResult,
  type AutomationOccurrenceRepository,
  type AutomationTargetRequest,
  type AutomationTraceEvent,
  type OccurrenceReservation,
} from "../packages/automation/index.ts";
import { parseView } from "@info/view";

function githubAutomation() {
  return parseAutomationDefinition({
    version: 1,
    enabled: true,
    trigger: {
      id: "github-summary",
      kind: "event",
      source: "chrome-extension",
      event: "browser.page_state",
      predicate: {
        type: "all",
        predicates: [
          { type: "field", path: "url", operator: "matches", value: "^https://github\\.com/[^/]+/[^/]+" },
          { type: "field", path: "dwell_ms", operator: "gte", value: 30000 },
        ],
      },
    },
    target: { kind: "transformation", transformation_id: "transformation.github.summary", revision: 3 },
    input_mapping: [
      {
        role: "current_page",
        required: true,
        sources: [
          { kind: "trigger_evidence", schema_name: "capture.browser.page_snapshot", source: "chrome-extension" },
        ],
      },
      {
        role: "current_project",
        required: false,
        sources: [{ kind: "view_query", schema_name: "project.current", limit: 1 }],
      },
    ],
    delivery: [
      { surface: "browser", urgency: "glance", expires_after_ms: 120000, actions: ["accept", "dismiss", "later"] },
    ],
    limits: { dedupe_window_ms: 90000, cooldown_ms: 90000, max_concurrency: 1, timeout_ms: 60000 },
  });
}

function automationView(definition = githubAutomation()) {
  return parseAutomationView(parseView({
    id: "automation:github-summary",
    revision: 2,
    name: "Summarize GitHub repositories",
    purpose: "Run the GitHub summary Transformation from declared browser evidence",
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
    time: { created_at: "2026-07-26T08:00:00.000Z" },
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

function githubSignal() {
  return parseTriggerSignal({
    id: "signal:github:1",
    kind: "event",
    source: "chrome-extension",
    event: "browser.page_state",
    occurred_at: "2026-07-26T08:01:00.000Z",
    idempotency_key: "tab:42:navigation:7",
    evidence: [{ view_id: "view:browser:github", revision: 4 }],
    payload: { url: "https://github.com/openai/codex", dwell_ms: 31000 },
  });
}

const emptyContextResolver = {
  async resolve() {
    return { bindings: [], disclosed_views: [], attempts: [] };
  },
};

test("Automation View is an exact derived View with a strict Automation representation", () => {
  const parsed = automationView();
  assert.equal(parsed.view.revision, 2);
  assert.equal(parsed.definition.target.kind, "transformation");
  if (parsed.definition.target.kind === "transformation") {
    assert.deepEqual(parsed.definition.target, {
      kind: "transformation",
      transformation_id: "transformation.github.summary",
      revision: 3,
    });
  }
  assert.equal(parsed.definition.input_mapping[0]?.sources[0]?.kind, "trigger_evidence");
});

test("Automation contracts reject invalid regex, timezone, and non-exact targets", () => {
  assert.throws(() => parseAutomationDefinition({
    version: 1,
    trigger: {
      id: "bad-regex",
      kind: "event",
      source: "browser",
      event: "page",
      predicate: { type: "field", path: "url", operator: "matches", value: "[" },
    },
    target: { kind: "transformation", transformation_id: "summary", revision: 1 },
  }), AutomationValidationError);

  assert.throws(() => parseAutomationDefinition({
    version: 1,
    trigger: {
      id: "bad-timezone",
      kind: "schedule",
      source: "scheduler",
      event: "daily",
      schedule: { format: "cron", expression: "0 21 * * *", timezone: "Mars/Olympus" },
    },
    target: { kind: "operation", name: "summary.daily", version: 1 },
  }), AutomationValidationError);

  assert.throws(() => parseAutomationDefinition({
    version: 1,
    trigger: { id: "missing-revision", kind: "user", source: "mac", event: "push_to_talk" },
    target: { kind: "transformation", transformation_id: "ambient.ask" },
  }), AutomationValidationError);
});

test("GitHub event matching is deterministic and creates an exact occurrence", () => {
  const definition = githubAutomation();
  const signal = githubSignal();

  assert.deepEqual(matchTrigger(definition.trigger, signal), {
    matched: true,
    reason: "source, event, and predicate matched",
  });

  const occurrence = createTriggerOccurrence({
    automation: { view_id: "automation:github-summary", revision: 2 },
    definition,
    signal,
  });
  assert.equal(occurrence.automation.revision, 2);
  assert.equal(occurrence.evidence[0]?.revision, 4);
  assert.match(occurrence.idempotency_key, /tab:42:navigation:7$/);
});

test("A non-matching Trigger cannot be converted into an occurrence", () => {
  const definition = githubAutomation();
  const signal = parseTriggerSignal({
    id: "signal:docs:1",
    kind: "event",
    source: "chrome-extension",
    event: "browser.page_state",
    occurred_at: "2026-07-26T08:01:00.000Z",
    idempotency_key: "tab:42:navigation:8",
    evidence: [{ view_id: "view:browser:docs", revision: 1 }],
    payload: { url: "https://example.com/docs", dwell_ms: 31000 },
  });
  assert.throws(() => createTriggerOccurrence({
    automation: { view_id: "automation:github-summary", revision: 2 },
    definition,
    signal,
  }), TriggerNotMatchedError);
});

test("Accumulation Triggers require an explicit numeric count at threshold", () => {
  const definition = parseAutomationDefinition({
    version: 1,
    trigger: {
      id: "session-ended",
      kind: "accumulation",
      source: "activity-runtime",
      event: "activity.window",
      window_ms: 300000,
      threshold: 5,
    },
    target: { kind: "operation", name: "activity.summarize", version: 1 },
  });
  const below = parseTriggerSignal({
    id: "signal:activity:1",
    kind: "accumulation",
    source: "activity-runtime",
    event: "activity.window",
    occurred_at: "2026-07-26T08:05:00.000Z",
    idempotency_key: "activity:window:1",
    payload: { count: 4 },
  });
  const reached = parseTriggerSignal({ ...below, id: "signal:activity:2", idempotency_key: "activity:window:2", payload: { count: 5 } });
  assert.equal(matchTrigger(definition.trigger, below).matched, false);
  assert.equal(matchTrigger(definition.trigger, reached).matched, true);
});

class MemoryOccurrenceRepository implements AutomationOccurrenceRepository {
  readonly entries = new Map<string, { correlation_id: string; status: "reserved" | "succeeded" | "failed" }>();

  async reserve(input: { idempotency_key: string; correlation_id: string }): Promise<OccurrenceReservation> {
    const existing = this.entries.get(input.idempotency_key);
    if (existing) return { created: false, reason: "duplicate", ...existing };
    this.entries.set(input.idempotency_key, { correlation_id: input.correlation_id, status: "reserved" });
    return { created: true };
  }

  async finalize(input: {
    idempotency_key: string;
    correlation_id: string;
    status: "succeeded" | "failed";
  }): Promise<void> {
    const existing = this.entries.get(input.idempotency_key);
    assert.ok(existing, "finalize requires a reservation");
    assert.equal(existing.correlation_id, input.correlation_id);
    this.entries.set(input.idempotency_key, { correlation_id: input.correlation_id, status: input.status });
  }
}

test("Automation Runtime reserves once, invokes the target, delivers progress/result, and traces every stage", async () => {
  const definition = parseAutomationDefinition({
    ...githubAutomation(),
    delivery: [{
      surface: "browser",
      urgency: "glance",
      show_progress: true,
      expires_after_ms: 120000,
      actions: ["accept", "dismiss", "cancel"],
    }],
  });
  const events: AutomationTraceEvent[] = [];
  const deliveries: AutomationDeliveryRequest[] = [];
  const targetRequests: AutomationTargetRequest[] = [];
  const occurrences = new MemoryOccurrenceRepository();
  const runtime = new AutomationRuntime({
    occurrences,
    context: emptyContextResolver,
    events: { emit: event => { events.push(event); } },
    target: {
      async execute(request, execution) {
        targetRequests.push(request);
        await execution.progress({
          run_id: "run:github:1",
          views: [{ view_id: "view:github:progress", revision: 2 }],
        });
        return {
          status: "succeeded",
          run_id: "run:github:1",
          output_views: [{ view_id: "view:github:summary", revision: 1 }],
        };
      },
    },
    delivery: {
      async deliver(request) {
        deliveries.push(request);
        return { status: "delivered", delivery_id: `delivered:${request.id}` };
      },
    },
    now: () => new Date("2026-07-26T08:01:01.000Z"),
  });

  const first = await runtime.invoke({ automation: automationView(definition), signal: githubSignal() });
  assert.equal(first.status, "succeeded");
  assert.equal(targetRequests.length, 1);
  assert.equal(targetRequests[0]?.occurrence.evidence[0]?.revision, 4);
  assert.equal(targetRequests[0]?.target.kind, "transformation");
  assert.deepEqual(deliveries.map(item => item.phase), ["accepted", "progress", "result"]);
  assert.deepEqual(deliveries[1]?.views, [{ view_id: "view:github:progress", revision: 2 }]);
  assert.deepEqual(events.map(event => event.type), [
    "automation.occurrence_received",
    "automation.occurrence_reserved",
    "automation.delivery_attempted",
    "automation.delivery_succeeded",
    "automation.context_resolved",
    "automation.run_started",
    "automation.run_progress",
    "automation.delivery_attempted",
    "automation.delivery_succeeded",
    "automation.result_committed",
    "automation.delivery_attempted",
    "automation.delivery_succeeded",
    "automation.occurrence_completed",
  ]);

  const duplicate = await runtime.invoke({ automation: automationView(definition), signal: githubSignal() });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(targetRequests.length, 1);
  assert.equal(events.at(-1)?.type, "automation.occurrence_deduped");
});

test("Structured target failure remains a failed Run with a Failure View and separate delivery", async () => {
  const events: AutomationTraceEvent[] = [];
  const deliveries: AutomationDeliveryRequest[] = [];
  const occurrences = new MemoryOccurrenceRepository();
  const runtime = new AutomationRuntime({
    occurrences,
    context: emptyContextResolver,
    events: { emit: event => { events.push(event); } },
    target: {
      async execute() {
        return {
          status: "failed",
          run_id: "run:github:failed",
          failure_view: { view_id: "view:failure:github", revision: 1 },
          failure: {
            stage: "validation",
            code: "output_contract_rejected",
            message: "Agent output failed Schema validation",
          },
        };
      },
    },
    delivery: {
      async deliver(request) {
        deliveries.push(request);
        return { status: "delivered", delivery_id: `delivered:${request.id}` };
      },
    },
  });

  const result = await runtime.invoke({ automation: automationView(), signal: githubSignal() });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.failure_view.view_id, "view:failure:github");
  assert.deepEqual(deliveries.map(item => item.phase), ["failure"]);
  assert.equal(events.some(event => event.type === "automation.execution_failed"), true);
  assert.equal(occurrences.entries.values().next().value?.status, "failed");
});

test("Delivery failure is explicit but does not rewrite successful execution", async () => {
  const events: AutomationTraceEvent[] = [];
  const runtime = new AutomationRuntime({
    occurrences: new MemoryOccurrenceRepository(),
    context: emptyContextResolver,
    events: { emit: event => { events.push(event); } },
    target: {
      async execute() {
        return { status: "succeeded", run_id: "run:delivery:1", output_views: [{ view_id: "view:result", revision: 1 }] };
      },
    },
    delivery: {
      async deliver(): Promise<AutomationDeliveryResult> {
        throw new Error("notch process unavailable");
      },
    },
  });
  const result = await runtime.invoke({ automation: automationView(), signal: githubSignal() });
  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.equal(result.deliveries[0]?.result.status, "failed");
    assert.match(result.deliveries[0]?.result.status === "failed" ? result.deliveries[0].result.error : "", /notch process unavailable/);
  }
  assert.equal(events.some(event => event.type === "automation.delivery_failed"), true);
});

test("non-delivered surface outcomes keep a successful Run and emit distinct traces", async () => {
  const cases: Array<{
    result: AutomationDeliveryResult;
    event: AutomationTraceEvent["type"];
  }> = [
    { result: { status: "expired", expired_at: "2026-07-26T08:01:01.000Z" }, event: "automation.delivery_expired" },
    { result: { status: "suppressed", reason: "surface_occupied", active_request_id: "request:active" }, event: "automation.delivery_suppressed" },
    { result: { status: "unavailable", error: "browser surface unavailable" }, event: "automation.delivery_unavailable" },
  ];

  for (const item of cases) {
    const events: AutomationTraceEvent[] = [];
    const runtime = new AutomationRuntime({
      occurrences: new MemoryOccurrenceRepository(),
      context: emptyContextResolver,
      events: { emit: event => { events.push(event); } },
      target: {
        async execute() {
          return { status: "succeeded", run_id: `run:${item.result.status}`, output_views: [{ view_id: "view:result", revision: 1 }] };
        },
      },
      delivery: { deliver: async () => item.result },
    });
    const result = await runtime.invoke({ automation: automationView(), signal: githubSignal() });
    assert.equal(result.status, "succeeded", item.result.status);
    assert.equal(events.some(event => event.type === item.event), true, item.result.status);
    assert.equal(events.some(event => event.type === "automation.execution_failed"), false, item.result.status);
  }
});

test("Unstructured target crashes fail the reservation and throw an observable runtime error", async () => {
  const events: AutomationTraceEvent[] = [];
  const occurrences = new MemoryOccurrenceRepository();
  const runtime = new AutomationRuntime({
    occurrences,
    context: emptyContextResolver,
    events: { emit: event => { events.push(event); } },
    target: { execute: async () => { throw new Error("execution transport crashed"); } },
    delivery: { deliver: async () => ({ status: "delivered", delivery_id: "unused" }) },
  });

  await assert.rejects(
    runtime.invoke({ automation: automationView(), signal: githubSignal() }),
    (error: unknown) => error instanceof AutomationRuntimeError && error.code === "target_execution_failed",
  );
  assert.equal(events.at(-1)?.type, "automation.runtime_failed");
  assert.equal(occurrences.entries.values().next().value?.status, "failed");
});

test("Disabled Automations are ignored before reservation or target execution", async () => {
  const events: AutomationTraceEvent[] = [];
  let reserved = false;
  const definition = parseAutomationDefinition({ ...githubAutomation(), enabled: false });
  const runtime = new AutomationRuntime({
    occurrences: {
      async reserve() { reserved = true; return { created: true }; },
      async finalize() { throw new Error("disabled Automation must not finalize"); },
    },
    context: emptyContextResolver,
    events: { emit: event => { events.push(event); } },
    target: { execute: async () => { throw new Error("disabled Automation must not execute"); } },
    delivery: { deliver: async () => { throw new Error("disabled Automation must not deliver"); } },
  });
  const result = await runtime.invoke({ automation: automationView(definition), signal: githubSignal() });
  assert.deepEqual(result, { status: "ignored", reason: "Automation is disabled" });
  assert.equal(reserved, false);
  assert.deepEqual(events.map(event => event.type), ["automation.occurrence_ignored"]);
});

test("Cooldown and concurrency reservations are explicit skipped results", async () => {
  for (const reason of ["cooldown", "concurrency"] as const) {
    const events: AutomationTraceEvent[] = [];
    const runtime = new AutomationRuntime({
      occurrences: {
        async reserve() {
          return { created: false, reason, correlation_id: `existing:${reason}`, status: "reserved" };
        },
        async finalize() { throw new Error("rejected occurrence must not finalize"); },
      },
      context: emptyContextResolver,
      events: { emit: event => { events.push(event); } },
      target: { execute: async () => { throw new Error("rejected occurrence must not execute"); } },
      delivery: { deliver: async () => { throw new Error("rejected occurrence must not deliver"); } },
    });
    const result = await runtime.invoke({ automation: automationView(), signal: githubSignal() });
    assert.deepEqual(result, {
      status: "skipped",
      reason,
      correlation_id: `existing:${reason}`,
      existing_status: "reserved",
    });
    assert.equal(events.at(-1)?.type, "automation.occurrence_rejected");
  }
});

test("Required context failure stops before target execution and finalizes the occurrence as failed", async () => {
  const events: AutomationTraceEvent[] = [];
  const occurrences = new MemoryOccurrenceRepository();
  let executed = false;
  const runtime = new AutomationRuntime({
    occurrences,
    context: {
      async resolve() {
        throw new AutomationContextResolutionError(
          "required context is missing for role: current_page",
          "required_context_missing",
          "current_page",
          [],
        );
      },
    },
    events: { emit: event => { events.push(event); } },
    target: { execute: async () => { executed = true; throw new Error("must not execute"); } },
    delivery: { deliver: async () => ({ status: "delivered", delivery_id: "progress:1" }) },
  });

  await assert.rejects(
    runtime.invoke({ automation: automationView(), signal: githubSignal() }),
    (error: unknown) => error instanceof AutomationRuntimeError && error.code === "context_resolution_failed",
  );
  assert.equal(executed, false);
  assert.equal(events.at(-1)?.type, "automation.context_failed");
  assert.equal(occurrences.entries.values().next().value?.status, "failed");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationContextResolver,
  AutomationRuntime,
  InMemoryAutomationTraceStore,
  type AutomationDefinition,
  type AutomationInvocationInput,
  type AutomationInvocationPredicateMatch,
  type AutomationInvocationResult,
  type AutomationOccurrenceRepository,
  type AutomationTargetRequest,
  type OccurrenceReservation,
  type ParsedAutomationView,
  type ReactiveCascadeAttemptRecord,
  type ReactiveCascadeLedger,
  type TriggerPredicate,
} from "../packages/automation/index.ts";
import {
  CommittedViewTriggerAdapter,
  CommittedViewTriggerError,
  VIEW_COMMITTED_TRIGGER_EVENT,
  VIEW_COMMITTED_TRIGGER_SOURCE,
  buildViewCommittedTriggerSignal,
  type CommittedViewTriggerEvent,
} from "../packages/adapters/committed-view-trigger/index.ts";
import {
  parseView,
  parseViewCommittedEvent,
  ViewCommittedOutboxDispatcher,
  type ExactViewRef,
  type View,
  type ViewCommittedEvent,
  type ViewDraft,
  type ViewQuery,
  type ReactiveCascadePolicySnapshot,
} from "../packages/view/index.ts";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";
import {
  SqliteAutomationOccurrenceRepository,
  SqliteAutomationTraceStore,
} from "../packages/adapters/automation-sqlite/index.ts";

const NOW = "2026-07-26T16:00:00.000Z";

const TEST_CASCADE_POLICY: ReactiveCascadePolicySnapshot = {
  id: "policy:test:reactive-cascade",
  revision: 1,
  limits: {
    max_depth: 8,
    max_fan_out: 100,
    max_total_attempts: 1_000,
    max_total_cost_usd: 100,
    max_elapsed_ms: 3_600_000,
    max_operator_concurrency: 100,
    reservation_lease_ms: 300_000,
  },
};

class MemoryCascadeLedger implements ReactiveCascadeLedger {
  private readonly attempts = new Map<string, ReactiveCascadeAttemptRecord>();

  async reservePlan(input: Parameters<ReactiveCascadeLedger["reservePlan"]>[0]) {
    const existing = input.attempts.map(attempt => this.attempts.get(attempt.attempt_id));
    if (existing.every(Boolean)) return { outcome: "duplicate" as const, attempts: existing as ReactiveCascadeAttemptRecord[] };
    const records = input.attempts.map(context => ({
      context,
      status: "reserved" as const,
      request_fingerprint: context.attempt_id,
      reserved_at: input.reserved_at,
      lease_expires_at: new Date(Date.parse(input.reserved_at) + context.policy.limits.reservation_lease_ms).toISOString(),
      updated_at: input.reserved_at,
      cost_usd: 0,
    }));
    records.forEach(record => this.attempts.set(record.context.attempt_id, record));
    return { outcome: "created" as const, attempts: records };
  }

  async bindOperator(input: Parameters<ReactiveCascadeLedger["bindOperator"]>[0]) {
    const current = await this.mustGet(input.attempt_id);
    const record: ReactiveCascadeAttemptRecord = {
      ...current,
      context: { ...current.context, target: { ...current.context.target, operator: input.operator } },
      status: "running",
      run_id: input.run_id,
      updated_at: input.started_at,
    };
    this.attempts.set(input.attempt_id, record);
    return record;
  }

  async finalize(input: Parameters<ReactiveCascadeLedger["finalize"]>[0]) {
    const current = await this.mustGet(input.attempt_id);
    const record: ReactiveCascadeAttemptRecord = {
      ...current,
      status: input.status,
      updated_at: input.completed_at,
      cost_usd: input.cost_usd,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.error_code ? { error_code: input.error_code } : {}),
      ...(input.error_message ? { error_message: input.error_message } : {}),
    };
    this.attempts.set(input.attempt_id, record);
    return record;
  }

  getAttempt(attemptId: string) { return Promise.resolve(this.attempts.get(attemptId)); }
  listRoot(root: string) { return Promise.resolve([...this.attempts.values()].filter(item => item.context.root_correlation_id === root)); }
  listEvents() { return Promise.resolve([]); }

  private async mustGet(attemptId: string): Promise<ReactiveCascadeAttemptRecord> {
    const record = this.attempts.get(attemptId);
    if (!record) throw new Error(`missing cascade attempt: ${attemptId}`);
    return record;
  }
}

function cascadeSafety() {
  return { cascades: new MemoryCascadeLedger(), cascade_policy: TEST_CASCADE_POLICY };
}

class MemoryViewReader {
  constructor(readonly values: View[]) {}

  async get(ref: ExactViewRef): Promise<View | undefined> {
    return this.values.find(view => view.id === ref.view_id && view.revision === ref.revision);
  }

  async query(query: ViewQuery = {}): Promise<View[]> {
    let selected = this.values.filter(view => (
      (query.schema_name === undefined || view.schema.name === query.schema_name)
      && (query.schema_names === undefined || query.schema_names.includes(view.schema.name))
      && (query.role === undefined || view.role === query.role)
    ));
    if (query.revisions === "latest") {
      const latest = new Map<string, View>();
      for (const view of selected) {
        const current = latest.get(view.id);
        if (!current || current.revision < view.revision) latest.set(view.id, view);
      }
      selected = [...latest.values()];
    }
    return selected.sort((left, right) => left.id.localeCompare(right.id)).slice(0, query.limit);
  }
}

class MemoryOccurrences implements AutomationOccurrenceRepository {
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
    assert.ok(existing);
    assert.equal(existing.correlation_id, input.correlation_id);
    this.entries.set(input.idempotency_key, { correlation_id: input.correlation_id, status: input.status });
  }
}

test("committed Raw and Derived Views match schema, source, Representation, relation, policy, and role predicates", async () => {
  const project = derivedView("view:project:metaflow", "project.current", { name: "Metaflow" });
  const raw = rawView("view:browser:codex", "capture.browser.page_snapshot", {
    title: "BuilderIO Agent Native for Codex",
    url: "https://github.com/BuilderIO/agent-native",
    text: "Agent-native tools expose one callable input/output boundary.",
  }, {
    relations: [{ type: "belongs_to", target: ref(project), metadata: {} }],
  });
  const derived = derivedView("view:summary:codex", "analysis.page_summary", {
    summary: "A normalized summary of the captured repository.",
  }, { inputs: [ref(raw)] });

  const complex = automationView("automation:complex", committedTrigger("complex", {
    type: "all",
    predicates: [
      field("view.schema.name", "eq", "capture.browser.page_snapshot"),
      field("view.source.connector", "eq", "browser"),
      field("view.representation.value.title", "contains", "Agent Native"),
      field("view.relation_types", "contains", "belongs_to"),
      field("view.policy.privacy", "eq", "private"),
      field("view.role", "eq", "raw"),
    ],
  }));
  const multiSchema = automationView("automation:multi-schema", committedTrigger("multi-schema", {
    type: "any",
    predicates: [
      field("view.schema.name", "eq", "capture.browser.page_snapshot"),
      field("view.schema.name", "eq", "analysis.page_summary"),
    ],
  }));
  const disabled = automationView("automation:disabled", {
    ...committedTrigger("disabled"),
    enabled: false,
  });
  const predicateFailure = automationView("automation:predicate-failure", committedTrigger("predicate-failure",
    field("view.schema.name", "eq", "capture.clipboard.item")));
  const unrelated = automationView("automation:user-trigger", {
    ...committedTrigger("user-trigger"),
    trigger: { id: "manual", kind: "user", source: "notch", event: "ask" },
  });
  const reader = new MemoryViewReader([project, raw, derived, complex.view, multiSchema.view, disabled.view, predicateFailure.view, unrelated.view]);
  const calls: Array<{
    automation: ParsedAutomationView;
    signalId: string;
    evidence: ExactViewRef[];
    payload: Record<string, unknown>;
    predicateMatch?: AutomationInvocationPredicateMatch;
  }> = [];
  const events: CommittedViewTriggerEvent[] = [];
  const adapter = new CommittedViewTriggerAdapter({
    views: reader,
    ...cascadeSafety(),
    events: { emit: event => { events.push(event); } },
    invocations: {
      async invoke({ automation, signal, predicate_match }) {
        calls.push({
          automation,
          signalId: signal.id,
          evidence: signal.evidence,
          payload: signal.payload,
          predicateMatch: predicate_match,
        });
        if (automation.view.id === "automation:complex") {
          return {
            status: "enqueued",
            correlation_id: `correlation:${automation.view.id}:${signal.id}`,
            receipt_id: `receipt:${signal.id}`,
          };
        }
        return succeededInvocation(automation, signal.id);
      },
    },
    now: () => new Date(NOW),
  });

  const rawReport = await adapter.dispatch(commitEvent(raw, "event:raw"));
  assert.deepEqual(calls.map(call => call.automation.view.id), ["automation:complex", "automation:multi-schema"]);
  assert.equal(rawReport.outcomes.filter(event => event.outcome === "matched").length, 2);
  assert.equal(rawReport.outcomes.filter(event => event.outcome === "enqueued").length, 2);
  assert.equal(rawReport.outcomes.some(event => event.details.receipt_id === `receipt:${calls[0]?.signalId}`), true);
  assert.equal(rawReport.outcomes.some(event => event.automation?.view_id === "automation:disabled" && event.reason === "Automation is disabled"), true);
  assert.equal(rawReport.outcomes.some(event => event.automation?.view_id === "automation:predicate-failure" && event.reason === "predicate did not match"), true);
  assert.deepEqual(calls[0]?.evidence, [ref(raw)]);
  assert.equal(calls[0]?.predicateMatch?.trigger_id, "complex");
  assert.equal(JSON.stringify(calls[0]?.payload).includes("BuilderIO Agent Native"), false);

  const publicSignal = buildViewCommittedTriggerSignal(commitEvent(raw, "event:projection"), raw);
  assert.deepEqual((publicSignal.payload.view as { representation: { access: string } }).representation, {
    form: "inline",
    kind: "capture.browser.page_snapshot",
    access: "descriptor",
  });

  const derivedReport = await adapter.dispatch(commitEvent(derived, "event:derived"));
  assert.equal(derivedReport.outcomes.some(event => event.outcome === "matched" && event.automation?.view_id === "automation:multi-schema"), true);
  assert.equal(calls.filter(call => call.automation.view.id === "automation:multi-schema").length, 2);
  assert.equal(calls.at(-1)?.evidence[0]?.view_id, derived.id);
  assert.equal(events.every(event => event.source_event_id === "event:raw" || event.source_event_id === "event:derived"), true);
});

test("duplicate ViewCommitted delivery reuses the exact Automation occurrence and executes the target once", async () => {
  const raw = rawView("view:clipboard:1", "capture.clipboard.item", { text: "Summarize this" });
  const automation = automationView("automation:clipboard-summary", committedTrigger("clipboard-summary",
    field("view.schema.name", "eq", "capture.clipboard.item")));
  const views = new MemoryViewReader([raw, automation.view]);
  const occurrences = new MemoryOccurrences();
  const cascade = cascadeSafety();
  let targetCalls = 0;
  const runtime = new AutomationRuntime({
    occurrences,
    context: { async resolve() { return { bindings: [], disclosed_views: [], attempts: [] }; } },
    target: {
      async execute() {
        targetCalls += 1;
        return { status: "succeeded", run_id: "run:clipboard:1", output_views: [{ view_id: "view:summary:1", revision: 1 }] };
      },
    },
    delivery: { async deliver() { return { status: "delivered", delivery_id: "delivery:none" }; } },
    events: new InMemoryAutomationTraceStore(() => new Date(NOW)),
    cascades: cascade.cascades,
    now: () => new Date(NOW),
  });
  const bridgeEvents: CommittedViewTriggerEvent[] = [];
  const adapter = new CommittedViewTriggerAdapter({
    views,
    ...cascade,
    invocations: runtime,
    events: { emit: event => { bridgeEvents.push(event); } },
    now: () => new Date(NOW),
  });
  const event = commitEvent(raw, "event:duplicate");

  const first = await adapter.dispatch(event);
  const second = await adapter.dispatch(event);

  assert.equal(targetCalls, 1);
  assert.equal(first.outcomes.some(outcome => outcome.outcome === "enqueued"), true);
  assert.equal(second.outcomes.some(outcome => outcome.outcome === "ignored" && outcome.reason.includes("already admitted")), true);
  const signals = bridgeEvents.filter(outcome => outcome.signal_id).map(outcome => outcome.signal_id);
  assert.equal(new Set(signals).size, 1);
  assert.equal(occurrences.entries.size, 1);
});

test("prevalidated content matches are bound to exact Automation revision, predicate, trigger, signal, and structure", async () => {
  const raw = rawView("view:proof:raw", "capture.clipboard.item", { text: "secret" });
  const definitionA = committedTrigger("shared-trigger",
    field("view.representation.value.text", "eq", "secret"));
  const automationA = automationView("automation:proof", definitionA);
  const proofCascade = cascadeSafety();
  let admitted: AutomationInvocationInput | undefined;
  const adapter = new CommittedViewTriggerAdapter({
    views: new MemoryViewReader([raw, automationA.view]),
    ...proofCascade,
    invocations: {
      async invoke(input) {
        admitted = input;
        return succeededInvocation(input.automation, input.signal.id);
      },
    },
    events: { emit() {} },
    now: () => new Date(NOW),
  });
  await adapter.dispatch(commitEvent(raw, "event:proof"));
  assert.ok(admitted);
  assert.ok(admitted.predicate_match);
  const proof = admitted.predicate_match;
  const signal = admitted.signal;

  let targetCalls = 0;
  const runtime = new AutomationRuntime({
    occurrences: new MemoryOccurrences(),
    context: { async resolve() { return { bindings: [], disclosed_views: [], attempts: [] }; } },
    target: {
      async execute() {
        targetCalls += 1;
        return { status: "succeeded", run_id: "run:proof", output_views: [{ view_id: "view:proof:output", revision: 1 }] };
      },
    },
    delivery: { async deliver() { return { status: "delivered", delivery_id: "delivery:proof" }; } },
    events: new InMemoryAutomationTraceStore(() => new Date(NOW)),
    cascades: proofCascade.cascades,
    now: () => new Date(NOW),
  });
  const definitionB = committedTrigger("shared-trigger",
    field("view.representation.value.text", "eq", "different"));
  const automationB = automationView("automation:other", definitionB);
  const automationRevision2 = automationView("automation:proof", definitionB, 2);
  const predicateTampered = { view: automationA.view, definition: definitionB };

  await assert.rejects(
    runtime.invoke({ automation: automationB, signal, predicate_match: proof }),
    /prevalidated predicate Automation mismatch/,
  );
  await assert.rejects(
    runtime.invoke({ automation: automationRevision2, signal, predicate_match: proof }),
    /prevalidated predicate Automation mismatch/,
  );
  await assert.rejects(
    runtime.invoke({ automation: predicateTampered, signal, predicate_match: proof }),
    /prevalidated predicate digest mismatch/,
  );
  await assert.rejects(
    runtime.invoke({
      automation: automationA,
      signal,
      predicate_match: { ...proof, trigger_id: "wrong-trigger" },
    }),
    /prevalidated predicate trigger mismatch/,
  );
  await assert.rejects(
    runtime.invoke({
      automation: automationA,
      signal,
      predicate_match: { ...proof, signal_id: "wrong-signal" },
    }),
    /prevalidated predicate signal mismatch/,
  );
  const structurallyWrong = await runtime.invoke({
    automation: automationA,
    signal: { ...signal, source: "other.source" },
    predicate_match: proof,
  });
  assert.deepEqual(structurallyWrong, { status: "ignored", reason: "source mismatch: other.source" });
  assert.equal(targetCalls, 0);
});

test("the transactional View outbox recursively triggers Raw-to-Derived Automation without source controllers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-committed-view-trigger-"));
  const views = new SqliteViewRepository(join(directory, "views.sqlite"), { now: () => NOW });
  try {
    const automation = automationView("automation:outbox", committedTrigger("outbox",
      field("view.schema.name", "eq", "capture.clipboard.item")));
    const derivedAutomation = automationView("automation:outbox-derived", committedTrigger("outbox-derived",
      field("view.schema.name", "eq", "analysis.page_summary")));
    const raw = rawView("view:outbox:clipboard", "capture.clipboard.item", { text: "A real outbox event" });
    await views.commit({ draft: draftOf(automation.view), expected_revision: 0 }, {
      batch_id: "batch:automation-setup",
      origin: { kind: "operation", id: "operation:automation-setup" },
    });
    await views.commit({ draft: draftOf(derivedAutomation.view), expected_revision: 0 }, {
      batch_id: "batch:derived-automation-setup",
      origin: { kind: "operation", id: "operation:derived-automation-setup" },
    });
    await views.commit({ draft: draftOf(raw), expected_revision: 0 }, {
      batch_id: "batch:clipboard-capture",
      origin: { kind: "capture", id: "capture:clipboard" },
    });

    const occurrences = new MemoryOccurrences();
    const cascade = cascadeSafety();
    let targetCalls = 0;
    const runtime = new AutomationRuntime({
      occurrences,
      context: { async resolve() { return { bindings: [], disclosed_views: [], attempts: [] }; } },
      target: {
        async execute(request) {
          targetCalls += 1;
          if (request.automation.view_id === automation.view.id) {
            const summary = derivedView("view:outbox:summary", "analysis.page_summary", { summary: "A derived outbox result" }, {
              inputs: [ref(raw)],
            });
            await views.commit({ draft: draftOf(summary), expected_revision: 0 }, {
              batch_id: "batch:derived-summary",
              origin: { kind: "execution", id: "run:outbox:raw" },
            });
            return { status: "succeeded", run_id: "run:outbox:raw", output_views: [ref(summary)] };
          }
          return {
            status: "succeeded",
            run_id: "run:outbox:derived",
            output_views: [{ view_id: "view:outbox:learning", revision: 1 }],
          };
        },
      },
      delivery: { async deliver() { return { status: "delivered", delivery_id: "delivery:outbox" }; } },
      events: new InMemoryAutomationTraceStore(() => new Date(NOW)),
      cascades: cascade.cascades,
      now: () => new Date(NOW),
    });
    const trigger = new CommittedViewTriggerAdapter({
      views,
      ...cascade,
      invocations: runtime,
      events: { emit() {} },
      now: () => new Date(NOW),
    });
    const dispatcher = new ViewCommittedOutboxDispatcher({
      outbox: views,
      publisher: { publish: event => trigger.handle(event) },
      consumer_id: "committed-view-trigger-test",
      now: () => NOW,
    });

    const first = await dispatcher.dispatch({ limit: 10 });
    const recursive = await dispatcher.dispatch({ limit: 10 });
    assert.equal(first.leased, 3);
    assert.equal(first.acknowledged.length, 3);
    assert.equal(recursive.leased, 1);
    assert.equal(recursive.acknowledged.length, 1);
    assert.equal(targetCalls, 2);
    assert.equal(occurrences.entries.size, 2);
    assert.equal((await views.listEvents({ statuses: ["acknowledged"] })).length, 4);
  } finally {
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("policy and normal context authorization deny evidence without invoking a Worker", async () => {
  const locallyDenied = rawView("view:sensitive:local", "capture.browser.page_snapshot", { title: "Private" }, {
    allowLocalSearch: false,
  });
  const representationAutomation = automationView("automation:representation", committedTrigger("representation",
    field("view.representation.value.title", "eq", "Private")));
  const descriptorAutomation = automationView("automation:representation-descriptor", committedTrigger("representation-descriptor",
    field("view.representation.kind", "eq", "capture.browser.page_snapshot")));
  const reader = new MemoryViewReader([locallyDenied, representationAutomation.view, descriptorAutomation.view]);
  let calls = 0;
  const adapter = new CommittedViewTriggerAdapter({
    views: reader,
    ...cascadeSafety(),
    invocations: {
      async invoke({ automation, signal }) {
        calls += 1;
        return succeededInvocation(automation, signal.id);
      },
    },
    events: { emit() {} },
    now: () => new Date(NOW),
  });
  const localReport = await adapter.dispatch(commitEvent(locallyDenied, "event:local-deny"));
  assert.equal(calls, 1);
  assert.equal(localReport.outcomes.some(event => event.outcome === "denied" && event.details.policy_constraint === "allow_local_search"), true);
  assert.equal(localReport.outcomes.some(event => event.outcome === "enqueued" && event.automation?.view_id === descriptorAutomation.view.id), true);

  const contextDenied = rawView("view:sensitive:context", "capture.clipboard.item", { text: "secret" });
  const contextAutomation = automationView("automation:context-deny", {
    ...committedTrigger("context-deny", field("view.representation.value.text", "eq", "secret")),
    input_mapping: [{ role: "evidence", required: true, sources: [{ kind: "trigger_evidence" }] }],
  });
  const contextViews = new MemoryViewReader([contextDenied, contextAutomation.view]);
  const contextDirectory = mkdtempSync(join(tmpdir(), "metaflow-trigger-privacy-"));
  const occurrences = new SqliteAutomationOccurrenceRepository(join(contextDirectory, "automation.sqlite"));
  const traces = new SqliteAutomationTraceStore(join(contextDirectory, "automation.sqlite"));
  const contextCascade = cascadeSafety();
  let deniedTargetRequest: AutomationTargetRequest | undefined;
  const runtime = new AutomationRuntime({
    occurrences,
    context: new AutomationContextResolver({
      views: contextViews,
      authorizer: {
        async authorize({ view }) {
          return { allowed: false, decision_id: `deny:${view.id}`, reason: "explicit View access deny" };
        },
      },
    }),
    target: {
      async execute(request) {
        deniedTargetRequest = request;
        assert.equal(request.pre_execution_failure?.code, "view_access_denied");
        assert.deepEqual(request.context.bindings[0]?.views.map(ref), [ref(contextDenied)]);
        return {
          status: "failed",
          run_id: "run:context-deny",
          failure_view: { view_id: "view:failure:context-deny", revision: 1 },
          failure: {
            stage: "authorization",
            code: "pre_execution_failed",
            message: request.pre_execution_failure?.message ?? "context denied",
          },
        };
      },
    },
    delivery: { async deliver() { return { status: "delivered", delivery_id: "unused" }; } },
    events: traces,
    cascades: contextCascade.cascades,
    now: () => new Date(NOW),
  });
  const contextAdapter = new CommittedViewTriggerAdapter({
    views: contextViews,
    ...contextCascade,
    invocations: runtime,
    events: { emit() {} },
    now: () => new Date(NOW),
  });
  try {
    const contextEvent = commitEvent(contextDenied, "event:context-deny");
    const contextReport = await contextAdapter.dispatch(contextEvent);
    assert.equal(contextReport.outcomes.some(event => (
      event.outcome === "failed"
      && event.stage === "invocation"
      && event.details.failure_stage === "authorization"
    )), true);
    assert.ok(deniedTargetRequest, "context denial must reach the target boundary to create canonical Failure evidence");

    const signal = buildViewCommittedTriggerSignal(contextEvent, contextDenied);
    const key = [
      contextAutomation.view.id,
      contextAutomation.view.revision,
      contextAutomation.definition.trigger.id,
      signal.idempotency_key,
    ].join(":");
    const stored = occurrences.inspect(key);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes("secret"), false);
    const trace = await traces.query({ correlation_id: stored.correlation_id });
    assert.equal(JSON.stringify(trace).includes("secret"), false);
    assert.equal(stored.occurrence.payload.view !== undefined, true);
  } finally {
    traces.close();
    occurrences.close();
    rmSync(contextDirectory, { recursive: true, force: true });
  }
});

test("zero matches, bounded predicate failure, and trace persistence are explicit", async () => {
  const raw = rawView("view:screen:1", "capture.screenpipe.ocr", { text: "Terminal" });
  const noAutomationEvents: CommittedViewTriggerEvent[] = [];
  const emptyAdapter = new CommittedViewTriggerAdapter({
    views: new MemoryViewReader([raw]),
    ...cascadeSafety(),
    invocations: { async invoke() { assert.fail("no Automation should be invoked"); } },
    events: { emit: event => { noAutomationEvents.push(event); } },
    now: () => new Date(NOW),
  });
  const empty = await emptyAdapter.dispatch(commitEvent(raw, "event:zero"));
  assert.equal(empty.outcomes.length, 1);
  assert.equal(empty.outcomes[0]?.outcome, "ignored");
  assert.equal(empty.outcomes[0]?.reason, "no Automation Views are available");

  const secondRaw = rawView("view:screen:2", "capture.screenpipe.ocr", { text: "Editor" });
  const oversizedEvent = parseViewCommittedEvent({
    ...commitEvent(raw, "event:oversized"),
    views: [
      commitEvent(raw, "event:oversized-a").views[0],
      commitEvent(secondRaw, "event:oversized-b").views[0],
    ],
  });
  const oversizedOutcomes: CommittedViewTriggerEvent[] = [];
  const boundedEventAdapter = new CommittedViewTriggerAdapter({
    views: new MemoryViewReader([raw, secondRaw]),
    ...cascadeSafety(),
    invocations: { async invoke() { assert.fail("oversized event must not invoke"); } },
    events: { emit: event => { oversizedOutcomes.push(event); } },
    max_event_views: 1,
    now: () => new Date(NOW),
  });
  await assert.rejects(
    boundedEventAdapter.dispatch(oversizedEvent),
    (error: unknown) => error instanceof CommittedViewTriggerError && error.code === "event_bound_exceeded",
  );
  assert.equal(oversizedOutcomes[0]?.outcome, "failed");
  assert.equal(oversizedOutcomes[0]?.details.view_count, 2);

  const regexAutomation = automationView("automation:regex", committedTrigger("regex", {
    type: "field",
    path: "view.representation.value.text",
    operator: "matches",
    value: "(a+)+$",
  }));
  const boundedEvents: CommittedViewTriggerEvent[] = [];
  const bounded = new CommittedViewTriggerAdapter({
    views: new MemoryViewReader([raw, regexAutomation.view]),
    ...cascadeSafety(),
    invocations: { async invoke() { assert.fail("unbounded predicate must not execute"); } },
    events: { emit: event => { boundedEvents.push(event); } },
    now: () => new Date(NOW),
  });
  await assert.rejects(
    bounded.dispatch(commitEvent(raw, "event:bounded")),
    (error: unknown) => error instanceof CommittedViewTriggerError
      && error.code === "dispatch_failed"
      && error.report?.outcomes.some(outcome => outcome.outcome === "failed") === true,
  );
  assert.equal(boundedEvents.some(event => event.reason.includes("regular-expression")), true);

  const largePredicateAutomation = automationView("automation:large-predicate", committedTrigger("large-predicate",
    field("view.schema.name", "eq", `capture.${"x".repeat(500)}`)));
  const largePredicateEvents: CommittedViewTriggerEvent[] = [];
  const byteBounded = new CommittedViewTriggerAdapter({
    views: new MemoryViewReader([raw, largePredicateAutomation.view]),
    ...cascadeSafety(),
    invocations: { async invoke() { assert.fail("oversized predicate must not execute"); } },
    events: { emit: event => { largePredicateEvents.push(event); } },
    max_predicate_bytes: 128,
    now: () => new Date(NOW),
  });
  await assert.rejects(
    byteBounded.dispatch(commitEvent(raw, "event:predicate-bytes")),
    (error: unknown) => error instanceof CommittedViewTriggerError && error.code === "dispatch_failed",
  );
  assert.equal(largePredicateEvents.some(event => event.reason.includes("predicate requires") && event.reason.includes("bytes")), true);

  const unrelated = rawView("view:unrelated", "capture.clipboard.item", { text: "not in event" });
  assert.throws(
    () => buildViewCommittedTriggerSignal(commitEvent(raw, "event:membership"), unrelated),
    /is not a member of ViewCommitted event/,
  );

  const traceFailure = new CommittedViewTriggerAdapter({
    views: new MemoryViewReader([raw]),
    ...cascadeSafety(),
    invocations: { async invoke() { assert.fail("trace failure occurs before invocation"); } },
    events: { emit() { throw new Error("trace disk full"); } },
    now: () => new Date(NOW),
  });
  await assert.rejects(
    traceFailure.dispatch(commitEvent(raw, "event:trace-failure")),
    (error: unknown) => error instanceof CommittedViewTriggerError && error.code === "trace_persistence_failed",
  );
});

function committedTrigger(id: string, predicate?: TriggerPredicate): AutomationDefinition {
  return {
    version: 1,
    enabled: true,
    trigger: {
      id,
      kind: "event",
      source: VIEW_COMMITTED_TRIGGER_SOURCE,
      event: VIEW_COMMITTED_TRIGGER_EVENT,
      ...(predicate ? { predicate } : {}),
    },
    target: { kind: "transformation", transformation_id: `transformation:${id}`, revision: 1 },
    input_mapping: [],
    delivery: [],
    limits: { dedupe_window_ms: 0, cooldown_ms: 0, max_concurrency: 1 },
  };
}

function field(
  path: string,
  operator: "eq" | "contains",
  value: string,
): { type: "field"; path: string; operator: "eq" | "contains"; value: string } {
  return { type: "field", path, operator, value };
}

function automationView(id: string, definition: AutomationDefinition, revision = 1): ParsedAutomationView {
  const view = parseView({
    id,
    revision,
    name: id,
    purpose: `Trigger ${definition.trigger.id}`,
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    role: "derived",
    time: { created_at: NOW },
    representation: { form: "inline", kind: "automation", value: definition, metadata: {} },
    materialization: { primary: materialization("automation-json") },
    relations: [],
    provenance: { inputs: [], actor: "user:local" },
    policy: policy(),
    metadata: {},
  });
  return { view, definition };
}

function rawView(
  id: string,
  schemaName: string,
  value: Record<string, string>,
  options: { relations?: View["relations"]; allowLocalSearch?: boolean } = {},
): View {
  return parseView({
    id,
    revision: 1,
    name: id,
    purpose: "Preserve source evidence",
    schema: { name: schemaName, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: NOW, created_at: NOW },
    representation: { form: "inline", kind: schemaName, value, metadata: {} },
    materialization: { primary: materialization("source-json") },
    relations: options.relations ?? [],
    provenance: {
      inputs: [],
      capture: {
        connector: schemaName.includes("screenpipe") ? "screenpipe" : schemaName.includes("clipboard") ? "clipboard" : "browser",
        connection_id: "connection:local",
        source_id: id,
        source_kind: schemaName,
        identity: "occurrence",
        assertion: "direct",
      },
      actor: "connector:local",
    },
    policy: policy(options.allowLocalSearch),
    metadata: {},
  });
}

function derivedView(
  id: string,
  schemaName: string,
  value: Record<string, string>,
  options: { inputs?: ExactViewRef[] } = {},
): View {
  return parseView({
    id,
    revision: 1,
    name: id,
    purpose: "Preserve derived information",
    schema: { name: schemaName, version: 1, mode: "freeform" },
    role: "derived",
    time: { created_at: NOW },
    representation: { form: "inline", kind: schemaName, value, metadata: {} },
    materialization: { primary: materialization("derived-json") },
    relations: [],
    provenance: { inputs: options.inputs ?? [], operator_run_id: "run:fixture", actor: "operator:fixture" },
    policy: policy(),
    metadata: {},
  });
}

function policy(allowLocalSearch = true): View["policy"] {
  return {
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: allowLocalSearch,
    labels: [],
  };
}

function materialization(id: string): View["materialization"]["primary"] {
  return { id, format: "json", media_type: "application/json", location: { kind: "inline" } };
}

function commitEvent(view: View, eventId: string): ViewCommittedEvent {
  return parseViewCommittedEvent({
    event_id: eventId,
    event_type: "view.committed",
    event_version: 1,
    batch_id: `batch:${eventId}`,
    transaction_id: `transaction:${eventId}`,
    committed_at: NOW,
    origin: { kind: view.role === "raw" ? "capture" : "execution", id: `origin:${eventId}` },
    views: [{
      ref: ref(view),
      role: view.role,
      schema: { name: view.schema.name, version: view.schema.version, mode: view.schema.mode },
      retention: view.policy.retention,
    }],
  });
}

function succeededInvocation(automation: ParsedAutomationView, signalId: string): AutomationInvocationResult {
  return {
    status: "succeeded",
    correlation_id: `correlation:${automation.view.id}:${signalId}`,
    occurrence: {
      id: `occurrence:${automation.view.id}:${signalId}`,
      automation: ref(automation.view),
      trigger_id: automation.definition.trigger.id,
      trigger_kind: automation.definition.trigger.kind,
      source: VIEW_COMMITTED_TRIGGER_SOURCE,
      occurred_at: NOW,
      idempotency_key: `occurrence-key:${automation.view.id}:${signalId}`,
      evidence: [],
      payload: {},
      match: { matched: true, reason: "fixture" },
    },
    run_id: `run:${automation.view.id}:${signalId}`,
    output_views: [{ view_id: `output:${automation.view.id}`, revision: 1 }],
    deliveries: [],
  };
}

function ref(view: Pick<View, "id" | "revision">): ExactViewRef {
  return { view_id: view.id, revision: view.revision };
}

function draftOf(view: View): ViewDraft {
  const { revision: _revision, ...draft } = view;
  return draft;
}

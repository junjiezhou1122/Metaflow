import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReactiveCascadeLimitError,
  parseAutomationDefinition,
  type AutomationDefinition,
  type AutomationInvocationInput,
  type AutomationInvocationResult,
  type ParsedAutomationView,
} from "../packages/automation/index.ts";
import {
  CommittedViewTriggerAdapter,
  CommittedViewTriggerError,
  VIEW_COMMITTED_TRIGGER_EVENT,
  VIEW_COMMITTED_TRIGGER_SOURCE,
} from "../packages/adapters/committed-view-trigger/index.ts";
import { SqliteReactiveCascadeLedger } from "../packages/adapters/automation-sqlite/index.ts";
import {
  parseView,
  parseViewCommittedEvent,
  type ExactViewRef,
  type ReactiveCascadeContext,
  type ReactiveCascadePolicySnapshot,
  type View,
  type ViewCommittedEvent,
  type ViewQuery,
} from "../packages/view/index.ts";

const NOW = "2026-07-26T18:00:00.000Z";

test("diamond fan-out is admitted in one stable plan and N+1 stops before any Worker invocation", async () => {
  await withCascadeLedger(async ledger => {
    const source = view("view:source", "analysis.loop", "raw");
    const automations = [automation("automation:a"), automation("automation:b")];
    const reader = new MemoryViewReader([source, ...automations.map(item => item.view)]);
    const admitted: AutomationInvocationInput[] = [];
    const allowed = new CommittedViewTriggerAdapter({
      views: reader,
      events: { emit() {} },
      invocations: { invoke: input => { admitted.push(input); return Promise.resolve(success(input)); } },
      cascades: ledger,
      cascade_policy: cascadePolicy({ max_fan_out: 2 }),
      now: () => new Date(NOW),
    });

    await allowed.dispatch(commitEvent(source, "event:diamond"));
    assert.equal(admitted.length, 2);
    const contexts = admitted.map(item => item.signal.cascade!);
    assert.deepEqual(contexts.map(item => item.fan_out_index), [0, 1]);
    assert.deepEqual(contexts.map(item => item.fan_out_total), [2, 2]);
    assert.deepEqual(contexts.map(item => item.target.automation.view_id), ["automation:a", "automation:b"]);
    assert.equal(new Set(contexts.map(item => item.root_correlation_id)).size, 1);
    assert.deepEqual(contexts.map(item => item.lineage), [[ref(source)], [ref(source)]]);

    const blockedLedger = new SqliteReactiveCascadeLedger(join(tmpdir(), `metaflow-cascade-blocked-${Date.now()}.sqlite`));
    try {
      const blockedCalls: AutomationInvocationInput[] = [];
      const blocked = new CommittedViewTriggerAdapter({
        views: reader,
        events: { emit() {} },
        invocations: {
          invoke: input => {
            if (input.signal.cascade?.disposition === "continue") blockedCalls.push(input);
            return Promise.resolve(input.signal.cascade?.disposition === "terminal" ? stopped(input) : success(input));
          },
        },
        cascades: blockedLedger,
        cascade_policy: cascadePolicy({ max_fan_out: 1 }),
        now: () => new Date(NOW),
      });
      const report = await blocked.dispatch(commitEvent(source, "event:fan-out-exhausted"));
      assert.equal(blockedCalls.length, 0);
      assert.equal(report.outcomes.filter(item => item.outcome === "stopped").length, 2);
      const root = report.outcomes.find(item => item.details.root_correlation_id)?.details.root_correlation_id;
      assert.equal(typeof root, "string");
      const records = await blockedLedger.listRoot(root as string);
      assert.equal(records.length, 2);
      assert.deepEqual(records.map(item => item.status), ["stopped", "stopped"]);
      assert.deepEqual(records.map(item => item.error_code), ["fan_out_exhausted", "fan_out_exhausted"]);
    } finally {
      blockedLedger.close();
    }
  });
});

test("committed View recursion requires durable safety options and rejects Operation escape targets", async () => {
  const source = view("view:safety-options", "analysis.loop", "raw");
  const transformationAutomation = automation("automation:safety-options");
  const base = {
    views: new MemoryViewReader([source, transformationAutomation.view]),
    events: { emit() {} },
    invocations: { invoke: (input: AutomationInvocationInput) => Promise.resolve(success(input)) },
    now: () => new Date(NOW),
  };
  assert.throws(
    () => new CommittedViewTriggerAdapter({ ...base, cascades: undefined as never, cascade_policy: cascadePolicy() }),
    (error: unknown) => error instanceof CommittedViewTriggerError && error.code === "invalid_options",
  );
  assert.throws(
    () => new CommittedViewTriggerAdapter({ ...base, cascades: {} as never, cascade_policy: undefined as never }),
    (error: unknown) => error instanceof CommittedViewTriggerError && error.code === "invalid_options",
  );

  await withCascadeLedger(async ledger => {
    const operationAutomation = automation("automation:operation-escape", {
      kind: "operation",
      name: "run.execute",
      version: 1,
    });
    let invocations = 0;
    const adapter = new CommittedViewTriggerAdapter({
      views: new MemoryViewReader([source, operationAutomation.view]),
      events: { emit() {} },
      invocations: {
        invoke: input => {
          invocations += 1;
          return Promise.resolve(success(input));
        },
      },
      cascades: ledger,
      cascade_policy: cascadePolicy(),
      now: () => new Date(NOW),
    });
    await assert.rejects(
      adapter.dispatch(commitEvent(source, "event:operation-escape")),
      (error: unknown) => error instanceof CommittedViewTriggerError && error.code === "dispatch_failed",
    );
    assert.equal(invocations, 0);
    assert.deepEqual(await ledger.listRoot("cascade-root:unused"), []);
  });
});

test("repeated semantic transformation and depth exhaustion become durable terminal attempts", async () => {
  await withCascadeLedger(async ledger => {
    const first = view("view:first", "analysis.loop", "derived");
    const second = view("view:second", "analysis.loop", "derived");
    const item = automation("automation:loop");
    const reader = new MemoryViewReader([first, second, item.view]);
    const admitted: AutomationInvocationInput[] = [];
    const adapter = new CommittedViewTriggerAdapter({
      views: reader,
      events: { emit() {} },
      invocations: {
        invoke: input => {
          if (input.signal.cascade?.disposition === "continue") admitted.push(input);
          return Promise.resolve(input.signal.cascade?.disposition === "terminal" ? stopped(input) : success(input));
        },
      },
      cascades: ledger,
      cascade_policy: cascadePolicy({ max_depth: 4 }),
      now: () => new Date(NOW),
    });
    await adapter.dispatch(commitEvent(first, "event:first"));
    const parent = admitted[0]?.signal.cascade;
    assert.ok(parent);

    const cycleReport = await adapter.dispatch(commitEvent(second, "event:second", parent));
    assert.equal(admitted.length, 1);
    assert.equal(cycleReport.outcomes.some(item => item.outcome === "stopped" && item.details.code === "cycle"), true);
    const records = await ledger.listRoot(parent.root_correlation_id);
    assert.equal(records.some(item => item.status === "stopped" && item.error_code === "cycle"), true);

    const depthLedgerPath = join(tmpdir(), `metaflow-cascade-depth-${Date.now()}.sqlite`);
    const depthLedger = new SqliteReactiveCascadeLedger(depthLedgerPath);
    try {
      const depthCalls: AutomationInvocationInput[] = [];
      const depthAdapter = new CommittedViewTriggerAdapter({
        views: reader,
        events: { emit() {} },
        invocations: {
          invoke: input => {
            if (input.signal.cascade?.disposition === "continue") depthCalls.push(input);
            return Promise.resolve(input.signal.cascade?.disposition === "terminal" ? stopped(input) : success(input));
          },
        },
        cascades: depthLedger,
        cascade_policy: cascadePolicy({ max_depth: 1 }),
        now: () => new Date(NOW),
      });
      await depthAdapter.dispatch(commitEvent(first, "event:depth:first"));
      const depthParent = depthCalls[0]!.signal.cascade!;
      const report = await depthAdapter.dispatch(commitEvent(second, "event:depth:second", {
        ...depthParent,
        semantic_fingerprints: ["1".repeat(64)],
      }));
      assert.equal(depthCalls.length, 1);
      assert.equal(report.outcomes.some(item => item.details.code === "depth_exhausted"), true);
    } finally {
      depthLedger.close();
    }
  });
});

test("expired reservations recover exactly and Operator concurrency is shared across Automations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-cascade-recovery-"));
  const dbPath = join(directory, "cascade.sqlite");
  const ledger = new SqliteReactiveCascadeLedger(dbPath);
  try {
    const first = context("attempt:first", "root:recovery", "automation:a", 0);
    assert.equal((await ledger.reservePlan({ attempts: [first], reserved_at: NOW })).outcome, "created");
    assert.equal((await ledger.reservePlan({
      attempts: [first],
      reserved_at: "2026-07-26T18:00:01.001Z",
    })).outcome, "recovered");

    const second = context("attempt:second", "root:other", "automation:b", 0);
    await ledger.reservePlan({ attempts: [second], reserved_at: NOW });
    await ledger.bindOperator({
      attempt_id: first.attempt_id,
      operator: { id: "operator:shared", revision: 1 },
      run_id: "run:first",
      started_at: NOW,
    });
    await assert.rejects(
      ledger.bindOperator({
        attempt_id: second.attempt_id,
        operator: { id: "operator:shared", revision: 1 },
        run_id: "run:second",
        started_at: NOW,
      }),
      (error: unknown) => error instanceof ReactiveCascadeLimitError
        && error.code === "operator_concurrency_exhausted"
        && error.attempt_id === second.attempt_id,
    );

    ledger.close();
    const reopened = new SqliteReactiveCascadeLedger(dbPath);
    try {
      const recovery = await reopened.reservePlan({
        attempts: [first],
        reserved_at: "2026-07-26T18:00:02.001Z",
      });
      assert.equal(recovery.outcome, "recovered");
      const recovered = await reopened.listRoot("root:recovery");
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.status, "reserved");
      assert.deepEqual(recovered[0]?.context.target.operator, { id: "operator:shared", revision: 1 });
      assert.equal(recovered[0]?.run_id, "run:first");
      const recoveryBinding = await reopened.bindOperator({
        attempt_id: first.attempt_id,
        operator: { id: "operator:shared", revision: 1 },
        run_id: "run:first",
        started_at: "2026-07-26T18:00:02.002Z",
      });
      assert.equal(recoveryBinding.status, "reserved");
      const timeline = await reopened.listEvents("root:recovery");
      assert.deepEqual(timeline.map(event => event.type), ["reserved", "recovered", "operator_bound", "recovered"]);
      assert.deepEqual(timeline.map(event => event.sequence), [...timeline.map(event => event.sequence)].sort((a, b) => a - b));
    } finally {
      reopened.close();
    }
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aggregate attempt, cost, and elapsed budgets stop before the next Operator", async () => {
  await withCascadeLedger(async ledger => {
    const first = context("attempt:budget:first", "root:budget", "automation:budget-a", 0);
    first.policy = cascadePolicy({ max_total_attempts: 1, max_total_cost_usd: 0.5, max_elapsed_ms: 1_000 });
    await ledger.reservePlan({ attempts: [first], reserved_at: NOW });
    await ledger.bindOperator({
      attempt_id: first.attempt_id,
      operator: { id: "operator:budget", revision: 1 },
      run_id: "run:budget:first",
      started_at: NOW,
    });
    await ledger.finalize({
      attempt_id: first.attempt_id,
      status: "succeeded",
      completed_at: "2026-07-26T18:00:00.500Z",
      run_id: "run:budget:first",
      cost_usd: 0.75,
    });
    const second = context("attempt:budget:second", "root:budget", "automation:budget-b", 0);
    second.policy = first.policy;
    second.parent_attempt_id = first.attempt_id;
    second.parent_event_id = "event:budget:second";
    second.depth = 2;
    second.aggregate.attempts = 2;
    const exhausted = await ledger.reservePlan({
      attempts: [second],
      reserved_at: "2026-07-26T18:00:00.600Z",
    });
    assert.equal(exhausted.outcome, "stopped");
    if (exhausted.outcome === "stopped") assert.equal(exhausted.code, "attempts_exhausted");

    const costFirst = context("attempt:cost:first", "root:cost", "automation:cost-a", 0);
    costFirst.policy = cascadePolicy({ max_total_attempts: 10, max_total_cost_usd: 0.5 });
    await ledger.reservePlan({ attempts: [costFirst], reserved_at: NOW });
    await ledger.bindOperator({
      attempt_id: costFirst.attempt_id,
      operator: { id: "operator:cost", revision: 1 },
      run_id: "run:cost:first",
      started_at: NOW,
    });
    await ledger.finalize({
      attempt_id: costFirst.attempt_id,
      status: "succeeded",
      completed_at: NOW,
      run_id: "run:cost:first",
      cost_usd: 0.75,
    });
    const terminalReplay = await ledger.bindOperator({
      attempt_id: costFirst.attempt_id,
      operator: { id: "operator:cost", revision: 1 },
      run_id: "run:cost:first",
      started_at: "2026-07-26T18:00:00.001Z",
    });
    assert.equal(terminalReplay.status, "succeeded");
    await assert.rejects(ledger.bindOperator({
      attempt_id: costFirst.attempt_id,
      operator: { id: "operator:changed", revision: 1 },
      run_id: "run:cost:first",
      started_at: "2026-07-26T18:00:00.002Z",
    }), /changed Operator or Run/);
    const costSecond = context("attempt:cost:second", "root:cost", "automation:cost-b", 0);
    costSecond.policy = costFirst.policy;
    costSecond.parent_attempt_id = costFirst.attempt_id;
    costSecond.depth = 2;
    costSecond.aggregate.attempts = 2;
    const costExhausted = await ledger.reservePlan({ attempts: [costSecond], reserved_at: NOW });
    assert.equal(costExhausted.outcome, "stopped");
    if (costExhausted.outcome === "stopped") assert.equal(costExhausted.code, "cost_exhausted");

    const time = context("attempt:time", "root:time", "automation:time", 0);
    time.policy = cascadePolicy({ max_elapsed_ms: 100 });
    const timedOut = await ledger.reservePlan({
      attempts: [time],
      reserved_at: "2026-07-26T18:00:00.101Z",
    });
    assert.equal(timedOut.outcome, "stopped");
    if (timedOut.outcome === "stopped") assert.equal(timedOut.code, "time_exhausted");

    const callerAggregate = context("attempt:caller-cost", "root:caller-cost", "automation:caller-cost", 0);
    callerAggregate.policy = cascadePolicy({ max_total_cost_usd: 0 });
    callerAggregate.aggregate.cost_usd = 0.01;
    const costResult = await ledger.reservePlan({ attempts: [callerAggregate], reserved_at: NOW });
    // The durable ledger, not caller-provided aggregate values, owns root totals.
    assert.equal(costResult.outcome, "created");

    const replayParent = context("attempt:replay:parent", "root:replay", "automation:replay", 0);
    await ledger.reservePlan({ attempts: [replayParent], reserved_at: NOW });
    await ledger.bindOperator({
      attempt_id: replayParent.attempt_id,
      operator: { id: "operator:replay", revision: 1 },
      run_id: "run:replay:parent",
      started_at: NOW,
    });
    await ledger.finalize({
      attempt_id: replayParent.attempt_id,
      status: "succeeded",
      completed_at: NOW,
      run_id: "run:replay:parent",
      cost_usd: 0,
    });
    const replay = context("attempt:replay:explicit", "root:replay", "automation:replay", 0);
    replay.parent_attempt_id = replayParent.attempt_id;
    replay.depth = 2;
    replay.aggregate.attempts = 2;
    replay.semantic_fingerprints = [
      replayParent.semantic_fingerprints[0]!,
      replayParent.semantic_fingerprints[0]!,
    ];
    replay.replay = {
      kind: "explicit_replay",
      previous_cascade_attempt_id: replayParent.attempt_id,
      previous_execution_attempt_id: "execution-attempt:replay:parent",
    };
    const replayResult = await ledger.reservePlan({ attempts: [replay], reserved_at: NOW });
    assert.equal(replayResult.outcome, "created");
    assert.equal((await ledger.getAttempt(replay.attempt_id))?.context.parent_attempt_id, replayParent.attempt_id);
  });
});

test("generated acyclic chains succeed through the exact depth boundary and concurrent delivery stays idempotent", async () => {
  await withCascadeLedger(async ledger => {
    let parent: string | undefined;
    for (let depth = 1; depth <= 4; depth += 1) {
      const attempt = context(`attempt:chain:${depth}`, "root:chain", `automation:chain:${depth}`, 0);
      attempt.policy = cascadePolicy({ max_depth: 4, max_total_attempts: 8 });
      attempt.depth = depth;
      attempt.aggregate.attempts = depth;
      attempt.semantic_fingerprints = Array.from({ length: depth }, (_, index) => (
        (index + 1).toString(16).repeat(64)
      ));
      if (parent) attempt.parent_attempt_id = parent;
      const reservation = await ledger.reservePlan({ attempts: [attempt], reserved_at: NOW });
      assert.equal(reservation.outcome, "created");
      await ledger.bindOperator({
        attempt_id: attempt.attempt_id,
        operator: { id: `operator:chain:${depth}`, revision: 1 },
        run_id: `run:chain:${depth}`,
        started_at: NOW,
      });
      await ledger.finalize({
        attempt_id: attempt.attempt_id,
        status: "succeeded",
        completed_at: NOW,
        run_id: `run:chain:${depth}`,
        cost_usd: 0,
      });
      parent = attempt.attempt_id;
    }
    const beyond = context("attempt:chain:5", "root:chain", "automation:chain:5", 0);
    beyond.policy = cascadePolicy({ max_depth: 4, max_total_attempts: 8 });
    beyond.depth = 5;
    beyond.aggregate.attempts = 5;
    beyond.parent_attempt_id = parent;
    beyond.semantic_fingerprints = Array.from({ length: 5 }, (_, index) => (
      (index + 1).toString(16).repeat(64)
    ));
    const stopped = await ledger.reservePlan({ attempts: [beyond], reserved_at: NOW });
    assert.equal(stopped.outcome, "stopped");
    if (stopped.outcome === "stopped") assert.equal(stopped.code, "depth_exhausted");

    const duplicate = context("attempt:concurrent", "root:concurrent", "automation:concurrent", 0);
    const results = await Promise.all([
      ledger.reservePlan({ attempts: [duplicate], reserved_at: NOW }),
      ledger.reservePlan({ attempts: [duplicate], reserved_at: NOW }),
      ledger.reservePlan({ attempts: [duplicate], reserved_at: NOW }),
    ]);
    assert.deepEqual(results.map(result => result.outcome).sort(), ["created", "duplicate", "duplicate"]);
    assert.equal((await ledger.listRoot("root:concurrent")).length, 1);
  });
});

test("atomic fan-out rejects mixed root facts and forged replay linkage", async () => {
  await withCascadeLedger(async ledger => {
    const first = context("attempt:fanout:first", "root:fanout-contract", "automation:first", 0);
    const second = context("attempt:fanout:second", "root:fanout-contract", "automation:second", 1);
    first.fan_out_total = 2;
    second.fan_out_total = 2;
    second.root_event_id = "event:forged-root";
    await assert.rejects(
      ledger.reservePlan({ attempts: [first, second], reserved_at: NOW }),
      /freeze one root, event, policy, and total/,
    );
    second.root_event_id = first.root_event_id;
    second.root_started_at = "2026-07-26T17:59:59.000Z";
    await assert.rejects(
      ledger.reservePlan({ attempts: [first, second], reserved_at: NOW }),
      /freeze one root, event, policy, and total/,
    );

    const parent = context("attempt:replay:real-parent", "root:forged-replay", "automation:replay", 0);
    await ledger.reservePlan({ attempts: [parent], reserved_at: NOW });
    await ledger.bindOperator({
      attempt_id: parent.attempt_id,
      operator: { id: "operator:replay", revision: 1 },
      run_id: "run:replay:real-parent",
      started_at: NOW,
    });
    await ledger.finalize({
      attempt_id: parent.attempt_id,
      status: "succeeded",
      completed_at: NOW,
      run_id: "run:replay:real-parent",
      cost_usd: 0,
    });
    const forged = context("attempt:replay:forged", "root:forged-replay", "automation:replay", 0);
    forged.parent_attempt_id = parent.attempt_id;
    forged.depth = 2;
    forged.aggregate.attempts = 2;
    forged.replay = {
      kind: "explicit_replay",
      previous_cascade_attempt_id: "attempt:replay:not-the-parent",
      previous_execution_attempt_id: "execution-attempt:forged",
    };
    await assert.rejects(
      ledger.reservePlan({ attempts: [forged], reserved_at: NOW }),
      /does not link a terminal parent attempt/,
    );
  });
});

class MemoryViewReader {
  constructor(readonly values: View[]) {}
  async get(refValue: ExactViewRef): Promise<View | undefined> {
    return this.values.find(item => item.id === refValue.view_id && item.revision === refValue.revision);
  }
  async query(query: ViewQuery = {}): Promise<View[]> {
    return this.values
      .filter(item => (query.schema_name === undefined || item.schema.name === query.schema_name)
        && (query.role === undefined || item.role === query.role))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, query.limit);
  }
}

async function withCascadeLedger(fn: (ledger: SqliteReactiveCascadeLedger) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-reactive-cascade-"));
  const ledger = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  try {
    await fn(ledger);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function automation(
  id: string,
  target: AutomationDefinition["target"] = {
    kind: "transformation",
    transformation_id: "transformation:loop",
    revision: 1,
  },
): ParsedAutomationView {
  const definition = parseAutomationDefinition({
    version: 1,
    trigger: {
      id: `${id}:trigger`,
      kind: "event",
      source: VIEW_COMMITTED_TRIGGER_SOURCE,
      event: VIEW_COMMITTED_TRIGGER_EVENT,
      predicate: { type: "field", path: "view.schema.name", operator: "eq", value: "analysis.loop" },
    },
    target,
  });
  const committed = parseView({
    ...baseView(id, "metaflow.automation", "derived"),
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    representation: { form: "inline", kind: "automation", value: definition, metadata: {} },
  });
  return { view: committed, definition };
}

function view(id: string, schema: string, role: "raw" | "derived"): View {
  return parseView(baseView(id, schema, role));
}

function baseView(id: string, schema: string, role: "raw" | "derived") {
  return {
    id,
    revision: 1,
    name: id,
    purpose: "reactive cascade fixture",
    aliases: [],
    schema: { name: schema, version: 1, mode: "freeform" as const },
    role,
    time: { created_at: NOW },
    representation: { form: "inline" as const, kind: schema, value: { id }, metadata: {} },
    materialization: {
      primary: { id: "json", format: "json", media_type: "application/json", location: { kind: "inline" as const } },
      alternatives: [],
    },
    relations: [],
    provenance: role === "raw"
      ? {
          inputs: [],
          capture: {
            connector: "fixture",
            connection_id: "fixture:local",
            source_id: id,
            source_kind: schema,
            identity: "occurrence" as const,
            assertion: "direct" as const,
          },
          actor: "connector:fixture",
        }
      : { inputs: [], operator_run_id: "run:fixture", actor: "operator:fixture" },
    policy: {
      owner: "user:local",
      visibility: "private" as const,
      privacy: "private" as const,
      retention: "normal" as const,
      allow_external_model: false,
      allow_embedding: false,
      allow_local_search: true,
      labels: [],
    },
    metadata: {},
  };
}

function commitEvent(source: View, eventId: string, cascade?: ReactiveCascadeContext): ViewCommittedEvent {
  return parseViewCommittedEvent({
    event_id: eventId,
    event_type: "view.committed",
    event_version: 1,
    batch_id: `batch:${eventId}`,
    transaction_id: `transaction:${eventId}`,
    committed_at: NOW,
    origin: { kind: source.role === "raw" ? "capture" : "execution", id: `origin:${eventId}` },
    ...(cascade ? { cascade } : {}),
    views: [{
      ref: ref(source),
      role: source.role,
      schema: source.schema,
      retention: source.policy.retention,
    }],
  });
}

function cascadePolicy(overrides: Partial<ReactiveCascadePolicySnapshot["limits"]> = {}): ReactiveCascadePolicySnapshot {
  return {
    id: "policy:reactive-cascade",
    revision: 1,
    limits: {
      max_depth: 4,
      max_fan_out: 8,
      max_total_attempts: 32,
      max_total_cost_usd: 10,
      max_elapsed_ms: 60_000,
      max_operator_concurrency: 1,
      reservation_lease_ms: 1_000,
      ...overrides,
    },
  };
}

function context(attemptId: string, root: string, automationId: string, index: number): ReactiveCascadeContext {
  return {
    attempt_id: attemptId,
    root_correlation_id: root,
    root_event_id: `event:${root}`,
    parent_event_id: `event:${root}`,
    target: {
      automation: { view_id: automationId, revision: 1 },
      transformation: { transformation_id: `transformation:${automationId}`, revision: 1 },
    },
    lineage: [{ view_id: `view:${attemptId}`, revision: 1 }],
    depth: 1,
    fan_out_index: index,
    fan_out_total: 1,
    semantic_fingerprints: [String(index + 1).repeat(64)],
    policy: cascadePolicy({ max_operator_concurrency: 1 }),
    root_started_at: NOW,
    attempt_started_at: NOW,
    aggregate: { attempts: 1, cost_usd: 0 },
    disposition: "continue",
  };
}

function success(input: AutomationInvocationInput): AutomationInvocationResult {
  return {
    status: "succeeded",
    correlation_id: `correlation:${input.automation.view.id}:${input.signal.id}`,
    occurrence: {
      id: `occurrence:${input.signal.id}`,
      automation: ref(input.automation.view),
      trigger_id: input.automation.definition.trigger.id,
      trigger_kind: "event",
      source: input.signal.source,
      occurred_at: input.signal.occurred_at,
      idempotency_key: `occurrence-key:${input.signal.id}`,
      evidence: input.signal.evidence,
      ...(input.signal.cascade ? { cascade: input.signal.cascade } : {}),
      payload: input.signal.payload,
      match: { matched: true, reason: "fixture" },
    },
    run_id: `run:${input.signal.id}`,
    output_views: [],
    deliveries: [],
  };
}

function stopped(input: AutomationInvocationInput): AutomationInvocationResult {
  const cascade = input.signal.cascade!;
  const succeeded = success(input);
  if (succeeded.status !== "succeeded") throw new Error("success fixture did not return an occurrence");
  return {
    status: "failed",
    correlation_id: `correlation:${input.automation.view.id}:${input.signal.id}`,
    occurrence: succeeded.occurrence,
    run_id: `run:${input.signal.id}`,
    failure_view: { view_id: `failure:${cascade.attempt_id}`, revision: 1 },
    error: cascade.terminal!.message,
    failure: {
      stage: "execution",
      code: "cascade_stopped",
      message: cascade.terminal!.message,
    },
    deliveries: [],
  };
}

function ref(value: Pick<View, "id" | "revision">): ExactViewRef {
  return { view_id: value.id, revision: value.revision };
}

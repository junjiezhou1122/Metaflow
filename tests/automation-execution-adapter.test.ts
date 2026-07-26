import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationExecutionTarget,
  InMemoryTransformationCatalog,
} from "../packages/adapters/automation-execution/index.ts";
import type {
  AutomationTargetExecutionContext,
  AutomationTargetRequest,
  AutomationTargetTraceEvent,
  ReactiveCascadeLedger,
} from "@info/automation";
import type {
  ExecutionReplayExplanation,
  ExecutionResult,
  ExecutionRuntime,
  StartExecutionInput,
} from "@info/execution";
import { exactTransformationRef, parseTransformation } from "@info/transformation";
import { exactViewRef, parseView, type View } from "@info/view";
import { SqliteReactiveCascadeLedger } from "../packages/adapters/automation-sqlite/index.ts";

const transformation = parseTransformation({
  id: "transformation.test.browser_summary",
  revision: 1,
  name: "Browser summary",
  instruction: {
    format: "natural_language",
    language: "en",
    text: "Summarize the exact Browser evidence.",
    parameters: {},
  },
  operator: {
    id: "operator.test.browser_summary",
    revision: 1,
    reference: { kind: "agent", adapter: "agent-execution" },
    configuration: { runtime_override: "acp_stdio" },
    required_capabilities: [],
  },
  inputs: [
    {
      role: "current_page",
      required: true,
      sources: [{ kind: "view", ref: { view_id: "view:page", revision: 1 } }],
    },
    {
      role: "current_selection",
      required: false,
      sources: [{ kind: "selector", selector: {
        id: "selector.selection",
        revision: 1,
        query: {
          scope: "matching",
          schema_names: ["capture.browser.selection"],
          roles: ["raw"],
          revision_scope: "latest",
          order: "newest",
          limit: 1,
          where: {},
        },
      } }],
    },
  ],
  output: {
    schema: { name: "summary.browser", version: 1, mode: "freeform" },
    schema_origin: "declared",
    cardinality: { min: 1, max: 1 },
  },
  policy: {
    id: "policy.test.browser_summary",
    revision: 1,
    configuration: { kind: "view_access", profile: "approve_all", rules: [] },
  },
  created_at: "2026-07-26T10:00:00.000Z",
});

test("Automation Execution target freezes exact bindings, including an explicitly empty optional role", async () => {
  const page = rawView("view:page", "capture.browser.page_snapshot");
  const output = derivedView("view:summary");
  let received: StartExecutionInput | undefined;
  const replayedEvents: AutomationTargetTraceEvent[] = [];
  const execution = {
    async execute(input: StartExecutionInput): Promise<ExecutionResult> {
      received = input;
      return {
        run: { id: input.run_id, status: "succeeded" } as ExecutionResult["run"],
        outputs: [output],
      };
    },
    async replay(runId: string): Promise<ExecutionReplayExplanation> {
      return {
        run: { id: runId, status: "succeeded" } as ExecutionReplayExplanation["run"],
        attempts: [],
        committed_outputs: [],
        events: [{
          sequence: 1,
          recorded_at: "2026-07-26T10:00:02.000Z",
          type: "agent.runtime_selected",
          occurred_at: "2026-07-26T10:00:01.000Z",
          run_id: runId,
          attempt_id: "attempt:1",
          payload: { runtime: "acp_stdio", invocation_id: "attempt:1" },
        } as ExecutionReplayExplanation["events"][number]],
      };
    },
  } satisfies Pick<ExecutionRuntime, "execute" | "replay">;
  const target = new AutomationExecutionTarget({
    transformations: new InMemoryTransformationCatalog([transformation]),
    execution,
    run_id: () => "run:automation:test",
  });
  const context: AutomationTargetExecutionContext = {
    async progress() {},
    async trace(event) { replayedEvents.push(event); },
  };

  const result = await target.execute(targetRequest(page), context);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.status === "succeeded" ? result.output_views : [], [exactViewRef(output)]);
  assert.deepEqual(received?.invocation_inputs, [
    { role: "current_page", views: [exactViewRef(page)] },
    { role: "current_selection", views: [] },
  ]);
  assert.equal(received?.access_use, "external_model");
  assert.deepEqual(replayedEvents.map(event => event.type), ["agent.runtime_selected"]);
  assert.equal(replayedEvents[0]?.run_id, "run:automation:test");
});

test("Transformation catalog rejects duplicate immutable revisions", () => {
  assert.throws(
    () => new InMemoryTransformationCatalog([transformation, transformation]),
    /Duplicate Transformation revision/,
  );
});

test("Automation Execution binds the exact Operator and terminalizes timeout evidence in the cascade ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-execution-cascade-"));
  const ledger = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  const page = rawView("view:page", "capture.browser.page_snapshot");
  const failure = derivedView("view:failure");
  const cascade = cascadeContext();
  try {
    await ledger.reservePlan({ attempts: [cascade], reserved_at: "2026-07-26T10:00:00.000Z" });
    let received: StartExecutionInput | undefined;
    const execution = {
      async execute(input: StartExecutionInput): Promise<ExecutionResult> {
        received = input;
        return {
          run: {
            id: input.run_id,
            status: "timed_out",
            completed_at: "2026-07-26T10:00:02.000Z",
            total_cost_usd: 0.2,
            failure_view: exactViewRef(failure),
            error: { code: "timeout", message: "Worker timed out", stage: "execution", details: {} },
          } as ExecutionResult["run"],
          outputs: [],
          failure,
        };
      },
      async replay(runId: string): Promise<ExecutionReplayExplanation> {
        return {
          run: { id: runId, status: "timed_out" } as ExecutionReplayExplanation["run"],
          attempts: [],
          committed_outputs: [],
          events: [],
        };
      },
    } satisfies Pick<ExecutionRuntime, "execute" | "replay">;
    const target = new AutomationExecutionTarget({
      transformations: new InMemoryTransformationCatalog([transformation]),
      execution,
      cascades: ledger,
      run_id: () => "run:cascade-timeout",
    });
    const request = targetRequest(page);
    request.cascade = cascade;
    const result = await target.execute(request, { async progress() {}, async trace() {} });
    assert.equal(result.status, "failed");
    assert.equal(received?.idempotency_key, `cascade:${cascade.attempt_id}`);
    assert.deepEqual(received?.cascade, cascade);
    const attempt = await ledger.getAttempt(cascade.attempt_id);
    assert.equal(attempt?.status, "failed");
    assert.deepEqual(attempt?.context.target.operator, {
      id: transformation.operator.id,
      revision: transformation.operator.revision,
    });
    assert.equal(attempt?.run_id, "run:cascade-timeout");
    assert.equal(attempt?.error_code, "timeout");
    assert.equal(attempt?.cost_usd, 0.2);
    assert.deepEqual((await ledger.listEvents(cascade.root_correlation_id)).map(event => event.type), [
      "reserved",
      "operator_bound",
      "failed",
    ]);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Operator concurrency exhaustion crosses Execution and records canonical failure evidence without a Worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-execution-concurrency-"));
  const ledger = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  const page = rawView("view:page", "capture.browser.page_snapshot");
  const failure = derivedView("view:failure:operator-concurrency");
  const blocker = cascadeContext({
    attempt_id: "cascade-attempt:operator-concurrency-blocker",
    root_correlation_id: "cascade-root:operator-concurrency-blocker",
    root_event_id: "event:root:operator-concurrency-blocker",
    parent_event_id: "event:parent:operator-concurrency-blocker",
  });
  const blocked = cascadeContext({
    attempt_id: "cascade-attempt:operator-concurrency-blocked",
    root_correlation_id: "cascade-root:operator-concurrency-blocked",
    root_event_id: "event:root:operator-concurrency-blocked",
    parent_event_id: "event:parent:operator-concurrency-blocked",
  });
  try {
    await ledger.reservePlan({ attempts: [blocker], reserved_at: "2026-07-26T10:00:00.000Z" });
    await ledger.bindOperator({
      attempt_id: blocker.attempt_id,
      operator: { id: transformation.operator.id, revision: transformation.operator.revision },
      run_id: "run:operator-concurrency-blocker",
      started_at: "2026-07-26T10:00:00.000Z",
    });
    await ledger.reservePlan({ attempts: [blocked], reserved_at: "2026-07-26T10:00:00.100Z" });

    let received: StartExecutionInput | undefined;
    const execution = {
      async execute(input: StartExecutionInput): Promise<ExecutionResult> {
        received = input;
        assert.equal(input.pre_execution_failure?.code, "operator_concurrency_exhausted");
        return {
          run: {
            id: input.run_id,
            status: "failed",
            completed_at: "2026-07-26T10:00:00.200Z",
            total_cost_usd: 0,
            failure_view: exactViewRef(failure),
            error: {
              code: "operator_concurrency_exhausted",
              message: "shared Operator concurrency is exhausted",
              stage: "execution",
              details: {},
            },
          } as ExecutionResult["run"],
          outputs: [],
          failure,
        };
      },
      async replay(runId: string): Promise<ExecutionReplayExplanation> {
        return {
          run: { id: runId, status: "failed" } as ExecutionReplayExplanation["run"],
          attempts: [],
          committed_outputs: [],
          events: [],
        };
      },
    } satisfies Pick<ExecutionRuntime, "execute" | "replay">;
    const target = new AutomationExecutionTarget({
      transformations: new InMemoryTransformationCatalog([transformation]),
      execution,
      cascades: ledger,
      run_id: () => "run:operator-concurrency-blocked",
    });
    const request = targetRequest(page);
    request.cascade = blocked;

    const result = await target.execute(request, { async progress() {}, async trace() {} });

    assert.equal(result.status, "failed");
    assert.equal(received?.pre_execution_failure?.stage, "execution");
    assert.deepEqual(received?.pre_execution_failure?.details, {
      cascade_attempt_id: blocked.attempt_id,
      cascade_stage: "admission",
    });
    assert.equal((await ledger.getAttempt(blocker.attempt_id))?.status, "running");
    const terminal = await ledger.getAttempt(blocked.attempt_id);
    assert.equal(terminal?.status, "failed");
    assert.equal(terminal?.run_id, "run:operator-concurrency-blocked");
    assert.equal(terminal?.error_code, "operator_concurrency_exhausted");
    assert.deepEqual(
      (await ledger.listEvents(blocked.root_correlation_id)).map(event => event.type),
      ["reserved", "failed"],
    );
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired running cascade reconciles its original Run without invoking the Worker again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-execution-recovery-"));
  const ledger = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  const page = rawView("view:page", "capture.browser.page_snapshot");
  const failure = derivedView("view:failure:recovered");
  const cascade = cascadeContext({
    attempt_id: "cascade-attempt:automation-execution-recovery",
    root_correlation_id: "cascade-root:automation-execution-recovery",
  });
  const runId = "run:cascade-recovered";
  try {
    await ledger.reservePlan({ attempts: [cascade], reserved_at: "2026-07-26T10:00:00.000Z" });
    await ledger.bindOperator({
      attempt_id: cascade.attempt_id,
      operator: { id: transformation.operator.id, revision: transformation.operator.revision },
      run_id: runId,
      started_at: "2026-07-26T10:00:00.000Z",
    });
    const recovered = await ledger.reservePlan({
      attempts: [cascade],
      reserved_at: "2026-07-26T10:00:06.000Z",
    });
    assert.equal(recovered.outcome, "recovered");
    assert.equal(recovered.attempts[0]?.status, "reserved");
    assert.equal(recovered.attempts[0]?.run_id, runId);

    let executeCalls = 0;
    let reconcileCalls = 0;
    const execution = {
      async execute(): Promise<ExecutionResult> {
        executeCalls += 1;
        assert.fail("a recovered running cascade must not invoke its Worker again");
      },
      async reconcileAbandonedRun(receivedRunId: string): Promise<ExecutionResult> {
        reconcileCalls += 1;
        assert.equal(receivedRunId, runId);
        return {
          run: {
            id: runId,
            status: "failed",
            completed_at: "2026-07-26T10:00:06.100Z",
            total_cost_usd: 0,
            failure_view: exactViewRef(failure),
            error: {
              code: "worker_process_abandoned",
              message: "Worker lease expired",
              stage: "execution",
              details: {},
            },
          } as ExecutionResult["run"],
          outputs: [],
          failure,
        };
      },
      async replay(receivedRunId: string): Promise<ExecutionReplayExplanation> {
        return {
          run: { id: receivedRunId, status: "failed" } as ExecutionReplayExplanation["run"],
          attempts: [],
          committed_outputs: [],
          events: [],
        };
      },
    } satisfies Pick<ExecutionRuntime, "execute" | "replay" | "reconcileAbandonedRun">;
    const target = new AutomationExecutionTarget({
      transformations: new InMemoryTransformationCatalog([transformation]),
      execution,
      cascades: ledger,
      run_id: () => runId,
    });
    const request = targetRequest(page);
    request.cascade = recovered.attempts[0]!.context;

    const result = await target.execute(request, { async progress() {}, async trace() {} });
    assert.equal(result.status, "failed");
    assert.equal(executeCalls, 0);
    assert.equal(reconcileCalls, 1);
    assert.equal((await ledger.getAttempt(cascade.attempt_id))?.status, "failed");

    const next = cascadeContext({
      attempt_id: "cascade-attempt:automation-execution-after-recovery",
      root_correlation_id: "cascade-root:automation-execution-after-recovery",
      root_event_id: "event:root:after-recovery",
      parent_event_id: "event:parent:after-recovery",
    });
    await ledger.reservePlan({ attempts: [next], reserved_at: "2026-07-26T10:00:07.000Z" });
    const bound = await ledger.bindOperator({
      attempt_id: next.attempt_id,
      operator: { id: transformation.operator.id, revision: transformation.operator.revision },
      run_id: "run:after-recovery",
      started_at: "2026-07-26T10:00:07.000Z",
    });
    assert.equal(bound.status, "running");
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("output commit followed by cascade-finalize crash is retried as the same success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-automation-execution-finalize-crash-"));
  const durable = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  const page = rawView("view:page", "capture.browser.page_snapshot");
  const output = derivedView("view:summary:finalize-crash");
  const cascade = cascadeContext({
    attempt_id: "cascade-attempt:finalize-crash",
    root_correlation_id: "cascade-root:finalize-crash",
  });
  let failSuccessFinalize = true;
  const finalizeStatuses: string[] = [];
  const ledger: ReactiveCascadeLedger = {
    reservePlan: input => durable.reservePlan(input),
    bindOperator: input => durable.bindOperator(input),
    getAttempt: attemptId => durable.getAttempt(attemptId),
    listRoot: root => durable.listRoot(root),
    listEvents: root => durable.listEvents(root),
    async finalize(input) {
      finalizeStatuses.push(input.status);
      if (input.status === "succeeded" && failSuccessFinalize) {
        failSuccessFinalize = false;
        throw new Error("simulated cascade finalize crash after output commit");
      }
      return durable.finalize(input);
    },
  };
  try {
    await ledger.reservePlan({ attempts: [cascade], reserved_at: "2026-07-26T10:00:00.000Z" });
    let runtimeInvocations = 0;
    let workerExecutions = 0;
    const execution = {
      async execute(input: StartExecutionInput): Promise<ExecutionResult> {
        runtimeInvocations += 1;
        if (runtimeInvocations === 1) workerExecutions += 1;
        return {
          run: {
            id: input.run_id,
            status: "succeeded",
            completed_at: "2026-07-26T10:00:01.000Z",
            total_cost_usd: 0.1,
          } as ExecutionResult["run"],
          outputs: [output],
        };
      },
      async reconcileAbandonedRun(): Promise<ExecutionResult> {
        assert.fail("a non-expired running cascade should replay Execution idempotently");
      },
      async replay(runId: string): Promise<ExecutionReplayExplanation> {
        return {
          run: { id: runId, status: "succeeded" } as ExecutionReplayExplanation["run"],
          attempts: [],
          committed_outputs: [],
          events: [],
        };
      },
    } satisfies Pick<ExecutionRuntime, "execute" | "replay" | "reconcileAbandonedRun">;
    const target = new AutomationExecutionTarget({
      transformations: new InMemoryTransformationCatalog([transformation]),
      execution,
      cascades: ledger,
      run_id: () => "run:finalize-crash",
    });
    const request = targetRequest(page);
    request.cascade = cascade;

    await assert.rejects(
      target.execute(request, { async progress() {}, async trace() {} }),
      /simulated cascade finalize crash/,
    );
    assert.equal((await durable.getAttempt(cascade.attempt_id))?.status, "running");
    assert.deepEqual(finalizeStatuses, ["succeeded"]);

    const replayed = await target.execute(request, { async progress() {}, async trace() {} });
    assert.equal(replayed.status, "succeeded");
    assert.equal((await durable.getAttempt(cascade.attempt_id))?.status, "succeeded");
    assert.deepEqual(finalizeStatuses, ["succeeded", "succeeded"]);
    assert.equal(runtimeInvocations, 2);
    assert.equal(workerExecutions, 1);
  } finally {
    durable.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function targetRequest(page: View): AutomationTargetRequest {
  return {
    correlation_id: "occurrence:test:1",
    automation: { view_id: "automation:test", revision: 1 },
    policy_snapshot: page.policy,
    occurrence: {
      id: "occurrence:test:1",
      automation: { view_id: "automation:test", revision: 1 },
      trigger_id: "trigger:test",
      trigger_kind: "event",
      source: "chrome-extension",
      occurred_at: "2026-07-26T10:00:00.000Z",
      idempotency_key: "event:test:1",
      evidence: [exactViewRef(page)],
      payload: {},
      match: { matched: true, reason: "test" },
    },
    target: { kind: "transformation", ...exactTransformationRef(transformation) },
    context: {
      bindings: [
        { role: "current_page", required: true, views: [page] },
        { role: "current_selection", required: false, views: [] },
      ],
      disclosed_views: [exactViewRef(page)],
      attempts: [],
    },
    requested_delivery: [],
  };
}

function cascadeContext(overrides: Partial<ReturnType<typeof baseCascadeContext>> = {}) {
  return { ...baseCascadeContext(), ...overrides };
}

function baseCascadeContext() {
  return {
    attempt_id: "cascade-attempt:automation-execution",
    root_correlation_id: "cascade-root:automation-execution",
    root_event_id: "event:root",
    parent_event_id: "event:parent",
    target: {
      automation: { view_id: "automation:test", revision: 1 },
      transformation: exactTransformationRef(transformation),
    },
    lineage: [{ view_id: "view:page", revision: 1 }],
    depth: 1,
    fan_out_index: 0,
    fan_out_total: 1,
    semantic_fingerprints: ["a".repeat(64)],
    policy: {
      id: "policy:cascade",
      revision: 1,
      limits: {
        max_depth: 4,
        max_fan_out: 4,
        max_total_attempts: 16,
        max_total_cost_usd: 10,
        max_elapsed_ms: 60_000,
        max_operator_concurrency: 1,
        reservation_lease_ms: 5_000,
      },
    },
    root_started_at: "2026-07-26T10:00:00.000Z",
    attempt_started_at: "2026-07-26T10:00:00.000Z",
    aggregate: { attempts: 1, cost_usd: 0 },
    disposition: "continue" as const,
  };
}

function rawView(id: string, schemaName: string): View {
  return parseView({
    id,
    revision: 1,
    name: "Exact Browser page",
    purpose: "Test evidence",
    aliases: [],
    schema: { name: schemaName, version: 1, mode: "freeform" },
    role: "raw",
    time: { created_at: "2026-07-26T10:00:00.000Z" },
    representation: {
      form: "inline",
      kind: "document",
      value: { url: "https://github.com/openai/codex", text: "Codex page" },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test",
        connection_id: "test:default",
        source_id: id,
        source_kind: "browser",
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: policy(),
    metadata: {},
  });
}

function derivedView(id: string): View {
  return parseView({
    ...rawView(id, "summary.browser"),
    role: "derived",
    representation: { form: "inline", kind: "agent_output", value: { summary: "Codex summary" }, metadata: {} },
    provenance: { inputs: [{ view_id: "view:page", revision: 1 }], actor: "test" },
  });
}

function policy() {
  return {
    owner: "user:local",
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: true,
    allow_embedding: false,
    labels: [],
  };
}

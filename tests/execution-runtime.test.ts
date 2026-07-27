import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentOperatorExecutionBridge,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  type OperatorExecutionInvocation,
  type OperatorExecutionPort,
  type OperatorExecutionResult,
  type StartExecutionInput,
} from "@info/execution";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  AgentExecutionAdapter,
  type AgentRuntimeAdapter,
  type AgentRuntimeContext,
  type AgentTaskRequest,
  type AgentTaskResult,
} from "../packages/adapters/agent-runtime/index.ts";
import { exactViewRef, type View, type ViewDraft, type ViewPolicy } from "@info/view";
import type { Transformation } from "@info/transformation";

const outputSchema = {
  name: "analysis.summary",
  version: 1,
  mode: "strict" as const,
  dialect: "https://json-schema.org/draft/2020-12/schema" as const,
  json_schema: {
    type: "object",
    required: ["summary"],
    additionalProperties: false,
    properties: { summary: { type: "string" } },
  },
};

const privatePolicy: ViewPolicy = {
  owner: "user:junjie",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  labels: ["personal"],
};

test("successful Run is persisted before execution, atomically commits outputs, and replays frozen evidence", async () => {
  await withHarness(async harness => {
    let observedRunBeforeExecute = false;
    harness.operator.behavior = async invocation => {
      observedRunBeforeExecute = (await harness.repository.getRun(invocation.run.id))?.status === "running";
      await invocationEvent(invocation);
      return { status: "succeeded", candidate: candidate(invocation, "view:summary:success"), cost_usd: 0.04 };
    };

    const result = await harness.runtime.execute(request(harness.input, "run:success"));
    assert.equal(observedRunBeforeExecute, true);
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0]?.provenance.operator_run_id, "run:success");
    assert.equal(result.run.total_cost_usd, 0.04);
    const executionEvent = (await harness.repository.listEvents()).find(item => item.event.origin.kind === "execution");
    assert.deepEqual(executionEvent?.event.origin, { kind: "execution", id: "run:success" });
    assert.deepEqual(executionEvent?.event.views.map(item => item.ref), result.outputs.map(exactViewRef));

    const replay = await harness.runtime.replay("run:success");
    assert.deepEqual(replay.run.frozen.inputs[0]?.selected, [exactViewRef(harness.input)]);
    assert.deepEqual(replay.run.frozen.inputs[0]?.sources[0]?.candidates, [exactViewRef(harness.input)]);
    assert.equal(replay.run.frozen.access_policy.configuration.profile, "approve_all");
    assert.equal(replay.attempts.length, 1);
    assert.deepEqual(replay.committed_outputs[0]?.inputs, [exactViewRef(harness.input)]);
    assert.deepEqual(replay.events.map(event => event.type), ["run.created", "attempt.started", "operator.progress", "run.succeeded"]);
    assert.deepEqual(replay.events.map(event => event.sequence), [...replay.events.map(event => event.sequence)].sort((a, b) => a - b));
    assert.equal((await harness.repository.listEvents()).filter(item => item.event.origin.kind === "execution").length, 1);
  });
});

test("Execution freezes the exact Operator into cascade evidence and propagates continue or terminal commits", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = async invocation => ({
      status: "succeeded",
      candidate: candidate(invocation, "view:summary:cascade"),
      cost_usd: 0.25,
    });
    const cascade = {
      attempt_id: "cascade-attempt:execution-success",
      root_correlation_id: "cascade-root:execution",
      root_event_id: "event:root",
      parent_event_id: "event:parent",
      target: {
        automation: { view_id: "automation:summary", revision: 1 },
        transformation: { transformation_id: "transformation:summary", revision: 1 },
      },
      lineage: [exactViewRef(harness.input)],
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
          max_operator_concurrency: 2,
          reservation_lease_ms: 5_000,
        },
      },
      root_started_at: "2026-07-26T12:00:00.000Z",
      attempt_started_at: "2026-07-26T12:00:00.000Z",
      aggregate: { attempts: 1, cost_usd: 0 },
      disposition: "continue" as const,
    };
    const success = await harness.runtime.execute(request(harness.input, "run:cascade-success", { cascade }));
    assert.deepEqual(success.run.frozen.cascade?.target.operator, { id: "operator:test", revision: 1 });
    const successEvent = (await harness.repository.listEvents()).find(item => item.event.origin.id === "run:cascade-success")?.event;
    assert.equal(successEvent?.cascade?.disposition, "continue");
    assert.equal(successEvent?.cascade?.aggregate.cost_usd, 0.25);

    harness.operator.behavior = async () => { throw new Error("cascade worker crash"); };
    const failed = await harness.runtime.execute(request(harness.input, "run:cascade-failed", {
      cascade: { ...cascade, attempt_id: "cascade-attempt:execution-failed" },
    }));
    assert.equal(failed.run.status, "failed");
    const failureEvent = (await harness.repository.listEvents()).find(item => item.event.origin.id === "run:cascade-failed")?.event;
    assert.equal(failureEvent?.cascade?.disposition, "terminal");

    const executionsBeforeStop = harness.operator.executions;
    const stopped = await harness.runtime.execute(request(harness.input, "run:cascade-stopped", {
      cascade: {
        ...cascade,
        attempt_id: "cascade-attempt:execution-stopped",
        disposition: "terminal",
        terminal: {
          code: "depth_exhausted",
          message: "cascade depth exceeds 4",
          stage: "admission",
        },
      },
    }));
    assert.equal(stopped.run.status, "failed");
    assert.equal(stopped.run.error?.code, "cascade_stopped");
    assert.equal(stopped.run.error?.details.terminal_code, "depth_exhausted");
    assert.equal(harness.operator.executions, executionsBeforeStop);
    const stopEvent = (await harness.repository.listEvents()).find(item => item.event.origin.id === "run:cascade-stopped")?.event;
    assert.equal(stopEvent?.cascade?.terminal?.code, "depth_exhausted");
  });
});

test("pre-execution failure commits canonical Run, Failure View, and outbox evidence without invoking a Worker", async () => {
  await withHarness(async harness => {
    const executionsBefore = harness.operator.executions;
    const result = await harness.runtime.execute(request(harness.input, "run:pre-execution-failure", {
      pre_execution_failure: {
        code: "view_access_denied",
        message: "Automation context denied the exact source View",
        stage: "authorization",
        details: { role: "source" },
      },
    }));

    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "pre_execution_failed");
    assert.equal(result.run.error?.stage, "authorization");
    assert.equal(result.run.error?.details.pre_execution_code, "view_access_denied");
    assert.equal(harness.operator.executions, executionsBefore);
    assert.ok(result.failure);
    assert.deepEqual(result.failure?.provenance.inputs, [exactViewRef(harness.input)]);
    const replay = await harness.runtime.replay(result.run.id);
    assert.equal(replay.attempts.length, 0);
    assert.deepEqual(replay.events.map(event => event.type), ["run.created", "run.failed"]);
    assert.equal(
      (await harness.repository.listEvents()).filter(item => item.event.origin.id === result.run.id).length,
      1,
    );
  });
});

test("an abandoned running Run is reconciled to one durable Failure View without reinvoking its Worker", async () => {
  await withHarness(async harness => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    harness.operator.behavior = async invocation => {
      markStarted();
      await blocked;
      return { status: "succeeded", candidate: candidate(invocation, "view:summary:abandoned") };
    };

    const original = harness.runtime.execute(request(harness.input, "run:abandoned"));
    await started;
    assert.equal((await harness.repository.getRun("run:abandoned"))?.status, "running");

    const reconciled = await harness.runtime.reconcileAbandonedRun("run:abandoned", {
      code: "worker_process_abandoned",
      message: "Worker lease expired after process death",
    });
    assert.equal(reconciled.run.status, "failed");
    assert.equal(reconciled.run.error?.code, "worker_process_abandoned");
    assert.ok(reconciled.failure);
    assert.equal(harness.operator.executions, 1);
    assert.equal((await harness.repository.getAttempts("run:abandoned"))[0]?.status, "failed");

    release();
    await assert.rejects(original, /Failure View could not be committed|cannot fail|cannot start|conflict/i);
    const replay = await harness.runtime.replay("run:abandoned");
    assert.equal(replay.run.failure_view?.view_id, reconciled.failure?.id);
    assert.equal((await harness.repository.listEvents()).filter(item => item.event.origin.id === "run:abandoned").length, 1);
  });
});

test("invocation-time exact bindings preserve trigger context even when a newer selector match exists", async () => {
  await withHarness(async harness => {
    const newer = (await harness.repository.commit({
      draft: rawView("view:input:newer-page", {
        observed_at: "2026-07-26T12:30:00.000Z",
        created_at: "2026-07-26T12:30:00.000Z",
      }),
      expected_revision: 0,
    })).view;
    const transformation = transform(harness.input, {
      inputs: [{
        role: "current_page",
        required: true,
        sources: [{
          kind: "selector",
          selector: {
            id: "selector:browser-page",
            revision: 1,
            query: {
              scope: "matching",
              schema_names: ["capture.test"],
              roles: ["raw"],
              revision_scope: "latest",
              order: "newest",
              limit: 10,
              where: {},
            },
          },
        }],
      }],
    });
    harness.operator.behavior = async invocation => {
      assert.deepEqual(invocation.inputs[0]?.views.map(exactViewRef), [exactViewRef(harness.input)]);
      assert.notDeepEqual(exactViewRef(harness.input), exactViewRef(newer));
      return { status: "succeeded", candidate: candidate(invocation, "view:summary:trigger-context") };
    };

    const result = await harness.runtime.execute(request(harness.input, "run:trigger-context", {
      transformation,
      invocation_inputs: [{ role: "current_page", views: [exactViewRef(harness.input)] }],
    }));
    assert.equal(result.run.status, "succeeded");
    assert.deepEqual(result.run.frozen.inputs[0]?.selected, [exactViewRef(harness.input)]);
    assert.deepEqual(result.run.frozen.inputs[0]?.sources[0]?.candidates, [exactViewRef(harness.input)]);
  });
});

test("same Execution idempotency key rejects changed exact invocation evidence", async () => {
  await withHarness(async harness => {
    const second = (await harness.repository.commit({
      draft: rawView("view:input:different-exact-evidence"),
      expected_revision: 0,
    })).view;
    const transformation = transform(harness.input, {
      inputs: [{
        role: "source",
        required: true,
        sources: [{
          kind: "selector",
          selector: {
            id: "selector:any-capture-test",
            revision: 1,
            query: {
              scope: "matching",
              schema_names: ["capture.test"],
              roles: ["raw"],
              revision_scope: "latest",
              order: "newest",
              limit: 10,
              where: {},
            },
          },
        }],
      }],
    });
    const idempotencyKey = "execution:exact-input-replay";
    const first = request(harness.input, "run:exact-input-replay", {
      transformation,
      idempotency_key: idempotencyKey,
      invocation_inputs: [{ role: "source", views: [exactViewRef(harness.input)] }],
    });
    const result = await harness.runtime.execute(first);
    assert.equal(result.run.status, "succeeded");

    await assert.rejects(
      harness.runtime.execute({
        ...first,
        invocation_inputs: [{ role: "source", views: [exactViewRef(second)] }],
      }),
      (error: unknown) => error instanceof Error
        && Reflect.get(error, "code") === "idempotency_conflict",
    );
    assert.equal(harness.operator.executions, 1);
  });
});

test("existing AgentExecutionAdapter crosses the canonical bridge and commits a Derived View", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-agent-bridge-"));
  const repository = new SqliteViewRepository(join(directory, "agent.sqlite"));
  try {
    const sourceDraft = rawView("view:agent:context");
    sourceDraft.policy = { ...privatePolicy, allow_external_model: true };
    sourceDraft.representation = {
      form: "inline",
      kind: "browser_page",
      value: {
        url: "https://example.com/exact-page",
        title: "Exact captured page",
        text: "This exact page text must reach the Agent runtime.",
      },
      metadata: {},
    };
    const source = (await repository.commit({ draft: sourceDraft, expected_revision: 0 })).view;
    const inspectingRuntime = new InspectingAgentRuntime();
    const agentPort = new AgentExecutionAdapter({
      runtimes: [inspectingRuntime],
      default_runtime: inspectingRuntime.id,
      now: () => new Date("2026-07-26T12:00:02.000Z"),
    });
    const bridge = new AgentOperatorExecutionBridge(agentPort, {
      now: () => "2026-07-26T12:00:03.000Z",
    });
    const runtime = new ExecutionRuntime(
      repository,
      repository,
      new DeterministicViewAccessAuthorizer(),
      bridge,
      undefined,
      { now: deterministicClock(), id: kind => `${kind}:agent-bridge` },
    );
    const transformation = transform(source, {
      id: "transformation:agent-summary",
      name: "Agent summary",
      operator: {
        id: "operator:agent-summary",
        revision: 1,
        reference: { kind: "agent", adapter: "agent-execution" },
        configuration: {
          runtime_override: inspectingRuntime.id,
          current_context: {
            screen: { title: "stale configured title", url: "https://stale.example" },
            raw: { configured: true },
          },
        },
        required_capabilities: [],
      },
      inputs: [{ role: "current_page", required: true, sources: [{ kind: "view", ref: exactViewRef(source) }] }],
      output: {
        schema: { name: "analysis.agent_summary", version: 1, mode: "freeform" },
        schema_origin: "declared",
        cardinality: { min: 1, max: 1 },
      },
    });
    const result = await runtime.execute(request(source, "run:agent-bridge", {
      transformation,
      access_use: "external_model",
    }));
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0]?.schema.name, "analysis.agent_summary");
    assert.equal(result.outputs[0]?.provenance.operator_run_id, "run:agent-bridge");
    assert.match(JSON.stringify(result.outputs[0]?.representation), /Agent runtime: inspecting/);
    assert.equal(inspectingRuntime.receivedExactText, true);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("zero-input schema_value Agent output is validated and committed only by Execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-zero-input-agent-"));
  const repository = new SqliteViewRepository(join(directory, "agent.sqlite"));
  const agentRuntime = new SchemaValueAgentRuntime({
    headline: "Daily English plan",
    tags: ["reading", "listening"],
  });
  try {
    const bridge = new AgentOperatorExecutionBridge(new AgentExecutionAdapter({
      runtimes: [agentRuntime],
      default_runtime: agentRuntime.id,
      now: () => new Date("2026-07-26T12:20:02.000Z"),
    }), {
      now: () => "2026-07-26T12:20:03.000Z",
      output_view_id: () => "view:learning:daily-plan",
    });
    const runtime = new ExecutionRuntime(
      repository,
      repository,
      new DeterministicViewAccessAuthorizer(),
      bridge,
      undefined,
      { now: deterministicClock(), id: kind => `${kind}:zero-input-agent` },
    );
    assert.equal(await repository.getLatest("view:learning:daily-plan"), undefined);

    const result = await runtime.execute(zeroInputAgentRequest("run:zero-input-agent", agentRuntime.id));

    assert.equal(result.run.status, "succeeded");
    assert.deepEqual(result.run.frozen.output_policy, externalModelPolicy);
    assert.equal(result.run.frozen.inputs.length, 0);
    assert.equal(result.outputs.length, 1);
    assert.deepEqual(result.outputs[0]?.representation, {
      form: "inline",
      kind: "agent_output",
      value: { headline: "Daily English plan", tags: ["reading", "listening"] },
      metadata: {},
    });
    assert.deepEqual(result.outputs[0]?.policy, externalModelPolicy);
    assert.deepEqual(result.outputs[0]?.provenance.inputs, []);
    assert.equal(result.outputs[0]?.provenance.operator_run_id, "run:zero-input-agent");
    assert.equal(agentRuntime.sawSchemaValueContract, true);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema-invalid schema_value output becomes Failure evidence without a target View", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-invalid-schema-value-agent-"));
  const repository = new SqliteViewRepository(join(directory, "agent.sqlite"));
  const agentRuntime = new SchemaValueAgentRuntime({ headline: 42, tags: "reading" });
  try {
    const bridge = new AgentOperatorExecutionBridge(new AgentExecutionAdapter({
      runtimes: [agentRuntime],
      default_runtime: agentRuntime.id,
    }), { output_view_id: () => "view:learning:invalid-plan" });
    const runtime = new ExecutionRuntime(
      repository,
      repository,
      new DeterministicViewAccessAuthorizer(),
      bridge,
      undefined,
      { now: deterministicClock(), id: kind => `${kind}:invalid-schema-value-agent` },
    );

    const result = await runtime.execute(zeroInputAgentRequest("run:invalid-schema-value-agent", agentRuntime.id));

    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "candidate_invalid");
    assert.equal(await repository.getLatest("view:learning:invalid-plan"), undefined);
    assert.equal(result.failure?.schema.name, "metaflow.execution.failure");
    assert.deepEqual(result.failure?.policy, externalModelPolicy);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conflicting output_policy and legacy failure_policy fail before Run creation", async () => {
  await withHarness(async harness => {
    await assert.rejects(
      harness.runtime.execute(request(harness.input, "run:conflicting-output-policy", {
        output_policy: privatePolicy,
        failure_policy: { ...privatePolicy, retention: "archive" },
      })),
      (error: unknown) => error instanceof Error
        && Reflect.get(error, "code") === "policy_mismatch"
        && /output_policy and legacy failure_policy/.test(error.message),
    );
    assert.equal(await harness.repository.getRun("run:conflicting-output-policy"), undefined);
    assert.equal(harness.operator.executions, 0);
  });
});

test("Agent bridge bounds large inline evidence while preserving exact refs and external references", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-agent-context-budget-"));
  const repository = new SqliteViewRepository(join(directory, "agent.sqlite"));
  try {
    const pageDraft = rawView("view:agent:large-page");
    pageDraft.policy = { ...privatePolicy, allow_external_model: true };
    pageDraft.representation = {
      form: "inline",
      kind: "browser_page",
      value: {
        url: "https://example.com/large-page",
        title: "Large captured page",
        text: "page-evidence-".repeat(2_000),
      },
      metadata: {},
    };
    const page = (await repository.commit({ draft: pageDraft, expected_revision: 0 })).view;
    const externalDraft = rawView("view:agent:external-document");
    externalDraft.policy = { ...privatePolicy, allow_external_model: true };
    externalDraft.representation = {
      form: "external_reference",
      kind: "document",
      uri: "https://example.com/documents/architecture.pdf",
      media_type: "application/pdf",
      metadata: {},
    };
    externalDraft.materialization.primary = {
      id: "source-pdf",
      format: "pdf",
      media_type: "application/pdf",
      location: { kind: "uri", uri: "https://example.com/documents/architecture.pdf" },
    };
    const external = (await repository.commit({ draft: externalDraft, expected_revision: 0 })).view;
    const inspectingRuntime = new BoundedContextAgentRuntime();
    const bridge = new AgentOperatorExecutionBridge(new AgentExecutionAdapter({
      runtimes: [inspectingRuntime],
      default_runtime: inspectingRuntime.id,
      now: () => new Date("2026-07-26T12:10:02.000Z"),
    }), { now: () => "2026-07-26T12:10:03.000Z" });
    const runtime = new ExecutionRuntime(
      repository,
      repository,
      new DeterministicViewAccessAuthorizer(),
      bridge,
      undefined,
      { now: deterministicClock(), id: kind => `${kind}:agent-context-budget` },
    );
    const transformation = transform(page, {
      id: "transformation:bounded-agent-context",
      name: "Bounded Agent context",
      operator: {
        id: "operator:bounded-agent-context",
        revision: 1,
        reference: { kind: "agent", adapter: "agent-execution" },
        configuration: {
          runtime_override: inspectingRuntime.id,
          current_context: { screen: { text: "stale configured page text" } },
        },
        required_capabilities: [],
      },
      inputs: [
        { role: "current_page", required: true, sources: [{ kind: "view", ref: exactViewRef(page) }] },
        { role: "reference", required: true, sources: [{ kind: "view", ref: exactViewRef(external) }] },
      ],
      output: {
        schema: { name: "analysis.bounded_context", version: 1, mode: "freeform" },
        schema_origin: "declared",
        cardinality: { min: 1, max: 1 },
      },
      budget: {
        id: "budget:bounded-agent-context",
        revision: 1,
        limits: { max_input_tokens: 1_000 },
        extensions: {},
      },
    });

    const result = await runtime.execute(request(page, "run:bounded-agent-context", {
      transformation,
      access_use: "external_model",
    }));
    assert.equal(result.run.status, "succeeded");
    const context = inspectingRuntime.currentContext;
    assert.ok(context);
    assert.ok(JSON.stringify(context).length <= 4_000);
    assert.doesNotMatch(JSON.stringify(context), /stale configured page text/);
    const evidence = context.raw?.metaflow_inputs as Array<{
      role: string;
      ref: { view_id: string; revision: number };
      representation: {
        form: string;
        uri?: string;
        truncated?: boolean;
        preview?: string;
        original_characters?: number;
      };
    }>;
    assert.deepEqual(evidence.map(item => item.ref), [exactViewRef(page), exactViewRef(external)]);
    assert.equal(evidence[0]?.representation.truncated, true);
    assert.ok((evidence[0]?.representation.original_characters ?? 0) > 20_000);
    assert.match(evidence[0]?.representation.preview ?? "", /page-evidence/);
    assert.equal(evidence[1]?.representation.form, "external_reference");
    assert.equal(evidence[1]?.representation.uri, "https://example.com/documents/architecture.pdf");
    assert.deepEqual(context.raw?.metaflow_context_budget, { max_characters: 4_000, truncated: true });
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mixed authorization rejection never calls the Operator or partially discloses allowed Views", async () => {
  await withHarness(async harness => {
    const second = await harness.repository.commit({ draft: rawView("view:input:denied"), expected_revision: 0 });
    const transformation = transform(harness.input, {
      inputs: [{
        role: "context",
        required: true,
        sources: [
          { kind: "view", ref: exactViewRef(harness.input) },
          { kind: "view", ref: exactViewRef(second.view) },
        ],
      }],
    });
    const denied = request(harness.input, "run:denied", { transformation });
    denied.access_policy.configuration.rules = [{
      id: "deny:second",
      effect: "deny",
      target: { kind: "view", ref: exactViewRef(second.view) },
      reason: "Exercise mixed-input fail closed behavior",
    }];

    const result = await harness.runtime.execute(denied);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "authorization_denied");
    assert.equal(harness.operator.executions, 0);
    assert.equal(result.failure?.schema.name, "metaflow.execution.failure");
    assert.deepEqual(result.failure?.provenance.inputs, [exactViewRef(second.view), exactViewRef(harness.input)]);
  });
});

test("strict Schema rejection commits a Failure View and no invalid output", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = async invocation => ({
      status: "succeeded",
      candidate: candidate(invocation, "view:summary:invalid", { representationValue: { wrong: true } }),
    });
    const result = await harness.runtime.execute(request(harness.input, "run:schema-rejection"));
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "candidate_invalid");
    assert.equal(await harness.repository.getLatest("view:summary:invalid"), undefined);
    assert.equal(result.failure?.provenance.operator_run_id, "run:schema-rejection");
  });
});

test("a base changed during Operator execution is reported as stale and never overwritten", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = async invocation => {
      await harness.repository.commit({
        draft: outputDraft(invocation, "view:summary:stale", { summary: "concurrent writer" }),
        expected_revision: 0,
      });
      return { status: "succeeded", candidate: candidate(invocation, "view:summary:stale") };
    };
    const result = await harness.runtime.execute(request(harness.input, "run:stale"));
    assert.equal(result.run.error?.code, "stale_base");
    assert.equal((await harness.repository.getLatest("view:summary:stale"))?.revision, 1);
    assert.equal(result.failure?.schema.name, "metaflow.execution.failure");
  });
});

test("explicit cancellation is observable and routes cancel to the active attempt", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = () => new Promise<OperatorExecutionResult>(() => undefined);
    const controller = new AbortController();
    controller.abort();
    const result = await harness.runtime.execute(request(harness.input, "run:cancelled"), { signal: controller.signal });
    assert.equal(result.run.status, "cancelled");
    assert.equal(result.run.error?.code, "cancelled");
    assert.equal(harness.operator.cancelled.length, 1);
    assert.equal((await harness.repository.getAttempts(result.run.id))[0]?.status, "cancelled");
  });
});

test("timeout is enforced from the frozen budget and remains a terminal trace event", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = () => new Promise<OperatorExecutionResult>(() => undefined);
    const transformation = transform(harness.input, {
      budget: { id: "budget:short", revision: 1, limits: { timeout_ms: 2 }, extensions: {} },
    });
    const result = await harness.runtime.execute(request(harness.input, "run:timeout", { transformation }));
    assert.equal(result.run.status, "timed_out");
    assert.equal(result.run.error?.code, "timeout");
    assert.equal((await harness.repository.getTrace(result.run.id)).at(-1)?.type, "run.timed_out");
  });
});

test("adapter crash becomes structured Failure evidence instead of an untracked rejection", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = async () => {
      throw new Error("adapter process exited 17");
    };
    const result = await harness.runtime.execute(request(harness.input, "run:crash"));
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "operator_crashed");
    assert.match(result.run.error?.message ?? "", /exited 17/);
  });
});

test("Operator failure details cannot overwrite the trusted runtime code", async () => {
  await withHarness(async harness => {
    harness.operator.behavior = async () => ({
      status: "failed",
      error: {
        code: "trusted_operator_code",
        message: "typed failure",
        details: { operator_code: "spoofed", provider_status: "rejected" },
      },
    });
    const result = await harness.runtime.execute(request(harness.input, "run:failure-code"));
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "operator_failed");
    assert.equal(result.run.error?.details.operator_code, "trusted_operator_code");
    assert.equal(result.run.error?.details.provider_status, "rejected");
  });
});

test("SQLite failure rolls back every output and then records a separate Failure View", async () => {
  await withHarness(async harness => {
    const db = new DatabaseSync(harness.dbPath);
    db.exec(`
      create trigger reject_second_execution_output
      before insert on view_revisions_v1
      when NEW.id = 'view:rollback:two'
      begin
        select raise(abort, 'forced execution output failure');
      end;
    `);
    db.close();
    harness.operator.behavior = async invocation => ({
      status: "succeeded",
      candidate: {
        outputs: [
          { draft: outputDraft(invocation, "view:rollback:one"), expected_revision: 0 },
          { draft: outputDraft(invocation, "view:rollback:two"), expected_revision: 0 },
        ],
      },
    });
    const transformation = transform(harness.input, {
      output: { schema: outputSchema, schema_origin: "declared", cardinality: { min: 2, max: 2 } },
    });

    const result = await harness.runtime.execute(request(harness.input, "run:rollback", { transformation }));
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "commit_failed");
    assert.equal(await harness.repository.getLatest("view:rollback:one"), undefined);
    assert.equal(await harness.repository.getLatest("view:rollback:two"), undefined);
    assert.equal(result.failure?.id, "view:failure:run:rollback");
  });
});

test("an alternative execution links to an explicit prior attempt rather than hiding fallback", async () => {
  await withHarness(async harness => {
    const first = await harness.runtime.execute(request(harness.input, "run:first"));
    const firstAttempt = (await harness.repository.getAttempts(first.run.id))[0]!;
    const second = await harness.runtime.execute(request(harness.input, "run:alternative", {
      previous_attempt_id: firstAttempt.id,
    }));
    const secondAttempt = (await harness.repository.getAttempts(second.run.id))[0]!;
    assert.equal(secondAttempt.previous_attempt_id, firstAttempt.id);
  });
});

type Harness = {
  directory: string;
  dbPath: string;
  repository: SqliteViewRepository;
  runtime: ExecutionRuntime;
  operator: FakeOperator;
  input: View;
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-execution-"));
  const dbPath = join(directory, "execution.sqlite");
  const repository = new SqliteViewRepository(dbPath);
  const operator = new FakeOperator();
  const clock = deterministicClock();
  let id = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    operator,
    undefined,
    { now: clock, id: kind => `${kind}:test:${++id}` },
  );
  try {
    const input = (await repository.commit({ draft: rawView(), expected_revision: 0 })).view;
    await run({ directory, dbPath, repository, runtime, operator, input });
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

class FakeOperator implements OperatorExecutionPort {
  executions = 0;
  cancelled: string[] = [];
  behavior: (invocation: OperatorExecutionInvocation) => Promise<OperatorExecutionResult> = async invocation => ({
    status: "succeeded",
    candidate: candidate(invocation, `view:summary:${invocation.run.id}`),
  });

  async execute(invocation: OperatorExecutionInvocation, context: Parameters<OperatorExecutionPort["execute"]>[1]) {
    this.executions += 1;
    Reflect.set(invocation, "emit", context.emit);
    return this.behavior(invocation);
  }

  async cancel(attemptId: string): Promise<void> {
    this.cancelled.push(attemptId);
  }
}

class InspectingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "inspecting";
  readonly kind = "mock" as const;
  receivedExactText = false;

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    const serialized = JSON.stringify(task.currentContext);
    assert.match(serialized, /This exact page text must reach the Agent runtime\./);
    assert.equal(task.currentContext?.screen?.url, "https://example.com/exact-page");
    assert.equal(task.currentContext?.screen?.title, "Exact captured page");
    assert.equal(task.currentContext?.screen?.text, "This exact page text must reach the Agent runtime.");
    assert.doesNotMatch(serialized, /https:\/\/stale\.example/);
    assert.equal((task.currentContext?.raw?.configured as boolean | undefined), true);
    const evidence = task.currentContext?.raw?.metaflow_inputs as Array<{
      role: string;
      ref: { view_id: string; revision: number };
      schema: { name: string };
      representation: { value?: { text?: string } };
    }>;
    assert.equal(evidence[0]?.role, "current_page");
    assert.equal(evidence[0]?.schema.name, "capture.test");
    assert.equal(evidence[0]?.representation.value?.text, "This exact page text must reach the Agent runtime.");
    this.receivedExactText = true;
    return {
      ok: true,
      reason: "inspected frozen context",
      output: {
        summary: "Agent consumed exact frozen page text.",
        key_points: ["Agent runtime: inspecting"],
        confidence: 1,
      },
      diagnostics: { runtime: this.id },
    };
  }
}

class BoundedContextAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "bounded-context";
  readonly kind = "mock" as const;
  currentContext?: AgentTaskRequest["currentContext"];

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    this.currentContext = task.currentContext;
    return {
      ok: true,
      reason: "captured bounded context",
      output: { summary: "Bounded context consumed.", confidence: 1 },
      diagnostics: { runtime: this.id },
    };
  }
}

class SchemaValueAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "schema-value-agent";
  readonly kind = "mock" as const;
  sawSchemaValueContract = false;

  constructor(private readonly value: unknown) {}

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    assert.equal(task.outputContract.mode, "schema_value");
    assert.equal(task.outputContract.viewType, "learning.daily_plan");
    this.sawSchemaValueContract = true;
    return {
      ok: true,
      reason: "returned an untrusted Schema value",
      schemaValue: this.value as never,
      diagnostics: { runtime: this.id },
    };
  }
}

async function invocationEvent(invocation: OperatorExecutionInvocation): Promise<void> {
  const emit = Reflect.get(invocation, "emit") as ((event: { type: string; payload: { phase: string } }) => Promise<void>);
  await emit({ type: "operator.progress", payload: { phase: "summarizing" } });
}

function request(input: View, runId: string, overrides: Partial<StartExecutionInput> = {}): StartExecutionInput {
  return {
    run_id: runId,
    correlation_id: `correlation:${runId}`,
    transformation: transform(input),
    access_policy: {
      id: "policy:approve-all",
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    access_use: "local_execution",
    ...overrides,
  };
}

const externalModelPolicy: ViewPolicy = {
  ...privatePolicy,
  allow_external_model: true,
};

function zeroInputAgentRequest(runId: string, runtimeId: string): StartExecutionInput {
  return {
    run_id: runId,
    correlation_id: `correlation:${runId}`,
    transformation: {
      id: "transformation:daily-learning-plan",
      revision: 1,
      name: "Daily learning plan",
      instruction: { format: "natural_language", text: "Create today's English learning plan.", parameters: {} },
      operator: {
        id: "operator:daily-learning-plan",
        revision: 1,
        reference: { kind: "agent", adapter: "agent-execution" },
        configuration: {
          runtime_override: runtimeId,
          output_mode: "schema_value",
        },
        required_capabilities: [],
      },
      inputs: [],
      output: {
        schema: {
          name: "learning.daily_plan",
          version: 1,
          mode: "strict",
          dialect: "https://json-schema.org/draft/2020-12/schema",
          json_schema: {
            type: "object",
            required: ["headline", "tags"],
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
        schema_origin: "declared",
        cardinality: { min: 1, max: 1 },
      },
      policy: {
        id: "policy:approve-all",
        revision: 1,
        configuration: { kind: "view_access", profile: "approve_all", rules: [] },
      },
      created_at: "2026-07-26T12:20:00.000Z",
      metadata: {},
    },
    access_policy: {
      id: "policy:approve-all",
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    access_use: "external_model",
    output_policy: externalModelPolicy,
  };
}

function transform(input: View, overrides: Partial<Transformation> = {}): Transformation {
  return {
    id: "transformation:summary",
    revision: 1,
    name: "Summarize selected evidence",
    instruction: { format: "natural_language", text: "Summarize the selected evidence.", parameters: {} },
    operator: {
      id: "operator:test",
      revision: 1,
      reference: { kind: "function", function_id: "test.summary", version: 1 },
      configuration: {},
      required_capabilities: [],
    },
    inputs: [{ role: "source", required: true, sources: [{ kind: "view", ref: exactViewRef(input) }] }],
    output: { schema: outputSchema, schema_origin: "declared", cardinality: { min: 1, max: 1 } },
    policy: {
      id: "policy:approve-all",
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    created_at: "2026-07-26T12:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function candidate(
  invocation: OperatorExecutionInvocation,
  id: string,
  options: { representationValue?: unknown } = {},
) {
  return {
    outputs: [{
      draft: outputDraft(invocation, id, options.representationValue ?? { summary: `Summary for ${id}` }),
      expected_revision: 0,
    }],
  };
}

function outputDraft(invocation: OperatorExecutionInvocation, id: string, value: unknown = { summary: "summary" }): ViewDraft {
  const inputRefs = invocation.inputs.flatMap(binding => binding.views.map(view => exactViewRef(view)));
  return {
    id,
    name: id,
    purpose: "Summarize source evidence",
    aliases: [],
    schema: outputSchema,
    role: "derived",
    time: { created_at: "2026-07-26T12:00:01.000Z" },
    representation: { form: "inline", kind: "json", value: value as never, metadata: {} },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
      alternatives: [],
    },
    relations: inputRefs.map(ref => ({ type: "derived_from", target: ref, metadata: {} })),
    provenance: {
      inputs: inputRefs,
      operator_run_id: invocation.run.id,
      actor: "operator:test",
      trace_id: invocation.run.trace_id,
    },
    policy: privatePolicy,
    metadata: {},
  };
}

function rawView(
  id = "view:input:source",
  time: { observed_at?: string; created_at?: string } = {},
): ViewDraft {
  return {
    id,
    name: "Captured source",
    purpose: "Test source evidence",
    aliases: [],
    schema: { name: "capture.test", version: 1, mode: "freeform" },
    role: "raw",
    time: {
      observed_at: time.observed_at ?? "2026-07-26T11:59:00.000Z",
      created_at: time.created_at ?? "2026-07-26T12:00:00.000Z",
    },
    representation: { form: "inline", kind: "text", value: "source evidence", metadata: {} },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
      alternatives: [],
    },
    relations: [],
    provenance: {
      inputs: [],
      capture: {
        connector: "test",
        connection_id: "test:default",
        source_id: id,
        source_kind: "fixture",
        identity: "occurrence",
        assertion: "direct",
      },
      actor: "capture-ingress",
    },
    policy: privatePolicy,
    metadata: {},
  };
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T12:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FunctionRef,
  RegisterFunctionOptions,
  TriggerRequest,
} from "iii-sdk";
import {
  type AutomationInvocationAdmissionResult,
  type AutomationInvocationInput,
  parseAutomationView,
} from "@info/automation";
import {
  AgentOperatorExecutionBridge,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  type AgentOperatorInvocation,
  type AgentOperatorPort,
  type AgentOperatorResult,
  type OperatorExecutionInvocation,
  type OperatorExecutionPort,
  type OperatorExecutionResult,
} from "@info/execution";
import { parseTransformation, type OperatorSnapshot, type Transformation } from "@info/transformation";
import {
  exactViewRef,
  parseView,
  type ExactViewRef,
  type View,
  type ViewDraft,
} from "@info/view";
import { SqliteViewRepository } from "../packages/adapters/storage-sqlite/index.ts";
import { SqliteReactiveCascadeLedger } from "../packages/adapters/automation-sqlite/index.ts";
import {
  AutomationCascadeTerminalizer,
  InMemoryTransformationCatalog,
} from "../packages/adapters/automation-execution/index.ts";
import { FunctionOperatorAdapter } from "../packages/adapters/function-operator/index.ts";
import {
  MARKDOWN_PARSER_FUNCTION,
  executeMarkdownParser,
} from "../packages/adapters/markdown-parser/index.ts";
import { obsidianMarkdownParserTransformation } from "../apps/ambient-daemon/definitions.ts";
import {
  III_AUTOMATION_FUNCTION_ID,
  III_ENGINE_VERSION,
  IiiAutomationInvocationEnvelopeSchema,
  IiiRuntimeError,
  IiiRuntimeWorker,
  METAFLOW_AUTOMATION_QUEUE,
  iiiOperatorFunctionId,
  type IiiClientPort,
  type IiiRuntimeEvent,
} from "../packages/adapters/iii-runtime/index.ts";

const NOW = "2026-07-26T18:00:00.000Z";

test("III Worker registers strict versioned Functions and fails startup on incompatible engine, SDK, or queue config", async () => {
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  const worker = await startWorker(engine, automation, async () => ignored(), events);
  try {
    const registration = engine.functions.get(III_AUTOMATION_FUNCTION_ID);
    assert.ok(registration);
    assert.equal(registration.options?.metadata?.metaflow_contract, "metaflow.automation.invoke.v1");
    assert.deepEqual(registration.options?.metadata?.queue, {
      name: METAFLOW_AUTOMATION_QUEUE.name,
      config_version: METAFLOW_AUTOMATION_QUEUE.version,
    });
    assert.equal(registration.options?.metadata?.function_abi_version, 1);
    assert.deepEqual(registration.options?.metadata?.capabilities, ["descriptor_only", "durable_queue", "retry", "dlq"]);
    assert.match(String((registration.options?.metadata?.input_contract as { schema_sha256?: unknown })?.schema_sha256), /^[a-f0-9]{64}$/);
    assert.match(String((registration.options?.metadata?.output_contract as { schema_sha256?: unknown })?.schema_sha256), /^[a-f0-9]{64}$/);
    assert.deepEqual(registration.options?.request_format?.required, [
      "schema_version",
      "contract",
      "message_id",
      "correlation_id",
      "queue",
      "automation",
      "signal",
    ]);
    await assert.rejects(
      engine.invoke(III_AUTOMATION_FUNCTION_ID, { schema_version: 1, unexpected: true }),
      /contract|Required/,
    );
    const unsafe = IiiAutomationInvocationEnvelopeSchema.parse({
      ...queuedEnvelope(automation),
      signal: { ...queuedEnvelope(automation).signal, payload: { text: "private raw text" } },
    });
    await assert.rejects(
      engine.invoke(III_AUTOMATION_FUNCTION_ID, unsafe),
      (error: unknown) => error instanceof IiiRuntimeError && error.code === "signal_payload_not_descriptor_safe",
    );
    assert.equal(events.some(event => event.type === "iii.worker.compatibility_verified"), true);
    assert.equal(events.some(event => event.type === "iii.worker.readiness_verified"), true);
    assert.equal(events.some(event => event.type === "iii.worker.registered"), true);
    assert.equal(process.env.III_DISABLE_TRACE_PAYLOADS, "true");

    engine.functionInfoMutator = detail => ({
      ...detail,
      metadata: { ...(detail.metadata as Record<string, unknown>), function_abi_version: 99 },
    });
    await assert.rejects(
      worker.verifyReadiness(),
      (error: unknown) => error instanceof IiiRuntimeError && error.code === "function_contract_incompatible",
    );
    engine.functionInfoMutator = undefined;
  } finally {
    await worker.close();
  }

  const oldEngine = new FakeIiiEngine("0.18.0");
  await assert.rejects(
    startWorker(oldEngine, automation, async () => ignored(), []),
    (error: unknown) => error instanceof IiiRuntimeError && error.code === "engine_version_incompatible",
  );

  const wrongQueue = new FakeIiiEngine(III_ENGINE_VERSION, 10);
  await assert.rejects(
    startWorker(wrongQueue, automation, async () => ignored(), []),
    (error: unknown) => error instanceof IiiRuntimeError && error.code === "queue_config_incompatible",
  );
  assert.equal(oldEngine.shutdowns, 1);

  await assert.rejects(
    IiiRuntimeWorker.start({
      engine_url: "ws://fake",
      sdk_version: "0.22.0",
      views: viewReader([automation.view]),
      automations: { invoke: async () => ignored() },
      events: { emit() {} },
      client_factory: () => engine.client(),
    }),
    (error: unknown) => error instanceof IiiRuntimeError && error.code === "sdk_version_incompatible",
  );

  await assert.rejects(
    IiiRuntimeWorker.start({
      engine_url: "ws://fake",
      queue: { ...METAFLOW_AUTOMATION_QUEUE, concurrency: 99 },
      views: viewReader([automation.view]),
      automations: { invoke: async () => ignored() },
      events: { emit() {} },
      client_factory: () => engine.client(),
    }),
    (error: unknown) => error instanceof IiiRuntimeError && error.code === "queue_config_incompatible",
  );

  const config = JSON.parse(readFileSync(
    join(process.cwd(), "packages/adapters/iii-runtime/iii-config.yaml"),
    "utf8",
  )) as { workers: Array<{ config: Record<string, unknown> }> };
  assert.deepEqual(config.workers[0]?.config.queue_configs, {
    "metaflow-automation-v1": {
      max_retries: 3,
      concurrency: 4,
      type: "standard",
      backoff_ms: 1000,
      poll_interval_ms: 100,
    },
  });
  assert.equal(JSON.stringify(config).includes("file_based"), true);
});

test("Automation admission enqueues exact evidence, records receipts, and leaves duplicate ownership to Automation Runtime", async () => {
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  let calls = 0;
  const worker = await startWorker(engine, automation, async input => {
    calls += 1;
    return calls === 1
      ? succeeded(input, "run:queue:first")
      : {
          status: "duplicate",
          correlation_id: correlation(input),
          existing_status: "succeeded",
        };
  }, events);
  try {
    const invocation = automationInvocation(automation);
    const first = await worker.automationQueue.invoke(invocation);
    const second = await worker.automationQueue.invoke(invocation);
    assert.equal(first.status, "enqueued");
    assert.equal(second.status, "enqueued");
    assert.notEqual(first.status === "enqueued" ? first.receipt_id : "", second.status === "enqueued" ? second.receipt_id : "");
    assert.equal(engine.queue.length, 2);
    const firstEnvelope = IiiAutomationInvocationEnvelopeSchema.parse(engine.queue[0]?.payload);
    const secondEnvelope = IiiAutomationInvocationEnvelopeSchema.parse(engine.queue[1]?.payload);
    assert.equal(firstEnvelope.message_id, secondEnvelope.message_id);
    assert.deepEqual(firstEnvelope.signal.evidence, invocation.signal.evidence);
    assert.deepEqual(firstEnvelope.automation, exactViewRef(automation.view));

    await assert.rejects(
      worker.automationQueue.invoke({
        ...invocation,
        signal: { ...invocation.signal, payload: { text: "raw private page content" } },
      }),
      (error: unknown) => error instanceof IiiRuntimeError && error.code === "signal_payload_not_descriptor_safe",
    );
    assert.equal(engine.queue.length, 2);

    await engine.drainAll();
    assert.equal(calls, 2);
    assert.equal(events.filter(event => event.type === "iii.queue.enqueued").length, 2);
    assert.equal(events.some(event => event.type === "iii.queue.duplicate"), true);
    assert.equal(events.filter(event => event.receipt_id).length, 2);
  } finally {
    await worker.close();
  }
});

test("III queue retries the same correlated message and preserves queued work across Worker restart", async () => {
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  let attempts = 0;
  let first = await startWorker(engine, automation, async input => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary Automation store outage");
    return succeeded(input, "run:retry");
  }, events);
  await first.automationQueue.invoke(automationInvocation(automation));
  await engine.drainAll();
  assert.equal(attempts, 2);
  const received = events.filter(event => event.type === "iii.queue.received");
  assert.equal(received.length, 2);
  assert.equal(new Set(received.map(event => event.message_id)).size, 1);
  assert.equal(events.some(event => event.type === "iii.queue.retryable_failure"), true);

  await first.automationQueue.invoke(automationInvocation(automation, "signal:restart"));
  assert.equal(engine.queue.length, 1);
  await first.close();
  assert.equal(engine.functions.has(III_AUTOMATION_FUNCTION_ID), false);

  let recovered = 0;
  const second = await startWorker(engine, automation, async input => {
    recovered += 1;
    return succeeded(input, "run:restart");
  }, events);
  try {
    await engine.drainAll();
    assert.equal(recovered, 1);
    assert.equal(engine.queue.length, 0);
  } finally {
    await second.close();
  }
});

test("a duplicate reserved occurrence is retryable and is never acknowledged as completed", async () => {
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  let calls = 0;
  const worker = await startWorker(engine, automation, async input => {
    calls += 1;
    return {
      status: "duplicate",
      correlation_id: correlation(input),
      existing_status: "reserved",
    };
  }, events);
  try {
    await worker.automationQueue.invoke(automationInvocation(automation, "signal:reserved"));
    await engine.drainAll();
    assert.equal(calls, METAFLOW_AUTOMATION_QUEUE.max_retries + 1);
    assert.equal(engine.dlq.length, 1);
    assert.equal(events.some(event => event.type === "iii.queue.completed"), false);
    assert.equal(events.some(event => event.type === "iii.queue.duplicate"), false);
    assert.equal(events.filter(event => event.type === "iii.queue.retryable_failure").length, calls);
  } finally {
    await worker.close();
  }
});

test("exhausted queue work enters the DLQ and inspection emits terminal correlated failure", async () => {
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  const worker = await startWorker(engine, automation, async () => {
    throw new Error("permanent crash");
  }, events);
  try {
    await worker.automationQueue.invoke(automationInvocation(automation, "signal:dlq"));
    await engine.drainAll();
    assert.equal(engine.dlq.length, 1);
    assert.equal(engine.dlq[0]?.retries, METAFLOW_AUTOMATION_QUEUE.max_retries);
    const messages = await worker.inspectDeadLetters();
    assert.equal(messages.length, 1);
    const observed = events.find(event => event.type === "iii.queue.dlq_observed");
    assert.equal(observed?.signal_id, "signal:dlq");
    assert.deepEqual(observed?.automation, exactViewRef(automation.view));
    assert.equal(observed?.payload.retries, METAFLOW_AUTOMATION_QUEUE.max_retries);
  } finally {
    await worker.close();
  }
});

test("DLQ monitoring terminalizes the exact reactive cascade attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-dlq-cascade-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const ledger = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  const input = (await repository.commit({ draft: rawViewDraft(), expected_revision: 0 })).view;
  const dlqTransformation = parseTransformation({
    ...transformation(input, functionOperator("operator:test:iii-dlq"), "summary.iii-dlq"),
    id: "transformation:test:iii",
  });
  let workerExecutions = 0;
  const execution = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    {
      async execute() {
        workerExecutions += 1;
        assert.fail("DLQ terminalization must not invoke an Operator Worker");
      },
      async cancel() {},
    },
    undefined,
    { now: () => NOW, id: kind => `${kind}:iii-dlq` },
  );
  const terminalizer = new AutomationCascadeTerminalizer({
    transformations: new InMemoryTransformationCatalog([dlqTransformation]),
    execution,
    views: repository,
  });
  const cascade = iiiCascade(automation, exactViewRef(input));
  await ledger.reservePlan({ attempts: [cascade], reserved_at: NOW });
  const worker = await startWorker(engine, automation, async () => {
    throw new Error("permanent reactive Worker crash");
  }, events, { cascades: ledger, cascade_terminalizer: terminalizer, dlq_poll_interval_ms: 100 });
  try {
    const invocation = automationInvocation(automation, "signal:dlq-cascade");
    invocation.signal.cascade = cascade;
    await worker.automationQueue.invoke(invocation);
    await engine.drainAll();
    await waitFor(async () => (await ledger.getAttempt(cascade.attempt_id))?.status === "stopped");
    const terminal = await ledger.getAttempt(cascade.attempt_id);
    assert.equal(terminal?.status, "stopped");
    assert.equal(terminal?.error_code, "iii_dlq_terminal");
    assert.match(terminal?.error_message ?? "", /permanent reactive Worker crash/);
    assert.ok(terminal?.run_id);
    const run = await repository.getRun(terminal!.run_id!);
    assert.equal(run?.status, "failed");
    assert.ok(run?.failure_view);
    assert.equal(workerExecutions, 0);
    assert.equal((await repository.listEvents()).filter(item => item.event.origin.id === run?.id).length, 1);
    const terminalEvent = events.find(event => event.type === "iii.queue.dlq_terminalized");
    assert.equal(terminalEvent?.run_id, run?.id);
    assert.deepEqual(terminalEvent?.payload.failure_view, run?.failure_view);
    worker.assertHealthy();
  } finally {
    await worker.close();
    repository.close();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DLQ transport failure preserves an already successful canonical Run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-dlq-success-"));
  const ledger = new SqliteReactiveCascadeLedger(join(directory, "cascade.sqlite"));
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const events: IiiRuntimeEvent[] = [];
  const cascade = iiiCascade(automation, { view_id: "view:evidence", revision: 7 }, {
    attempt_id: "cascade-attempt:iii-dlq-success",
    root_correlation_id: "cascade-root:iii-dlq-success",
    root_event_id: "event:iii-dlq-success",
    parent_event_id: "event:iii-dlq-success",
  });
  await ledger.reservePlan({ attempts: [cascade], reserved_at: NOW });
  await ledger.bindOperator({
    attempt_id: cascade.attempt_id,
    operator: { id: "operator:test:iii-success", revision: 1 },
    run_id: "run:iii:already-succeeded",
    started_at: NOW,
  });
  const worker = await startWorker(engine, automation, async () => {
    throw new Error("queue acknowledgement crashed after Run success");
  }, events, {
    cascades: ledger,
    cascade_terminalizer: {
      async terminalize({ attempt }) {
        assert.equal(attempt.run_id, "run:iii:already-succeeded");
        return {
          status: "succeeded",
          run_id: "run:iii:already-succeeded",
          output_views: [{ view_id: "view:summary:already-succeeded", revision: 1 }],
        };
      },
    },
  });
  try {
    const invocation = automationInvocation(automation, "signal:dlq-success");
    invocation.signal.cascade = cascade;
    await worker.automationQueue.invoke(invocation);
    await engine.drainAll();
    await worker.inspectDeadLetters();
    const terminal = await ledger.getAttempt(cascade.attempt_id);
    assert.equal(terminal?.status, "succeeded");
    assert.equal(terminal?.run_id, "run:iii:already-succeeded");
    assert.equal(terminal?.error_code, undefined);
    const terminalEvent = events.find(event => event.type === "iii.queue.dlq_terminalized");
    assert.equal(terminalEvent?.payload.execution_status, "succeeded");
  } finally {
    await worker.close();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Function and Agent Workers execute through III while Execution Runtime validates and atomically commits Views", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-runtime-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const engine = new FakeIiiEngine();
  const events: IiiRuntimeEvent[] = [];
  const automation = automationView();
  const input = (await repository.commit({ draft: rawViewDraft(), expected_revision: 0 })).view;
  const functionTransformation = transformation(input, functionOperator(), "summary.function");
  const agentTransformation = transformation(input, agentOperator(), "summary.agent");
  const functionPort: OperatorExecutionPort = {
    async execute(invocation) {
      return {
        status: "succeeded",
        candidate: outputCandidate(invocation, `view:function:${invocation.run.id}`, { summary: "Function Worker output" }),
      };
    },
    async cancel() {},
  };
  const agent = new FakeAgentOperator();
  const agentBridge = new AgentOperatorExecutionBridge(agent, {
    now: () => NOW,
    output_view_id: invocation => `view:agent:${invocation.run.id}`,
  });
  const worker = await IiiRuntimeWorker.start({
    engine_url: "ws://fake",
    views: repository,
    automations: { invoke: async () => ignored() },
    operators: [
      {
        operator: functionTransformation.operator,
        port: functionPort,
        formations: [{
          kind: "processor",
          id: "processor.test.function",
          version: 1,
          abi_version: 1,
          transformation: functionTransformation,
        }],
      },
      {
        operator: agentTransformation.operator,
        port: agentBridge,
        formations: [{
          kind: "processor",
          id: "processor.test.agent",
          version: 1,
          abi_version: 1,
          transformation: agentTransformation,
        }],
      },
    ],
    events: { emit: event => { events.push(event); } },
    client_factory: () => engine.client(),
    now: () => NOW,
  });
  let id = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    worker.operatorClient,
    undefined,
    { now: () => NOW, id: kind => `${kind}:iii:${++id}` },
  );
  try {
    assert.equal(engine.functions.has(iiiOperatorFunctionId(functionTransformation.operator)), true);
    assert.equal(engine.functions.has(iiiOperatorFunctionId(agentTransformation.operator)), true);
    const functionMetadata = engine.functions.get(iiiOperatorFunctionId(functionTransformation.operator))?.options?.metadata;
    assert.deepEqual(functionMetadata?.capabilities, ["metaflow.processor"]);
    assert.deepEqual(
      (functionMetadata?.formation_contracts as Array<Record<string, unknown>>)?.map(item => item.id),
      ["processor.test.function"],
    );
    assert.match(String((functionMetadata?.operator as { snapshot_sha256?: unknown })?.snapshot_sha256), /^[a-f0-9]{64}$/);

    const functionResult = await runtime.execute(executionRequest(functionTransformation, "run:iii:function"));
    assert.equal(functionResult.run.status, "succeeded");
    assert.equal(functionResult.outputs[0]?.representation.form, "inline");
    assert.deepEqual(functionResult.outputs[0]?.representation.form === "inline"
      ? functionResult.outputs[0].representation.value
      : undefined, { summary: "Function Worker output" });

    const agentResult = await runtime.execute(executionRequest(agentTransformation, "run:iii:agent"));
    assert.equal(agentResult.run.status, "succeeded");
    assert.equal(agent.executions, 1);
    assert.deepEqual(agentResult.outputs[0]?.provenance.inputs, [exactViewRef(input)]);
    assert.equal(events.some(event => event.type === "iii.operator.received" && event.run_id === "run:iii:agent"), true);
    assert.equal(events.some(event => event.type === "iii.operator.completed" && event.run_id === "run:iii:function"), true);
  } finally {
    await worker.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Markdown Parser is an exact III formation, commits only through Execution, and survives Worker restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-markdown-parser-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const engine = new FakeIiiEngine();
  const source = (await repository.commit({ draft: obsidianMarkdownViewDraft(), expected_revision: 0 })).view;
  const parserTransformation = parseTransformation({
    ...obsidianMarkdownParserTransformation,
    inputs: [{ role: "source", required: true, sources: [{ kind: "view", ref: exactViewRef(source) }] }],
  });
  const parserPort = new FunctionOperatorAdapter([{
    reference: MARKDOWN_PARSER_FUNCTION,
    execute: executeMarkdownParser,
  }]);
  const registration = {
    operator: parserTransformation.operator,
    port: parserPort,
    formations: [{
      kind: "parser" as const,
      id: "parser.markdown",
      version: 1,
      abi_version: 1 as const,
      transformation: parserTransformation,
    }],
  };
  let first = await IiiRuntimeWorker.start({
    engine_url: "ws://fake",
    views: repository,
    automations: { invoke: async () => ignored() },
    operators: [registration],
    events: { emit() {} },
    client_factory: () => engine.client(),
    now: () => NOW,
  });
  try {
    const metadata = engine.functions.get(iiiOperatorFunctionId(parserTransformation.operator))?.options?.metadata;
    assert.deepEqual(metadata?.capabilities, ["metaflow.parser"]);
    assert.deepEqual((metadata?.formation_contracts as Array<Record<string, unknown>>)?.[0]?.transformation, {
      transformation_id: parserTransformation.id,
      revision: parserTransformation.revision,
    });
    const firstRuntime = executionRuntime(repository, first.operatorClient, "parser-first");
    const firstResult = await firstRuntime.execute(executionRequest(parserTransformation, "run:iii:parser:first"));
    assert.equal(firstResult.run.status, "succeeded");
    assert.equal(firstResult.outputs[0]?.schema.name, "metaflow.view.fragment-set");
    assert.equal(firstResult.outputs[0]?.provenance.operator_run_id, firstResult.run.id);
    assert.equal((firstResult.outputs[0]?.representation.form === "inline"
      ? (firstResult.outputs[0].representation.value as { fragments?: unknown[] }).fragments?.length
      : 0), 4);

    await first.close();
    const second = await IiiRuntimeWorker.start({
      engine_url: "ws://fake",
      views: repository,
      automations: { invoke: async () => ignored() },
      operators: [registration],
      events: { emit() {} },
      client_factory: () => engine.client(),
      now: () => NOW,
    });
    first = second;
    await second.verifyReadiness("restart");
    const secondRuntime = executionRuntime(repository, second.operatorClient, "parser-second");
    const secondResult = await secondRuntime.execute(executionRequest(parserTransformation, "run:iii:parser:second"));
    assert.equal(secondResult.run.status, "succeeded");
    assert.notDeepEqual(secondResult.outputs[0] && exactViewRef(secondResult.outputs[0]), firstResult.outputs[0] && exactViewRef(firstResult.outputs[0]));
  } finally {
    await first.close().catch(() => undefined);
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual, committed-View, and scheduled entry points execute one exact III Operator Function", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-entry-points-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const engine = new FakeIiiEngine();
  const automation = automationView();
  const input = (await repository.commit({ draft: rawViewDraft(), expected_revision: 0 })).view;
  const transform = transformation(input, functionOperator("operator:test:entry-points"), "summary.entry-points");
  const executed: string[] = [];
  const port: OperatorExecutionPort = {
    async execute(invocation) {
      executed.push(`${invocation.run.frozen.transformation.operator.id}@${invocation.run.frozen.transformation.operator.revision}`);
      return { status: "succeeded", candidate: outputCandidate(invocation, `view:${invocation.run.id}`, { ok: true }) };
    },
    async cancel() {},
  };
  let runtime: ExecutionRuntime;
  const worker = await IiiRuntimeWorker.start({
    engine_url: "ws://fake",
    views: {
      async get(ref) {
        if (ref.view_id === automation.view.id && ref.revision === automation.view.revision) return automation.view;
        return repository.get(ref);
      },
    },
    automations: {
      async invoke(invocation) {
        const result = await runtime.execute(executionRequest(transform, `run:iii:${invocation.signal.kind}`));
        return succeeded(invocation, result.run.id);
      },
    },
    operators: [{
      operator: transform.operator,
      port,
      formations: [{ kind: "processor", id: "processor.test.entry-points", version: 1, abi_version: 1, transformation: transform }],
    }],
    events: { emit() {} },
    client_factory: () => engine.client(),
    now: () => NOW,
  });
  runtime = executionRuntime(repository, worker.operatorClient, "entry-points");
  try {
    const manual = await runtime.execute(executionRequest(transform, "run:iii:manual"));
    assert.equal(manual.run.status, "succeeded");
    await worker.automationQueue.invoke(automationInvocation(automation, "signal:committed-view"));
    await worker.automationQueue.invoke(scheduledAutomationInvocation(automation));
    await engine.drainAll();
    assert.deepEqual(executed, [
      "operator:test:entry-points@1",
      "operator:test:entry-points@1",
      "operator:test:entry-points@1",
    ]);
    assert.equal(engine.functions.has(iiiOperatorFunctionId(transform.operator)), true);
  } finally {
    await worker.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Execution cancellation crosses the III cancel Function and remains a canonical cancelled Run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-iii-cancel-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const engine = new FakeIiiEngine();
  const input = (await repository.commit({ draft: rawViewDraft(), expected_revision: 0 })).view;
  const transform = transformation(input, functionOperator("operator:test:slow"), "summary.cancelled");
  const slow = new CancellableOperator();
  const worker = await IiiRuntimeWorker.start({
    engine_url: "ws://fake",
    views: repository,
    automations: { invoke: async () => ignored() },
    operators: [{ operator: transform.operator, port: slow }],
    events: { emit() {} },
    client_factory: () => engine.client(),
    now: () => NOW,
  });
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    worker.operatorClient,
    undefined,
    { now: () => NOW, id: kind => `${kind}:cancel` },
  );
  const controller = new AbortController();
  try {
    const pending = runtime.execute(executionRequest(transform, "run:iii:cancel"), { signal: controller.signal });
    await slow.started;
    controller.abort();
    const result = await pending;
    assert.equal(result.run.status, "cancelled");
    assert.equal(result.failure?.schema.name, "metaflow.execution.failure");
    assert.equal(slow.cancelled.length, 1);
    assert.match(slow.cancelled[0] ?? "", /^attempt:/);
  } finally {
    await worker.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

type FunctionRegistration = {
  handler: (input: unknown) => Promise<unknown>;
  options?: RegisterFunctionOptions;
};

type QueueJob = {
  function_id: string;
  queue: string;
  payload: unknown;
  receipt: string;
  attempts: number;
};

class FakeIiiEngine {
  readonly functions = new Map<string, FunctionRegistration>();
  readonly queue: QueueJob[] = [];
  readonly dlq: Array<{
    id: string;
    payload: unknown;
    error: string;
    failed_at: number;
    retries: number;
    size_bytes: number;
  }> = [];
  shutdowns = 0;
  functionInfoMutator?: (detail: Record<string, unknown>) => Record<string, unknown>;
  private receipt = 0;

  constructor(readonly version = III_ENGINE_VERSION, readonly queueConcurrency = 4) {}

  client(): IiiClientPort {
    const owned = new Set<string>();
    return {
      registerFunction: (functionId, handler, options) => {
        if (this.functions.has(functionId)) throw new Error(`duplicate function: ${functionId}`);
        this.functions.set(functionId, { handler, options });
        owned.add(functionId);
        return {
          id: functionId,
          unregister: () => {
            this.functions.delete(functionId);
            owned.delete(functionId);
          },
        } satisfies FunctionRef;
      },
      trigger: async <TInput, TOutput>(request: TriggerRequest<TInput>) => {
        if (request.function_id === "engine::workers::list") {
          return { workers: [{ id: "iii-engine", name: "iii-engine", version: this.version, runtime: "engine", status: "available" }] } as TOutput;
        }
        if (request.function_id === "engine::queue::topic_stats") {
          return { depth: this.queue.length, consumer_count: this.queueConcurrency, dlq_depth: this.dlq.length, config: null } as TOutput;
        }
        if (request.function_id === "engine::functions::info") {
          const functionId = (request.payload as { function_id?: string }).function_id;
          const registration = functionId ? this.functions.get(functionId) : undefined;
          if (!functionId || !registration) throw new Error(`unknown function: ${String(functionId)}`);
          const detail = {
            function_id: functionId,
            worker_name: "metaflow-v1",
            description: registration.options?.description,
            request_schema: registration.options?.request_format,
            response_schema: registration.options?.response_format,
            metadata: registration.options?.metadata,
            registered_triggers: [],
          };
          return (this.functionInfoMutator?.(detail) ?? detail) as TOutput;
        }
        if (request.function_id === "engine::queue::dlq_messages") {
          return this.dlq as TOutput;
        }
        if (request.action?.type === "enqueue") {
          if (!this.functions.has(request.function_id)) throw new Error(`unknown function: ${request.function_id}`);
          const receipt = `receipt:${++this.receipt}`;
          this.queue.push({
            function_id: request.function_id,
            queue: request.action.queue,
            payload: request.payload,
            receipt,
            attempts: 0,
          });
          return { messageReceiptId: receipt } as TOutput;
        }
        return await this.invoke(request.function_id, request.payload) as TOutput;
      },
      shutdown: async () => {
        this.shutdowns += 1;
        for (const id of owned) this.functions.delete(id);
        owned.clear();
      },
    };
  }

  async invoke(functionId: string, input: unknown): Promise<unknown> {
    const registration = this.functions.get(functionId);
    if (!registration) throw new Error(`unknown function: ${functionId}`);
    return registration.handler(input);
  }

  async drainAll(): Promise<void> {
    let deliveries = 0;
    while (this.queue.length > 0) {
      if (++deliveries > 100) throw new Error("fake III queue did not quiesce");
      const job = this.queue.shift()!;
      try {
        await this.invoke(job.function_id, job.payload);
      } catch (error) {
        if (job.attempts < METAFLOW_AUTOMATION_QUEUE.max_retries) {
          this.queue.push({ ...job, attempts: job.attempts + 1 });
        } else {
          this.dlq.push({
            id: `dlq:${job.receipt}`,
            payload: job.payload,
            error: error instanceof Error ? error.message : String(error),
            failed_at: Math.floor(Date.parse(NOW) / 1_000),
            retries: job.attempts,
            size_bytes: Buffer.byteLength(JSON.stringify(job.payload)),
          });
        }
      }
    }
  }
}

async function startWorker(
  engine: FakeIiiEngine,
  automation: ReturnType<typeof automationView>,
  invoke: (input: AutomationInvocationInput) => Promise<AutomationInvocationAdmissionResult>,
  events: IiiRuntimeEvent[],
  options: Pick<Parameters<typeof IiiRuntimeWorker.start>[0], "cascades" | "cascade_terminalizer" | "dlq_poll_interval_ms"> = {},
) {
  return IiiRuntimeWorker.start({
    engine_url: "ws://fake",
    views: viewReader([automation.view]),
    automations: { invoke },
    events: { emit: event => { events.push(event); } },
    client_factory: () => engine.client(),
    now: () => NOW,
    ...options,
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function viewReader(views: View[]) {
  return {
    async get(ref: ExactViewRef) {
      return views.find(view => view.id === ref.view_id && view.revision === ref.revision);
    },
  };
}

function automationView() {
  const view = parseView({
    ...rawViewDraft(),
    id: "automation:test:iii",
    name: "III test Automation",
    schema: {
      name: "metaflow.automation",
      version: 1,
      mode: "strict",
      dialect: "https://json-schema.org/draft/2020-12/schema",
      json_schema: { type: "object" },
    },
    role: "derived",
    representation: {
      form: "inline",
      kind: "automation",
      value: {
        version: 1,
        enabled: true,
        trigger: { id: "trigger:iii", kind: "event", source: "metaflow.view", event: "view.committed" },
        target: { kind: "transformation", transformation_id: "transformation:test:iii", revision: 1 },
        input_mapping: [],
        delivery: [],
        limits: { dedupe_window_ms: 0, cooldown_ms: 0, max_concurrency: 1 },
      },
      metadata: {},
    },
    provenance: { inputs: [], actor: "test" },
    revision: 1,
  });
  return parseAutomationView(view);
}

function automationInvocation(
  automation: ReturnType<typeof automationView>,
  signalId = "signal:iii",
): AutomationInvocationInput {
  return {
    automation,
    signal: {
      id: signalId,
      kind: "event",
      source: "metaflow.view",
      event: "view.committed",
      occurred_at: NOW,
      idempotency_key: `idempotency:${signalId}`,
      evidence: [{ view_id: "view:evidence", revision: 7 }],
      payload: {
        view: {
          ref: { view_id: "view:evidence", revision: 7 },
          schema: { name: "capture.browser.page_snapshot", version: 1 },
          representation: { form: "inline", kind: "capture.browser.page_snapshot", access: "descriptor" },
        },
      },
    },
  };
}

function iiiCascade(
  automation: ReturnType<typeof automationView>,
  evidence: ExactViewRef,
  overrides: Record<string, unknown> = {},
) {
  return {
    attempt_id: "cascade-attempt:iii-dlq",
    root_correlation_id: "cascade-root:iii-dlq",
    root_event_id: "event:iii-dlq",
    parent_event_id: "event:iii-dlq",
    target: {
      automation: exactViewRef(automation.view),
      transformation: { transformation_id: "transformation:test:iii", revision: 1 },
    },
    lineage: [evidence],
    depth: 1,
    fan_out_index: 0,
    fan_out_total: 1,
    semantic_fingerprints: ["d".repeat(64)],
    policy: {
      id: "policy:iii-dlq",
      revision: 1,
      limits: {
        max_depth: 4,
        max_fan_out: 4,
        max_total_attempts: 16,
        max_total_cost_usd: 10,
        max_elapsed_ms: 60_000,
        max_operator_concurrency: 2,
        reservation_lease_ms: 1_000,
      },
    },
    root_started_at: NOW,
    attempt_started_at: NOW,
    aggregate: { attempts: 1, cost_usd: 0 },
    disposition: "continue" as const,
    ...overrides,
  };
}

function queuedEnvelope(automation: ReturnType<typeof automationView>) {
  const invocation = automationInvocation(automation, "signal:direct");
  return {
    schema_version: 1 as const,
    contract: "metaflow.automation.invoke.v1" as const,
    message_id: "iii-message:direct",
    correlation_id: correlation(invocation),
    enqueued_at: NOW,
    queue: { name: "metaflow-automation-v1" as const, config_version: 1 as const },
    automation: exactViewRef(automation.view),
    signal: invocation.signal,
  };
}

function correlation(input: AutomationInvocationInput): string {
  return [
    "automation-occurrence",
    input.automation.view.id,
    input.automation.view.revision,
    input.automation.definition.trigger.id,
    input.signal.id,
  ].join(":");
}

function succeeded(input: AutomationInvocationInput, runId: string): AutomationInvocationAdmissionResult {
  return {
    status: "succeeded",
    correlation_id: correlation(input),
    occurrence: {
      id: correlation(input),
      automation: exactViewRef(input.automation.view),
      trigger_id: input.automation.definition.trigger.id,
      trigger_kind: input.signal.kind,
      source: input.signal.source,
      occurred_at: input.signal.occurred_at,
      idempotency_key: input.signal.idempotency_key,
      evidence: input.signal.evidence,
      payload: input.signal.payload,
      match: { matched: true, reason: "test" },
    },
    run_id: runId,
    output_views: [{ view_id: `view:output:${runId}`, revision: 1 }],
    deliveries: [],
  };
}

function ignored(): AutomationInvocationAdmissionResult {
  return { status: "ignored", reason: "test" };
}

function functionOperator(id = "operator:test:function"): OperatorSnapshot {
  return {
    id,
    revision: 1,
    reference: { kind: "function", function_id: "test.summary", version: 1 },
    configuration: {},
    required_capabilities: [],
  };
}

function agentOperator(): OperatorSnapshot {
  return {
    id: "operator:test:agent",
    revision: 1,
    reference: { kind: "agent", adapter: "agent-execution" },
    configuration: {},
    required_capabilities: [],
  };
}

function transformation(input: View, operator: OperatorSnapshot, schemaName: string): Transformation {
  return parseTransformation({
    id: `transformation:${schemaName}`,
    revision: 1,
    name: `${schemaName} summary`,
    instruction: { format: "natural_language", text: "Summarize exact input.", parameters: {} },
    operator,
    inputs: [{ role: "source", required: true, sources: [{ kind: "view", ref: exactViewRef(input) }] }],
    output: {
      schema: { name: schemaName, version: 1, mode: "freeform" },
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    policy: {
      id: "policy:test:approve-all",
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    created_at: NOW,
    metadata: {},
  });
}

function executionRequest(transformation: Transformation, runId: string) {
  return {
    run_id: runId,
    correlation_id: `correlation:${runId}`,
    transformation,
    access_policy: transformation.policy!,
    access_use: "local_execution" as const,
  };
}

function rawViewDraft(): ViewDraft {
  return {
    id: "view:iii:input",
    name: "III input",
    purpose: "Exercise Worker boundary",
    aliases: [],
    schema: { name: "capture.test", version: 1, mode: "freeform" },
    role: "raw",
    time: { created_at: NOW },
    representation: { form: "inline", kind: "text", value: "Exact input for III Worker", metadata: {} },
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
        source_id: "view:iii:input",
        source_kind: "fixture",
        identity: "occurrence",
        assertion: "direct",
      },
    },
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: true,
      allow_embedding: false,
      labels: [],
    },
    metadata: {},
  };
}

function obsidianMarkdownViewDraft(): ViewDraft {
  return {
    ...rawViewDraft(),
    id: "view:iii:obsidian-markdown",
    name: "III Markdown input",
    schema: { name: "capture.obsidian.document", version: 1, mode: "freeform" },
    representation: {
      form: "inline",
      kind: "obsidian_markdown_document",
      media_type: "text/markdown",
      value: {
        vault_id: "vault:test",
        document_id: "document:test",
        relative_path: "Learning/English.md",
        revision: { sha256: "a".repeat(64), byte_length: 54, mtime_ms: 1_785_130_000_000 },
        markdown: "# English learning\n\nReview exact phrases.\n\n- one\n- two",
        frontmatter: null,
        headings: [],
        links: [],
      },
      metadata: {},
    },
  };
}

function scheduledAutomationInvocation(
  automation: ReturnType<typeof automationView>,
): AutomationInvocationInput {
  const invocation = automationInvocation(automation, "signal:scheduled");
  return {
    ...invocation,
    signal: {
      ...invocation.signal,
      kind: "schedule",
      source: "scheduler",
      event: "period",
      payload: {
        schedule: { expression: "0 0 * * *", timezone: "UTC" },
        period: { start: "2026-07-25T00:00:00.000Z", end: "2026-07-26T00:00:00.000Z" },
        dispatch: { mode: "scheduled", state: "on_time", detected_at: NOW },
      },
    },
  };
}

function executionRuntime(
  repository: SqliteViewRepository,
  operator: OperatorExecutionPort,
  idPrefix: string,
): ExecutionRuntime {
  let id = 0;
  return new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    operator,
    undefined,
    { now: () => NOW, id: kind => `${kind}:${idPrefix}:${++id}` },
  );
}

function outputCandidate(invocation: OperatorExecutionInvocation, id: string, value: unknown) {
  const inputRefs = invocation.inputs.flatMap(binding => binding.views.map(exactViewRef));
  return {
    outputs: [{
      draft: {
        id,
        name: invocation.run.frozen.transformation.name,
        purpose: invocation.run.frozen.transformation.instruction.text,
        aliases: [],
        schema: invocation.run.frozen.transformation.output.schema,
        role: "derived",
        time: { created_at: NOW },
        representation: { form: "inline", kind: "summary", value, metadata: {} },
        materialization: {
          primary: { id: "canonical", format: "json", media_type: "application/json", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: inputRefs.map(target => ({ type: "derived_from", target, metadata: {} })),
        provenance: {
          inputs: inputRefs,
          operator_run_id: invocation.run.id,
          actor: "function:test",
          trace_id: invocation.run.trace_id,
        },
        policy: invocation.inputs[0]!.views[0]!.policy,
        metadata: {},
      },
      expected_revision: 0,
    }],
    diagnostics: {},
  };
}

class FakeAgentOperator implements AgentOperatorPort {
  executions = 0;

  async execute(invocation: AgentOperatorInvocation): Promise<AgentOperatorResult> {
    this.executions += 1;
    assert.equal(invocation.inputs[0]?.views[0]?.ref.view_id, "view:iii:input");
    return {
      status: "succeeded",
      runtime: "agent:test",
      candidate: { summary: "Agent Worker output" },
      diagnostics: {},
    };
  }

  async cancel() {
    return { status: "cancelled" as const, runtime: "agent:test" };
  }
}

class CancellableOperator implements OperatorExecutionPort {
  readonly cancelled: string[] = [];
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private finish!: (result: OperatorExecutionResult) => void;

  constructor() {
    this.started = new Promise(resolve => { this.markStarted = resolve; });
  }

  async execute(): Promise<OperatorExecutionResult> {
    this.markStarted();
    return new Promise(resolve => { this.finish = resolve; });
  }

  async cancel(attemptId: string): Promise<void> {
    this.cancelled.push(attemptId);
    this.finish({ status: "cancelled", reason: "cancelled through III" });
  }
}

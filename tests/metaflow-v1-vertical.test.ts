import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentExecutionAdapter, type AgentRuntimeAdapter, type AgentRuntimeContext, type AgentTaskRequest, type AgentTaskResult } from "@info/agent-runtime-adapter";
import { browserSourceConnection, configureBrowserCapture } from "@info/browser-capture-adapter";
import { CaptureIngress, ConnectorRuntime } from "@info/capture";
import {
  AgentOperatorExecutionBridge,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  FeedbackEvolutionService,
  OperatorExecutionRouter,
  RepairExecutionService,
  failureClassification,
  inheritStrictestViewPolicy,
  parseFailureView,
  parseRepairDecisionView,
  type OperatorExecutionInvocation,
  type RepairPolicySnapshot,
} from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  GrantOperationAuthorizer,
  OperationEnvelopeSchema,
  OperationService,
  type OperationContext,
  type OperationEnvelope,
  type OperationName,
  type OperationObserver,
  type OperationTraceEvent,
} from "@info/operations";
import {
  CliOperationAdapter,
  HttpOperationAdapter,
  createOperationMcpServer,
  operationMcpToolName,
} from "@info/operation-surfaces";
import {
  ScreenpipeCaptureConnector,
  configureScreenpipeCapture,
  screenpipeSourceConnection,
} from "@info/screenpipe-capture-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";
import {
  exactTransformationRef,
  parseTransformation,
  type OperatorReference,
  type Transformation,
  type TransformationInputBinding,
} from "@info/transformation";
import {
  exactViewRef,
  PrivacyForgetService,
  type ExactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewSchemaRef,
} from "@info/view";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "screenpipe");

const policy: ViewPolicy = {
  owner: "user:local",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  labels: ["metaflow-v1-vertical"],
};

const approveAll = {
  id: "policy:metaflow-v1-vertical",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

const summarySchema: ViewSchemaRef = {
  name: "summary.metaflow.activity",
  version: 1,
  mode: "freeform",
};

test("Browser and Screenpipe evidence evolves through Function, Agent, feedback, repair, policy, and shared surfaces", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp-metaflow-v1-vertical-"));
  const database = join(directory, "metaflow.sqlite");
  const views = new SqliteViewRepository(database);
  const transformations = new SqliteTransformationRepository(database);
  const clock = deterministicClock();
  const capture = new ConnectorRuntime(views, new CaptureIngress({ repository: views, now: clock }), { now: clock });
  const browser = await configureBrowserCapture({
    runtime: capture,
    connection: browserSourceConnection({ id: "chrome:vertical", privacy: policy }),
  });
  const screenpipeConnector = new ScreenpipeCaptureConnector({
    fetch: recordedScreenpipeFetch(),
    now: clock,
  });
  const screenpipeConnection = screenpipeSourceConnection({
    id: "screenpipe:vertical",
    endpoint: "http://screenpipe.vertical",
    privacy: policy,
    required_capabilities: ["frame_ocr"],
  });
  await configureScreenpipeCapture({
    runtime: capture,
    connector: screenpipeConnector,
    connection: screenpipeConnection,
  });

  const functionCalls: string[] = [];
  const functions = new FunctionOperatorAdapter([
    {
      reference: { kind: "function", function_id: "metaflow.vertical.summary", version: 1 },
      execute: invocation => {
        functionCalls.push(invocation.run.id);
        return validFunctionCandidate(invocation, clock);
      },
    },
    {
      reference: { kind: "function", function_id: "metaflow.vertical.invalid", version: 1 },
      execute: invocation => {
        functionCalls.push(invocation.run.id);
        return { malformed: "candidate" };
      },
    },
    {
      reference: { kind: "function", function_id: "metaflow.vertical.repair", version: 1 },
      execute: invocation => {
        functionCalls.push(invocation.run.id);
        return validFunctionCandidate(invocation, clock);
      },
    },
  ]);
  const agentRuntime = new VerticalAgentRuntime();
  const agentBridge = new AgentOperatorExecutionBridge(new AgentExecutionAdapter({
    runtimes: [agentRuntime],
    default_runtime: agentRuntime.id,
  }), { now: clock });
  const operators = new OperatorExecutionRouter([
    { kind: "function", port: functions },
    { kind: "agent", port: agentBridge },
  ]);
  let executionIdentity = 0;
  const execution = new ExecutionRuntime(
    views,
    views,
    new DeterministicViewAccessAuthorizer(),
    operators,
    undefined,
    { now: clock, id: kind => `${kind}:metaflow-v1-vertical:${++executionIdentity}` },
  );
  const feedback = new FeedbackEvolutionService({ views, runs: views, transformations });
  const privacy = new PrivacyForgetService({ views, requests: views, now: clock });
  const repairs = new RepairExecutionService({ views, runtime: execution });
  const observer = new MemoryOperationObserver();
  const operations = new OperationService({
    views,
    transformations,
    execution,
    runs: views,
    feedback,
    privacy,
    capture,
    capture_traces: views,
    authorization: new GrantOperationAuthorizer(),
    observer,
    now: clock,
  });

  try {
    const browserEvent = canonicalBrowserEvent();
    const browserCapture = await browser.submit(browserEvent);
    assert.equal(browserCapture.status, "stored");
    const browserReplay = await browser.submit(browserEvent);
    assert.equal(browserReplay.replayed, true);
    assert.deepEqual(browserReplay.captured_views, browserCapture.captured_views);

    const screenpipeCapture = await capture.run(screenpipeConnection.id, "pull", {
      resource: "search",
      query: { content_types: ["ocr"], limit: 50 },
    });
    assert.equal(screenpipeCapture[0]?.receipts[0]?.status, "stored");

    const page = await mustGet(views, roleRef(browserCapture, "page"));
    const selection = await mustGet(views, roleRef(browserCapture, "selection"));
    const frame = (await views.query({ schema_name: "capture.screenpipe.frame_ocr", revisions: "all", limit: 10 }))[0];
    assert.ok(frame);
    assert.equal(page.role, "raw");
    assert.equal(frame.role, "raw");
    assert.equal(page.revision, 1);
    assert.equal(frame.revision, 1);
    assert.equal((await views.query({ role: "raw", revisions: "all", limit: 20 })).length, 3);

    const initial = transformation({
      id: "transformation:metaflow-v1-summary",
      instruction: "Summarize the exact Browser page and Screenpipe frame as one Metaflow work note.",
      reference: { kind: "function", function_id: "metaflow.vertical.summary", version: 1 },
      configuration: {
        scenario: "initial",
        output_view_id: "view:metaflow-v1-summary",
        expected_revision: 0,
      },
      inputs: exactInputs([
        ["current_page", page],
        ["screen_frame", frame],
      ]),
      output: summarySchema,
    });
    await operationOk(operations, "transformation.submit", {
      transformation: initial,
      expected_revision: 0,
      idempotency_key: "transformation:metaflow-v1-summary:1",
    });
    const initialRun = await operationOk(operations, "run.execute", {
      transformation: exactTransformationRef(initial),
      parameters: runParameters("run:metaflow-v1:function:1"),
    });
    const initialResult = initialRun.data as { run: { status: string }; outputs: View[] };
    assert.equal(initialResult.run.status, "succeeded");
    const initialSummary = initialResult.outputs[0]!;
    assert.deepEqual(initialSummary.provenance.inputs, sortedRefs([exactViewRef(page), exactViewRef(frame)]));
    const functionReplay = await execution.replay("run:metaflow-v1:function:1");
    assert.equal(functionReplay.events.at(-1)?.type, "run.succeeded");
    assert.deepEqual(functionReplay.committed_outputs[0]?.inputs, sortedRefs([exactViewRef(page), exactViewRef(frame)]));

    const agentTransformation = transformation({
      id: "transformation:metaflow-v1-agent-page",
      instruction: "Explain why this exact captured page matters to the Metaflow v1 architecture.",
      reference: { kind: "agent", adapter: "agent-execution" },
      configuration: { runtime_override: agentRuntime.id },
      inputs: exactInputs([
        ["current_page", page],
        ["current_selection", selection],
      ]),
      output: { name: "analysis.metaflow.page", version: 1, mode: "freeform" },
    });
    await operationOk(operations, "transformation.submit", {
      transformation: agentTransformation,
      expected_revision: 0,
      idempotency_key: "transformation:metaflow-v1-agent-page:1",
    });
    const agentRun = await operationOk(operations, "run.execute", {
      transformation: exactTransformationRef(agentTransformation),
      parameters: runParameters("run:metaflow-v1:agent:1"),
    });
    assert.equal(
      (agentRun.data as { run: { status: string } }).run.status,
      "succeeded",
      JSON.stringify(agentRun.data),
    );
    assert.equal(agentRuntime.receivedCanonicalBrowserContext, true);

    const recordedFeedback = await operationOk(operations, "feedback.submit", {
      feedback: {
        feedback_id: "metaflow-v1-summary-correction",
        sentiment: "correction",
        message: "Make the summary actionable and explicitly relate Browser evidence to Screenpipe evidence.",
        actor: "user:local",
        occurred_at: clock(),
        target_view: exactViewRef(initialSummary),
        target_run_id: "run:metaflow-v1:function:1",
        requested_changes: ["instruction", "operator_configuration"],
        metadata: {},
      },
    });
    const feedbackView = (recordedFeedback.data as { view: View }).view;
    const evolved = await feedback.apply({
      feedback: exactViewRef(feedbackView),
      base_transformation: exactTransformationRef(initial),
      actor: "agent:metaflow-v1-feedback-planner",
      resolution: "Add an action section and preserve exact Browser plus Screenpipe lineage.",
      created_at: clock(),
      change: {
        instruction: {
          ...initial.instruction,
          text: "Produce an actionable Metaflow note that connects the exact Browser page with the exact Screenpipe frame.",
        },
        operator: {
          ...initial.operator,
          revision: 2,
          configuration: {
            scenario: "improved",
            output_view_id: "view:metaflow-v1-summary",
            expected_revision: 1,
          },
        },
      },
    });
    const evolvedRun = await operationOk(operations, "run.execute", {
      transformation: exactTransformationRef(evolved),
      parameters: runParameters("run:metaflow-v1:function:2"),
    });
    const evolvedResult = evolvedRun.data as { run: { status: string }; outputs: View[] };
    assert.equal(evolvedResult.run.status, "succeeded", JSON.stringify(evolvedRun.data));
    const evolvedSummary = evolvedResult.outputs[0]!;
    assert.equal(evolved.revision, 2);
    assert.equal(evolvedSummary.id, initialSummary.id);
    assert.equal(evolvedSummary.revision, 2);
    assert.deepEqual(
      evolvedSummary.relations.find(relation => relation.type === "supersedes")?.target,
      exactViewRef(initialSummary),
    );
    assert.match(JSON.stringify(evolvedSummary.representation), /improved/);

    const invalid = transformation({
      id: "transformation:metaflow-v1-invalid",
      instruction: "Force one invalid candidate so repair remains observable.",
      reference: { kind: "function", function_id: "metaflow.vertical.invalid", version: 1 },
      configuration: {},
      inputs: exactInputs([["current_page", page]]),
      output: { name: "summary.metaflow.invalid", version: 1, mode: "freeform" },
    });
    await operationOk(operations, "transformation.submit", {
      transformation: invalid,
      expected_revision: 0,
      idempotency_key: "transformation:metaflow-v1-invalid:1",
    });
    const failedRun = await operationOk(operations, "run.execute", {
      transformation: exactTransformationRef(invalid),
      parameters: runParameters("run:metaflow-v1:failure:1"),
    });
    const failedResult = failedRun.data as { run: { status: string }; failure: View };
    assert.equal(failedResult.run.status, "failed");
    assert.equal(failureClassification(parseFailureView(failedResult.failure)), "candidate_invalid");

    const repairTransformation = transformation({
      id: "transformation:metaflow-v1-repair",
      instruction: "Repair the failed summary using the exact page and exact Failure View.",
      reference: { kind: "function", function_id: "metaflow.vertical.repair", version: 1 },
      configuration: {
        scenario: "repaired",
        output_view_id: "view:metaflow-v1-repair",
        expected_revision: 0,
      },
      inputs: exactInputs([
        ["current_page", page],
        ["failure", failedResult.failure],
      ]),
      output: { name: "summary.metaflow.repaired", version: 1, mode: "freeform" },
    });
    await operationOk(operations, "transformation.submit", {
      transformation: repairTransformation,
      expected_revision: 0,
      idempotency_key: "transformation:metaflow-v1-repair:1",
    });
    const repair = await repairs.execute({
      run_id: "run:metaflow-v1:repair:1",
      correlation_id: "correlation:metaflow-v1:repair:1",
      idempotency_key: "execution:metaflow-v1:repair:1",
      failure: exactViewRef(failedResult.failure),
      transformation: repairTransformation,
      access_policy: approveAll,
      access_use: "local_execution",
      policy: repairPolicy(),
      created_at: clock(),
    });
    assert.equal(repair.status, "executed");
    if (repair.status !== "executed") throw new Error("Repair was unexpectedly blocked");
    assert.equal(parseRepairDecisionView(repair.decision).status, "allowed");
    assert.equal(repair.execution.run.status, "succeeded");
    assert.deepEqual(repair.execution.run.frozen.repair?.parent_failure, exactViewRef(failedResult.failure));

    const denyTransformation = transformation({
      id: "transformation:metaflow-v1-deny",
      instruction: "This must not execute because one exact input is denied.",
      reference: { kind: "function", function_id: "metaflow.vertical.summary", version: 1 },
      configuration: {
        scenario: "must-not-run",
        output_view_id: "view:metaflow-v1-denied-output",
        expected_revision: 0,
      },
      inputs: exactInputs([
        ["current_page", page],
        ["screen_frame", frame],
      ]),
      output: { name: "summary.metaflow.denied", version: 1, mode: "freeform" },
    });
    await operationOk(operations, "transformation.submit", {
      transformation: denyTransformation,
      expected_revision: 0,
      idempotency_key: "transformation:metaflow-v1-deny:1",
    });
    const callsBeforeDeny = functionCalls.length;
    const deniedRun = await operationOk(operations, "run.execute", {
      transformation: exactTransformationRef(denyTransformation),
      parameters: runParameters("run:metaflow-v1:deny:1", {
        ...approveAll,
        id: "policy:metaflow-v1-deny",
        configuration: {
          ...approveAll.configuration,
          rules: [{
            id: "deny:exact-screenpipe-frame",
            effect: "deny" as const,
            target: { kind: "view" as const, ref: exactViewRef(frame) },
            reason: "The user excluded this exact Screenpipe frame.",
          }],
        },
      }),
    });
    assert.equal((deniedRun.data as { run: { status: string } }).run.status, "failed");
    assert.equal(functionCalls.length, callsBeforeDeny);
    const deniedDecision = await operationOk(operations, "policy.decision.get", { run_id: "run:metaflow-v1:deny:1" });
    assert.equal((deniedDecision.data as { outcome: string }).outcome, "denied");
    assert.deepEqual((deniedDecision.data as { denied_views: ExactViewRef[] }).denied_views, [exactViewRef(frame)]);

    const surfaces = await createSurfaces(operations);
    try {
      const graphQueries = await Promise.all(surfaces.map(surface => surface.call("view.search", {
        query: { revisions: "all", limit: 200 },
      })));
      for (const graph of graphQueries.slice(1)) assert.deepEqual(graph, graphQueries[0]);
      const graphViews = successData(graphQueries[0]) as View[];
      assert.ok(graphViews.some(view => view.id === page.id && view.role === "raw"));
      assert.ok(graphViews.some(view => view.id === frame.id && view.role === "raw"));
      assert.ok(graphViews.some(view => view.id === evolvedSummary.id && view.revision === 2));
      assert.ok(graphViews.some(view => view.schema.name === "metaflow.execution.failure"));
      assert.ok(graphViews.some(view => view.schema.name === "metaflow.repair.decision"));

      const traversals = await Promise.all(surfaces.map(surface => surface.call("view.traverse", {
        query: { ref: exactViewRef(evolvedSummary), direction: "outgoing", limit: 50 },
      })));
      for (const traversal of traversals.slice(1)) assert.deepEqual(traversal, traversals[0]);
      assert.ok((successData(traversals[0]) as Array<{ type: string }>).some(relation => relation.type === "derived_from"));
      assert.ok((successData(traversals[0]) as Array<{ type: string }>).some(relation => relation.type === "supersedes"));
    } finally {
      await Promise.all(surfaces.map(surface => surface.close()));
    }

    assert.ok(observer.events.some(event => event.operation === "run.execute" && event.type === "operation.succeeded"));
  } finally {
    transformations.close();
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class VerticalAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "metaflow-v1-fake-agent";
  readonly kind = "mock" as const;
  receivedCanonicalBrowserContext = false;

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    assert.equal(task.currentContext?.screen?.url, "https://github.com/openai/codex#readme");
    assert.equal(task.currentContext?.screen?.title, "openai/codex");
    assert.equal(task.currentContext?.screen?.text, "Codex is an open source coding agent that inspired this Metaflow test.");
    assert.equal(task.currentContext?.screen?.selected_text, "open source coding agent");
    const evidence = task.currentContext?.raw?.metaflow_inputs as Array<{
      role: string;
      ref: ExactViewRef;
      representation: { value?: { content?: { text?: string } } };
    }>;
    assert.deepEqual(evidence.map(item => item.role), ["current_page", "current_selection"]);
    assert.equal(evidence[0]?.representation.value?.content?.text, "Codex is an open source coding agent that inspired this Metaflow test.");
    this.receivedCanonicalBrowserContext = true;
    return {
      ok: true,
      reason: "fake Agent consumed the frozen Browser Views",
      output: {
        summary: "The captured Codex page matters because Metaflow keeps exact evidence and observable execution.",
        key_points: ["Exact Browser View", "Observable Agent Run"],
        confidence: 1,
      },
    };
  }
}

class MemoryOperationObserver implements OperationObserver {
  readonly events: OperationTraceEvent[] = [];

  async record(event: OperationTraceEvent): Promise<void> {
    this.events.push(event);
  }
}

type Surface = {
  call(operation: OperationName, input: unknown): Promise<OperationEnvelope>;
  close(): Promise<void>;
};

async function createSurfaces(service: OperationService): Promise<Surface[]> {
  const contextProvider = () => operationContext("request:metaflow-v1-shared-graph");
  const cli = new CliOperationAdapter(service, contextProvider);
  const http = new HttpOperationAdapter(service, contextProvider);
  const server = createOperationMcpServer({ service, context: contextProvider });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metaflow-v1-vertical", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return [
    {
      call: (operation, input) => service.execute({ operation, input }, contextProvider()),
      close: async () => undefined,
    },
    {
      call: async (operation, input) => (await cli.invoke([operation, JSON.stringify(input)])).envelope,
      close: async () => undefined,
    },
    {
      call: async (operation, input) => (await http.handle({
        method: "POST",
        path: `/metaflow/v1/operations/${encodeURIComponent(operation)}`,
        body: input,
      })).body,
      close: async () => undefined,
    },
    {
      call: async (operation, input) => {
        const result = await client.callTool({
          name: operationMcpToolName(operation),
          arguments: input as Record<string, unknown>,
        });
        return OperationEnvelopeSchema.parse(result.structuredContent);
      },
      close: async () => {
        await client.close();
        await server.close();
      },
    },
  ];
}

function transformation(input: {
  id: string;
  instruction: string;
  reference: OperatorReference;
  configuration: JsonObject;
  inputs: TransformationInputBinding[];
  output: ViewSchemaRef;
}): Transformation {
  return parseTransformation({
    id: input.id,
    revision: 1,
    name: input.id,
    instruction: { format: "natural_language", text: input.instruction, language: "en", parameters: {} },
    operator: {
      id: `operator:${input.id}`,
      revision: 1,
      reference: input.reference,
      configuration: input.configuration,
      required_capabilities: [],
    },
    inputs: input.inputs,
    output: {
      schema: input.output,
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    policy: approveAll,
    budget: {
      id: `budget:${input.id}`,
      revision: 1,
      limits: { timeout_ms: 10_000, max_cost_usd: 1, max_input_tokens: 8_000 },
      extensions: {},
    },
    created_at: "2026-07-26T18:00:00.000Z",
    metadata: {},
  });
}

function exactInputs(entries: Array<[string, View]>): TransformationInputBinding[] {
  return entries.map(([role, view]) => ({
    role,
    required: true,
    sources: [{ kind: "view", ref: exactViewRef(view) }],
  }));
}

function validFunctionCandidate(invocation: OperatorExecutionInvocation, now: () => string) {
  const configuration = invocation.run.frozen.transformation.operator.configuration;
  const outputId = requiredString(configuration.output_view_id, "output_view_id");
  const expectedRevision = requiredInteger(configuration.expected_revision, "expected_revision");
  const scenario = requiredString(configuration.scenario, "scenario");
  const inputs = invocation.inputs.flatMap(binding => binding.views);
  const refs = sortedRefs(inputs.map(exactViewRef));
  const draft: ViewDraft = {
    id: outputId,
    name: invocation.run.frozen.transformation.name,
    purpose: "Verified Metaflow v1 vertical-slice output",
    aliases: [],
    schema: invocation.run.frozen.transformation.output.schema,
    role: "derived",
    time: { created_at: now() },
    representation: {
      form: "inline",
      kind: "metaflow_v1_vertical_result",
      media_type: "application/json",
      value: {
        scenario,
        summary: scenario === "improved"
          ? "Browser and Screenpipe evidence now produce an actionable Metaflow note."
          : scenario === "repaired"
            ? "The invalid candidate was repaired from exact Failure evidence."
            : "Browser and Screenpipe evidence produced one Metaflow note.",
      },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [
      ...refs.map(target => ({ type: "derived_from", target, metadata: {} })),
      ...(expectedRevision > 0
        ? [{ type: "supersedes", target: { view_id: outputId, revision: expectedRevision }, metadata: {} }]
        : []),
    ],
    provenance: {
      inputs: refs,
      operator_run_id: invocation.run.id,
      actor: "function:metaflow-v1-vertical",
      trace_id: invocation.run.trace_id,
    },
    policy: inheritStrictestViewPolicy(inputs.map(view => view.policy)),
    metadata: { scenario },
  };
  return {
    outputs: [{
      draft,
      expected_revision: expectedRevision,
      idempotency_key: `output:${invocation.run.id}`,
    }],
  };
}

function runParameters(runId: string, accessPolicy = approveAll) {
  return {
    run_id: runId,
    correlation_id: `correlation:${runId}`,
    access_policy: accessPolicy,
    access_use: "local_execution" as const,
    idempotency_key: `execution:${runId}`,
  };
}

function repairPolicy(): RepairPolicySnapshot {
  return {
    id: "repair-policy:metaflow-v1-vertical",
    revision: 1,
    max_depth: 4,
    max_repeated_fingerprint: 2,
    retryable_error_codes: ["candidate_invalid"],
    non_retryable_error_codes: ["authorization_denied"],
  };
}

async function operationOk(service: OperationService, operation: OperationName, input: unknown) {
  const envelope = await service.execute({ operation, input }, operationContext(`request:${operation}`));
  assert.equal(envelope.ok, true, envelope.ok ? undefined : JSON.stringify(envelope.error));
  return envelope as Extract<OperationEnvelope, { ok: true }>;
}

function operationContext(requestId: string): OperationContext {
  return { request_id: requestId, principal: { id: "user:local", grants: ["*"] } };
}

function successData(envelope: OperationEnvelope): JsonValue {
  assert.equal(envelope.ok, true, envelope.ok ? undefined : JSON.stringify(envelope.error));
  return envelope.data;
}

function roleRef(
  submission: { captured_views: Array<{ role: string; ref: ExactViewRef }> },
  role: string,
): ExactViewRef {
  const captured = submission.captured_views.find(item => item.role === role);
  assert.ok(captured, `Missing captured Browser role ${role}`);
  return captured.ref;
}

async function mustGet(repository: SqliteViewRepository, ref: ExactViewRef): Promise<View> {
  const view = await repository.get(ref);
  assert.ok(view, `Missing View ${ref.view_id}@${ref.revision}`);
  return view;
}

function canonicalBrowserEvent() {
  return {
    version: 1 as const,
    event_id: "browser-event:metaflow-v1-vertical",
    kind: "page" as const,
    action: "page_snapshot" as const,
    occurred_at: "2026-07-26T17:55:00.000Z",
    captured_at: "2026-07-26T17:55:00.100Z",
    source: { connector: "chrome-extension" as const, connection_id: "chrome:vertical" },
    browser: {
      tab_id: 27,
      window_id: 4,
      visit_id: "visit:metaflow-v1-vertical",
      attention: "focused" as const,
      tab_active: true,
      window_focused: true,
      document_id: "document:metaflow-v1-vertical",
      frame_id: 0,
    },
    page: {
      url: "https://github.com/openai/codex#readme",
      canonical_url: "https://github.com/openai/codex",
      title: "openai/codex",
      domain: "github.com",
    },
    content: {
      text: "Codex is an open source coding agent that inspired this Metaflow test.",
      selected_text: "open source coding agent",
    },
    facts: { tab_id: 27, navigation_id: "navigation:metaflow-v1-vertical" },
    policy,
  };
}

function recordedScreenpipeFetch(): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") return jsonResponse(fixture("health-0.4.30.json"));
    if (url.pathname === "/search" && url.searchParams.get("content_type") === "ocr") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const body = structuredClone(fixture("search-ocr.json")) as {
        data: unknown[];
        pagination: { offset: number; total: number };
      };
      body.pagination.offset = offset;
      if (offset > 0) body.data = [];
      return jsonResponse(body);
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDirectory, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`Function configuration.${field} must be a string`);
  return value;
}

function requiredInteger(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Function configuration.${field} must be a non-negative integer`);
  }
  return value;
}

function sortedRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...refs].sort((left, right) => `${left.view_id}@${left.revision}`.localeCompare(`${right.view_id}@${right.revision}`));
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T18:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentOperatorExecutionBridge,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  OperatorExecutionFailure,
  OperatorExecutionRouter,
  type AgentOperatorInvocation,
  type AgentOperatorPort,
  type AgentOperatorResult,
  type OperatorExecutionInvocation,
} from "@info/execution";
import { SqliteViewRepository } from "@info/storage-sqlite";
import type { OperatorReference, Transformation } from "@info/transformation";
import {
  exactViewRef,
  type ExactViewRef,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewSchemaRef,
} from "@info/view";
import {
  FunctionOperatorAdapter,
  type FunctionOperatorRegistration,
} from "../packages/adapters/function-operator/index.ts";

const ownerPolicy: ViewPolicy = {
  owner: "user:junjie",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: true,
  allow_embedding: false,
  labels: ["personal"],
};

const accessPolicy = {
  id: "policy:operators:approve-all",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

const segmentSchema: ViewSchemaRef = strictSchema("content.segment", {
  type: "object",
  required: ["index", "text"],
  additionalProperties: false,
  properties: {
    index: { type: "integer", minimum: 0 },
    text: { type: "string" },
  },
});

const mergedSchema: ViewSchemaRef = strictSchema("content.merged", {
  type: "object",
  required: ["items", "text"],
  additionalProperties: false,
  properties: {
    items: { type: "array", items: { type: "string" } },
    text: { type: "string" },
  },
});

const groupedSchema: ViewSchemaRef = strictSchema("view.group", {
  type: "object",
  required: ["basis", "members"],
  additionalProperties: false,
  properties: {
    basis: { type: "string" },
    members: {
      type: "array",
      items: {
        type: "object",
        required: ["view_id", "revision"],
        additionalProperties: false,
        properties: {
          view_id: { type: "string" },
          revision: { type: "integer", minimum: 1 },
        },
      },
    },
  },
});

test("deterministic split and merge are ordinary Transformation shapes with exact Run provenance", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:article", "Alpha\nBeta");
    const split = transformation({
      id: "transformation:split-lines",
      instruction: "Split the article into non-empty lines.",
      reference: functionRef("content.split-lines", 1),
      inputs: [{ role: "source", views: [source] }],
      outputSchema: segmentSchema,
      cardinality: { min: 1 },
      operationShape: "split",
    });

    const splitResult = await harness.execute("run:split-lines", split);
    assert.equal(splitResult.run.status, "succeeded");
    assert.deepEqual(splitResult.outputs.map(view => semanticValue(view)), [
      { index: 0, text: "Alpha" },
      { index: 1, text: "Beta" },
    ]);
    assert.equal((await harness.repository.get(exactViewRef(source)))?.representation.form, "inline");
    assert.equal((await harness.repository.get(exactViewRef(source)))?.revision, 1);
    assertRunProvenance(splitResult.outputs, "run:split-lines", [exactViewRef(source)]);

    const merge = transformation({
      id: "transformation:merge-segments",
      instruction: "Merge selected segments in their declared order.",
      reference: functionRef("content.merge-segments", 1),
      inputs: [{ role: "segments", views: splitResult.outputs }],
      outputSchema: mergedSchema,
      cardinality: { min: 1, max: 1 },
      operationShape: "merge",
    });
    const mergeResult = await harness.execute("run:merge-segments", merge);
    assert.equal(mergeResult.run.status, "succeeded");
    assert.deepEqual(semanticValue(mergeResult.outputs[0]!), {
      items: ["Alpha", "Beta"],
      text: "Alpha\nBeta",
    });
    assertRunProvenance(
      mergeResult.outputs,
      "run:merge-segments",
      splitResult.outputs.map(exactViewRef),
    );
    assert.deepEqual(
      (await harness.runtime.replay("run:merge-segments")).events.map(event => event.type),
      ["run.created", "attempt.started", "function.started", "function.completed", "run.succeeded"],
    );
  });
});

test("a grouped View freezes exact membership and evolves by immutable revision", async () => {
  await withHarness(async harness => {
    const first = await harness.commitRaw("view:event:1", { action: "open", trace: "work:metaflow" });
    const second = await harness.commitRaw("view:event:2", { action: "edit", trace: "work:metaflow" });
    const initial = transformation({
      id: "transformation:group-trace",
      instruction: "Group the selected activity evidence by its shared trace.",
      reference: functionRef("activity.group-exact-members", 1),
      inputs: [{ role: "members", views: [first, second] }],
      outputSchema: groupedSchema,
      cardinality: { min: 1, max: 1 },
      operationShape: "group",
      operatorConfiguration: { group_view_id: "view:group:work:metaflow", basis: "trace:work:metaflow" },
    });
    const initialResult = await harness.execute("run:group-trace:1", initial);
    const revisionOne = initialResult.outputs[0]!;
    assert.equal(revisionOne.revision, 1);
    assert.deepEqual(memberRefs(revisionOne), [exactViewRef(first), exactViewRef(second)]);

    const third = await harness.commitRaw("view:event:3", { action: "test", trace: "work:metaflow" });
    const evolved = transformation({
      id: "transformation:group-trace",
      revision: 2,
      instruction: "Group the selected activity evidence by its shared trace.",
      reference: functionRef("activity.group-exact-members", 1),
      inputs: [
        { role: "base_group", views: [revisionOne] },
        { role: "members", views: [third] },
      ],
      outputSchema: groupedSchema,
      cardinality: { min: 1, max: 1 },
      operationShape: "group",
      operatorConfiguration: { group_view_id: "view:group:work:metaflow", basis: "trace:work:metaflow" },
    });
    const evolvedResult = await harness.execute("run:group-trace:2", evolved);
    const revisionTwo = evolvedResult.outputs[0]!;
    assert.equal(revisionTwo.id, revisionOne.id);
    assert.equal(revisionTwo.revision, 2);
    assert.deepEqual(memberRefs(revisionTwo), [exactViewRef(first), exactViewRef(second), exactViewRef(third)]);
    assert.deepEqual(memberRefs((await harness.repository.get(exactViewRef(revisionOne)))!), [
      exactViewRef(first),
      exactViewRef(second),
    ]);
    assert.deepEqual(
      revisionTwo.relations.find(relation => relation.type === "supersedes")?.target,
      exactViewRef(revisionOne),
    );
    assertRunProvenance(revisionTwo ? [revisionTwo] : [], "run:group-trace:2", [
      exactViewRef(revisionOne),
      exactViewRef(third),
    ]);
  });
});

test("one Execution Runtime routes registered Function and Agent semantic grouping without a Core taxonomy", async () => {
  await withHarness(async harness => {
    const coding = await harness.commitRaw("view:activity:coding", { text: "Implemented immutable View revisions" });
    const reading = await harness.commitRaw("view:activity:reading", { text: "Read a graph database article" });

    const functionTransformation = transformation({
      id: "transformation:trace-group-arbitrary",
      instruction: "Group exact evidence using the requested arbitrary basis.",
      reference: functionRef("activity.group-exact-members", 1),
      inputs: [{ role: "members", views: [coding, reading] }],
      outputSchema: groupedSchema,
      cardinality: { min: 1, max: 1 },
      operationShape: "anything-user-defined",
      operatorConfiguration: { group_view_id: "view:group:arbitrary", basis: "custom:morning-focus" },
    });
    const deterministic = await harness.execute("run:group:function", functionTransformation);

    const agentTransformation = transformation({
      id: "transformation:semantic-group",
      instruction: "Group activity by semantic relevance to learning Metaflow architecture.",
      reference: { kind: "agent", adapter: "fake-semantic-grouper" },
      inputs: [{ role: "activity", views: [coding, reading] }],
      outputSchema: groupedSchema,
      cardinality: { min: 1, max: 1 },
      operationShape: "agent-invented-semantic-group",
    });
    const semantic = await harness.execute("run:group:agent", agentTransformation, "external_model");

    assert.equal(deterministic.run.frozen.transformation.operator.reference.kind, "function");
    assert.equal(semantic.run.frozen.transformation.operator.reference.kind, "agent");
    assert.deepEqual(semanticValue(semantic.outputs[0]!), {
      basis: "semantic:metaflow-learning",
      members: [exactViewRef(coding)],
    });
    assertRunProvenance(semantic.outputs, "run:group:agent", [exactViewRef(coding), exactViewRef(reading)]);
    assert.deepEqual(
      (await harness.runtime.replay("run:group:agent")).events.map(event => event.type),
      ["run.created", "attempt.started", "agent.completed", "run.succeeded"],
    );
  });
});

test("Function Operator registration is exact-versioned and rejects duplicates", () => {
  const registration = splitRegistration();
  const adapter = new FunctionOperatorAdapter([registration]);
  assert.throws(() => adapter.register(registration), /already registered/);
  assert.doesNotThrow(() => adapter.register({ ...registration, reference: functionRef("content.split-lines", 2) }));
});

test("a durable trace failure is observable and releases Function attempt state", async () => {
  const reference = functionRef("test.trace-cleanup", 1);
  let executions = 0;
  const adapter = new FunctionOperatorAdapter([{
    reference,
    execute() {
      executions += 1;
      return { outputs: [] };
    },
  }]);
  const invocation = {
    run: { frozen: { transformation: { operator: { reference } } } },
    attempt: { id: "attempt:trace-cleanup" },
    inputs: [],
  } as OperatorExecutionInvocation;
  const controller = new AbortController();

  await assert.rejects(
    adapter.execute(invocation, {
      signal: controller.signal,
      emit: async () => { throw new Error("trace unavailable"); },
    }),
    /trace unavailable|failure trace both failed/,
  );
  assert.equal(executions, 0);

  const recovered = await adapter.execute(invocation, {
    signal: controller.signal,
    emit: async () => undefined,
  });
  assert.equal(recovered.status, "succeeded");
  assert.equal(executions, 1);
});

test("a typed Function failure retains both the Operator and durable trace errors", async () => {
  const reference = functionRef("test.typed-failure-trace", 1);
  const operatorError = new OperatorExecutionFailure("typed_failure", "typed execution failed");
  const adapter = new FunctionOperatorAdapter([{
    reference,
    execute() {
      throw operatorError;
    },
  }]);
  const invocation = {
    run: { frozen: { transformation: { operator: { reference } } } },
    attempt: { id: "attempt:typed-failure-trace" },
    inputs: [],
  } as OperatorExecutionInvocation;
  let emits = 0;

  await assert.rejects(
    adapter.execute(invocation, {
      signal: new AbortController().signal,
      emit: async () => {
        emits += 1;
        if (emits === 2) throw new Error("failure trace unavailable");
      },
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors[0] === operatorError
      && error.errors[1] instanceof Error
      && error.errors[1].message === "failure trace unavailable",
  );
});

test("Function cancellation emits one cancellation event and no contradictory failure", async () => {
  const reference = functionRef("test.cancellable", 1);
  const adapter = new FunctionOperatorAdapter([{
    reference,
    execute(_invocation, context) {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    },
  }]);
  const invocation = minimalFunctionInvocation(reference, "attempt:cancellable");
  const events: string[] = [];
  const execution = adapter.execute(invocation, {
    signal: new AbortController().signal,
    emit: async event => { events.push(event.type); },
  });

  await new Promise(resolve => setImmediate(resolve));
  await adapter.cancel(invocation.attempt.id);
  await assert.rejects(execution, /cancelled/);
  assert.deepEqual(events, ["function.started", "function.cancelled"]);
});

type Harness = {
  repository: SqliteViewRepository;
  runtime: ExecutionRuntime;
  commitRaw(id: string, value: JsonValue): Promise<View>;
  execute(runId: string, transformation: Transformation, accessUse?: "local_execution" | "external_model"): ReturnType<ExecutionRuntime["execute"]>;
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-operators-"));
  const repository = new SqliteViewRepository(join(directory, "operators.sqlite"));
  const functions = new FunctionOperatorAdapter([
    splitRegistration(),
    mergeRegistration(),
    exactGroupRegistration(),
  ]);
  const agent = new AgentOperatorExecutionBridge(new FakeSemanticGroupingAgent(), {
    now: () => "2026-07-26T13:00:02.000Z",
    output_view_id: invocation => `view:semantic-group:${invocation.run.id}`,
  });
  const operators = new OperatorExecutionRouter([
    { kind: "function", port: functions },
    { kind: "agent", port: agent },
  ]);
  let identity = 0;
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    operators,
    undefined,
    {
      now: deterministicClock(),
      id: kind => `${kind}:view-operators:${++identity}`,
    },
  );
  const harness: Harness = {
    repository,
    runtime,
    async commitRaw(id, value) {
      return (await repository.commit({ draft: rawView(id, value), expected_revision: 0 })).view;
    },
    execute(runId, input, accessUse = "local_execution") {
      return runtime.execute({
        run_id: runId,
        correlation_id: `correlation:${runId}`,
        transformation: input,
        access_policy: accessPolicy,
        access_use: accessUse,
      });
    },
  };
  try {
    await run(harness);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function splitRegistration(): FunctionOperatorRegistration {
  return {
    reference: functionRef("content.split-lines", 1),
    execute(invocation) {
      const source = invocation.inputs.find(binding => binding.role === "source")?.views[0];
      const value = source ? semanticValue(source) : undefined;
      if (typeof value !== "string") throw new TypeError("content.split-lines requires one inline string source");
      const lines = value.split("\n").map(line => line.trim()).filter(Boolean);
      return {
        outputs: lines.map((text, index) => ({
          draft: derivedDraft(invocation, `view:segment:${source.id}:${index}`, { index, text }),
          expected_revision: 0,
        })),
        diagnostics: { line_count: lines.length },
      };
    },
  };
}

function mergeRegistration(): FunctionOperatorRegistration {
  return {
    reference: functionRef("content.merge-segments", 1),
    execute(invocation) {
      const views = invocation.inputs.find(binding => binding.role === "segments")?.views ?? [];
      const items = views.map(view => {
        const value = semanticValue(view);
        if (!isObject(value) || typeof value.text !== "string") throw new TypeError("merge input requires text");
        return value.text;
      });
      return {
        outputs: [{
          draft: derivedDraft(invocation, "view:merged:segments", { items, text: items.join("\n") }),
          expected_revision: 0,
        }],
      };
    },
  };
}

function exactGroupRegistration(): FunctionOperatorRegistration {
  return {
    reference: functionRef("activity.group-exact-members", 1),
    execute(invocation) {
      const configuration = invocation.run.frozen.transformation.operator.configuration;
      const groupViewId = configuration.group_view_id;
      const basis = configuration.basis;
      if (typeof groupViewId !== "string" || typeof basis !== "string") {
        throw new TypeError("group-exact-members requires group_view_id and basis configuration");
      }
      const base = invocation.inputs.find(binding => binding.role === "base_group")?.views[0];
      const priorMembers = base ? memberRefs(base) : [];
      const added = invocation.inputs.find(binding => binding.role === "members")?.views.map(exactViewRef) ?? [];
      const members = uniqueRefs([...priorMembers, ...added]);
      return {
        outputs: [{
          draft: derivedDraft(invocation, groupViewId, { basis, members }, base),
          expected_revision: base?.revision ?? 0,
        }],
        diagnostics: { membership_count: members.length, basis },
      };
    },
  };
}

class FakeSemanticGroupingAgent implements AgentOperatorPort {
  async capabilities() {
    return [{
      runtime: "fake-semantic-grouper",
      kind: "fake",
      modes: ["invoke" as const],
      supports_cancel: true,
      supports_permissions: false,
      supports_progress: false,
      supports_mcp_servers: false,
    }];
  }

  async execute(invocation: AgentOperatorInvocation, context?: Parameters<AgentOperatorPort["execute"]>[1]): Promise<AgentOperatorResult> {
    const refs = invocation.inputs.flatMap(binding => binding.views.map(view => view.ref));
    await context?.events?.emit({
      type: "agent.completed",
      occurred_at: "2026-07-26T13:00:01.000Z",
      invocation_id: invocation.invocation_id,
      run_id: invocation.run_id,
      correlation_id: invocation.correlation_id,
      transformation: invocation.transformation,
      runtime: "fake-semantic-grouper",
    });
    return {
      status: "succeeded",
      runtime: "fake-semantic-grouper",
      candidate: { basis: "semantic:metaflow-learning", members: refs.slice(0, 1) },
    };
  }

  async cancel() {
    return { status: "cancelled" as const, runtime: "fake-semantic-grouper" };
  }
}

function transformation(input: {
  id: string;
  revision?: number;
  instruction: string;
  reference: OperatorReference;
  inputs: Array<{ role: string; views: View[] }>;
  outputSchema: ViewSchemaRef;
  cardinality: { min: number; max?: number };
  operationShape: string;
  operatorConfiguration?: Record<string, JsonValue>;
}): Transformation {
  const revision = input.revision ?? 1;
  return {
    id: input.id,
    revision,
    name: input.id,
    instruction: { format: "natural_language", text: input.instruction, parameters: {} },
    operator: {
      id: `operator:${input.id}`,
      revision: 1,
      reference: input.reference,
      configuration: input.operatorConfiguration ?? {},
      required_capabilities: [],
    },
    inputs: input.inputs.map(binding => ({
      role: binding.role,
      required: true,
      sources: binding.views.map(view => ({ kind: "view" as const, ref: exactViewRef(view) })),
    })),
    output: {
      schema: input.outputSchema,
      schema_origin: "declared",
      cardinality: input.cardinality,
    },
    policy: accessPolicy,
    created_at: revision === 1 ? "2026-07-26T13:00:00.000Z" : "2026-07-26T13:01:00.000Z",
    ...(revision > 1 ? { supersedes: { transformation_id: input.id, revision: revision - 1 } } : {}),
    metadata: { operation_shape: input.operationShape },
  };
}

function derivedDraft(
  invocation: OperatorExecutionInvocation,
  id: string,
  value: JsonValue,
  base?: View,
): ViewDraft {
  const inputs = invocation.inputs.flatMap(binding => binding.views.map(exactViewRef));
  const reference = invocation.run.frozen.transformation.operator.reference;
  return {
    id,
    name: invocation.run.frozen.transformation.name,
    purpose: invocation.run.frozen.transformation.instruction.text,
    aliases: [],
    schema: invocation.run.frozen.transformation.output.schema,
    role: "derived",
    time: { created_at: invocation.run.id.endsWith(":2") ? "2026-07-26T13:01:02.000Z" : "2026-07-26T13:00:02.000Z" },
    representation: { form: "inline", kind: "json", value, metadata: {} },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [
      ...inputs.map(target => ({ type: "derived_from", target, metadata: {} })),
      ...(base ? [{ type: "supersedes", target: exactViewRef(base), metadata: {} }] : []),
    ],
    provenance: {
      inputs,
      operator_run_id: invocation.run.id,
      actor: reference.kind === "function"
        ? `function:${reference.function_id}@${reference.version}`
        : `operator:${reference.kind}`,
      trace_id: invocation.run.trace_id,
    },
    policy: ownerPolicy,
    metadata: { operation_shape: invocation.run.frozen.transformation.metadata.operation_shape ?? "custom" },
  };
}

function rawView(id: string, value: JsonValue): ViewDraft {
  return {
    id,
    name: id,
    purpose: "Captured test evidence",
    aliases: [],
    schema: { name: "capture.test", version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: "2026-07-26T12:59:00.000Z", created_at: "2026-07-26T13:00:00.000Z" },
    representation: { form: "inline", kind: "json", value, metadata: {} },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: {
      inputs: [],
      capture: {
        connector: "test",
        connection_id: "test:operators",
        source_id: id,
        source_kind: "fixture",
        identity: "occurrence",
        assertion: "direct",
      },
      actor: "capture-ingress",
    },
    policy: ownerPolicy,
    metadata: {},
  };
}

function functionRef(functionId: string, version: number): Extract<OperatorReference, { kind: "function" }> {
  return { kind: "function", function_id: functionId, version };
}

function minimalFunctionInvocation(
  reference: Extract<OperatorReference, { kind: "function" }>,
  attemptId: string,
): OperatorExecutionInvocation {
  return {
    run: { frozen: { transformation: { operator: { reference } } } },
    attempt: { id: attemptId },
    inputs: [],
  } as OperatorExecutionInvocation;
}

function strictSchema(name: string, jsonSchema: JsonValue): ViewSchemaRef {
  return {
    name,
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: jsonSchema,
  };
}

function semanticValue(view: View): JsonValue {
  if (view.representation.form !== "inline") throw new TypeError(`Expected inline View ${view.id}@${view.revision}`);
  return view.representation.value;
}

function memberRefs(view: View): ExactViewRef[] {
  const value = semanticValue(view);
  if (!isObject(value) || !Array.isArray(value.members)) throw new TypeError("Grouped View requires members");
  return value.members.map(member => {
    if (!isObject(member) || typeof member.view_id !== "string" || typeof member.revision !== "number") {
      throw new TypeError("Grouped View member is not an exact View ref");
    }
    return { view_id: member.view_id, revision: member.revision };
  });
}

function assertRunProvenance(outputs: View[], runId: string, inputs: ExactViewRef[]): void {
  const expected = uniqueRefs(inputs);
  for (const output of outputs) {
    assert.equal(output.role, "derived");
    assert.equal(output.provenance.operator_run_id, runId);
    assert.deepEqual(uniqueRefs(output.provenance.inputs), expected);
    const related = uniqueRefs(output.relations
      .filter(relation => relation.type === "derived_from")
      .map(relation => relation.target));
    assert.deepEqual(related, expected);
  }
}

function uniqueRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...new Map(refs.map(ref => [`${ref.view_id}@${ref.revision}`, ref])).values()]
    .sort((left, right) => `${left.view_id}@${left.revision}`.localeCompare(`${right.view_id}@${right.revision}`));
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T13:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

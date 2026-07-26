import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  FeedbackEvolutionError,
  FeedbackEvolutionService,
  parseFeedbackView,
  type OperatorExecutionInvocation,
} from "@info/execution";
import { FunctionOperatorAdapter } from "../packages/adapters/function-operator/index.ts";
import { SqliteTransformationRepository } from "../packages/adapters/transformation-sqlite/index.ts";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  TransformationRepositoryError,
  exactTransformationRef,
  parseTransformation,
  type Transformation,
} from "@info/transformation";
import {
  exactViewRef,
  type ExactViewRef,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewSchemaRef,
} from "@info/view";

const policy: ViewPolicy = {
  owner: "user:junjie",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  labels: ["personal-learning"],
};

const accessPolicy = {
  id: "policy:feedback-evolution",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

const learningSchemaV1 = learningSchema(1, false);
const learningSchemaV2 = learningSchema(2, true);

test("Transformation revisions and idempotency survive a SQLite repository restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-transformation-restart-"));
  const dbPath = join(directory, "metaflow.sqlite");
  const source = committedRawView("view:source:repository-restart", { text: "Durable evidence" });
  const first = baseTransformation(source);
  const second = parseTransformation({
    ...first,
    revision: 2,
    supersedes: exactTransformationRef(first),
    instruction: { ...first.instruction, text: "Select one durable expression." },
    created_at: "2026-07-26T14:00:01.000Z",
  });
  const idempotencyKey = "transformation:repository-restart:2";

  let repository = new SqliteTransformationRepository(dbPath);
  try {
    await repository.commit({ transformation: first, expected_revision: 0 });
    await repository.commit({
      transformation: second,
      expected_revision: 1,
      idempotency_key: idempotencyKey,
    });
  } finally {
    repository.close();
  }

  repository = new SqliteTransformationRepository(dbPath);
  try {
    assert.deepEqual(await repository.get(exactTransformationRef(first)), first);
    assert.deepEqual(await repository.get(exactTransformationRef(second)), second);
    assert.deepEqual(await repository.getLatest(first.id), second);
    const replay = await repository.commit({
      transformation: second,
      expected_revision: 1,
      idempotency_key: idempotencyKey,
    });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.transformation, second);
    await assert.rejects(
      repository.commit({
        transformation: parseTransformation({
          ...second,
          instruction: { ...second.instruction, text: "Conflicting replay." },
        }),
        expected_revision: 1,
        idempotency_key: idempotencyKey,
      }),
      (error: unknown) => error instanceof TransformationRepositoryError && error.code === "idempotency_conflict",
    );
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("negative feedback explicitly evolves a Transformation and immutable learning View with complete lineage", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:english-page", {
      title: "Building observable runtimes",
      text: "Freeze exact evidence. Make failures observable. Preserve immutable history.",
    });
    const preference = await harness.commitRaw("view:preference:metaflow", {
      topics: ["Metaflow", "agent architecture"],
      desired_count: 2,
    });
    const initialTransformation = baseTransformation(source);
    await harness.transformations.commit({
      transformation: initialTransformation,
      expected_revision: 0,
      idempotency_key: "transformation:learning-material:1",
    });

    const initial = await harness.execute("run:learning:1", initialTransformation);
    assert.equal(initial.run.status, "succeeded");
    const firstOutput = initial.outputs[0]!;
    assert.equal(firstOutput.revision, 1);
    assert.deepEqual(semanticValue(firstOutput), { items: ["Freeze exact evidence."] });

    const recorded = await harness.feedback.record({
      feedback_id: "learning-too-generic",
      sentiment: "negative",
      message: "This is too generic. Use my Metaflow interests, produce two items, and explain why each matters.",
      actor: "user:junjie",
      occurred_at: "2026-07-26T14:01:00.000Z",
      target_view: exactViewRef(firstOutput),
      target_run_id: initial.run.id,
      requested_changes: ["instruction", "operator_configuration", "output_schema", "selection"],
      metadata: { surface: "learning-app" },
    });
    const feedbackRef = exactViewRef(recorded.view);
    const feedback = parseFeedbackView(recorded.view);
    assert.equal(recorded.view.schema.name, "metaflow.feedback");
    assert.deepEqual(feedback.target_view, exactViewRef(firstOutput));
    assert.equal(feedback.target_run_id, initial.run.id);
    assert.deepEqual(recorded.view.provenance.inputs, [exactViewRef(firstOutput)]);
    assert.equal(recorded.view.provenance.trace_id, initial.run.trace_id);

    const evolved = await harness.feedback.apply({
      feedback: feedbackRef,
      base_transformation: exactTransformationRef(initialTransformation),
      actor: "agent:feedback-planner",
      resolution: "Personalize selection, add rationale, and include the exact preference View.",
      created_at: "2026-07-26T14:02:00.000Z",
      change: {
        instruction: {
          format: "natural_language",
          text: "Create two English learning items relevant to the user's Metaflow interests and explain why each matters.",
          parameters: { count: 2, require_rationale: true },
        },
        operator: {
          ...initialTransformation.operator,
          revision: 2,
          configuration: { strategy: "personalized", count: 2 },
        },
        inputs: [
          { role: "source", required: true, sources: [{ kind: "view", ref: exactViewRef(source) }] },
          { role: "preferences", required: true, sources: [{ kind: "view", ref: exactViewRef(preference) }] },
        ],
        output: {
          schema: learningSchemaV2,
          schema_origin: "declared",
          cardinality: { min: 1, max: 1 },
        },
      },
    });
    assert.equal(evolved.revision, 2);
    assert.deepEqual(evolved.supersedes, exactTransformationRef(initialTransformation));
    assert.deepEqual(evolved.inputs.map(input => input.role), [
      "source",
      "preferences",
      "evolution_target",
      "evolution_feedback",
    ]);
    assert.deepEqual(
      (evolved.metadata.evolution as Record<string, JsonValue>).feedback,
      feedbackRef,
    );
    assert.deepEqual(
      await harness.transformations.get(exactTransformationRef(initialTransformation)),
      initialTransformation,
    );

    const improved = await harness.execute("run:learning:2", evolved);
    assert.equal(improved.run.status, "succeeded");
    const secondOutput = improved.outputs[0]!;
    assert.equal(secondOutput.id, firstOutput.id);
    assert.equal(secondOutput.revision, 2);
    assert.equal(secondOutput.schema.version, 2);
    assert.deepEqual(semanticValue(secondOutput), {
      items: ["Freeze exact evidence.", "Make failures observable."],
      rationale: "Selected for Metaflow and agent architecture interests.",
    });
    assert.deepEqual(
      secondOutput.relations.find(relation => relation.type === "supersedes")?.target,
      exactViewRef(firstOutput),
    );
    const expectedInputs = sortedRefs([
      exactViewRef(source),
      exactViewRef(preference),
      exactViewRef(firstOutput),
      feedbackRef,
    ]);
    assert.deepEqual(sortedRefs(secondOutput.provenance.inputs), expectedInputs);
    assert.deepEqual((await harness.runtime.replay("run:learning:2")).run.frozen.transformation, evolved);
    assert.deepEqual(await harness.views.get(exactViewRef(firstOutput)), firstOutput);
    assert.deepEqual(await harness.views.get(exactViewRef(secondOutput)), secondOutput);
  });
});

test("concurrent feedback evolutions use normal Transformation CAS and preserve both Feedback Views", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:concurrent", { text: "Freeze evidence." });
    const first = baseTransformation(source);
    await harness.transformations.commit({ transformation: first, expected_revision: 0 });
    const initial = await harness.execute("run:concurrent:1", first);
    const target = initial.outputs[0]!;

    const feedbackA = await harness.feedback.record({
      feedback_id: "concurrent-a",
      sentiment: "correction",
      message: "Use simpler language.",
      actor: "user:junjie",
      occurred_at: "2026-07-26T14:10:00.000Z",
      target_view: exactViewRef(target),
      requested_changes: ["instruction"],
      metadata: {},
    });
    const feedbackB = await harness.feedback.record({
      feedback_id: "concurrent-b",
      sentiment: "correction",
      message: "Use more technical language.",
      actor: "user:junjie",
      occurred_at: "2026-07-26T14:10:01.000Z",
      target_view: exactViewRef(target),
      requested_changes: ["instruction"],
      metadata: {},
    });
    const applyInputs = [
      {
        feedback: exactViewRef(feedbackA.view),
        base_transformation: exactTransformationRef(first),
        change: { instruction: { ...first.instruction, text: "Select one simple expression." } },
        actor: "agent:feedback-planner",
        resolution: "Apply simpler language.",
        created_at: "2026-07-26T14:11:00.000Z",
      },
      {
        feedback: exactViewRef(feedbackB.view),
        base_transformation: exactTransformationRef(first),
        change: { instruction: { ...first.instruction, text: "Select one technically precise expression." } },
        actor: "agent:feedback-planner",
        resolution: "Apply more technical language.",
        created_at: "2026-07-26T14:11:01.000Z",
      },
    ] as const;

    const results = await Promise.allSettled(applyInputs.map(input => harness.feedback.apply(input)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof TransformationRepositoryError);
    assert.equal((rejected as PromiseRejectedResult).reason.code, "conflict");
    assert.equal((await harness.transformations.getLatest(first.id))?.revision, 2);
    assert.ok(await harness.views.get(exactViewRef(feedbackA.view)));
    assert.ok(await harness.views.get(exactViewRef(feedbackB.view)));

    const winnerIndex = results.findIndex(result => result.status === "fulfilled");
    const replayed = await harness.feedback.apply(applyInputs[winnerIndex]!);
    assert.equal(replayed.revision, 2);
  });
});

test("feedback and evolution fail closed on mismatched Run or unresolved requested changes", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:invalid-feedback", { text: "Evidence" });
    const transformation = baseTransformation(source);
    await harness.transformations.commit({ transformation, expected_revision: 0 });
    const result = await harness.execute("run:feedback-validation", transformation);

    await assert.rejects(
      harness.feedback.record({
        feedback_id: "wrong-run",
        sentiment: "negative",
        message: "Wrong target",
        actor: "user:junjie",
        occurred_at: "2026-07-26T14:20:00.000Z",
        target_view: exactViewRef(source),
        target_run_id: result.run.id,
        requested_changes: ["instruction"],
        metadata: {},
      }),
      (error: unknown) => error instanceof FeedbackEvolutionError && error.code === "target_run_mismatch",
    );

    const feedback = await harness.feedback.record({
      feedback_id: "unresolved-change",
      sentiment: "negative",
      message: "Change both the instruction and output Schema.",
      actor: "user:junjie",
      occurred_at: "2026-07-26T14:20:01.000Z",
      target_view: exactViewRef(result.outputs[0]!),
      target_run_id: result.run.id,
      requested_changes: ["instruction", "output_schema"],
      metadata: {},
    });
    await assert.rejects(
      harness.feedback.apply({
        feedback: exactViewRef(feedback.view),
        base_transformation: exactTransformationRef(transformation),
        change: { instruction: { ...transformation.instruction, text: "A changed instruction." } },
        actor: "agent:feedback-planner",
        resolution: "Only instruction was changed.",
        created_at: "2026-07-26T14:21:00.000Z",
      }),
      (error: unknown) => error instanceof FeedbackEvolutionError && error.code === "requested_change_unresolved",
    );
    assert.equal((await harness.transformations.getLatest(transformation.id))?.revision, 1);
  });
});

type Harness = {
  views: SqliteViewRepository;
  transformations: SqliteTransformationRepository;
  runtime: ExecutionRuntime;
  feedback: FeedbackEvolutionService;
  commitRaw(id: string, value: JsonValue): Promise<View>;
  execute(runId: string, transformation: Transformation): ReturnType<ExecutionRuntime["execute"]>;
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-feedback-evolution-"));
  const dbPath = join(directory, "metaflow.sqlite");
  const views = new SqliteViewRepository(dbPath);
  const transformations = new SqliteTransformationRepository(dbPath);
  const functions = new FunctionOperatorAdapter([{
    reference: { kind: "function", function_id: "learning.extract", version: 1 },
    execute: learningOperator,
  }]);
  let identity = 0;
  const runtime = new ExecutionRuntime(
    views,
    views,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: deterministicClock(), id: kind => `${kind}:feedback:${++identity}` },
  );
  const feedback = new FeedbackEvolutionService({ views, runs: views, transformations });
  const harness: Harness = {
    views,
    transformations,
    runtime,
    feedback,
    async commitRaw(id, value) {
      return (await views.commit({ draft: rawView(id, value), expected_revision: 0 })).view;
    },
    execute(runId, transformation) {
      return runtime.execute({
        run_id: runId,
        correlation_id: `correlation:${runId}`,
        transformation,
        access_policy: accessPolicy,
        access_use: "local_execution",
      });
    },
  };
  try {
    await run(harness);
  } finally {
    transformations.close();
    views.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function baseTransformation(source: View): Transformation {
  return parseTransformation({
    id: "transformation:learning-material",
    revision: 1,
    name: "Personal English learning material",
    instruction: {
      format: "natural_language",
      text: "Select one useful English expression.",
      parameters: { count: 1 },
    },
    operator: {
      id: "operator:learning-extract",
      revision: 1,
      reference: { kind: "function", function_id: "learning.extract", version: 1 },
      configuration: { strategy: "generic", count: 1 },
      required_capabilities: [],
    },
    inputs: [{
      role: "source",
      required: true,
      sources: [{ kind: "view", ref: exactViewRef(source) }],
    }],
    output: {
      schema: learningSchemaV1,
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    policy: accessPolicy,
    created_at: "2026-07-26T14:00:00.000Z",
    metadata: { application: "english-learning" },
  });
}

function learningOperator(invocation: OperatorExecutionInvocation) {
  const target = invocation.inputs.find(binding => binding.role === "evolution_target")?.views[0];
  const personalized = invocation.run.frozen.transformation.operator.configuration.strategy === "personalized";
  const value: JsonValue = personalized
    ? {
        items: ["Freeze exact evidence.", "Make failures observable."],
        rationale: "Selected for Metaflow and agent architecture interests.",
      }
    : { items: ["Freeze exact evidence."] };
  return {
    outputs: [{
      draft: learningDraft(invocation, value, target),
      expected_revision: target?.revision ?? 0,
    }],
    diagnostics: { strategy: personalized ? "personalized" : "generic" },
  };
}

function learningDraft(invocation: OperatorExecutionInvocation, value: JsonValue, target?: View): ViewDraft {
  const inputs = invocation.inputs.flatMap(binding => binding.views.map(exactViewRef));
  return {
    id: "view:learning:daily",
    name: "Personal English learning material",
    purpose: "Personal English learning material",
    aliases: [],
    schema: invocation.run.frozen.transformation.output.schema,
    role: "derived",
    time: { created_at: invocation.run.id.endsWith(":2") ? "2026-07-26T14:03:00.000Z" : "2026-07-26T14:00:30.000Z" },
    representation: { form: "inline", kind: "learning_material", value, metadata: {} },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [
      ...inputs.map(input => ({ type: "derived_from", target: input, metadata: {} })),
      ...(target ? [{ type: "supersedes", target: exactViewRef(target), metadata: {} }] : []),
    ],
    provenance: {
      inputs,
      operator_run_id: invocation.run.id,
      actor: "function:learning.extract@1",
      trace_id: invocation.run.trace_id,
    },
    policy,
    metadata: { transformation: exactTransformationRef(invocation.run.frozen.transformation) },
  };
}

function rawView(id: string, value: JsonValue): ViewDraft {
  return {
    id,
    name: id,
    purpose: "Captured input evidence",
    aliases: [],
    schema: { name: "capture.learning-input", version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: "2026-07-26T13:59:00.000Z", created_at: "2026-07-26T14:00:00.000Z" },
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
        connection_id: "test:feedback",
        source_id: id,
        source_kind: "fixture",
        identity: "occurrence",
        assertion: "direct",
      },
      actor: "capture-ingress",
    },
    policy,
    metadata: {},
  };
}

function committedRawView(id: string, value: JsonValue): View {
  return {
    ...rawView(id, value),
    revision: 1,
  };
}

function learningSchema(version: number, rationale: boolean): ViewSchemaRef {
  return {
    name: "learning.personal-material",
    version,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: {
      type: "object",
      required: rationale ? ["items", "rationale"] : ["items"],
      additionalProperties: false,
      properties: {
        items: { type: "array", minItems: 1, items: { type: "string" } },
        ...(rationale ? { rationale: { type: "string", minLength: 1 } } : {}),
      },
    },
  };
}

function semanticValue(view: View): JsonValue {
  if (view.representation.form !== "inline") throw new TypeError("Expected inline learning material");
  return view.representation.value;
}

function sortedRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...refs].sort((left, right) => `${left.view_id}@${left.revision}`.localeCompare(`${right.view_id}@${right.revision}`));
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T14:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

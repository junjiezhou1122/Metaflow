import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CandidateArtifactRepresentationSchema,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  ExecutionRuntimeError,
  RepairExecutionService,
  failureClassification,
  parseFailureView,
  parseRepairDecisionView,
  type OperatorExecutionInvocation,
  type OperatorExecutionPort,
  type OperatorExecutionResult,
  type RepairPolicySnapshot,
} from "@info/execution";
import { SqliteTransformationRepository } from "../packages/adapters/transformation-sqlite/index.ts";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  exactTransformationRef,
  parseTransformation,
  type Transformation,
  type TransformationInputBinding,
} from "@info/transformation";
import {
  exactViewRef,
  parseViewDraft,
  type ExactViewRef,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewSchemaRef,
} from "@info/view";

const privatePolicy: ViewPolicy = {
  owner: "user:junjie",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  labels: ["failure-repair"],
};

const approveAll = {
  id: "policy:failure-repair",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

const repairPolicy: RepairPolicySnapshot = {
  id: "repair-policy:bounded",
  revision: 1,
  max_depth: 4,
  max_repeated_fingerprint: 1,
  retryable_error_codes: [],
  non_retryable_error_codes: ["authorization_denied"],
};

const strictResultSchema: ViewSchemaRef = {
  name: "result.strict",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    required: ["result"],
    additionalProperties: false,
    properties: { result: { type: "string" } },
  },
};

test("quota, candidate, policy, timeout, crash, and unknown failures remain strict bounded evidence", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:failure-matrix", { text: "Evidence" });
    const cases = [
      { scenario: "quota", expected: "quota_exhausted" },
      { scenario: "schema_invalid", expected: "candidate_invalid", artifact: true, artifactState: "captured" },
      { scenario: "large_candidate", expected: "candidate_invalid", artifact: true, artifactState: "truncated" },
      { scenario: "non_json_candidate", expected: "candidate_invalid", artifact: true, artifactState: "unavailable" },
      { scenario: "policy_denied", expected: "authorization_denied", denied: true },
      { scenario: "timeout", expected: "timeout", timeout: true },
      { scenario: "crash", expected: "operator_crashed" },
      { scenario: "unknown", expected: "unknown_external_failure" },
    ] as const;

    for (const item of cases) {
      const runId = `run:failure:${item.scenario}`;
      const scenarioTransformation = transformation({
        id: `transformation:failure:${item.scenario}`,
        scenario: item.scenario,
        inputs: exactInputs("source", [source]),
        output: strictResultSchema,
        ...(item.timeout ? { timeoutMs: 5 } : {}),
      });
      const accessPolicy = structuredClone(approveAll);
      if (item.denied) {
        accessPolicy.configuration.rules.push({
          id: "deny:failure-matrix",
          effect: "deny",
          target: { kind: "view", ref: exactViewRef(source) },
          reason: "Exercise policy failure evidence",
        });
      }
      const result = await harness.runtime.execute({
        run_id: runId,
        correlation_id: `correlation:${runId}`,
        transformation: scenarioTransformation,
        access_policy: accessPolicy,
        access_use: "local_execution",
      });

      assert.notEqual(result.run.status, "succeeded");
      assert.equal(result.outputs.length, 0);
      assert.ok(result.failure);
      assert.equal(result.failure.schema.mode, "strict");
      const failure = parseFailureView(result.failure);
      assert.equal(failureClassification(failure), item.expected);
      assert.deepEqual(failure.access_policy, accessPolicy);
      assert.equal(failure.authorization.outcome, item.denied ? "denied" : "allowed");
      assert.deepEqual(failure.causal_chain, { ancestor_failures: [], depth: 0 });
      const replay = await harness.runtime.replay(runId);
      assert.deepEqual(replay.failure?.ref, exactViewRef(result.failure));

      if (item.artifact) {
        assert.ok(failure.candidate_artifact);
        const artifact = await harness.views.get(failure.candidate_artifact);
        assert.ok(artifact?.representation.form === "inline");
        const evidence = CandidateArtifactRepresentationSchema.parse(artifact.representation.value);
        assert.equal(evidence.state, item.artifactState);
        if (evidence.state === "truncated") {
          assert.ok(evidence.byte_length && evidence.byte_length > 64 * 1024);
          assert.equal(evidence.digest?.algorithm, "sha256");
          assert.ok(evidence.preview && evidence.preview.length <= 4 * 1024);
        }
        if (evidence.state === "unavailable") assert.match(evidence.reason ?? "", /not valid JSON/);
        assert.deepEqual(replay.failure?.candidate_artifact, failure.candidate_artifact);
        assert.equal(await harness.views.getLatest(`view:result:${runId}`), undefined);
      } else {
        assert.equal(failure.candidate_artifact, undefined);
      }
    }
  });
});

test("Failure Views are split and grouped by ordinary Transformations", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:failure-operators", { text: "Evidence" });
    const failures: View[] = [];
    for (const scenario of ["quota", "crash", "unknown"] as const) {
      const runId = `run:operator-failure:${scenario}`;
      const result = await harness.execute(runId, transformation({
        id: `transformation:operator-failure:${scenario}`,
        scenario,
        inputs: exactInputs("source", [source]),
        output: strictResultSchema,
      }));
      assert.ok(result.failure);
      failures.push(result.failure);
    }

    const split = await harness.execute("run:failure-split", transformation({
      id: "transformation:failure-split",
      scenario: "split_failures",
      inputs: exactInputs("failures", failures),
      output: { name: "analysis.failure-case", version: 1, mode: "freeform" },
      cardinality: { min: failures.length, max: failures.length },
    }));
    assert.equal(split.run.status, "succeeded");
    assert.deepEqual(
      split.outputs.map(view => inlineValue(view)).sort(compareFailureCase),
      [
        { failure: exactViewRef(failures[0]!), classification: "quota_exhausted" },
        { failure: exactViewRef(failures[1]!), classification: "operator_crashed" },
        { failure: exactViewRef(failures[2]!), classification: "unknown_external_failure" },
      ].sort(compareFailureCase),
    );

    const grouped = await harness.execute("run:failure-group", transformation({
      id: "transformation:failure-group",
      scenario: "group_failures",
      inputs: exactInputs("failures", failures),
      output: { name: "view.failure-group", version: 1, mode: "freeform" },
    }));
    assert.equal(grouped.run.status, "succeeded");
    assert.deepEqual(inlineValue(grouped.outputs[0]!), {
      basis: "repair-triage",
      members: sortedRefs(failures.map(exactViewRef)),
    });
    assert.deepEqual(grouped.outputs[0]?.provenance.inputs, sortedRefs(failures.map(exactViewRef)));
  });
});

test("Execution idempotency replays frozen selector inputs after newer Views arrive", async () => {
  await withHarness(async harness => {
    const first = await harness.commitRaw("view:source:idempotency-first", { text: "First exact evidence" });
    const selectorTransformation = transformation({
      id: "transformation:selector-idempotency",
      scenario: "valid",
      inputs: [{
        role: "source",
        required: true,
        sources: [{
          kind: "selector",
          selector: {
            id: "selector:latest-failure-repair-source",
            revision: 1,
            query: {
              scope: "matching",
              schema_names: ["capture.failure-repair"],
              roles: ["raw"],
              where: {},
              revision_scope: "latest",
              order: "newest",
              limit: 1,
            },
          },
        }],
      }],
      output: strictResultSchema,
    });
    const request = {
      run_id: "run:selector-idempotency",
      correlation_id: "correlation:selector-idempotency",
      idempotency_key: "execution:selector-idempotency",
      transformation: selectorTransformation,
      access_policy: approveAll,
      access_use: "local_execution" as const,
    };
    const initial = await harness.runtime.execute(request);
    assert.equal(initial.run.status, "succeeded");
    assert.deepEqual(initial.run.frozen.inputs[0]?.selected, [exactViewRef(first)]);
    const calls = harness.operator.calls;

    const newerDraft = rawView("view:source:idempotency-newer", { text: "Newer evidence must not replace frozen input" });
    newerDraft.time.observed_at = "2026-07-26T17:00:00.000Z";
    await harness.views.commit({ draft: newerDraft, expected_revision: 0 });
    const replay = await harness.runtime.execute(request);
    assert.equal(harness.operator.calls, calls);
    assert.deepEqual(replay.run.frozen.inputs[0]?.selected, [exactViewRef(first)]);

    await assert.rejects(
      harness.runtime.execute({ ...request, run_id: "run:selector-idempotency:conflict" }),
      (error: unknown) => error instanceof ExecutionRuntimeError && error.code === "idempotency_conflict",
    );
  });
});

test("Execution idempotency returns the frozen terminal Run after repository restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-execution-idempotency-restart-"));
  const dbPath = join(directory, "metaflow.sqlite");
  const firstRepository = new SqliteViewRepository(dbPath);
  const firstOperator = new ScenarioOperator();
  const firstRuntime = new ExecutionRuntime(
    firstRepository,
    firstRepository,
    new DeterministicViewAccessAuthorizer(),
    firstOperator,
    undefined,
    { now: deterministicClock(), id: kind => `${kind}:before-restart` },
  );
  const source = (await firstRepository.commit({
    draft: rawView("view:source:idempotency-restart", { text: "Frozen before restart" }),
    expected_revision: 0,
  })).view;
  const frozenTransformation = transformation({
    id: "transformation:idempotency-restart",
    scenario: "valid",
    inputs: exactInputs("source", [source]),
    output: strictResultSchema,
  });
  const request = {
    run_id: "run:idempotency-restart",
    correlation_id: "correlation:idempotency-restart",
    idempotency_key: "execution:idempotency-restart",
    transformation: frozenTransformation,
    access_policy: approveAll,
    access_use: "local_execution" as const,
  };
  let firstResult: Awaited<ReturnType<ExecutionRuntime["execute"]>> | undefined;
  try {
    firstResult = await firstRuntime.execute(request);
    assert.equal(firstResult.run.status, "succeeded");
    assert.equal(firstOperator.calls, 1);
  } finally {
    firstRepository.close();
  }

  const restartedRepository = new SqliteViewRepository(dbPath);
  const restartedOperator = new ScenarioOperator();
  const restartedRuntime = new ExecutionRuntime(
    restartedRepository,
    restartedRepository,
    new DeterministicViewAccessAuthorizer(),
    restartedOperator,
    undefined,
    { now: deterministicClock(), id: kind => `${kind}:after-restart` },
  );
  try {
    if (!firstResult) throw new Error("Initial idempotent Run did not complete before restart");
    const replay = await restartedRuntime.execute(request);
    assert.equal(restartedOperator.calls, 0);
    assert.deepEqual(replay.run, firstResult.run);
    assert.deepEqual(replay.outputs.map(exactViewRef), firstResult.outputs.map(exactViewRef));
  } finally {
    restartedRepository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit repair creates Diagnosis, Transformation r2, repair Runs, and idempotent corrected output", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:repair-success", { text: "The exact source" });
    const original = transformation({
      id: "transformation:repairable-summary",
      scenario: "schema_invalid",
      inputs: exactInputs("source", [source]),
      output: strictResultSchema,
    });
    await harness.transformations.commit({ transformation: original, expected_revision: 0 });
    const initial = await harness.execute("run:repairable:1", original);
    assert.ok(initial.failure);

    const diagnosisTransformation = transformation({
      id: "transformation:diagnose-failure",
      scenario: "diagnose",
      inputs: exactInputs("failure", [initial.failure]),
      output: { name: "diagnosis.execution", version: 1, mode: "freeform" },
    });
    const diagnosisRequest = {
      run_id: "run:diagnosis:1",
      correlation_id: "correlation:repair-success",
      idempotency_key: "repair:diagnosis:1",
      failure: exactViewRef(initial.failure),
      transformation: diagnosisTransformation,
      access_policy: approveAll,
      access_use: "local_execution" as const,
      policy: repairPolicy,
      created_at: "2026-07-26T16:10:00.000Z",
    };
    const diagnosis = await harness.repairs.execute(diagnosisRequest);
    assert.equal(diagnosis.status, "executed");
    assert.equal(diagnosis.execution.run.status, "succeeded");
    assert.deepEqual(inlineValue(diagnosis.execution.outputs[0]!), {
      diagnosis: "Candidate output did not satisfy the declared Schema.",
    });
    const callsAfterDiagnosis = harness.operator.calls;
    const diagnosisReplay = await harness.repairs.execute(diagnosisRequest);
    assert.equal(diagnosisReplay.status, "executed");
    assert.equal(harness.operator.calls, callsAfterDiagnosis);
    assert.deepEqual(diagnosisReplay.execution.run, diagnosis.execution.run);

    const repaired = parseTransformation({
      ...original,
      revision: 2,
      supersedes: exactTransformationRef(original),
      instruction: { ...original.instruction, text: "Return a Schema-valid repaired result using the Diagnosis View." },
      operator: { ...original.operator, revision: 2, configuration: { scenario: "repaired" } },
      inputs: [
        ...exactInputs("source", [source]),
        ...exactInputs("failure", [initial.failure]),
        ...exactInputs("diagnosis", diagnosis.execution.outputs),
      ],
      created_at: "2026-07-26T16:11:00.000Z",
    });
    await harness.transformations.commit({
      transformation: repaired,
      expected_revision: 1,
      idempotency_key: "transformation:repairable-summary:2",
    });
    const repair = await harness.repairs.execute({
      run_id: "run:repairable:2",
      correlation_id: "correlation:repair-success",
      idempotency_key: "repair:corrected-output:1",
      failure: exactViewRef(initial.failure),
      transformation: repaired,
      access_policy: approveAll,
      access_use: "local_execution",
      policy: repairPolicy,
      created_at: "2026-07-26T16:12:00.000Z",
    });
    assert.equal(repair.status, "executed");
    assert.equal(repair.execution.run.status, "succeeded");
    assert.deepEqual(inlineValue(repair.execution.outputs[0]!), { result: "Repaired from exact Failure and Diagnosis evidence." });
    assert.deepEqual(repair.execution.run.frozen.repair?.parent_failure, exactViewRef(initial.failure));
    assert.equal((await harness.transformations.get(exactTransformationRef(original)))?.revision, 1);
    assert.equal((await harness.transformations.getLatest(original.id))?.revision, 2);
    assert.ok(await harness.views.get(exactViewRef(initial.failure)));
  });
});

test("failed repair preserves causal evidence and repeated or cyclic repair stops as a View", async () => {
  await withHarness(async harness => {
    const source = await harness.commitRaw("view:source:repair-loop", { text: "Evidence" });
    const initial = await harness.execute("run:repair-loop:initial", transformation({
      id: "transformation:repair-loop-source",
      scenario: "crash",
      inputs: exactInputs("source", [source]),
      output: strictResultSchema,
    }));
    assert.ok(initial.failure);

    const firstRepair = transformation({
      id: "transformation:crashing-repair",
      scenario: "repair_crash",
      inputs: exactInputs("failure", [initial.failure]),
      output: { name: "diagnosis.repair", version: 1, mode: "freeform" },
    });
    const failedRepair = await harness.repairs.execute({
      run_id: "run:repair-loop:1",
      correlation_id: "correlation:repair-loop",
      idempotency_key: "repair:loop:1",
      failure: exactViewRef(initial.failure),
      transformation: firstRepair,
      access_policy: approveAll,
      access_use: "local_execution",
      policy: repairPolicy,
      created_at: "2026-07-26T16:20:00.000Z",
    });
    assert.equal(failedRepair.status, "executed");
    assert.ok(failedRepair.execution.failure);
    const childFailure = parseFailureView(failedRepair.execution.failure);
    assert.deepEqual(childFailure.causal_chain.ancestor_failures, [exactViewRef(initial.failure)]);
    assert.deepEqual(childFailure.repair?.parent_failure, exactViewRef(initial.failure));
    assert.ok(childFailure.repair?.decision_view);

    const repeatedTransformation = parseTransformation({
      ...firstRepair,
      revision: 2,
      supersedes: exactTransformationRef(firstRepair),
      inputs: exactInputs("failure", [failedRepair.execution.failure]),
      created_at: "2026-07-26T16:21:00.000Z",
    });
    const repeated = await harness.repairs.execute({
      run_id: "run:repair-loop:2",
      correlation_id: "correlation:repair-loop",
      idempotency_key: "repair:loop:2",
      failure: exactViewRef(failedRepair.execution.failure),
      transformation: repeatedTransformation,
      access_policy: approveAll,
      access_use: "local_execution",
      policy: repairPolicy,
      created_at: "2026-07-26T16:21:01.000Z",
    });
    assert.equal(repeated.status, "blocked");
    assert.equal(parseRepairDecisionView(repeated.decision).reason, "repeated_fingerprint");
    assert.equal(await harness.views.getRun("run:repair-loop:2"), undefined);

    const cyclicFailure = await harness.commitCyclicFailure(failedRepair.execution.failure);
    const cyclic = await harness.repairs.execute({
      run_id: "run:repair-cycle:blocked",
      correlation_id: "correlation:repair-cycle",
      idempotency_key: "repair:cycle:blocked",
      failure: exactViewRef(cyclicFailure),
      transformation: transformation({
        id: "transformation:cycle-repair",
        scenario: "diagnose",
        inputs: exactInputs("failure", [cyclicFailure]),
        output: { name: "diagnosis.cycle", version: 1, mode: "freeform" },
      }),
      access_policy: approveAll,
      access_use: "local_execution",
      policy: repairPolicy,
      created_at: "2026-07-26T16:22:00.000Z",
    });
    assert.equal(cyclic.status, "blocked");
    assert.equal(parseRepairDecisionView(cyclic.decision).reason, "causal_cycle");
    assert.equal(await harness.views.getRun("run:repair-cycle:blocked"), undefined);
  });
});

type Harness = {
  views: SqliteViewRepository;
  transformations: SqliteTransformationRepository;
  runtime: ExecutionRuntime;
  repairs: RepairExecutionService;
  operator: ScenarioOperator;
  commitRaw(id: string, value: JsonValue): Promise<View>;
  commitCyclicFailure(source: View): Promise<View>;
  execute(runId: string, transformation: Transformation): ReturnType<ExecutionRuntime["execute"]>;
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-failure-repair-"));
  const dbPath = join(directory, "metaflow.sqlite");
  const views = new SqliteViewRepository(dbPath);
  const transformations = new SqliteTransformationRepository(dbPath);
  const operator = new ScenarioOperator();
  let identity = 0;
  const runtime = new ExecutionRuntime(
    views,
    views,
    new DeterministicViewAccessAuthorizer(),
    operator,
    undefined,
    { now: deterministicClock(), id: kind => `${kind}:failure-repair:${++identity}` },
  );
  const repairs = new RepairExecutionService({ views, runtime });
  const harness: Harness = {
    views,
    transformations,
    runtime,
    repairs,
    operator,
    async commitRaw(id, value) {
      return (await views.commit({ draft: rawView(id, value), expected_revision: 0 })).view;
    },
    async commitCyclicFailure(source) {
      const evidence = parseFailureView(source);
      const { repair: _repair, ...nonRepairEvidence } = evidence;
      const self: ExactViewRef = { view_id: "view:failure:causal-cycle", revision: 1 };
      const { revision: _revision, ...draft } = source;
      const value = {
        ...nonRepairEvidence,
        run_id: "run:causal-cycle-evidence",
        trace_id: "trace:causal-cycle-evidence",
        causal_chain: { ancestor_failures: [self], depth: 1 },
      };
      return (await views.commit({
        draft: parseViewDraft({
          ...draft,
          id: self.view_id,
          name: "Cyclic Failure evidence",
          representation: { ...draft.representation, value },
          relations: draft.relations.filter(relation => relation.type !== "repair_of" && relation.type !== "repair_decision"),
          provenance: { ...draft.provenance, operator_run_id: value.run_id, trace_id: value.trace_id },
        }),
        expected_revision: 0,
      })).view;
    },
    execute(runId, transformation) {
      return runtime.execute({
        run_id: runId,
        correlation_id: `correlation:${runId}`,
        transformation,
        access_policy: approveAll,
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

class ScenarioOperator implements OperatorExecutionPort {
  calls = 0;

  async execute(invocation: OperatorExecutionInvocation, context: { signal: AbortSignal }): Promise<OperatorExecutionResult> {
    this.calls += 1;
    const scenario = invocation.run.frozen.transformation.operator.configuration.scenario;
    if (scenario === "quota") {
      return { status: "failed", error: { code: "quota_exhausted", message: "Model quota is exhausted" } };
    }
    if (scenario === "unknown") {
      return { status: "failed", error: { code: "unknown_external_failure", message: "Provider returned an unknown failure" } };
    }
    if (scenario === "crash" || scenario === "repair_crash") throw new Error(`Operator code crashed: ${scenario}`);
    if (scenario === "timeout") {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted after timeout")), { once: true });
      });
    }
    if (scenario === "schema_invalid") {
      return { status: "succeeded", candidate: candidate(invocation, `view:result:${invocation.run.id}`, { wrong: true }) };
    }
    if (scenario === "large_candidate") {
      return { status: "succeeded", candidate: { invalid_envelope: "x".repeat(70 * 1024) } };
    }
    if (scenario === "non_json_candidate") {
      return { status: "succeeded", candidate: { invalid_envelope: 1n } };
    }
    if (scenario === "diagnose") {
      return {
        status: "succeeded",
        candidate: candidate(invocation, `view:diagnosis:${invocation.run.id}`, {
          diagnosis: "Candidate output did not satisfy the declared Schema.",
        }),
      };
    }
    if (scenario === "repaired") {
      return {
        status: "succeeded",
        candidate: candidate(invocation, "view:result:repairable-summary", {
          result: "Repaired from exact Failure and Diagnosis evidence.",
        }),
      };
    }
    if (scenario === "split_failures") {
      const failures = invocation.inputs.flatMap(binding => binding.views);
      return {
        status: "succeeded",
        candidate: {
          outputs: failures.map((failure, index) => ({
            draft: derivedDraft(invocation, `view:failure-case:${index}`, {
              failure: exactViewRef(failure),
              classification: failureClassification(parseFailureView(failure)),
            }),
            expected_revision: 0,
          })),
        },
      };
    }
    if (scenario === "group_failures") {
      const failures = invocation.inputs.flatMap(binding => binding.views);
      return {
        status: "succeeded",
        candidate: candidate(invocation, "view:failure-group:repair-triage", {
          basis: "repair-triage",
          members: failures.map(exactViewRef),
        }),
      };
    }
    return { status: "succeeded", candidate: candidate(invocation, `view:result:${invocation.run.id}`, { result: "ok" }) };
  }

  async cancel(): Promise<void> {}
}

function transformation(input: {
  id: string;
  scenario: string;
  inputs: TransformationInputBinding[];
  output: ViewSchemaRef;
  revision?: number;
  cardinality?: { min: number; max?: number };
  timeoutMs?: number;
}): Transformation {
  return parseTransformation({
    id: input.id,
    revision: input.revision ?? 1,
    name: input.id,
    instruction: { format: "natural_language", text: `Execute ${input.scenario}.`, parameters: {} },
    operator: {
      id: `operator:${input.id}`,
      revision: input.revision ?? 1,
      reference: { kind: "function", function_id: "failure-repair.scenario", version: 1 },
      configuration: { scenario: input.scenario },
      required_capabilities: [],
    },
    inputs: input.inputs,
    output: {
      schema: input.output,
      schema_origin: "declared",
      cardinality: input.cardinality ?? { min: 1, max: 1 },
    },
    policy: approveAll,
    ...(input.timeoutMs ? {
      budget: { id: `budget:${input.id}`, revision: 1, limits: { timeout_ms: input.timeoutMs }, extensions: {} },
    } : {}),
    created_at: "2026-07-26T16:00:00.000Z",
    metadata: {},
  });
}

function exactInputs(role: string, views: View[]): TransformationInputBinding[] {
  return [{ role, required: true, sources: views.map(view => ({ kind: "view" as const, ref: exactViewRef(view) })) }];
}

function candidate(invocation: OperatorExecutionInvocation, id: string, value: JsonValue) {
  return { outputs: [{ draft: derivedDraft(invocation, id, value), expected_revision: 0 }] };
}

function derivedDraft(invocation: OperatorExecutionInvocation, id: string, value: JsonValue): ViewDraft {
  const inputs = invocation.inputs.flatMap(binding => binding.views.map(exactViewRef));
  return {
    id,
    name: id,
    purpose: invocation.run.frozen.transformation.instruction.text,
    aliases: [],
    schema: invocation.run.frozen.transformation.output.schema,
    role: "derived",
    time: { created_at: "2026-07-26T16:00:01.000Z" },
    representation: { form: "inline", kind: "json", value, metadata: {} },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: inputs.map(target => ({ type: "derived_from", target, metadata: {} })),
    provenance: {
      inputs,
      operator_run_id: invocation.run.id,
      actor: "function:failure-repair.scenario@1",
      trace_id: invocation.run.trace_id,
    },
    policy: privatePolicy,
    metadata: {},
  };
}

function rawView(id: string, value: JsonValue): ViewDraft {
  return {
    id,
    name: id,
    purpose: "Captured test evidence",
    aliases: [],
    schema: { name: "capture.failure-repair", version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: "2026-07-26T15:59:00.000Z", created_at: "2026-07-26T16:00:00.000Z" },
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
        connection_id: "test:failure-repair",
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

function inlineValue(view: View): JsonValue {
  assert.equal(view.representation.form, "inline");
  return view.representation.value;
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-26T16:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

function compareFailureCase(left: JsonValue, right: JsonValue): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function sortedRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...refs].sort((left, right) => `${left.view_id}@${left.revision}`.localeCompare(`${right.view_id}@${right.revision}`));
}

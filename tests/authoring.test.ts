import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthoringError,
  AuthoringReceiptValueSchema,
  AuthoringService,
  lifecycleValue,
  type AuthoringObserver,
  type AuthoringProposalAgentPort,
  type AuthoringTraceEvent,
} from "@info/authoring";
import { ViewRepositoryError, exactViewRef, parseViewDraft } from "@info/view";
import { ViewPackageCatalog, defineViewPackage } from "@info/view-package";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";
import { AgentRuntimeAuthoringProposalAdapter, type AgentRuntimeAdapter, type AgentTaskRequest } from "@info/agent-runtime-adapter";

const actor = "user:local";
const policy = {
  owner: actor,
  visibility: "private" as const,
  privacy: "private" as const,
  retention: "normal" as const,
  allow_external_model: true,
  allow_embedding: false,
  allow_local_search: true,
  labels: ["authoring"],
};

test("strict Receipt contract rejects contradictory terminal state and partial Run evidence", () => {
  const base = {
    contract_version: 1 as const,
    request: { view_id: "view:authoring:request:strict-receipt", revision: 1 },
    completed_by: actor,
    trace_id: "trace:authoring:strict-receipt",
  };
  assert.equal(AuthoringReceiptValueSchema.safeParse({
    ...base,
    status: "applied",
    target: { kind: "view_package", id: "view-package.learning", version: 1, manifest_digest: "a".repeat(64) },
    error: { code: "must_not_coexist", message: "contradictory" },
  }).success, false);
  assert.equal(AuthoringReceiptValueSchema.safeParse({
    ...base,
    status: "failed",
    target: { kind: "view", ref: { view_id: "view:target", revision: 1 } },
    error: { code: "failed", message: "failed" },
  }).success, false);
  assert.equal(AuthoringReceiptValueSchema.safeParse({
    ...base,
    status: "applied",
    target: {
      kind: "transformation",
      ref: { transformation_id: "transformation:strict-receipt", revision: 1 },
      run_id: "run:strict-receipt",
    },
  }).success, false);
});

test("Agent authoring adapter requests schema_value and returns untrusted JSON without commit authority", async () => {
  let task: AgentTaskRequest | undefined;
  let submitCalls = 0;
  const runtime: AgentRuntimeAdapter = {
    id: "runtime:authoring-test",
    kind: "mock",
    async capabilities() { return { runtimeId: this.id, kind: this.kind }; },
    async submit(input) {
      submitCalls += 1;
      task = input;
      return { ok: true, reason: "candidate", schemaValue: viewCandidate() as any };
    },
  };
  const request = {
    request: {
      contract_version: 1,
      artifact_kind: "view",
      prompt: "Create a learning View",
      source_views: [],
      requested_by: actor,
      trace_id: "trace:agent-authoring",
    },
    request_ref: { view_id: "view:request:agent-authoring", revision: 1 },
    policy: { ...policy, allow_external_model: false },
    output_schema: { type: "object" },
  };
  const adapter = new AgentRuntimeAuthoringProposalAdapter([runtime], runtime.id, { local_runtime_ids: [runtime.id] });
  const candidate = await adapter.propose(request, { signal: new AbortController().signal });
  assert.deepEqual(candidate, viewCandidate());
  assert.equal(task?.outputContract.mode, "schema_value");
  assert.equal(task?.policy?.allowExternalLlm, false);
  assert.equal(task?.policy?.allowWrite, false);
  assert.equal(task?.constraints?.direct_commit_forbidden, true);
  await assert.rejects(
    new AgentRuntimeAuthoringProposalAdapter([runtime], runtime.id).propose(request, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof AuthoringError && error.code === "authoring_external_model_forbidden",
  );
  assert.equal(submitCalls, 1, "a forbidden external runtime must not receive the Request");
});

test("concrete View authoring freezes proposal digest, requires exact approval, applies through ViewRepository, and replays", async () => {
  await withHarness(viewCandidate(), async harness => {
    const request = await harness.service.request(requestInput("view"), actor);
    const requestReplay = await harness.service.request(requestInput("view"), actor);
    assert.deepEqual(requestReplay, request);

    const proposal = await harness.service.propose(proposeInput(exactViewRef(request)), actor);
    const proposalReplay = await harness.service.propose(proposeInput(exactViewRef(request)), actor);
    assert.deepEqual(proposalReplay, proposal);
    assert.equal(harness.agent.calls, 1, "idempotent replay must not invoke the Agent again");
    await assert.rejects(
      harness.service.propose(proposeInput(exactViewRef(request)), "user:other"),
      (error: unknown) => error instanceof AuthoringError && error.code === "authoring_owner_mismatch",
    );
    const proposalValue = lifecycleValue(proposal);
    assert.equal("artifact_digest" in proposalValue, true);
    if (!("artifact_digest" in proposalValue)) throw new Error("expected Proposal value");

    await assert.rejects(
      harness.service.approve(decisionInput(exactViewRef(proposal), "0".repeat(64)), actor),
      (error: unknown) => error instanceof AuthoringError && error.code === "authoring_digest_mismatch",
    );

    const decision = await harness.service.approve(decisionInput(exactViewRef(proposal), proposalValue.artifact_digest), actor);
    const receipt = await harness.service.apply(applyInput(exactViewRef(decision)), actor);
    const receiptReplay = await harness.service.apply(applyInput(exactViewRef(decision)), actor);
    assert.deepEqual(receiptReplay, receipt);
    const receiptValue = lifecycleValue(receipt);
    assert.equal("status" in receiptValue && receiptValue.status, "applied");
    if (!("target" in receiptValue) || receiptValue.target?.kind !== "view") throw new Error("expected applied View target");
    const target = await harness.views.get(receiptValue.target.ref);
    assert.equal(target?.name, "English learning collection");
    assert.equal(target?.policy.owner, actor);
    assert.deepEqual(target?.provenance.inputs, [exactViewRef(request)]);
    assert.deepEqual((await harness.service.inspect({ ref: exactViewRef(receipt) })).lifecycle, receiptValue);
    assert.deepEqual(harness.events.map(event => event.type), [
      "authoring.requested",
      "authoring.proposed",
      "authoring.approved",
      "authoring.applied",
    ]);
  });
});

test("Request policy cannot weaken exact source View policy and target provenance retains the sources", async () => {
  await withHarness(viewCandidate(), async harness => {
    const source = (await harness.views.commit({
      draft: parseViewDraft({
        id: "view:authoring:sensitive-source",
        name: "Sensitive learning source",
        purpose: "Prove authoring policy inheritance",
        schema: { name: "learning.sensitive.source", version: 1, mode: "freeform" },
        role: "derived",
        time: { created_at: "2026-07-27T00:59:00.000Z" },
        representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: "private", metadata: {} },
        materialization: {
          primary: { id: "canonical", format: "markdown", media_type: "text/markdown", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: [],
        provenance: { inputs: [], actor },
        policy: { ...policy, privacy: "sensitive", allow_external_model: false, allow_embedding: false, labels: ["authoring", "sensitive"] },
        metadata: {},
      }),
      expected_revision: 0,
    })).view;
    const sourceRef = exactViewRef(source);
    const weak = { ...requestInput("view", "policy-weak"), source_views: [sourceRef] };
    await assert.rejects(
      harness.service.request(weak, actor),
      (error: unknown) => error instanceof AuthoringError && error.code === "authoring_policy_weakening",
    );
    const inheritedPolicy = {
      ...policy,
      privacy: "sensitive" as const,
      allow_external_model: false,
      allow_embedding: false,
      labels: ["authoring", "sensitive"],
    };
    const request = await harness.service.request({
      ...requestInput("view", "policy-safe"),
      source_views: [sourceRef],
      policy: inheritedPolicy,
    }, actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "policy-safe"), actor);
    const value = lifecycleValue(proposal) as any;
    const decision = await harness.service.approve(decisionInput(exactViewRef(proposal), value.artifact_digest, "policy-safe"), actor);
    const receipt = await harness.service.apply(applyInput(exactViewRef(decision), "policy-safe"), actor);
    const target = (lifecycleValue(receipt) as any).target;
    const authored = await harness.views.get(target.ref);
    assert.deepEqual(authored?.provenance.inputs, [exactViewRef(request), sourceRef]);
    assert.deepEqual(authored?.policy, inheritedPolicy);
  });
});

test("reject atomically commits exact Decision and terminal Receipt", async () => {
  await withHarness(viewCandidate(), async harness => {
    const request = await harness.service.request(requestInput("view", "reject"), actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "reject"), actor);
    const value = lifecycleValue(proposal);
    if (!("artifact_digest" in value)) throw new Error("expected Proposal value");
    const rejected = await harness.service.reject({
      ...decisionInput(exactViewRef(proposal), value.artifact_digest, "reject"),
      receipt_view_id: "view:authoring:receipt:reject",
    }, actor);
    assert.equal((lifecycleValue(rejected.decision) as any).decision, "rejected");
    assert.equal((lifecycleValue(rejected.receipt) as any).status, "rejected");
    const replay = await harness.service.reject({
      ...decisionInput(exactViewRef(proposal), value.artifact_digest, "reject"),
      receipt_view_id: "view:authoring:receipt:reject",
    }, actor);
    assert.deepEqual(replay, rejected);
  });
});

test("View Package proposal resolves an exact registered manifest and rejects executable Agent payload", async () => {
  const catalog = new ViewPackageCatalog();
  catalog.register(examplePackage());
  await withHarness({ kind: "view_package", package: { id: "view-package.learning", version: 1 } }, async harness => {
    harness.catalog.register(examplePackage());
    const request = await harness.service.request(requestInput("view_package", "package"), actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "package"), actor);
    const proposalValue = lifecycleValue(proposal) as any;
    assert.match(proposalValue.artifact.package.manifest_digest, /^[a-f0-9]{64}$/);
    const decision = await harness.service.approve(decisionInput(exactViewRef(proposal), proposalValue.artifact_digest, "package"), actor);
    const receipt = await harness.service.apply(applyInput(exactViewRef(decision), "package"), actor);
    assert.deepEqual((lifecycleValue(receipt) as any).target, {
      kind: "view_package",
      id: "view-package.learning",
      version: 1,
      manifest_digest: proposalValue.artifact.package.manifest_digest,
    });
  });

  await withHarness({
    kind: "view_package",
    package: { id: "view-package.learning", version: 1, code: "export default () => process.exit()" },
  }, async harness => {
    harness.catalog.register(examplePackage());
    const request = await harness.service.request(requestInput("view_package", "code"), actor);
    await assert.rejects(
      harness.service.propose(proposeInput(exactViewRef(request), "code"), actor),
      (error: unknown) => error instanceof AuthoringError
        && error.code === "authoring_candidate_invalid"
        && typeof error.details.receipt === "object",
    );
    const receipt = await harness.views.get({ view_id: "view:authoring:receipt:proposal-failure:code", revision: 1 });
    assert.equal((lifecycleValue(receipt!) as any).status, "failed");
    await assert.rejects(
      harness.service.propose(proposeInput(exactViewRef(request), "code"), actor),
      (error: unknown) => error instanceof AuthoringError
        && error.code === "authoring_candidate_invalid"
        && error.details.replayed === true,
    );
    assert.equal(harness.agent.calls, 1, "a failed Proposal replay must not invoke the Agent again");
  });
});

test("Transformation proposal commits through CAS and optionally invokes ordinary Execution", async () => {
  const transformation = {
    id: "transformation:authored:summary",
    revision: 1,
    name: "Authored summary",
    instruction: { format: "natural_language", text: "Summarize the selected Views", parameters: {} },
    operator: {
      id: "operator:registered:summary",
      revision: 1,
      reference: { kind: "function", function_id: "summary", version: 1 },
      configuration: {},
      required_capabilities: [],
    },
    inputs: [],
    output: {
      schema: { name: "summary.authored", version: 1, mode: "freeform" },
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    created_at: "2026-07-27T01:10:00.000Z",
    metadata: {},
  };
  const execute = {
    run_id: "run:authoring:summary",
    correlation_id: "correlation:authoring:summary",
    access_policy: { id: "policy:authoring", revision: 1, configuration: { kind: "view_access", profile: "approve_all", rules: [] } },
    access_use: "local_execution",
    idempotency_key: "execution:authoring:summary",
  };
  await withHarness({ kind: "transformation", transformation, expected_revision: 0, execute }, async harness => {
    const request = await harness.service.request(requestInput("transformation", "transformation"), actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "transformation"), actor);
    const proposalValue = lifecycleValue(proposal) as any;
    const decision = await harness.service.approve(decisionInput(exactViewRef(proposal), proposalValue.artifact_digest, "transformation"), actor);
    const receipt = await harness.service.apply(applyInput(exactViewRef(decision), "transformation"), actor);
    assert.deepEqual((lifecycleValue(receipt) as any).target, {
      kind: "transformation",
      ref: { transformation_id: transformation.id, revision: 1 },
      run_id: execute.run_id,
      run_status: "succeeded",
    });
    assert.equal((await harness.transformations.get({ transformation_id: transformation.id, revision: 1 }))?.name, transformation.name);
    assert.equal(harness.executions.length, 1);
  });
});

test("Agent-generated executable Transformation configuration is explicitly rejected with a Receipt", async () => {
  const candidate = transformationCandidate("transformation:authored:executable");
  candidate.transformation.operator.configuration = { code: "export default async function run() {}" };
  await withHarness(candidate, async harness => {
    const request = await harness.service.request(requestInput("transformation", "executable"), actor);
    await assert.rejects(
      harness.service.propose(proposeInput(exactViewRef(request), "executable"), actor),
      (error: unknown) => error instanceof AuthoringError
        && error.code === "authoring_executable_payload_forbidden"
        && typeof error.details.receipt === "object",
    );
    const receipt = await harness.views.get({ view_id: "view:authoring:receipt:proposal-failure:executable", revision: 1 });
    assert.equal((lifecycleValue(receipt!) as any).status, "failed");
  });
});

test("oversized Agent output fails before deep candidate validation and persists the exact failure", async () => {
  const oversized = viewCandidate();
  oversized.view.representation.value = "x".repeat(1_000_001);
  await withHarness(oversized, async harness => {
    const request = await harness.service.request(requestInput("view", "oversized"), actor);
    await assert.rejects(
      harness.service.propose(proposeInput(exactViewRef(request), "oversized"), actor),
      (error: unknown) => error instanceof AuthoringError
        && error.code === "authoring_candidate_too_large"
        && typeof error.details.receipt === "object",
    );
    assert.equal(harness.agent.calls, 1);
  });
});

test("failed apply commits an exact terminal Receipt before surfacing the dependency error", async () => {
  const invalidCasCandidate = {
    kind: "transformation",
    transformation: {
      id: "transformation:authored:invalid-cas",
      revision: 1,
      name: "Invalid CAS proposal",
      instruction: { format: "natural_language", text: "This commit must fail its expected base", parameters: {} },
      operator: {
        id: "operator:registered:summary",
        revision: 1,
        reference: { kind: "function", function_id: "summary", version: 1 },
        configuration: {},
        required_capabilities: [],
      },
      inputs: [],
      output: {
        schema: { name: "summary.invalid-cas", version: 1, mode: "freeform" },
        schema_origin: "declared",
        cardinality: { min: 1, max: 1 },
      },
      created_at: "2026-07-27T01:20:00.000Z",
      metadata: {},
    },
    expected_revision: 1,
  };
  await withHarness(invalidCasCandidate, async harness => {
    const request = await harness.service.request(requestInput("transformation", "apply-failure"), actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "apply-failure"), actor);
    const proposalValue = lifecycleValue(proposal) as any;
    const decision = await harness.service.approve(decisionInput(exactViewRef(proposal), proposalValue.artifact_digest, "apply-failure"), actor);
    const apply = applyInput(exactViewRef(decision), "apply-failure");
    await assert.rejects(
      harness.service.apply(apply, actor),
      (error: unknown) => error instanceof AuthoringError && typeof error.details.receipt === "object",
    );
    const receipt = await harness.views.get({ view_id: apply.receipt_view_id, revision: 1 });
    assert.equal((lifecycleValue(receipt!) as any).status, "failed");
    await assert.rejects(
      harness.service.apply(apply, actor),
      (error: unknown) => error instanceof AuthoringError
        && typeof error.details.receipt === "object"
        && error.details.replayed === true,
    );
  });
});

test("a target commit followed by Receipt storage failure remains retryable and never records a false failure", async () => {
  await withHarness(viewCandidate(), async harness => {
    const request = await harness.service.request(requestInput("view", "receipt-recovery"), actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "receipt-recovery"), actor);
    const proposalValue = lifecycleValue(proposal) as any;
    const decision = await harness.service.approve(
      decisionInput(exactViewRef(proposal), proposalValue.artifact_digest, "receipt-recovery"),
      actor,
    );
    const apply = applyInput(exactViewRef(decision), "receipt-recovery");
    const commit = harness.views.commit.bind(harness.views);
    let failReceiptOnce = true;
    harness.views.commit = async (input, context) => {
      if (failReceiptOnce && input.draft.schema.name === "metaflow.authoring.receipt") {
        failReceiptOnce = false;
        throw new ViewRepositoryError("simulated Receipt storage interruption", "storage_failure", {
          operation: "commit",
          phase: "receipt_test",
        });
      }
      return commit(input, context);
    };

    await assert.rejects(
      harness.service.apply(apply, actor),
      (error: unknown) => error instanceof AuthoringError
        && error.code === "authoring_receipt_commit_failed"
        && (error.details.target as any)?.kind === "view",
    );
    assert.equal(await harness.views.get({ view_id: apply.receipt_view_id, revision: 1 }), undefined);
    assert.ok(await harness.views.get({ view_id: "view:learning:english", revision: 1 }), "target must remain committed");

    const receipt = await harness.service.apply(apply, actor);
    assert.equal((lifecycleValue(receipt) as any).status, "applied");
    assert.equal((await harness.views.query({ schema_name: "learning.english.collection", revisions: "all" })).length, 1);
  });
});

test("Apply rejects lifecycle and target identity collisions before committing either target or Receipt", async () => {
  await withHarness(viewCandidate(), async harness => {
    const request = await harness.service.request(requestInput("view", "identity-conflict"), actor);
    const proposal = await harness.service.propose(proposeInput(exactViewRef(request), "identity-conflict"), actor);
    const proposalValue = lifecycleValue(proposal) as any;
    const decision = await harness.service.approve(
      decisionInput(exactViewRef(proposal), proposalValue.artifact_digest, "identity-conflict"),
      actor,
    );
    await assert.rejects(
      harness.service.apply({
        ...applyInput(exactViewRef(decision), "identity-conflict"),
        receipt_view_id: "view:learning:english",
      }, actor),
      (error: unknown) => error instanceof AuthoringError && error.code === "authoring_target_identity_conflict",
    );
    assert.equal(await harness.views.get({ view_id: "view:learning:english", revision: 1 }), undefined);
  });
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function withHarness(candidate: unknown, run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness(candidate);
  try {
    await run(harness);
  } finally {
    harness.transformations.close();
    harness.views.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
}

async function createHarness(candidate: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-authoring-"));
  const database = join(directory, "metaflow.sqlite");
  const views = new SqliteViewRepository(database);
  const transformations = new SqliteTransformationRepository(database);
  const catalog = new ViewPackageCatalog();
  const events: AuthoringTraceEvent[] = [];
  const observer: AuthoringObserver = { async record(event) { events.push(event); } };
  const agent = new FixedAgent(candidate);
  const executions: unknown[] = [];
  const service = new AuthoringService({
    views,
    transformations,
    packages: catalog,
    agent,
    observer,
    execution: {
      async execute(input) {
        executions.push(input);
        return { run: { id: input.run_id, status: "succeeded" }, outputs: [] } as any;
      },
    },
    now: deterministicClock(),
  });
  return { directory, views, transformations, catalog, events, agent, executions, service };
}

class FixedAgent implements AuthoringProposalAgentPort {
  calls = 0;
  constructor(private readonly candidate: unknown) {}
  async propose(): Promise<unknown> {
    this.calls += 1;
    return this.candidate;
  }
}

function requestInput(kind: "view" | "transformation" | "view_package", suffix = "success") {
  return {
    view_id: `view:authoring:request:${suffix}`,
    expected_revision: 0,
    artifact_kind: kind,
    prompt: `Create ${kind} for English learning`,
    source_views: [],
    policy,
    trace_id: `trace:authoring:${suffix}`,
    idempotency_key: `authoring:request:${suffix}`,
    created_at: "2026-07-27T01:00:00.000Z",
  };
}

function proposeInput(request: { view_id: string; revision: number }, suffix = "success") {
  return {
    request,
    proposal_view_id: `view:authoring:proposal:${suffix}`,
    expected_revision: 0,
    idempotency_key: `authoring:proposal:${suffix}`,
    failure_receipt_view_id: `view:authoring:receipt:proposal-failure:${suffix}`,
    created_at: "2026-07-27T01:01:00.000Z",
  };
}

function decisionInput(proposal: { view_id: string; revision: number }, digest: string, suffix = "success") {
  return {
    proposal,
    proposal_digest: digest,
    decision_view_id: `view:authoring:decision:${suffix}`,
    expected_revision: 0,
    idempotency_key: `authoring:decision:${suffix}`,
    created_at: "2026-07-27T01:02:00.000Z",
  };
}

function applyInput(decision: { view_id: string; revision: number }, suffix = "success") {
  return {
    decision,
    receipt_view_id: `view:authoring:receipt:${suffix}`,
    expected_revision: 0,
    idempotency_key: `authoring:apply:${suffix}`,
    created_at: "2026-07-27T01:03:00.000Z",
  };
}

function viewCandidate() {
  return {
    kind: "view",
    view: {
      id: "view:learning:english",
      name: "English learning collection",
      purpose: "Combine useful English learning material",
      aliases: [],
      schema: { name: "learning.english.collection", version: 1, mode: "freeform" },
      representation: {
        form: "inline",
        kind: "markdown",
        media_type: "text/markdown",
        value: "# English learning",
        metadata: {},
      },
      materialization: {
        primary: { id: "canonical", format: "markdown", media_type: "text/markdown", location: { kind: "inline" } },
        alternatives: [],
      },
      relations: [],
      metadata: {},
      expected_revision: 0,
    },
  };
}

function transformationCandidate(id: string) {
  return {
    kind: "transformation" as const,
    transformation: {
      id,
      revision: 1,
      name: "Authored Transformation",
      instruction: { format: "natural_language" as const, text: "Transform exact Views", parameters: {} },
      operator: {
        id: "operator:registered:authoring",
        revision: 1,
        reference: { kind: "function" as const, function_id: "registered-authoring", version: 1 },
        configuration: {} as Record<string, unknown>,
        required_capabilities: [],
      },
      inputs: [],
      output: {
        schema: { name: "authored.output", version: 1, mode: "freeform" as const },
        schema_origin: "declared" as const,
        cardinality: { min: 1, max: 1 },
      },
      created_at: "2026-07-27T01:30:00.000Z",
      metadata: {},
    },
    expected_revision: 0,
  };
}

function examplePackage() {
  const schema = { name: "learning.package.example", version: 1, mode: "freeform" as const };
  const schemaKey = { name: schema.name, version: schema.version };
  return defineViewPackage({
    manifest_version: 1,
    id: "view-package.learning",
    version: 1,
    name: "Learning package",
    description: "Registered exact learning package",
    schemas: [schema],
    representations: [{ id: "learning-markdown", schema: schemaKey, forms: ["inline"], kinds: ["markdown"], media_types: ["text/markdown"] }],
    materializations: [{ id: "learning-markdown", schema: schemaKey, formats: ["markdown"], media_types: ["text/markdown"], locations: ["inline"] }],
    renderers: [],
    parsers: [],
    processors: [],
    methods: [],
    evolutions: [],
  });
}

function deterministicClock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-27T01:00:00.000Z") + tick++ * 10).toISOString();
}

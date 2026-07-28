import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AuthoringService,
} from "@info/authoring";
import {
  CaptureIngress,
  ConnectorPackageCatalog,
  ConnectorRuntime,
  SourceConnectionOnboardingService,
  TrustedConnectorPackageLoader,
} from "@info/capture";
import {
  AgentOperatorExecutionBridge,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  FeedbackEvolutionService,
  OperatorExecutionRouter,
} from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  MARKDOWN_PARSER_FUNCTION,
  executeMarkdownParser,
} from "@info/markdown-parser-adapter";
import {
  GrantOperationAuthorizer,
  OperationService,
  RepositoryViewReadAuthorizer,
  type OperationContext,
  type OperationEnvelope,
  type OperationName,
} from "@info/operations";
import { SearchService } from "@info/search";
import {
  SqliteVecEmbeddingViewSchema,
  SqliteViewRepository,
  sqliteVecSourceDigest,
} from "@info/storage-sqlite";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";
import { exactTransformationRef, type Transformation } from "@info/transformation";
import {
  AgentExecutionAdapter,
  AgentRuntimeAuthoringProposalAdapter,
  type AgentRuntimeAdapter,
  type AgentRuntimeContext,
  type AgentTaskRequest,
  type AgentTaskResult,
} from "@info/agent-runtime-adapter";
import {
  PrivacyForgetService,
  exactViewRef,
  parseViewDraft,
  type ExactViewRef,
  type View,
  type ViewDraft,
} from "@info/view";
import { ViewPackageCatalog } from "@info/view-package";
import {
  APPLICATION_SPACE_COMPOSITION_RELATION,
  APPLICATION_SPACE_MEMBERSHIP_RELATION,
} from "../view-packages/application-space/index.ts";
import {
  CodexHistoryCaptureConnector,
  codexHistorySourceConnection,
  configureCodexHistoryCapture,
} from "@info/codex-history-capture-adapter";
import {
  OBSIDIAN_IDENTITY_POLICY,
  OBSIDIAN_PARSER_CONTRACT,
  OBSIDIAN_SECRET_POLICY,
  ObsidianCaptureAdapter,
  configureObsidianCapture,
  obsidianSourceConnection,
  type ObsidianWatcherAccelerator,
} from "@info/obsidian-capture-adapter";
import { obsidianMarkdownParserTransformation } from "../apps/ambient-daemon/definitions.ts";
import { createAmbientDaemonComposition } from "../apps/ambient-daemon/composition.ts";
import {
  PersonalizedWorkflowError,
  projectPersonalizedWorkflowEvidence,
  runPersonalizedViewWorkflow,
  type PersonalizedWorkflowInput,
} from "../scripts/v1/personalized-view-workflow.ts";

const OWNER = "user:local";
const CREATED_AT = "2026-07-27T10:00:00.000Z";
const EMBEDDING_PROFILE = {
  id: "embedding:personalized-workflow",
  revision: 1,
  provider: "fixture",
  model: "synthetic-three-dimensional-vector",
  dimension: 3,
  distance_metric: "cosine" as const,
};
const POLICY = {
  owner: OWNER,
  visibility: "private" as const,
  privacy: "private" as const,
  retention: "normal" as const,
  allow_external_model: true,
  allow_embedding: true,
  allow_local_search: true,
  labels: ["personalized-workflow"],
};
const ACCESS_POLICY = {
  id: "policy:personalized-workflow",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

test("personalized Codex and Obsidian Views form, search, evolve, replay, and forget through shared Operations", async () => {
  const fixture = await createSourceFixture();
  const database = join(fixture.root, "metaflow.sqlite");
  const agent = new PersonalizedAgentRuntime();
  let harness = await createHarness(database, fixture, agent);
  try {
    const codexReceipts = await harness.capture.run(harness.codexConnectionId, "pull", {});
    const obsidianReceipts = await harness.capture.run(harness.obsidianConnectionId, "pull", {});
    assert.equal(codexReceipts.length, 1);
    assert.equal(obsidianReceipts.length, 3);

    const rawViews = await harness.views.query({ role: "raw", revisions: "latest", limit: 50 });
    const codexViews = rawViews.filter(view => view.schema.name.startsWith("capture.codex."));
    const obsidianViews = rawViews.filter(view => view.schema.name === "capture.obsidian.document");
    assert.equal(codexViews.length, 3);
    assert.equal(obsidianViews.length, 3);
    assert.ok(rawViews.every(view => view.revision === 1));
    assert.ok(rawViews.every(view => view.provenance.capture?.assertion === "direct"));
    assert.ok(rawViews.every(view => view.policy.allow_embedding && view.policy.allow_local_search));
    assert.ok(rawViews.every(view => !JSON.stringify(view).includes(fixture.root)));

    await harness.transformations.commit({
      transformation: obsidianMarkdownParserTransformation,
      expected_revision: 0,
      idempotency_key: "seed:personalized:markdown-parser",
    });
    let embedding: View | undefined;
    const workflow = await runPersonalizedViewWorkflow({
      workflow_id: "personalized",
      created_at: CREATED_AT,
      principal: { id: OWNER, grants: ["*"] },
      ports: { views: harness.views, transformations: harness.transformations, operations: harness.service },
      sources: {
        codex: codexViews.sort(compareViews).map(exactViewRef),
        obsidian: obsidianViews.sort(compareViews).map(exactViewRef),
      },
      markdown_parser: {
        transformation: exactTransformationRef(obsidianMarkdownParserTransformation),
        access_policy: ACCESS_POLICY,
      },
      authoring: {
        prompt: "Create a View that compares decisions reflected in code with wiki-only decisions and contradictions.",
        approval_reason: "The exact sources and strict working-state output are correct.",
        expected_output_schema: { name: "personal.working_state", version: 1 },
        expected_working_state_view_id: "view:personalized:working-state",
      },
      search: {
        keyword_query: "prioritizes",
        internal_query: "retrieval contract",
        relation_query: "personalized",
      },
      feedback: {
        message: "Separate unresolved contradictions from wiki-only future plans.",
        requested_changes: ["instruction"],
        evolved_instruction: "Compare exact code and wiki evidence, and separate unresolved contradictions from future plans.",
        resolution: "Applied the requested distinction to the Transformation instruction.",
      },
      semantic_gate: async ({ working_state, operations }) => {
        embedding = (await harness.views.commit({
          draft: embeddingDraft(working_state, workingStateText(working_state)),
          expected_revision: 0,
          idempotency_key: "embedding:personalized:working-state",
        })).view;
        const semantic = await search(operations, "semantic", {
          contract_version: 1,
          query: { text: "What changed between implementation and the wiki?" },
          scope: { kind: "exact_views", refs: [exactViewRef(working_state), exactViewRef(embedding)] },
          target: { envelope: false, internal: true, related_views: false },
          modes: ["semantic"],
          semantic: { embedding_profile: { id: EMBEDDING_PROFILE.id, revision: EMBEDDING_PROFILE.revision } },
          fusion: { strategy: "rrf@1", k: 60, weights: { semantic: 1 } },
          failure_mode: "require_all",
          page: { limit: 20 },
        });
        assert.deepEqual(semantic.hits[0]?.ref, exactViewRef(working_state));
        assert.deepEqual(semantic.hits[0]?.matches[0]?.semantic_evidence_ref, exactViewRef(embedding));
      },
    });

    assert.equal(agent.authoringCalls, 1);
    assert.equal(agent.executionCalls, 1);
    assert.equal(workflow.fragment_views.length, 3);
    assert.equal(workflow.application_space.schema.name, "application.space");
    assert.equal(workflow.application_space.relations.filter(relation => relation.type === APPLICATION_SPACE_COMPOSITION_RELATION).length, 1);
    assert.equal(workflow.application_space.relations.filter(relation => relation.type === APPLICATION_SPACE_MEMBERSHIP_RELATION).length, 3);
    assert.equal(workflow.feedback.transformation.revision, 2);
    assert.equal(workflow.semantic_gate_executed, true);
    assert.ok(embedding);
    const evidence = projectPersonalizedWorkflowEvidence(workflow);
    assert.equal(evidence.source_counts.total, 6);
    assert.equal(evidence.semantic_gate_executed, true);
    assert.doesNotMatch(JSON.stringify(evidence), /Implemented exact revision search|retrieval contract requires|Graph Explorer before/u);

    const exactRefsBeforeRestart = [
      ...rawViews,
      ...workflow.fragment_views,
      workflow.working_state,
      workflow.application_space,
      embedding,
      workflow.feedback.view,
    ].map(item => exactViewRef(item));
    const replayInput = runExecutionInput(exactTransformationRef(workflow.authoring.transformation), workflow.source_refs);
    await harness.close();
    harness = await createHarness(database, fixture, agent);
    for (const ref of exactRefsBeforeRestart) assert.ok(await harness.views.get(ref), `${ref.view_id}@${ref.revision}`);
    assert.deepEqual(await harness.capture.run(harness.codexConnectionId, "pull", {}), []);
    assert.deepEqual(await harness.capture.run(harness.obsidianConnectionId, "pull", {}), []);
    const replay = await executeOk(harness.service, "run.execute", replayInput, "request:execution:replay");
    assert.equal((replay.data as { run: { status: string } }).run.status, "succeeded");
    assert.deepEqual(executionOutputs(replay.data).map(exactViewRef), [exactViewRef(workflow.working_state)]);
    assert.equal(agent.executionCalls, 1, "durable idempotent replay must not invoke the Agent again");

    const forgottenSource = workflow.source_views.codex.find(view => view.schema.name === "capture.codex.message")!;
    const preview = await executeOk(harness.service, "privacy.forget.request", {
      request_id: "forget:personalized:codex-message",
      requested_at: tick(20),
      targets: [{ kind: "exact_view", ref: exactViewRef(forgottenSource) }],
      mixed_source_rule: "purge",
    }, "request:forget:preview");
    const forgotten = await executeOk(harness.service, "privacy.forget.execute", {
      request_id: "forget:personalized:codex-message",
      authorization: { kind: "confirmed_preview", plan_digest: (preview.data as any).plan.plan_digest },
    }, "request:forget:execute");
    assert.equal((forgotten.data as { status: string }).status, "succeeded");
    assert.equal(await harness.views.get(exactViewRef(forgottenSource)), undefined);
    assert.equal(await harness.views.get(exactViewRef(workflow.working_state)), undefined);
    assert.equal(await harness.views.get(exactViewRef(workflow.application_space)), undefined);
    assert.equal(await harness.views.get(exactViewRef(embedding)), undefined);
  } finally {
    await harness.close();
    await fixture.cleanup();
  }
});

test("personalized workflow rejects missing, duplicate, over-limit, wrong-Schema, and non-Raw exact sources before processing", async t => {
  const fixture = await createSourceFixture();
  const database = join(fixture.root, "metaflow.sqlite");
  const agent = new PersonalizedAgentRuntime();
  const harness = await createHarness(database, fixture, agent);
  try {
    await harness.capture.run(harness.codexConnectionId, "pull", {});
    await harness.capture.run(harness.obsidianConnectionId, "pull", {});
    const rawViews = await harness.views.query({ role: "raw", revisions: "latest", limit: 50 });
    const codex = rawViews.filter(view => view.schema.name.startsWith("capture.codex.")).sort(compareViews);
    const obsidian = rawViews.filter(view => view.schema.name === "capture.obsidian.document").sort(compareViews);
    const derivedCodex = (await harness.views.commit({
      draft: parseViewDraft({
        id: "view:personalized:invalid-derived-source",
        name: "Invalid derived source fixture",
        purpose: "Prove the workflow rejects a non-Raw source before processing",
        aliases: [],
        schema: { name: "capture.codex.message", version: 1, mode: "freeform" },
        role: "derived",
        time: { created_at: CREATED_AT },
        representation: { form: "inline", kind: "fixture", media_type: "application/json", value: {}, metadata: {} },
        materialization: {
          primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: [],
        provenance: { inputs: [exactViewRef(codex[0]!)], actor: "fixture:invalid-source" },
        policy: POLICY,
        metadata: {},
      }),
      expected_revision: 0,
    })).view;
    const validationViewMap = new Map(
      [...codex, ...obsidian, derivedCodex].map(view => [`${view.id}@${view.revision}`, view]),
    );
    const validationViews: PersonalizedWorkflowInput["ports"]["views"] = {
      async get(ref) { return validationViewMap.get(`${ref.view_id}@${ref.revision}`); },
      async commit() { throw new Error("Invalid sources must fail before commit"); },
      async getRun() { throw new Error("Invalid sources must fail before Run reads"); },
    };

    const base = (sources: PersonalizedWorkflowInput["sources"]): PersonalizedWorkflowInput => ({
      workflow_id: "personalized-validation",
      created_at: CREATED_AT,
      principal: { id: OWNER, grants: ["*"] },
      ports: { views: validationViews, transformations: harness.transformations, operations: harness.service },
      sources,
      markdown_parser: { transformation: exactTransformationRef(obsidianMarkdownParserTransformation), access_policy: ACCESS_POLICY },
      authoring: {
        prompt: "This must not execute for invalid sources.",
        approval_reason: "This must not execute for invalid sources.",
        expected_output_schema: { name: "personal.working_state", version: 1 },
      },
      search: { keyword_query: "unused", internal_query: "unused", relation_query: "unused" },
      feedback: {
        message: "unused",
        requested_changes: ["instruction"],
        evolved_instruction: "unused",
        resolution: "unused",
      },
    });
    const expectCode = async (sources: PersonalizedWorkflowInput["sources"], code: string) => {
      await assert.rejects(runPersonalizedViewWorkflow(base(sources)), error => {
        assert.equal((error as PersonalizedWorkflowError).name, "PersonalizedWorkflowError", JSON.stringify(error));
        assert.equal((error as PersonalizedWorkflowError).code, code);
        return true;
      });
    };
    await t.test("duplicate exact ref", () => expectCode({
      codex: [exactViewRef(codex[0]!), exactViewRef(codex[0]!)],
      obsidian: [exactViewRef(obsidian[0]!)],
    }, "source_ref_duplicate"));
    await t.test("missing exact revision", () => expectCode({
      codex: [{ view_id: "view:personalized:missing-source", revision: 1 }],
      obsidian: [exactViewRef(obsidian[0]!)],
    }, "source_ref_missing"));
    await t.test("wrong source Schema", () => expectCode({
      codex: [exactViewRef(obsidian[0]!)],
      obsidian: [exactViewRef(obsidian[1]!)],
    }, "codex_schema_invalid"));
    await t.test("non-Raw source", () => expectCode({
      codex: [exactViewRef(derivedCodex)],
      obsidian: [exactViewRef(obsidian[0]!)],
    }, "source_not_raw"));
    await t.test("over explicit limit", () => expectCode({
      codex: Array.from({ length: 65 }, (_, index) => ({ view_id: `view:over-limit:${index}`, revision: 1 })),
      obsidian: [exactViewRef(obsidian[0]!)],
    }, "source_limit_exceeded"));
    assert.equal(agent.authoringCalls, 0);
    assert.equal(agent.executionCalls, 0);
  } finally {
    await harness.close();
    await fixture.cleanup();
  }
});

test("Ambient composition exposes semantic Search only with an explicit store profile and query embedding port", async () => {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-semantic-composition-"));
  const token = "personalized-semantic-operation-token-32-bytes";
  const queryEmbedding = {
    async embed() {
      return { values: [1, 0, 0], dimension: 3, distance_metric: "cosine" as const };
    },
  };
  const common = {
    operation_auth_token: token,
    agent_runtime: new PersonalizedAgentRuntime(),
    now: () => new Date(CREATED_AT),
  };

  await assert.rejects(
    createAmbientDaemonComposition({
      ...common,
      data_directory: join(root, "missing-query-port"),
      view_store: { semantic_search: { profiles: [EMBEDDING_PROFILE] } },
    }),
    /requires both a SQLite semantic profile and a query embedding port/u,
  );
  await assert.rejects(
    createAmbientDaemonComposition({
      ...common,
      data_directory: join(root, "missing-store-profile"),
      semantic_search: { query_embedding: queryEmbedding },
    }),
    /requires both a SQLite semantic profile and a query embedding port/u,
  );

  const composition = await createAmbientDaemonComposition({
    ...common,
    data_directory: join(root, "configured"),
    view_store: { semantic_search: { profiles: [EMBEDDING_PROFILE] } },
    semantic_search: { query_embedding: queryEmbedding },
  });
  try {
    const target = (await composition.views.commit({
      draft: parseViewDraft({
        id: "view:personalized:composition-semantic-target",
        name: "Daemon semantic working state",
        purpose: "Prove Ambient composition exposes configured semantic Search",
        aliases: [],
        schema: workingStateSchema(),
        role: "derived",
        time: { created_at: CREATED_AT },
        representation: {
          form: "inline",
          kind: "agent_output",
          media_type: "application/json",
          value: {
            code_reflected_decisions: ["Semantic evidence is committed as a View."],
            wiki_only_decisions: [],
            contradictions: ["Daemon composition must wire both semantic ports."],
            sources: [{ view_id: "view:personalized:composition-semantic-target", revision: 1 }],
          },
          metadata: {},
        },
        materialization: {
          primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: [],
        provenance: { inputs: [], actor: "fixture:semantic-composition", operator_run_id: "run:semantic-composition" },
        policy: POLICY,
        metadata: {},
      }),
      expected_revision: 0,
    })).view;
    const embedding = (await composition.views.commit({
      draft: embeddingDraft(target, "Daemon composition must wire both semantic ports."),
      expected_revision: 0,
    })).view;
    const response = await executeOk(composition.operationService, "view.search", {
      request: {
        contract_version: 1,
        query: { text: "How is semantic search wired?" },
        scope: { kind: "exact_views", refs: [exactViewRef(target), exactViewRef(embedding)] },
        target: { envelope: false, internal: true, related_views: false },
        modes: ["semantic"],
        semantic: { embedding_profile: { id: EMBEDDING_PROFILE.id, revision: EMBEDDING_PROFILE.revision } },
        fusion: { strategy: "rrf@1", k: 60, weights: { semantic: 1 } },
        failure_mode: "require_all",
        page: { limit: 10 },
      },
    }, "request:composition:semantic");
    const hits = (response.data as SearchResult).hits;
    assert.deepEqual(hits.map(hit => hit.ref), [exactViewRef(target)]);
    assert.deepEqual(hits[0]?.matches[0]?.semantic_evidence_ref, exactViewRef(embedding));
  } finally {
    await composition.close();
    await rm(root, { recursive: true, force: true });
  }
});

type SourceFixture = {
  root: string;
  codexHome: string;
  obsidianVault: string;
  cleanup(): Promise<void>;
};

async function createSourceFixture(): Promise<SourceFixture> {
  const root = await mkdtemp(join(tmpdir(), "metaflow-personalized-workflow-"));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "07", "27");
  const archived = join(codexHome, "archived_sessions");
  const obsidianVault = join(root, "obsidian-vault");
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  await mkdir(obsidianVault, { recursive: true });
  const jsonl = [
    { timestamp: CREATED_AT, type: "session_meta", payload: { session_id: "personalized-session-001", id: "personalized-session-001", timestamp: CREATED_AT, cwd: "/workspace/metaflow", originator: "Synthetic Personalized Test", cli_version: "0.145.0", source: "fixture", thread_source: "fixture", model_provider: "synthetic-provider", base_instructions: {}, dynamic_tools: [] } },
    { timestamp: tick(1), type: "turn_context", payload: { turn_id: "personalized-turn-001" } },
    { timestamp: tick(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Implement exact View search before the graph explorer." }] } },
    { timestamp: tick(3), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Implemented exact revision search and kept semantic indexing outside query execution." }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(join(sessions, "rollout-personalized.jsonl"), jsonl);
  const notes = {
    "architecture.md": "# Architecture\n\nThe retrieval contract requires exact View refs and parser projections before Search.\n",
    "roadmap.md": "# Roadmap\n\nBuild the Graph Explorer before semantic indexing is considered complete.\n",
    "learning.md": "# English learning\n\nCombine watched videos with saved pages and subtract vocabulary already mastered.\n",
  };
  for (const [relativePath, markdown] of Object.entries(notes)) {
    const path = join(obsidianVault, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
  }
  return { root, codexHome, obsidianVault, cleanup: () => rm(root, { recursive: true, force: true }) };
}

class DeterministicWatcher implements ObsidianWatcherAccelerator {
  async load() {
    return { reference: null, changed_paths: [], recovered: false };
  }
  async write(input: { checkpoint_revision: number }) {
    return { path: `snapshot-${input.checkpoint_revision}.bin` as const, sha256: "a".repeat(64) };
  }
}

type Harness = {
  views: SqliteViewRepository;
  transformations: SqliteTransformationRepository;
  capture: ConnectorRuntime;
  service: OperationService;
  codexConnectionId: string;
  obsidianConnectionId: string;
  close(): Promise<void>;
};

async function createHarness(database: string, fixture: SourceFixture, agentRuntime: PersonalizedAgentRuntime): Promise<Harness> {
  const views = new SqliteViewRepository(database, { semantic_search: { profiles: [EMBEDDING_PROFILE] } });
  const transformations = new SqliteTransformationRepository(database);
  const now = deterministicClock();
  const capture = new ConnectorRuntime(views, new CaptureIngress({ repository: views, now }), { now });
  const codexConnection = codexHistorySourceConnection({
    id: "codex-history:personalized",
    source_root: "both",
    content_mode: "messages",
    privacy: POLICY,
  });
  const obsidianConnection = obsidianSourceConnection({
    id: "obsidian:personalized",
    configuration: {
      vault_id: "personalized-vault",
      vault_root: fixture.obsidianVault,
      include: ["**/*.md"],
      max_file_bytes: 1_000_000,
      identity_policy: OBSIDIAN_IDENTITY_POLICY,
      parser_contract: OBSIDIAN_PARSER_CONTRACT,
      secret_policy: OBSIDIAN_SECRET_POLICY,
    },
    privacy: POLICY,
  });
  await configureCodexHistoryCapture({
    runtime: capture,
    connector: new CodexHistoryCaptureConnector({ codex_home: fixture.codexHome, now }),
    connection: codexConnection,
  });
  await configureObsidianCapture({
    runtime: capture,
    connector: new ObsidianCaptureAdapter({ now, watcher: new DeterministicWatcher() }),
    connection: obsidianConnection,
  });
  const agent = new AgentExecutionAdapter({
    runtimes: [agentRuntime],
    default_runtime: agentRuntime.id,
    now: () => new Date(now()),
  });
  const operators = new OperatorExecutionRouter([
    {
      kind: "agent",
      port: new AgentOperatorExecutionBridge(agent, {
        now,
        output_view_id: () => "view:personalized:working-state",
      }),
    },
    { kind: "function", port: new FunctionOperatorAdapter([{ reference: MARKDOWN_PARSER_FUNCTION, execute: executeMarkdownParser }]) },
  ]);
  const execution = new ExecutionRuntime(
    views,
    views,
    new DeterministicViewAccessAuthorizer(),
    operators,
    undefined,
    { now, id: kind => `${kind}:personalized:${createHash("sha256").update(`${kind}:${now()}`).digest("hex").slice(0, 16)}` },
  );
  const feedback = new FeedbackEvolutionService({ views, runs: views, transformations });
  const privacy = new PrivacyForgetService({ views, requests: views, now });
  const reads = new RepositoryViewReadAuthorizer(views);
  const search = new SearchService({
    authorization: reads,
    scope_source: views.search,
    descriptors: views.search,
    keyword: views.search,
    semantic: views.semantic_search,
    query_embedding: {
      async embed() {
        return { values: [1, 0, 0], dimension: 3, distance_metric: "cosine" as const };
      },
    },
    observer: { async record() {} },
    now,
  });
  const authoring = new AuthoringService({
    views,
    transformations,
    execution,
    packages: new ViewPackageCatalog(),
    agent: new AgentRuntimeAuthoringProposalAdapter([agentRuntime], agentRuntime.id, { local_runtime_ids: [agentRuntime.id] }),
    observer: { async record() {} },
    now,
  });
  const connectorCatalog = new ConnectorPackageCatalog();
  const service = new OperationService({
    views,
    graph: views.search,
    search,
    view_reads: reads,
    transformations,
    execution,
    runs: views,
    feedback,
    privacy,
    capture,
    connector_onboarding: new SourceConnectionOnboardingService({
      catalog: connectorCatalog,
      loader: new TrustedConnectorPackageLoader({
        catalog: connectorCatalog,
        artifacts: {
          async inspect() { return undefined; },
          async instantiate() { throw new Error("No Connector Packages are installed in this workflow fixture"); },
        },
        publisher_keys: { async publicKey() { return undefined; } },
        allowed_permissions: [],
        supported_abi_version: 1,
      }),
      runtime: capture,
      repository: views,
      now,
    }),
    capture_traces: views,
    authoring,
    authorization: new GrantOperationAuthorizer(),
    observer: { async record() {} },
    now,
  });
  return {
    views,
    transformations,
    capture,
    service,
    codexConnectionId: codexConnection.id,
    obsidianConnectionId: obsidianConnection.id,
    async close() {
      transformations.close();
      views.close();
    },
  };
}

class PersonalizedAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "personalized-agent";
  readonly kind = "mock" as const;
  authoringCalls = 0;
  executionCalls = 0;

  async capabilities() {
    return { runtimeId: this.id, kind: this.kind, modes: ["invoke" as const] };
  }

  async submit(task: AgentTaskRequest, _context: AgentRuntimeContext): Promise<AgentTaskResult> {
    if (task.outputContract.viewType === "metaflow.authoring.transformation.proposal") {
      this.authoringCalls += 1;
      const request = task.currentContext?.raw?.metaflow_authoring_request as { source_views?: ExactViewRef[] } | undefined;
      const sourceRefs = request?.source_views;
      assert.ok(sourceRefs && sourceRefs.length === 6);
      return {
        ok: true,
        reason: "Generated a declarative exact-source Transformation proposal",
        schemaValue: authoredTransformationCandidate(sourceRefs),
      };
    }
    if (task.outputContract.viewType === "personal.working_state") {
      this.executionCalls += 1;
      assert.equal(task.outputContract.mode, "schema_value");
      const evidence = task.currentContext?.raw?.metaflow_inputs as Array<{
        role: string;
        ref: ExactViewRef;
        schema: { name: string };
        representation: { value?: unknown };
      }> | undefined;
      assert.ok(evidence && evidence.length === 6);
      const serialized = JSON.stringify(evidence);
      assert.match(serialized, /Implemented exact revision search/);
      assert.match(serialized, /retrieval contract requires exact View refs/);
      assert.match(serialized, /Graph Explorer before semantic indexing/);
      return {
        ok: true,
        reason: "Compared the exact code and wiki evidence",
        schemaValue: {
          code_reflected_decisions: ["Exact revision search exists and semantic indexing stays outside query execution."],
          wiki_only_decisions: ["The wiki says the Graph Explorer should precede completion of semantic indexing."],
          contradictions: ["Code prioritizes Search while the roadmap prioritizes the Graph Explorer."],
          sources: evidence.map(item => item.ref),
        },
      };
    }
    throw new Error(`Unexpected Agent output contract: ${task.outputContract.viewType}`);
  }
}

function authoredTransformationCandidate(sourceRefs: ExactViewRef[]) {
  const transformation: Transformation = {
    id: "transformation:personalized:working-state",
    revision: 1,
    name: "Metaflow Implementation Working State",
    instruction: {
      format: "natural_language",
      text: "Compare exact Codex and Obsidian Views into code-reflected decisions, wiki-only decisions, and contradictions.",
      parameters: {},
    },
    operator: {
      id: "operator:personalized:working-state",
      revision: 1,
      reference: { kind: "agent", adapter: "agent-execution", profile: "personalized-working-state" },
      configuration: {
        runtime_override: "personalized-agent",
        execution_mode: "invoke",
        output_mode: "schema_value",
        autonomy: "suggest",
        allow_network: false,
        allow_write: false,
      },
      required_capabilities: [],
    },
    inputs: [{ role: "sources", required: true, sources: sourceRefs.map(ref => ({ kind: "view" as const, ref })) }],
    output: {
      schema: workingStateSchema(),
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    policy: ACCESS_POLICY,
    budget: {
      id: "budget:personalized:working-state",
      revision: 1,
      limits: { timeout_ms: 10_000, max_attempts: 1, max_input_tokens: 20_000, max_output_tokens: 2_000 },
      extensions: {},
    },
    created_at: tick(4),
    metadata: {},
  };
  return {
    kind: "transformation",
    transformation,
    expected_revision: 0,
    execute: runExecutionParameters(sourceRefs),
  };
}

function workingStateSchema() {
  const exactRef = {
    type: "object",
    required: ["view_id", "revision"],
    additionalProperties: false,
    properties: {
      view_id: { type: "string", minLength: 1, maxLength: 240 },
      revision: { type: "integer", minimum: 1 },
    },
  };
  return {
    name: "personal.working_state",
    version: 1,
    mode: "strict" as const,
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: {
      type: "object",
      required: ["code_reflected_decisions", "wiki_only_decisions", "contradictions", "sources"],
      additionalProperties: false,
      properties: {
        code_reflected_decisions: { type: "array", items: { type: "string" } },
        wiki_only_decisions: { type: "array", items: { type: "string" } },
        contradictions: { type: "array", items: { type: "string" } },
        sources: { type: "array", minItems: 1, items: exactRef },
      },
    },
    search_projection: {
      version: 1 as const,
      fields: [
        { path: "/name", category: "title" as const },
        { path: "/representation/value/code_reflected_decisions/*", category: "text" as const },
        { path: "/representation/value/wiki_only_decisions/*", category: "text" as const },
        { path: "/representation/value/contradictions/*", category: "text" as const },
      ],
    },
  };
}

function runExecutionParameters(sourceRefs: ExactViewRef[]) {
  return {
    run_id: "run:personalized:working-state",
    correlation_id: "correlation:personalized:working-state",
    access_policy: ACCESS_POLICY,
    access_use: "external_model" as const,
    invocation_inputs: [{ role: "sources", views: sourceRefs }],
    idempotency_key: "execution:personalized:working-state",
  };
}

function runExecutionInput(transformation: { transformation_id: string; revision: number }, sourceRefs: ExactViewRef[]) {
  return { transformation, parameters: runExecutionParameters(sourceRefs) };
}

function embeddingDraft(target: View, sourceText: string): ViewDraft {
  return parseViewDraft({
    id: "view:embedding:personalized-working-state",
    name: "Personalized working-state embedding",
    purpose: "Freeze deterministic semantic evidence for the exact working-state View.",
    aliases: [],
    schema: SqliteVecEmbeddingViewSchema,
    role: "derived",
    time: { created_at: tick(6) },
    representation: {
      form: "inline",
      kind: "metaflow.search.embedding",
      media_type: "application/json",
      value: {
        contract_version: 1,
        target: {
          ref: exactViewRef(target),
          location: { kind: "representation", path: "/representation/value/contradictions/0" },
          source_digest: sqliteVecSourceDigest(sourceText),
        },
        profile: EMBEDDING_PROFILE,
        vector: [1, 0, 0],
      },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [{ type: "embedding_of", target: exactViewRef(target), metadata: {} }],
    provenance: { inputs: [exactViewRef(target)], operator_run_id: "run:personalized:embedding", actor: "fixture:embedder" },
    policy: POLICY,
    metadata: {},
  });
}

type SearchResult = {
  hits: Array<{
    ref: ExactViewRef;
    matched_schema: { name: string };
    matches: Array<{ location: { kind: string }; semantic_evidence_ref?: ExactViewRef }>;
    path?: unknown[];
  }>;
};

async function search(service: OperationService, suffix: string, request: unknown): Promise<SearchResult> {
  const envelope = await executeOk(service, "view.search", { request }, `request:search:${suffix}`);
  return envelope.data as SearchResult;
}

async function executeOk(
  service: OperationService,
  operation: OperationName,
  input: unknown,
  requestId: string,
): Promise<Extract<OperationEnvelope, { ok: true }>> {
  return ok(service.execute({ operation, input }, operationContext(requestId)));
}

async function ok(promise: Promise<OperationEnvelope>): Promise<Extract<OperationEnvelope, { ok: true }>> {
  const envelope = await promise;
  assert.equal(envelope.ok, true, envelope.ok ? undefined : JSON.stringify(envelope.error));
  return envelope as Extract<OperationEnvelope, { ok: true }>;
}

function operationContext(requestId: string): OperationContext {
  return { request_id: requestId, principal: { id: OWNER, grants: ["*"] } };
}

function executionOutputs(data: unknown): View[] {
  const outputs = (data as { outputs?: unknown }).outputs;
  assert.ok(Array.isArray(outputs));
  return outputs as View[];
}

function workingStateText(view: View): string {
  assert.equal(view.representation.form, "inline");
  if (view.representation.form !== "inline") throw new Error("working-state Representation must be inline");
  const value = view.representation.value as { contradictions: string[] };
  assert.equal(typeof value.contradictions[0], "string");
  return value.contradictions[0]!;
}

function deterministicClock(): () => string {
  let sequence = 0;
  return () => new Date(Date.parse(CREATED_AT) + sequence++ * 10).toISOString();
}

function tick(sequence: number): string {
  return new Date(Date.parse(CREATED_AT) + sequence * 1_000).toISOString();
}

function compareViews(left: View, right: View): number {
  return left.id.localeCompare(right.id) || left.revision - right.revision;
}

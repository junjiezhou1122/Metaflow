import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AuthoringService,
  lifecycleValue,
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
  OperationEnvelopeSchema,
  OperationService,
  RepositoryViewReadAuthorizer,
  type OperationContext,
  type OperationEnvelope,
  type OperationName,
} from "@info/operations";
import {
  CliOperationAdapter,
  HttpOperationAdapter,
  createOperationMcpServer,
  operationMcpToolName,
} from "@info/operation-surfaces";
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
  APPLICATION_SPACE_REPRESENTATION_KIND,
  applicationSpaceRelations,
  applicationSpaceSchema,
  normalizeApplicationSpaceEntries,
  type ApplicationSpaceEntry,
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
import { EXPLORER_DEFAULT_EDGE_TYPES } from "../apps/view-explorer/src/contracts.ts";
import { ViewExplorerOperationClient } from "../apps/view-explorer/src/operation-client.ts";

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
  let surfaces: Surface[] = [];
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
    const fragmentViews: View[] = [];
    for (const [index, source] of obsidianViews.sort(compareViews).entries()) {
      const parsed = await ok(harness.service.execute({
        operation: "run.execute",
        input: {
          transformation: exactTransformationRef(obsidianMarkdownParserTransformation),
          parameters: {
            run_id: `run:personalized:parser:${index + 1}`,
            correlation_id: `correlation:personalized:parser:${index + 1}`,
            access_policy: ACCESS_POLICY,
            access_use: "local_execution",
            invocation_inputs: [{ role: "source", views: [exactViewRef(source)] }],
            idempotency_key: `execution:personalized:parser:${index + 1}`,
          },
        },
      }, operationContext(`request:parser:${index + 1}`)));
      const output = executionOutputs(parsed.data)[0];
      assert.ok(output);
      assert.equal(output.schema.name, "metaflow.view.fragment-set");
      assert.deepEqual(output.provenance.inputs, [exactViewRef(source)]);
      fragmentViews.push(output);
    }

    const sourceRefs = [...codexViews, ...obsidianViews].sort(compareViews).map(exactViewRef);
    const requested = await executeOk(harness.service, "view.authoring.request", {
      view_id: "view:personalized:authoring:request",
      expected_revision: 0,
      artifact_kind: "transformation",
      prompt: "Create a View that compares decisions reflected in code with wiki-only decisions and contradictions.",
      source_views: sourceRefs,
      policy: POLICY,
      trace_id: "trace:personalized:authoring",
      idempotency_key: "authoring:personalized:request",
      created_at: CREATED_AT,
    }, "request:authoring:request");
    const requestRef = exactViewRef(requested.data as View);
    const proposed = await executeOk(harness.service, "view.authoring.propose", {
      request: requestRef,
      proposal_view_id: "view:personalized:authoring:proposal",
      expected_revision: 0,
      idempotency_key: "authoring:personalized:proposal",
      failure_receipt_view_id: "view:personalized:authoring:proposal-failure",
      created_at: tick(1),
    }, "request:authoring:propose");
    const proposal = proposed.data as View;
    const proposalValue = lifecycleValue(proposal) as { artifact_digest: string };
    const approved = await executeOk(harness.service, "view.authoring.approve", {
      proposal: exactViewRef(proposal),
      proposal_digest: proposalValue.artifact_digest,
      decision_view_id: "view:personalized:authoring:decision",
      expected_revision: 0,
      reason: "The exact sources and strict working-state output are correct.",
      idempotency_key: "authoring:personalized:decision",
      created_at: tick(2),
    }, "request:authoring:approve");
    const applied = await executeOk(harness.service, "view.authoring.apply", {
      decision: exactViewRef(approved.data as View),
      receipt_view_id: "view:personalized:authoring:receipt",
      expected_revision: 0,
      idempotency_key: "authoring:personalized:apply",
      created_at: tick(3),
    }, "request:authoring:apply");
    const receiptValue = lifecycleValue(applied.data as View) as {
      status: string;
      target: { kind: string; ref: { transformation_id: string; revision: number }; run_id: string; run_status: string };
    };
    assert.equal(receiptValue.status, "applied");
    assert.equal(receiptValue.target.kind, "transformation");
    assert.equal(receiptValue.target.run_status, "succeeded");
    const transformationRef = receiptValue.target.ref;
    const authoredTransformation = await harness.transformations.get(transformationRef);
    assert.ok(authoredTransformation);
    const authoredRun = await harness.views.getRun(receiptValue.target.run_id);
    assert.equal(authoredRun?.status, "succeeded");
    const workingState = await outputForRun(harness.views, receiptValue.target.run_id);
    assert.deepEqual(exactViewRef(workingState), { view_id: "view:personalized:working-state", revision: 1 });
    assertWorkingState(workingState, sourceRefs);
    assert.equal(agent.authoringCalls, 1);
    assert.equal(agent.executionCalls, 1);

    const applicationSpace = (await harness.views.commit({
      draft: applicationSpaceDraft([
        { ref: exactViewRef(workingState), semantics: "composition" },
        ...fragmentViews.map(view => ({ ref: exactViewRef(view), semantics: "membership" as const })),
      ]),
      expected_revision: 0,
      idempotency_key: "application-space:personalized",
    })).view;
    assert.equal(applicationSpace.schema.name, "application.space");
    assert.deepEqual(exactViewRef(applicationSpace), { view_id: "view:personalized:application-space", revision: 1 });
    assert.equal(applicationSpace.relations.filter(relation => relation.type === APPLICATION_SPACE_COMPOSITION_RELATION).length, 1);
    assert.equal(applicationSpace.relations.filter(relation => relation.type === APPLICATION_SPACE_MEMBERSHIP_RELATION).length, 3);

    const explorerCalls: string[] = [];
    const explorer = new ViewExplorerOperationClient({
      async call(operation, input, signal) {
        if (signal.aborted) throw signal.reason;
        explorerCalls.push(operation);
        return harness.service.execute(
          { operation, input },
          operationContext(`request:view-explorer:${operation}`),
        );
      },
    });
    const explorerSignal = new AbortController().signal;
    const explorerProjection = await explorer.project({
      roots: [exactViewRef(applicationSpace)],
      direction: "both",
      edge_types: [...EXPLORER_DEFAULT_EDGE_TYPES],
      max_depth: 2,
      max_nodes: 100,
      max_edges: 500,
    }, explorerSignal);
    assert.ok(explorerProjection.nodes.some(node => sameRef(node.ref, exactViewRef(applicationSpace))));
    assert.ok(explorerProjection.nodes.some(node => sameRef(node.ref, exactViewRef(workingState))));
    assert.deepEqual(await explorer.getView(exactViewRef(workingState), explorerSignal), workingState);
    assert.deepEqual(explorerCalls, ["view.graph.project", "view.get"]);

    const workingText = workingStateText(workingState);
    const embedding = (await harness.views.commit({
      draft: embeddingDraft(workingState, workingText),
      expected_revision: 0,
      idempotency_key: "embedding:personalized:working-state",
    })).view;

    const keyword = await search(harness.service, "keyword", {
      contract_version: 1,
      query: { text: "prioritizes" },
      scope: { kind: "all_visible", max_nodes: 100, max_scan: 200 },
      target: { envelope: true, internal: true, related_views: false },
      modes: ["keyword"],
      fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
      failure_mode: "require_all",
      page: { limit: 20 },
    });
    assert.ok(keyword.hits.some(hit => sameRef(hit.ref, exactViewRef(workingState))));

    const internal = await search(harness.service, "internal", {
      contract_version: 1,
      query: { text: "retrieval contract" },
      scope: { kind: "exact_views", refs: fragmentViews.map(exactViewRef) },
      target: { envelope: false, internal: true, related_views: false },
      modes: ["keyword"],
      fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
      failure_mode: "require_all",
      page: { limit: 20 },
    });
    assert.equal(internal.hits.length, 1);
    assert.equal(internal.hits[0]?.matched_schema.name, "metaflow.view.fragment-set");
    assert.ok(internal.hits[0]?.matches.some(match => match.location.kind === "representation"));

    const related = await search(harness.service, "relation", {
      contract_version: 1,
      query: { text: "personalized" },
      scope: {
        kind: "subgraph",
        roots: [exactViewRef(applicationSpace)],
        direction: "outgoing",
        relation_types: [APPLICATION_SPACE_COMPOSITION_RELATION, APPLICATION_SPACE_MEMBERSHIP_RELATION],
        max_depth: 1,
        max_nodes: 20,
      },
      target: { envelope: false, internal: false, related_views: true },
      modes: ["relation"],
      fusion: { strategy: "rrf@1", k: 60, weights: { relation: 1 } },
      failure_mode: "require_all",
      page: { limit: 20 },
    });
    const workingStateRelationHit = related.hits.find(hit => sameRef(hit.ref, exactViewRef(workingState)));
    assert.ok(workingStateRelationHit);
    assert.equal(workingStateRelationHit.path?.length, 1);
    assert.equal(related.hits.find(hit => sameRef(hit.ref, exactViewRef(applicationSpace)))?.path?.length, 0);

    const semanticRequest = {
      contract_version: 1 as const,
      query: { text: "What changed between implementation and the wiki?" },
      scope: { kind: "exact_views" as const, refs: [exactViewRef(workingState), exactViewRef(embedding)] },
      target: { envelope: false, internal: true, related_views: false },
      modes: ["semantic" as const],
      semantic: { embedding_profile: { id: EMBEDDING_PROFILE.id, revision: EMBEDDING_PROFILE.revision } },
      fusion: { strategy: "rrf@1" as const, k: 60 as const, weights: { semantic: 1 } },
      failure_mode: "require_all" as const,
      page: { limit: 20 },
    };
    const semantic = await search(harness.service, "semantic", semanticRequest);
    assert.deepEqual(semantic.hits[0]?.ref, exactViewRef(workingState));
    assert.deepEqual(semantic.hits[0]?.matches[0]?.semantic_evidence_ref, exactViewRef(embedding));

    surfaces = await createSurfaces(harness.service);
    const equivalent = await Promise.all(surfaces.map(surface => surface.call("view.search", { request: semanticRequest })));
    for (const response of equivalent.slice(1)) assert.deepEqual(response, equivalent[0]);
    assert.equal(equivalent[0]?.ok, true);
    const exactReads = await Promise.all(surfaces.map(surface => surface.call("view.get", { ref: exactViewRef(workingState) })));
    for (const response of exactReads) {
      assert.equal(response.ok, true);
      if (response.ok) assert.deepEqual(response.data, workingState);
    }
    await closeSurfaces(surfaces);
    surfaces = [];

    const submitted = await executeOk(harness.service, "feedback.submit", {
      feedback: {
        feedback_id: "feedback:personalized:working-state",
        sentiment: "correction",
        message: "Separate unresolved contradictions from wiki-only future plans.",
        actor: OWNER,
        occurred_at: tick(10),
        target_view: exactViewRef(workingState),
        target_run_id: receiptValue.target.run_id,
        requested_changes: ["instruction"],
        metadata: {},
      },
    }, "request:feedback:submit");
    const feedbackRef = exactViewRef((submitted.data as { view: View }).view);
    const evolved = await executeOk(harness.service, "feedback.apply", {
      feedback: feedbackRef,
      base_transformation: transformationRef,
      change: {
        instruction: {
          ...authoredTransformation!.instruction,
          text: "Compare exact code and wiki evidence, and separate unresolved contradictions from future plans.",
        },
      },
      actor: OWNER,
      resolution: "Applied the requested distinction to the Transformation instruction.",
      created_at: tick(11),
    }, "request:feedback:apply");
    assert.equal((evolved.data as Transformation).revision, 2);
    assert.deepEqual((evolved.data as Transformation).supersedes, transformationRef);

    const exactRefsBeforeRestart = [
      ...rawViews,
      ...fragmentViews,
      workingState,
      applicationSpace,
      embedding,
      submitted.data as { view: View },
    ].flatMap(item => "view" in item ? [exactViewRef(item.view)] : [exactViewRef(item as View)]);
    const replayInput = runExecutionInput(transformationRef, sourceRefs);
    await harness.close();
    harness = await createHarness(database, fixture, agent);
    for (const ref of exactRefsBeforeRestart) assert.ok(await harness.views.get(ref), `${ref.view_id}@${ref.revision}`);
    assert.deepEqual(await harness.capture.run(harness.codexConnectionId, "pull", {}), []);
    assert.deepEqual(await harness.capture.run(harness.obsidianConnectionId, "pull", {}), []);
    const replay = await executeOk(harness.service, "run.execute", replayInput, "request:execution:replay");
    assert.equal((replay.data as { run: { status: string } }).run.status, "succeeded");
    assert.deepEqual(executionOutputs(replay.data).map(exactViewRef), [exactViewRef(workingState)]);
    assert.equal(agent.executionCalls, 1, "durable idempotent replay must not invoke the Agent again");

    const forgottenSource = codexViews.find(view => view.schema.name === "capture.codex.message")!;
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
    assert.equal(await harness.views.get(exactViewRef(workingState)), undefined);
    assert.equal(await harness.views.get(exactViewRef(applicationSpace)), undefined);
    assert.equal(await harness.views.get(exactViewRef(embedding)), undefined);
  } finally {
    await closeSurfaces(surfaces);
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

function applicationSpaceDraft(entriesValue: ApplicationSpaceEntry[]): ViewDraft {
  const entries = normalizeApplicationSpaceEntries(entriesValue);
  return parseViewDraft({
    id: "view:personalized:application-space",
    name: "Personalized Metaflow working space",
    purpose: "Compose exact captured evidence, parser projections, and the current working-state View.",
    aliases: [],
    schema: applicationSpaceSchema,
    role: "derived",
    time: { created_at: tick(5) },
    representation: {
      form: "inline",
      kind: APPLICATION_SPACE_REPRESENTATION_KIND,
      media_type: "application/json",
      value: { version: 1, entries },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: applicationSpaceRelations(entries),
    provenance: { inputs: entries.map(entry => entry.ref), actor: OWNER },
    policy: POLICY,
    metadata: {},
  });
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

type Surface = {
  name: "in-process" | "cli" | "http" | "mcp";
  call(operation: OperationName, input: unknown): Promise<OperationEnvelope>;
  close(): Promise<void>;
};

async function createSurfaces(service: OperationService): Promise<Surface[]> {
  const contextProvider = () => operationContext("request:surface:equivalent");
  const cli = new CliOperationAdapter(service, contextProvider);
  const http = new HttpOperationAdapter(service, contextProvider);
  const server = createOperationMcpServer({ service, context: contextProvider });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "personalized-view-workflow", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return [
    { name: "in-process", call: (operation, input) => service.execute({ operation, input }, contextProvider()), close: async () => undefined },
    { name: "cli", call: async (operation, input) => (await cli.invoke([operation, JSON.stringify(input)])).envelope, close: async () => undefined },
    { name: "http", call: async (operation, input) => (await http.handle({ method: "POST", path: `/metaflow/v1/operations/${encodeURIComponent(operation)}`, body: input })).body, close: async () => undefined },
    {
      name: "mcp",
      call: async (operation, input) => {
        const result = await client.callTool({ name: operationMcpToolName(operation), arguments: input as Record<string, unknown> });
        return OperationEnvelopeSchema.parse(result.structuredContent);
      },
      close: async () => { await client.close(); await server.close(); },
    },
  ];
}

async function closeSurfaces(surfaces: Surface[]): Promise<void> {
  await Promise.all(surfaces.map(surface => surface.close()));
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

async function outputForRun(views: SqliteViewRepository, runId: string): Promise<View> {
  const run = await views.getRun(runId);
  assert.ok(run);
  assert.equal(run.output_views.length, 1);
  const output = await views.get(run.output_views[0]!);
  assert.ok(output);
  return output;
}

function assertWorkingState(view: View, sources: ExactViewRef[]): void {
  assert.equal(view.schema.name, "personal.working_state");
  assert.equal(view.representation.form, "inline");
  if (view.representation.form !== "inline") return;
  const value = view.representation.value as { code_reflected_decisions: string[]; wiki_only_decisions: string[]; contradictions: string[]; sources: ExactViewRef[] };
  assert.equal(value.code_reflected_decisions.length, 1);
  assert.equal(value.wiki_only_decisions.length, 1);
  assert.equal(value.contradictions.length, 1);
  assert.deepEqual(value.sources, sources);
  assert.deepEqual(view.provenance.inputs, sources);
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

function sameRef(left: ExactViewRef, right: ExactViewRef): boolean {
  return left.view_id === right.view_id && left.revision === right.revision;
}

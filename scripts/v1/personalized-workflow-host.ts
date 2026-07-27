import { createHash } from "node:crypto";
import { AgentRuntimeAuthoringProposalAdapter, AgentExecutionAdapter, type AgentRuntimeAdapter } from "@info/agent-runtime-adapter";
import { AuthoringService } from "@info/authoring";
import {
  ConnectorPackageCatalog,
  SourceConnectionOnboardingService,
  TrustedConnectorPackageLoader,
  type ConnectorRuntime,
} from "@info/capture";
import {
  AgentOperatorExecutionBridge,
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  FeedbackEvolutionService,
  OperatorExecutionRouter,
} from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import { MARKDOWN_PARSER_FUNCTION, executeMarkdownParser } from "@info/markdown-parser-adapter";
import {
  GrantOperationAuthorizer,
  OperationService,
  RepositoryViewReadAuthorizer,
} from "@info/operations";
import { SearchService, type QueryEmbeddingPort } from "@info/search";
import { type SqliteViewRepository } from "@info/storage-sqlite";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";
import { type Transformation } from "@info/transformation";
import { PrivacyForgetService, canonicalJson } from "@info/view";
import { ViewPackageCatalog } from "@info/view-package";
import { obsidianMarkdownParserTransformation } from "../../apps/ambient-daemon/definitions.js";

export type PersonalizedWorkflowHostOptions = {
  database_path: string;
  views: SqliteViewRepository;
  capture: ConnectorRuntime;
  agent_runtime: AgentRuntimeAdapter;
  workflow_id: string;
  now: () => string;
  local_agent_runtime?: boolean;
  semantic?: {
    query_embedding: QueryEmbeddingPort;
  };
};

export async function createPersonalizedWorkflowHost(options: PersonalizedWorkflowHostOptions) {
  const transformations = new SqliteTransformationRepository(options.database_path);
  try {
    await seedTransformation(transformations, obsidianMarkdownParserTransformation);
    const agent = new AgentExecutionAdapter({
      runtimes: [options.agent_runtime],
      default_runtime: options.agent_runtime.id,
      now: () => new Date(options.now()),
    });
    const execution = new ExecutionRuntime(
      options.views,
      options.views,
      new DeterministicViewAccessAuthorizer(),
      new OperatorExecutionRouter([
        {
          kind: "agent",
          port: new AgentOperatorExecutionBridge(agent, {
            now: options.now,
            output_view_id: () => `view:${options.workflow_id}:working-state`,
          }),
        },
        {
          kind: "function",
          port: new FunctionOperatorAdapter([{
            reference: MARKDOWN_PARSER_FUNCTION,
            execute: executeMarkdownParser,
          }]),
        },
      ]),
      undefined,
      {
        now: options.now,
        id: kind => `${kind}:${options.workflow_id}:${createHash("sha256").update(`${kind}:${options.now()}`).digest("hex").slice(0, 16)}`,
      },
    );
    const reads = new RepositoryViewReadAuthorizer(options.views);
    const search = new SearchService({
      authorization: reads,
      scope_source: options.views.search,
      descriptors: options.views.search,
      keyword: options.views.search,
      ...(options.semantic ? {
        semantic: options.views.semantic_search,
        query_embedding: options.semantic.query_embedding,
      } : {}),
      observer: { async record() {} },
      now: options.now,
    });
    const authoring = new AuthoringService({
      views: options.views,
      transformations,
      execution,
      packages: new ViewPackageCatalog(),
      agent: new AgentRuntimeAuthoringProposalAdapter(
        [options.agent_runtime],
        options.agent_runtime.id,
        options.local_agent_runtime ? { local_runtime_ids: [options.agent_runtime.id] } : {},
      ),
      observer: { async record() {} },
      now: options.now,
    });
    const connectorCatalog = new ConnectorPackageCatalog();
    const operations = new OperationService({
      views: options.views,
      graph: options.views.search,
      search,
      view_reads: reads,
      transformations,
      execution,
      runs: options.views,
      feedback: new FeedbackEvolutionService({ views: options.views, runs: options.views, transformations }),
      privacy: new PrivacyForgetService({ views: options.views, requests: options.views, now: options.now }),
      capture: options.capture,
      connector_onboarding: new SourceConnectionOnboardingService({
        catalog: connectorCatalog,
        loader: new TrustedConnectorPackageLoader({
          catalog: connectorCatalog,
          artifacts: {
            async inspect() { return undefined; },
            async instantiate() { throw new Error("No Connector Packages are installed in the personalized acceptance host"); },
          },
          publisher_keys: { async publicKey() { return undefined; } },
          allowed_permissions: [],
          supported_abi_version: 1,
        }),
        runtime: options.capture,
        repository: options.views,
        now: options.now,
      }),
      capture_traces: options.views,
      authoring,
      authorization: new GrantOperationAuthorizer(),
      observer: { async record() {} },
      now: options.now,
    });
    return {
      transformations,
      execution,
      authoring,
      operations,
      close() {
        transformations.close();
      },
    };
  } catch (error) {
    transformations.close();
    throw error;
  }
}

async function seedTransformation(
  repository: SqliteTransformationRepository,
  transformation: Transformation,
): Promise<void> {
  const ref = { transformation_id: transformation.id, revision: transformation.revision };
  const existing = await repository.get(ref);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(transformation)) {
      throw new Error(`Seed Transformation revision conflict: ${ref.transformation_id}@${ref.revision}`);
    }
    return;
  }
  await repository.commit({
    transformation,
    expected_revision: 0,
    idempotency_key: "seed:personalized:markdown-parser",
  });
}

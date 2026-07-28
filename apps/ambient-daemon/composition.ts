import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  CaptureIngress,
  ConnectorPackageCatalog,
  SourceConnectionOnboardingService,
  TrustedConnectorPackageLoader,
  type ConnectorPackageArtifactPort,
  type ConnectorPackageDescriptor,
  type ConnectorPermission,
  type ConnectorPublisherKeyPort,
  type SourceConnection,
} from "@info/capture";
import { ConnectorRuntime } from "@info/capture";
import {
  AutomationContextResolver,
  AutomationDeliveryCoordinator,
  AutomationFeedbackViewService,
  AutomationRuntime,
  parseAutomationView,
  type AutomationContextAuthorizer,
} from "@info/automation";
import {
  DeterministicViewAccessAuthorizer,
  AgentOperatorExecutionBridge,
  ExecutionRuntime,
  FeedbackEvolutionService,
  OperatorExecutionRouter,
  parseViewAccessPolicySnapshot,
} from "@info/execution";
import {
  AgentExecutionAdapter,
  AgentRuntimeAuthoringProposalAdapter,
  type AgentRuntimeAdapter,
} from "@info/agent-runtime-adapter";
import { AuthoringService } from "@info/authoring";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  MARKDOWN_PARSER_FUNCTION,
  executeMarkdownParser,
} from "@info/markdown-parser-adapter";
import {
  AutomationExecutionCommandHandler,
  AutomationExecutionTarget,
} from "@info/automation-execution-adapter";
import {
  SqliteAutomationDeliveryLedger,
  SqliteAutomationOccurrenceRepository,
  SqliteReactiveCascadeLedger,
  SqliteAutomationTraceStore,
} from "@info/automation-sqlite";
import {
  BrowserAutomationController,
  BrowserAutomationHttpBridge,
  BrowserDeliveryMailbox,
  ViewBrowserAutomationCatalog,
} from "@info/browser-automation-adapter";
import { configureBrowserCapture } from "@info/browser-capture-adapter";
import {
  CodexHistoryCaptureConnector,
  configureCodexHistoryCapture,
} from "@info/codex-history-capture-adapter";
import {
  ObsidianCaptureAdapter,
  configureObsidianCapture,
} from "@info/obsidian-capture-adapter";
import {
  ScreenpipeCaptureConnector,
  ScreenpipeOpenParametersSchema,
  configureScreenpipeCapture,
} from "@info/screenpipe-capture-adapter";
import {
  SCREENPIPE_AUDIO_FUNCTION,
  SCREENPIPE_TIMELINE_FUNCTION,
  executeScreenpipeAudio,
  executeScreenpipeTimeline,
} from "@info/screenpipe-derived-views";
import {
  BrowserDomRequestBroker,
  MacAutomationController,
  MacAutomationHttpBridge,
  MacDeliveryMailbox,
  ViewMacAutomationCatalog,
} from "@info/macos-automation-adapter";
import { SqliteViewRepository, type SqliteViewRepositoryOptions } from "@info/storage-sqlite";
import {
  SchedulerAutomationController,
  SqliteScheduleCursorRepository,
  ViewSchedulerAutomationCatalog,
} from "@info/scheduler-automation-adapter";
import { InboxAutomationHttpBridge, InboxDeliveryMailbox } from "@info/inbox-automation-adapter";
import { HttpOperationAdapter } from "@info/operation-surfaces";
import {
  GrantOperationAuthorizer,
  JsonConsoleOperationObserver,
  OperationService,
  RepositoryViewReadAuthorizer,
} from "@info/operations";
import { SearchService, type QueryEmbeddingPort } from "@info/search";
import { SqliteTransformationRepository } from "@info/transformation-sqlite";
import { exactTransformationRef, type Transformation } from "@info/transformation";
import { ViewPackageCatalog } from "@info/view-package";
import { applicationSpaceViewPackage } from "@info/view-package-application-space";
import { githubRepositorySummaryViewPackage } from "@info/view-package-github-repository-summary";
import { obsidianDocumentViewPackage } from "@info/view-package-obsidian-document";
import {
  PrivacyForgetService,
  canonicalJson,
  parseView,
  type ReactiveCascadePolicySnapshot,
  type View,
} from "@info/view";
import {
  githubSummaryAutomationDraft,
  githubSummaryTransformation,
  dailySummaryAutomationDraft,
  dailySummaryTransformation,
  macVoiceAssistAutomationDraft,
  macVoiceAssistTransformation,
  obsidianMarkdownParserTransformation,
} from "./definitions.js";
import { createAmbientV1HttpHandler } from "./http-handler.js";
import { createAmbientMcpHttpHandler } from "./mcp-handler.js";
import { AmbientOperationAccess } from "./operation-access.js";

export type AmbientDaemonCompositionOptions = {
  data_directory: string;
  operation_auth_token: string;
  view_store?: SqliteViewRepositoryOptions;
  semantic_search?: {
    query_embedding: QueryEmbeddingPort;
  };
  trusted_operation_origins?: readonly string[];
  agent_runtime: AgentRuntimeAdapter;
  agent_aliases?: Record<string, string>;
  agent_mcp_servers?: import("@info/agent-runtime-adapter").AgentMcpServerConfig[];
  direct_assist?: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>;
  mac_delivery_mailbox?: MacDeliveryMailbox;
  capture_sources?: {
    codex_history?: {
      connector?: CodexHistoryCaptureConnector;
      connection?: SourceConnection;
    };
    obsidian?: {
      connector?: ObsidianCaptureAdapter;
      connections: readonly SourceConnection[];
    };
    screenpipe?: {
      connector?: ScreenpipeCaptureConnector;
      connection?: SourceConnection;
    };
  };
  connector_packages?: {
    descriptors: readonly ConnectorPackageDescriptor[];
    artifacts: ConnectorPackageArtifactPort;
    publisher_keys: ConnectorPublisherKeyPort;
    allowed_permissions: readonly ConnectorPermission[];
    supported_abi_version?: number;
  };
  now?: () => Date;
};

export const AMBIENT_REACTIVE_CASCADE_POLICY: ReactiveCascadePolicySnapshot = {
  id: "policy:ambient:reactive-cascade",
  revision: 1,
  limits: {
    max_depth: 8,
    max_fan_out: 32,
    max_total_attempts: 256,
    max_total_cost_usd: 10,
    max_elapsed_ms: 3_600_000,
    max_operator_concurrency: 4,
    reservation_lease_ms: 300_000,
  },
};

export async function createAmbientDaemonComposition(options: AmbientDaemonCompositionOptions) {
  const hasSemanticStore = options.view_store?.semantic_search !== undefined;
  if (hasSemanticStore !== (options.semantic_search !== undefined)) {
    throw new TypeError("Ambient semantic Search requires both a SQLite semantic profile and a query embedding port");
  }
  const now = options.now ?? (() => new Date());
  const operationAccess = new AmbientOperationAccess(
    options.operation_auth_token,
    options.trusted_operation_origins,
  );
  const databasePath = join(options.data_directory, "metaflow.sqlite");
  const automationPath = join(options.data_directory, "automation.sqlite");
  const views = new SqliteViewRepository(databasePath, options.view_store);
  const transformations = new SqliteTransformationRepository(databasePath);
  const occurrences = new SqliteAutomationOccurrenceRepository(automationPath);
  const cascades = new SqliteReactiveCascadeLedger(automationPath);
  const ledger = new SqliteAutomationDeliveryLedger(automationPath);
  const traces = new SqliteAutomationTraceStore(automationPath);
  const schedulerCursors = new SqliteScheduleCursorRepository(automationPath);
  try {
    await seedTransformation(transformations, githubSummaryTransformation, "seed:transformation.github.repository_summary@1");
    await seedTransformation(transformations, obsidianMarkdownParserTransformation, "seed:transformation.parser.markdown@1");
    await seedTransformation(transformations, macVoiceAssistTransformation, "seed:transformation.macos.voice_assist@1");
    await seedTransformation(transformations, dailySummaryTransformation, "seed:transformation.ambient.daily_summary@1");
    await seedAutomation(views, githubSummaryAutomationDraft, "seed:automation.browser.github_repository_summary@1");
    await seedAutomation(views, macVoiceAssistAutomationDraft, "seed:automation.macos.voice_assist@1");
    await seedAutomation(views, dailySummaryAutomationDraft, "seed:automation.ambient.daily_summary@1");

    const access = new DeterministicViewAccessAuthorizer();
    const agent = new AgentExecutionAdapter({
      runtimes: [options.agent_runtime],
      default_runtime: options.agent_runtime.id,
      mcp_servers: options.agent_mcp_servers,
      now,
    });
    const operators = new OperatorExecutionRouter([
      { kind: "agent", port: new AgentOperatorExecutionBridge(agent, { now: () => now().toISOString() }) },
      {
        kind: "function",
        port: new FunctionOperatorAdapter([
          { reference: MARKDOWN_PARSER_FUNCTION, execute: executeMarkdownParser },
          { reference: SCREENPIPE_TIMELINE_FUNCTION, execute: executeScreenpipeTimeline },
          { reference: SCREENPIPE_AUDIO_FUNCTION, execute: executeScreenpipeAudio },
        ]),
      },
    ]);
    const execution = new ExecutionRuntime(
      views,
      views,
      access,
      operators,
      undefined,
      { now: () => now().toISOString() },
    );
    const viewPackages = new ViewPackageCatalog();
    for (const viewPackage of [
      applicationSpaceViewPackage,
      githubRepositorySummaryViewPackage,
      obsidianDocumentViewPackage,
    ]) {
      viewPackages.register(viewPackage);
    }
    const authoring = new AuthoringService({
      views,
      transformations,
      execution,
      packages: viewPackages,
      agent: new AgentRuntimeAuthoringProposalAdapter([options.agent_runtime], options.agent_runtime.id),
      observer: {
        async record(event, cause) {
          console.info(JSON.stringify({
            component: "metaflow-authoring",
            ...event,
            ...(cause instanceof Error ? {
              cause_name: cause.name,
              cause_message_digest: createHash("sha256").update(cause.message).digest("hex"),
            } : {}),
          }));
        },
      },
      now: () => now().toISOString(),
    });
    const target = new AutomationExecutionTarget({
      transformations,
      execution,
      cascades,
    });
    const mailbox = new BrowserDeliveryMailbox(now);
    const macMailbox = options.mac_delivery_mailbox ?? new MacDeliveryMailbox(now);
    const inboxMailbox = new InboxDeliveryMailbox(now);
    const browserContext = new BrowserDomRequestBroker({ now });
    const delivery = new AutomationDeliveryCoordinator({
      renderers: [mailbox, macMailbox, inboxMailbox],
      ledger,
      feedback: new AutomationFeedbackViewService(views),
      commands: new AutomationExecutionCommandHandler(target),
      events: traces,
      now,
    });
    const context = new AutomationContextResolver({
      views,
      authorizer: localContextAuthorizer(access),
    });
    const runtime = new AutomationRuntime({
      occurrences,
      cascades,
      context,
      target,
      delivery,
      events: traces,
      now,
    });
    const scheduler = new SchedulerAutomationController({
      catalog: new ViewSchedulerAutomationCatalog(views),
      cursors: schedulerCursors,
      runtime,
      now,
      events: {
        emit(event) {
          console.info(JSON.stringify({ component: "scheduler-automation", ...event }));
        },
      },
    });
    const capture = new CaptureIngress({
      repository: views,
      now: () => now().toISOString(),
      onEvent(event) {
        console.info(JSON.stringify({ component: "capture-ingress", ...event }));
      },
    });
    const connectorRuntime = new ConnectorRuntime(views, capture, {
      now: () => now().toISOString(),
    });
    const captureSources = await configureExternalCaptureSources(connectorRuntime, options.capture_sources);
    const browserCapture = await configureBrowserCapture({ runtime: connectorRuntime });
    const browserController = new BrowserAutomationController({
      capture: browserCapture,
      catalog: new ViewBrowserAutomationCatalog(views),
      runtime,
      now,
      events: {
        emit(event) {
          console.info(JSON.stringify({ component: "browser-automation", ...event }));
        },
      },
    });
    const browserAutomation = new BrowserAutomationHttpBridge({
      controller: browserController,
      mailbox,
      delivery,
      ledger,
      views,
    });
    const macController = new MacAutomationController({
      capture,
      catalog: new ViewMacAutomationCatalog(views),
      runtime,
      browser_context: browserContext,
      agents: agentResolver(options.agent_runtime.id, options.agent_aliases),
      now,
      events: {
        emit(event) {
          console.info(JSON.stringify({ component: "macos-automation", ...event }));
        },
      },
    });
    const macAutomation = new MacAutomationHttpBridge({
      controller: macController,
      mailbox: macMailbox,
      delivery,
      ledger,
      views,
      browser_context: browserContext,
    });
    const inboxAutomation = new InboxAutomationHttpBridge({
      mailbox: inboxMailbox,
      delivery,
      ledger,
      views,
    });
    const feedback = new FeedbackEvolutionService({ views, runs: views, transformations });
    const privacy = new PrivacyForgetService({ views, requests: views, now: () => now().toISOString() });
    const viewReads = new RepositoryViewReadAuthorizer(views);
    const search = new SearchService({
      authorization: viewReads,
      scope_source: views.search,
      descriptors: views.search,
      keyword: views.search,
      ...(options.semantic_search ? {
        semantic: views.semantic_search,
        query_embedding: options.semantic_search.query_embedding,
      } : {}),
      observer: {
        async record(event, cause) {
          console.info(JSON.stringify({
            component: "metaflow-search",
            ...event,
            ...(cause instanceof Error ? {
              cause_name: cause.name,
              cause_message_digest: createHash("sha256").update(cause.message).digest("hex"),
            } : {}),
          }));
        },
      },
      now: () => now().toISOString(),
    });
    const connectorCatalog = new ConnectorPackageCatalog();
    for (const descriptor of options.connector_packages?.descriptors ?? []) connectorCatalog.register(descriptor);
    const connectorOnboarding = new SourceConnectionOnboardingService({
      catalog: connectorCatalog,
      loader: new TrustedConnectorPackageLoader({
        catalog: connectorCatalog,
        artifacts: options.connector_packages?.artifacts ?? {
          async inspect() { return undefined; },
          async instantiate() { throw new Error("No Connector Packages are installed"); },
        },
        publisher_keys: options.connector_packages?.publisher_keys ?? { async publicKey() { return undefined; } },
        allowed_permissions: options.connector_packages?.allowed_permissions ?? [],
        supported_abi_version: options.connector_packages?.supported_abi_version ?? 1,
      }),
      runtime: connectorRuntime,
      repository: views,
      now: () => now().toISOString(),
    });
    const operationService = new OperationService({
      views,
      graph: views.search,
      search,
      view_reads: viewReads,
      transformations,
      execution,
      runs: views,
      feedback,
      privacy,
      capture: connectorRuntime,
      connector_onboarding: connectorOnboarding,
      capture_traces: views,
      authoring,
      authorization: new GrantOperationAuthorizer(),
      observer: new JsonConsoleOperationObserver(),
      now: () => now().toISOString(),
    });
    const operationHttp = new HttpOperationAdapter(operationService, () => ({
      request_id: `request:http:${randomUUID()}`,
      principal: { id: "user:local", grants: ["*"] },
    }));
    const handler = createAmbientV1HttpHandler({
      browser_capture: browserCapture,
      browser_automation: browserAutomation,
      mac_automation: macAutomation,
      inbox_automation: inboxAutomation,
      operations: operationHttp,
      operation_access: operationAccess,
      direct_assist: options.direct_assist,
    });
    const mcpHandler = createAmbientMcpHttpHandler(operationService, operationAccess);

    return {
      handler,
      mcpHandler,
      views,
      transformations,
      occurrences,
      cascades,
      ledger,
      traces,
      execution,
      authoring,
      viewPackages,
      operationService,
      delivery,
      scheduler,
      inboxMailbox,
      inboxAutomation,
      browserAutomation,
      browserCapture,
      captureSources,
      connectorRuntime,
      macAutomation,
      browserContext,
      async close() {
        scheduler.close();
        browserContext.close();
        await options.agent_runtime.close?.();
        schedulerCursors.close();
        traces.close();
        ledger.close();
        cascades.close();
        occurrences.close();
        transformations.close();
        views.close();
      },
    };
  } catch (error) {
    schedulerCursors.close();
    traces.close();
    ledger.close();
    cascades.close();
    occurrences.close();
    transformations.close();
    views.close();
    throw error;
  }
}

async function configureExternalCaptureSources(
  runtime: ConnectorRuntime,
  sources: AmbientDaemonCompositionOptions["capture_sources"],
) {
  const configured = new Set<string>();
  const explicitParametersRequired = new Set<string>();
  if (sources?.codex_history) {
    const result = await configureCodexHistoryCapture({
      runtime,
      ...(sources.codex_history.connector ? { connector: sources.codex_history.connector } : {}),
      ...(sources.codex_history.connection ? { connection: sources.codex_history.connection } : {}),
    });
    configured.add(result.connection.id);
  }
  if (sources?.obsidian) {
    if (sources.obsidian.connections.length === 0) {
      throw new TypeError("Obsidian capture configuration requires at least one Source Connection");
    }
    const [first, ...rest] = sources.obsidian.connections;
    const connector = sources.obsidian.connector ?? new ObsidianCaptureAdapter();
    await configureObsidianCapture({ runtime, connector, connection: first });
    configured.add(first.id);
    for (const connection of rest) {
      await runtime.registerConnection(connection);
      configured.add(connection.id);
    }
  }
  if (sources?.screenpipe) {
    const result = await configureScreenpipeCapture({
      runtime,
      ...(sources.screenpipe.connector ? { connector: sources.screenpipe.connector } : {}),
      ...(sources.screenpipe.connection ? { connection: sources.screenpipe.connection } : {}),
    });
    configured.add(result.connection.id);
    explicitParametersRequired.add(result.connection.id);
  }
  const connectionIds = Object.freeze([...configured].sort());
  return Object.freeze({
    connection_ids: connectionIds,
    async pull(connectionId: string, parameters?: Record<string, unknown>) {
      if (!configured.has(connectionId)) {
        throw new Error(`Capture Source Connection is not configured in this composition: ${connectionId}`);
      }
      const boundedParameters = explicitParametersRequired.has(connectionId)
        ? boundedScreenpipePullParameters(connectionId, parameters)
        : parameters ?? {};
      return runtime.run(connectionId, "pull", boundedParameters);
    },
  });
}

function boundedScreenpipePullParameters(
  connectionId: string,
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const parsed = ScreenpipeOpenParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    throw new Error(`Screenpipe Capture Source Connection requires strict explicit pull parameters: ${connectionId}`);
  }
  const { start_time: start, end_time: end } = parsed.data.query;
  if (!start || !end) {
    throw new Error(`Screenpipe Capture Source Connection requires an explicit bounded period: ${connectionId}`);
  }
  if (Date.parse(end) - Date.parse(start) > 86_400_000) {
    throw new Error(`Screenpipe Capture Source Connection period exceeds one day: ${connectionId}`);
  }
  return parsed.data;
}

async function seedTransformation(
  transformations: SqliteTransformationRepository,
  transformation: Transformation,
  idempotencyKey: string,
): Promise<void> {
  const ref = exactTransformationRef(transformation);
  const existing = await transformations.get(ref);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(transformation)) {
      throw new Error(`Seed Transformation revision conflict: ${ref.transformation_id}@${ref.revision}`);
    }
    return;
  }
  await transformations.commit({
    transformation,
    expected_revision: 0,
    idempotency_key: idempotencyKey,
  });
}

async function seedAutomation(
  views: SqliteViewRepository,
  draft: typeof githubSummaryAutomationDraft,
  idempotencyKey: string,
): Promise<void> {
  const existing = await views.get({ view_id: draft.id, revision: 1 });
  if (existing) {
    const expected = parseView({ ...draft, revision: 1 });
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new Error(`Seed Automation revision conflict: ${existing.id}@${existing.revision}`);
    }
    parseAutomationView(existing);
    return;
  }
  const committed = await views.commit({
    draft,
    expected_revision: 0,
    idempotency_key: idempotencyKey,
  });
  parseAutomationView(committed.view);
}

function agentResolver(defaultRuntime: string, aliases: Record<string, string> | undefined) {
  for (const [name, runtime] of Object.entries(aliases ?? {})) {
    if (runtime !== defaultRuntime) {
      throw new Error(`Agent alias ${name} targets unregistered runtime ${runtime}`);
    }
  }
  const normalized = new Map<string, string>([
    [defaultRuntime.toLowerCase(), defaultRuntime],
    ...Object.entries(aliases ?? {}).map(([name, runtime]) => [name.toLowerCase(), runtime] as const),
  ]);
  return {
    resolve(requestedName: string) {
      return normalized.get(requestedName.toLowerCase());
    },
  };
}

function localContextAuthorizer(
  authorizer: DeterministicViewAccessAuthorizer,
): AutomationContextAuthorizer {
  return {
    async authorize({ view }) {
      const decision = await authorizer.authorize({
        policy: parseViewAccessPolicySnapshot(githubSummaryTransformation.policy),
        operator: githubSummaryTransformation.operator,
        use: "local_execution",
        views: [view as View],
      });
      return {
        allowed: decision.outcome === "allowed",
        decision_id: decision.decision_id,
        reason: decision.views[0]?.decisive.reason ?? decision.outcome,
      };
    },
  };
}

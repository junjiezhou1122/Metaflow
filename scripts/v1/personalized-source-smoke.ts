import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AcpStdioAgentRuntimeAdapter, type AgentRuntimeAdapter } from "@info/agent-runtime-adapter";
import {
  CodexHistoryCaptureConnector,
  codexHistorySourceConnection,
} from "@info/codex-history-capture-adapter";
import {
  CaptureIngress,
  CaptureRuntimeError,
  ConnectorRuntime,
  type CaptureBatch,
  type CommitCaptureBatchResult,
  type ConnectorContext,
  type ConnectorOpenRequest,
  type ConnectorPort,
  type SourceConnection,
} from "@info/capture";
import {
  OBSIDIAN_IDENTITY_POLICY,
  OBSIDIAN_PARSER_CONTRACT,
  OBSIDIAN_SECRET_POLICY,
  ObsidianSafeRelativePathSchema,
  ObsidianCaptureAdapter,
  obsidianSourceConnection,
  type ObsidianWatcherAccelerator,
} from "@info/obsidian-capture-adapter";
import type { OperationContext, OperationName, OperationService } from "@info/operations";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { exactTransformationRef } from "@info/transformation";
import { ExactViewRefSchema, ViewSchemaRefSchema, exactViewRef, type ExactViewRef, type View } from "@info/view";
import { obsidianMarkdownParserTransformation } from "../../apps/ambient-daemon/definitions.js";
import { resolveAmbientAcpCommand } from "../../apps/ambient-daemon/index.js";
import {
  runPersonalizedViewExplorerAcceptance,
  PersonalizedViewExplorerAcceptanceError,
  type PersonalizedViewExplorerAcceptanceEvidence,
  type PersonalizedViewExplorerAcceptanceInput,
} from "../../apps/view-explorer/e2e/personalized-acceptance.js";
import {
  runPersonalizedAgentAccessGate,
  PersonalizedAgentAccessError,
  type PersonalizedAgentAccessEvidence,
  type PersonalizedAgentAccessInput,
} from "./personalized-agent-access.js";
import {
  PERSONALIZED_WORKFLOW_SOURCE_LIMITS,
  PersonalizedWorkflowError,
  projectPersonalizedWorkflowEvidence,
  runPersonalizedViewWorkflow,
  type PersonalizedWorkflowResult,
} from "./personalized-view-workflow.js";
import { createPersonalizedWorkflowHost } from "./personalized-workflow-host.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_VIEW_EVIDENCE_SAMPLES = 20;
const WORKFLOW_ID = "personalized-real-source";
const WORKFLOW_ACCESS_POLICY = {
  id: "policy:personalized-real-source",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};
const WORKING_STATE_SCHEMA = ViewSchemaRefSchema.parse({
  name: "personal.working_state",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    required: ["summary", "confirmed_decisions", "open_questions", "next_actions", "sources"],
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      confirmed_decisions: { type: "array", items: { type: "string" } },
      open_questions: { type: "array", items: { type: "string" } },
      next_actions: { type: "array", items: { type: "string" } },
      sources: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["view_id", "revision"],
          additionalProperties: false,
          properties: {
            view_id: { type: "string", minLength: 1, maxLength: 240 },
            revision: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/summary", category: "text" },
      { path: "/representation/value/confirmed_decisions/*", category: "text" },
      { path: "/representation/value/open_questions/*", category: "text" },
      { path: "/representation/value/next_actions/*", category: "text" },
    ],
  },
});
const CONNECTIONS = {
  codex: "codex-history:personalized-source-smoke",
  obsidian: "obsidian:personalized-source-smoke",
} as const;

export const PersonalizedSourceSmokeConfigSchema = z.object({
  version: z.literal(1),
  codex_rollouts: z.array(z.string().min(1).max(4_096)).min(1).max(100),
  obsidian_vault_root: z.string().min(1).max(4_096),
  obsidian_notes: z.array(ObsidianSafeRelativePathSchema).min(1).max(500),
  obsidian_vault_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
  workflow: z.object({
    enabled: z.literal(true),
    external_model_approved: z.boolean(),
    max_codex_messages: z.number().int().min(1).max(20),
    internal_query: z.string().trim().min(1).max(500),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  validateAbsoluteSelections(value.codex_rollouts, ".jsonl", context);
  if (!isAbsolute(value.obsidian_vault_root)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["obsidian_vault_root"], message: "vault root must be absolute" });
  }
  validateObsidianSelections(value.obsidian_notes, context);
});

export type PersonalizedSourceSmokeConfig = z.infer<typeof PersonalizedSourceSmokeConfigSchema>;

const CheckpointEvidenceSchema = z.object({
  revision: z.number().int().nonnegative(),
  cursor_sha256: SHA256,
}).strict();

const ConnectorEvidenceSchema = z.object({
  connector_id: z.enum(["codex-history", "obsidian-capture"]),
  connection_id: z.enum([CONNECTIONS.codex, CONNECTIONS.obsidian]),
  committed_batches: z.number().int().nonnegative(),
  stored_views: z.number().int().nonnegative(),
  checkpoint: CheckpointEvidenceSchema,
  replay: z.object({
    submitted_batches: z.literal(1),
    confirmed_exact_replays: z.literal(1),
    post_checkpoint_emitted_batches: z.literal(0),
    post_checkpoint_emitted_receipts: z.literal(0),
    checkpoint_unchanged: z.literal(true),
  }).strict(),
  trace_event_counts: z.record(z.string().min(1), z.number().int().nonnegative()),
}).strict();

const ViewEvidenceSchema = z.object({
  ref: ExactViewRefSchema,
  schema: z.object({
    name: z.string().min(1),
    version: z.number().int().positive(),
  }).strict(),
  role: z.literal("raw"),
}).strict();

const SmokeEvidencePayloadSchema = z.object({
  version: z.literal(3),
  ok: z.literal(true),
  sources: z.object({
    codex_rollouts: z.number().int().positive(),
    obsidian_notes: z.number().int().positive(),
    manifest_sha256: SHA256,
  }).strict(),
  capture: z.object({
    committed_batches: z.number().int().nonnegative(),
    stored_views: z.number().int().positive(),
    view_manifest_sha256: SHA256,
    views_truncated: z.boolean(),
    connectors: z.array(ConnectorEvidenceSchema).length(2),
    views: z.array(ViewEvidenceSchema).min(1).max(MAX_VIEW_EVIDENCE_SAMPLES),
  }).strict(),
  workflow: z.object({
    source_count: z.number().int().min(2).max(96),
    source_manifest_sha256: SHA256,
    fragment_count: z.number().int().positive(),
    graph_node_count: z.number().int().min(2),
    search_hit_counts: z.object({
      keyword: z.number().int().positive(),
      internal: z.number().int().positive(),
      relation: z.number().int().positive(),
    }).strict(),
    surface_parity: z.literal(true),
    transformation_revisions: z.tuple([z.literal(1), z.literal(2)]),
    restart_exact_replay: z.literal(true),
    privacy_forget: z.literal(true),
    semantic: z.literal("not_run_no_authorized_embedding"),
    agent_access: z.object({
      transport: z.enum(["mcp", "http_cli", "mixed"]),
      citation_count: z.number().int().min(2).max(20),
      operation_counts: z.object({
        search: z.number().int().positive().max(8),
        exact_get: z.number().int().min(2).max(8),
        graph_project: z.number().int().positive().max(4),
      }).strict(),
      evidence_sha256: SHA256,
    }).strict(),
    graph_explorer: z.object({
      graph_ready: z.literal(true),
      exact_working_state_selected: z.literal(true),
      accessible_dom_synchronized: z.literal(true),
      node_count: z.number().int().positive(),
      edge_count: z.number().int().positive(),
      evidence_sha256: SHA256,
    }).strict(),
  }).strict().nullable(),
  cleanup: z.object({
    workspace_removed: z.literal(true),
    database_removed: z.literal(true),
  }).strict(),
}).strict();

export const PersonalizedSourceSmokeEvidenceSchema = SmokeEvidencePayloadSchema.extend({
  evidence_sha256: SHA256,
}).strict();

export type PersonalizedSourceSmokeEvidence = z.infer<typeof PersonalizedSourceSmokeEvidenceSchema>;

export class PersonalizedSourceSmokeError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalizedSourceSmokeError";
  }
}

type SmokeOptions = {
  now?: () => string;
  temporary_parent?: string;
  agent_runtime?: AgentRuntimeAdapter;
  local_agent_runtime?: boolean;
  agent_access_gate?: (input: PersonalizedAgentAccessInput) => Promise<PersonalizedAgentAccessEvidence>;
  graph_explorer_gate?: (
    input: PersonalizedViewExplorerAcceptanceInput,
  ) => Promise<PersonalizedViewExplorerAcceptanceEvidence>;
};

export async function runPersonalizedSourceSmoke(
  input: PersonalizedSourceSmokeConfig,
  options: SmokeOptions = {},
): Promise<PersonalizedSourceSmokeEvidence> {
  const config = parseConfig(input);
  const capturedAt = parseTimestamp(options.now?.() ?? new Date().toISOString());
  const temporaryParent = options.temporary_parent ?? tmpdir();
  const workspace = await mkdtemp(join(temporaryParent, "metaflow-personalized-source-smoke-"));
  const database = join(workspace, "views.sqlite");
  const codexHome = join(workspace, "selected-codex");
  const obsidianVault = join(workspace, "selected-obsidian");
  let repository: SqliteViewRepository | undefined;
  let workflowHost: Awaited<ReturnType<typeof createPersonalizedWorkflowHost>> | undefined;
  let payload: z.infer<typeof SmokeEvidencePayloadSchema> | undefined;

  try {
    const sourceManifest = await stageSelectedSources(config, codexHome, obsidianVault);
    repository = new SqliteViewRepository(database, { now: () => capturedAt });
    const runtime = new ConnectorRuntime(
      repository,
      new CaptureIngress({ repository, now: () => capturedAt }),
      { now: () => capturedAt },
    );
    const capturedConnectors = await registerConnectors(runtime, config, codexHome, obsidianVault, capturedAt);

    const first = await runBoth(runtime);
    if (first.codex.length < 1 || first.obsidian.length < 1) {
      throw new PersonalizedSourceSmokeError("connector_capture_empty", "Each selected source kind must produce a committed Capture batch");
    }
    const firstCheckpoints = await readCheckpoints(repository);
    const exactReplay = {
      codex: await capturedConnectors.codex.replayOne(runtime),
      obsidian: await capturedConnectors.obsidian.replayOne(runtime),
    };
    const postCheckpoint = await runBoth(runtime);
    const replayCheckpoints = await readCheckpoints(repository);
    const capturedViews = await readCapturedViews(repository, first);
    const allViews = capturedViews.map(viewEvidence).sort(compareViewEvidence);
    const connectorEvidence = await Promise.all([
      connectorEvidenceFor(repository, "codex-history", CONNECTIONS.codex, first.codex, exactReplay.codex, postCheckpoint.codex, firstCheckpoints.codex, replayCheckpoints.codex),
      connectorEvidenceFor(repository, "obsidian-capture", CONNECTIONS.obsidian, first.obsidian, exactReplay.obsidian, postCheckpoint.obsidian, firstCheckpoints.obsidian, replayCheckpoints.obsidian),
    ]);
    const committedBatches = first.codex.length + first.obsidian.length;
    const storedViews = allViews.length;
    if (committedBatches < 1 || storedViews < 1) {
      throw new PersonalizedSourceSmokeError("capture_empty", "Selected sources did not produce any committed Raw Views");
    }
    let workflowEvidence: z.infer<typeof SmokeEvidencePayloadSchema>["workflow"] = null;
    if (config.workflow) {
      if (!options.agent_runtime) {
        throw new PersonalizedSourceSmokeError("workflow_agent_missing", "Full personalized workflow requires one explicit Agent runtime");
      }
      if (!config.workflow.external_model_approved && !options.local_agent_runtime) {
        throw new PersonalizedSourceSmokeError(
          "workflow_agent_policy_invalid",
          "An external Agent runtime requires explicit source-policy approval",
        );
      }
      const selected = selectWorkflowSources(capturedViews, config.workflow.max_codex_messages);
      const workflowClock = monotonicClock(capturedAt);
      workflowHost = await createPersonalizedWorkflowHost({
        database_path: database,
        views: repository,
        capture: runtime,
        agent_runtime: options.agent_runtime,
        workflow_id: WORKFLOW_ID,
        now: workflowClock,
        local_agent_runtime: options.local_agent_runtime,
      });
      const workflow = await runPersonalizedViewWorkflow({
        workflow_id: WORKFLOW_ID,
        created_at: capturedAt,
        principal: { id: "user:local", grants: ["*"] },
        ports: {
          views: repository,
          transformations: workflowHost.transformations,
          operations: workflowHost.operations,
        },
        sources: {
          codex: selected.codex.map(exactViewRef),
          obsidian: selected.obsidian.map(exactViewRef),
        },
        markdown_parser: {
          transformation: exactTransformationRef(obsidianMarkdownParserTransformation),
          access_policy: WORKFLOW_ACCESS_POLICY,
        },
        authoring: {
          prompt: authoringPrompt(selected, options.agent_runtime.id, config.workflow.external_model_approved, capturedAt),
          approval_reason: "The strict exact-source working-state Transformation satisfies the requested local workflow.",
          expected_output_schema: { name: "personal.working_state", version: 1 },
          expected_output_contract: WORKING_STATE_SCHEMA,
          expected_working_state_view_id: `view:${WORKFLOW_ID}:working-state`,
        },
        search: {
          keyword_query: "Personalized Evidence Working State",
          internal_query: config.workflow.internal_query,
          relation_query: "personalized",
        },
        feedback: {
          message: "Keep confirmed findings separate from open questions and next actions.",
          requested_changes: ["instruction"],
          evolved_instruction: "Synthesize the exact selected evidence, keeping confirmed findings, open questions, and next actions explicitly separate.",
          resolution: "Applied the requested distinction to the immutable Transformation revision.",
        },
      });
      const principal: OperationContext["principal"] = { id: "user:local", grants: ["*"] };
      const agentAccessEvidence = await (options.agent_access_gate ?? runPersonalizedAgentAccessGate)({
        operations: workflowHost.operations,
        principal,
        working_state: exactViewRef(workflow.working_state),
        application_space: exactViewRef(workflow.application_space),
        queries: {
          working_state: "Personalized Evidence Working State",
          application_space: workflow.application_space.name,
        },
      });
      const graphExplorerEvidence = await (options.graph_explorer_gate ?? runPersonalizedViewExplorerAcceptance)({
        operations: workflowHost.operations,
        principal,
        working_state: exactViewRef(workflow.working_state),
        application_space: exactViewRef(workflow.application_space),
      });
      const ownedRepository = repository;
      const ownedHost = workflowHost;
      repository = undefined;
      workflowHost = undefined;
      workflowEvidence = await restartReplayForget({
        workflow,
        repository: ownedRepository,
        host: ownedHost,
        database,
        agent_runtime: options.agent_runtime,
        local_agent_runtime: options.local_agent_runtime,
        now: workflowClock,
        agent_access: agentAccessEvidence,
        graph_explorer: graphExplorerEvidence,
      });
    }
    payload = {
      version: 3,
      ok: true,
      sources: {
        codex_rollouts: config.codex_rollouts.length,
        obsidian_notes: config.obsidian_notes.length,
        manifest_sha256: sourceManifest,
      },
      capture: {
        committed_batches: committedBatches,
        stored_views: storedViews,
        view_manifest_sha256: digestJson(allViews),
        views_truncated: allViews.length > MAX_VIEW_EVIDENCE_SAMPLES,
        connectors: connectorEvidence,
        views: allViews.slice(0, MAX_VIEW_EVIDENCE_SAMPLES),
      },
      workflow: workflowEvidence,
      cleanup: { workspace_removed: true, database_removed: true },
    };
  } finally {
    try {
      workflowHost?.close();
      repository?.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  if (!payload) {
    throw new PersonalizedSourceSmokeError("smoke_incomplete", "Personalized source smoke ended without evidence");
  }
  await assertRemoved(workspace, database);
  const parsed = SmokeEvidencePayloadSchema.parse(payload);
  return PersonalizedSourceSmokeEvidenceSchema.parse({
    ...parsed,
    evidence_sha256: digestJson(parsed),
  });
}

export async function readPersonalizedSourceSmokeConfig(path: string): Promise<PersonalizedSourceSmokeConfig> {
  if (!isAbsolute(path)) {
    throw new PersonalizedSourceSmokeError("config_path_invalid", "Smoke config path must be absolute");
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new PersonalizedSourceSmokeError("config_unreadable", "Smoke config could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new PersonalizedSourceSmokeError("config_json_invalid", "Smoke config is not valid JSON");
  }
  return parseConfig(value);
}

function parseConfig(value: unknown): PersonalizedSourceSmokeConfig {
  const parsed = PersonalizedSourceSmokeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersonalizedSourceSmokeError(
      "config_invalid",
      `Smoke config is incompatible (${parsed.error.issues.length} validation issue${parsed.error.issues.length === 1 ? "" : "s"})`,
    );
  }
  return parsed.data;
}

function validateAbsoluteSelections(
  paths: string[],
  extension: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  paths.forEach((path, index) => {
    if (!isAbsolute(path)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["codex_rollouts", index], message: "source path must be absolute" });
    }
    if (extname(path).toLowerCase() !== extension) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["codex_rollouts", index], message: `source path must end with ${extension}` });
    }
    const normalized = resolve(path);
    if (seen.has(normalized)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["codex_rollouts", index], message: "source path must be unique" });
    }
    seen.add(normalized);
  });
}

function validateObsidianSelections(paths: string[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  paths.forEach((path, index) => {
    if (extname(path).toLowerCase() !== ".md") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["obsidian_notes", index], message: "source path must end with .md" });
    }
    if (seen.has(path)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["obsidian_notes", index], message: "source path must be unique" });
    }
    seen.add(path);
  });
}

async function stageSelectedSources(
  config: PersonalizedSourceSmokeConfig,
  codexHome: string,
  obsidianVault: string,
): Promise<string> {
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(obsidianVault, { recursive: true, mode: 0o700 });
  const entries: Array<{ kind: "codex" | "obsidian"; index: number; sha256: string; selection_sha256?: string }> = [];
  const selectedFileIdentities = new Set<string>();
  for (const [index, source] of config.codex_rollouts.entries()) {
    const directory = join(codexHome, "sessions", `selected-${String(index).padStart(3, "0")}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const copied = await copySelectedFile(source, join(directory, `rollout-selected-${String(index).padStart(3, "0")}.jsonl`), "codex", index);
    assertUniqueSelectedFile(selectedFileIdentities, copied.identity);
    entries.push({ kind: "codex", index, sha256: copied.sha256 });
  }
  const sourceVaultRoot = await resolveSourceVaultRoot(config.obsidian_vault_root);
  for (const [index, relativePath] of config.obsidian_notes.entries()) {
    const source = await resolveSelectedVaultFile(sourceVaultRoot, relativePath, index);
    const target = join(obsidianVault, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const copied = await copySelectedFile(source, target, "obsidian", index);
    assertUniqueSelectedFile(selectedFileIdentities, copied.identity);
    entries.push({ kind: "obsidian", index, sha256: copied.sha256, selection_sha256: createHash("sha256").update(relativePath).digest("hex") });
  }
  return digestJson(entries);
}

async function copySelectedFile(source: string, target: string, kind: "codex" | "obsidian", index: number): Promise<{ sha256: string; identity: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    const hash = createHash("sha256");
    const hashingStream = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk as Buffer);
        callback(null, chunk);
      },
    });
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      hashingStream,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("source changed while copying");
    }
    return { sha256: hash.digest("hex"), identity: `${before.dev}:${before.ino}` };
  } catch {
    throw new PersonalizedSourceSmokeError(
      `${kind}_source_unreadable`,
      `Selected ${kind} source at index ${index} could not be copied safely`,
    );
  } finally {
    await handle?.close();
  }
}

function assertUniqueSelectedFile(seen: Set<string>, identity: string): void {
  if (seen.has(identity)) {
    throw new PersonalizedSourceSmokeError("source_selection_duplicate", "The same source file was selected more than once");
  }
  seen.add(identity);
}

async function resolveSourceVaultRoot(configuredRoot: string): Promise<string> {
  try {
    const root = await realpath(configuredRoot);
    const details = await lstat(root);
    if (!details.isDirectory()) throw new Error("not a directory");
    return root;
  } catch {
    throw new PersonalizedSourceSmokeError("obsidian_vault_unavailable", "Selected Obsidian vault root is unavailable");
  }
}

async function resolveSelectedVaultFile(root: string, relativePath: string, index: number): Promise<string> {
  try {
    const configured = join(root, ...relativePath.split("/"));
    const sourceDetails = await lstat(configured);
    if (sourceDetails.isSymbolicLink()) throw new Error("symlink source is forbidden");
    const source = await realpath(configured);
    const relation = relative(root, source);
    if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error("source escaped vault root");
    }
    return source;
  } catch {
    throw new PersonalizedSourceSmokeError("obsidian_source_unreadable", `Selected obsidian source at index ${index} could not be resolved safely`);
  }
}

async function registerConnectors(
  runtime: ConnectorRuntime,
  config: PersonalizedSourceSmokeConfig,
  codexHome: string,
  obsidianVault: string,
  capturedAt: string,
): Promise<{ codex: CaptureTap; obsidian: CaptureTap }> {
  const privacy = sourcePolicy(config);
  const codexConnection = codexHistorySourceConnection({
    id: CONNECTIONS.codex,
    source_root: "sessions",
    content_mode: "messages",
    privacy,
  });
  const obsidianConnection = obsidianSourceConnection({
      id: CONNECTIONS.obsidian,
      configuration: {
        vault_id: config.obsidian_vault_id,
        vault_root: obsidianVault,
        include: ["**/*.md"],
        max_file_bytes: 8_000_000,
        identity_policy: OBSIDIAN_IDENTITY_POLICY,
        parser_contract: OBSIDIAN_PARSER_CONTRACT,
        secret_policy: OBSIDIAN_SECRET_POLICY,
      },
      privacy,
  });
  const codex = new CaptureTap(new CodexHistoryCaptureConnector({ codex_home: codexHome, now: () => capturedAt }));
  const obsidian = new CaptureTap(new ObsidianCaptureAdapter({ now: () => capturedAt, watcher: new ContentFreeWatcher() }));
  runtime.registerConnector(codex);
  await runtime.registerConnection(codexConnection);
  runtime.registerConnector(obsidian);
  await runtime.registerConnection(obsidianConnection);
  return { codex, obsidian };
}

function sourcePolicy(config: PersonalizedSourceSmokeConfig) {
  return {
    owner: "user:local",
    visibility: "private" as const,
    privacy: "sensitive" as const,
    retention: "normal" as const,
    allow_external_model: config.workflow?.external_model_approved ?? false,
    allow_embedding: false,
    allow_local_search: true,
    labels: ["personalized-source-smoke"],
  };
}

class CaptureTap implements ConnectorPort {
  readonly manifest;
  private firstBatch?: CaptureBatch;

  constructor(private readonly delegate: ConnectorPort) {
    this.manifest = delegate.manifest;
  }

  health(connection: SourceConnection, context: ConnectorContext) {
    return this.delegate.health(connection, context);
  }

  async *open(connection: SourceConnection, request: ConnectorOpenRequest, context: ConnectorContext) {
    for await (const batch of this.delegate.open(connection, request, context)) {
      this.firstBatch ??= batch;
      yield batch;
    }
  }

  async replayOne(runtime: ConnectorRuntime): Promise<CommitCaptureBatchResult> {
    if (!this.firstBatch) {
      throw new PersonalizedSourceSmokeError("replay_batch_missing", "Connector did not emit a batch eligible for exact replay");
    }
    const result = await runtime.submitBatch(this.firstBatch);
    if (!result.replayed) {
      throw new PersonalizedSourceSmokeError("exact_replay_failed", "Capture did not recognize an exact batch replay");
    }
    return result;
  }
}

class ContentFreeWatcher implements ObsidianWatcherAccelerator {
  async load() {
    return { reference: null, changed_paths: [], recovered: false };
  }

  async write(input: { checkpoint_revision: number }) {
    return {
      path: `snapshot-${input.checkpoint_revision}.bin` as const,
      sha256: createHash("sha256").update(`checkpoint:${input.checkpoint_revision}`).digest("hex"),
    };
  }
}

async function runBoth(runtime: ConnectorRuntime): Promise<{
  codex: CommitCaptureBatchResult[];
  obsidian: CommitCaptureBatchResult[];
}> {
  const codex = await runtime.run(CONNECTIONS.codex, "pull", {});
  const obsidian = await runtime.run(CONNECTIONS.obsidian, "pull", {});
  return { codex, obsidian };
}

async function readCheckpoints(repository: SqliteViewRepository) {
  const codex = await repository.getCaptureCheckpoint(CONNECTIONS.codex);
  const obsidian = await repository.getCaptureCheckpoint(CONNECTIONS.obsidian);
  if (!codex || !obsidian) {
    throw new PersonalizedSourceSmokeError("checkpoint_missing", "Capture checkpoint evidence is missing");
  }
  return { codex, obsidian };
}

async function connectorEvidenceFor(
  repository: SqliteViewRepository,
  connectorId: "codex-history" | "obsidian-capture",
  connectionId: typeof CONNECTIONS.codex | typeof CONNECTIONS.obsidian,
  first: CommitCaptureBatchResult[],
  exactReplay: CommitCaptureBatchResult,
  postCheckpoint: CommitCaptureBatchResult[],
  checkpoint: { revision: number; cursor: Record<string, unknown> },
  replayCheckpoint: { revision: number; cursor: Record<string, unknown> },
) {
  const checkpointEvidence = checkpointFor(checkpoint);
  const replayEvidence = checkpointFor(replayCheckpoint);
  if (digestJson(checkpointEvidence) !== digestJson(replayEvidence)) {
    throw new PersonalizedSourceSmokeError("checkpoint_drift", "Replay changed a frozen Capture checkpoint");
  }
  const trace = await repository.getCaptureTrace(connectionId);
  const traceEventCounts: Record<string, number> = {};
  for (const event of trace) traceEventCounts[event.type] = (traceEventCounts[event.type] ?? 0) + 1;
  return ConnectorEvidenceSchema.parse({
    connector_id: connectorId,
    connection_id: connectionId,
    committed_batches: first.length,
    stored_views: storedReceiptCount(first),
    checkpoint: checkpointEvidence,
    replay: {
      submitted_batches: 1,
      confirmed_exact_replays: exactReplay.replayed ? 1 : 0,
      post_checkpoint_emitted_batches: postCheckpoint.length,
      post_checkpoint_emitted_receipts: postCheckpoint.reduce((count, batch) => count + batch.receipts.length, 0),
      checkpoint_unchanged: true,
    },
    trace_event_counts: Object.fromEntries(Object.entries(traceEventCounts).sort(([left], [right]) => left.localeCompare(right, "en"))),
  });
}

function checkpointFor(checkpoint: { revision: number; cursor: Record<string, unknown> }) {
  return CheckpointEvidenceSchema.parse({
    revision: checkpoint.revision,
    cursor_sha256: digestJson(checkpoint.cursor),
  });
}

async function readCapturedViews(
  repository: SqliteViewRepository,
  first: { codex: CommitCaptureBatchResult[]; obsidian: CommitCaptureBatchResult[] },
): Promise<View[]> {
  const refs = storedRefs([...first.codex, ...first.obsidian]);
  const views: View[] = [];
  for (const ref of refs) {
    const view = await repository.get(ref);
    if (!view) throw new PersonalizedSourceSmokeError("committed_view_missing", "A committed exact View could not be read back");
    views.push(view);
  }
  return views.sort(compareViews);
}

function compareViews(left: View, right: View): number {
  return left.id.localeCompare(right.id, "en") || left.revision - right.revision;
}

function compareViewEvidence(
  left: z.infer<typeof ViewEvidenceSchema>,
  right: z.infer<typeof ViewEvidenceSchema>,
): number {
  return left.ref.view_id.localeCompare(right.ref.view_id, "en") || left.ref.revision - right.ref.revision;
}

function selectWorkflowSources(views: View[], maxCodexMessages: number): { codex: View[]; obsidian: View[] } {
  const codex = views
    .filter(view => view.schema.name === "capture.codex.message" && view.schema.version === 1)
    .sort(compareViews)
    .slice(0, maxCodexMessages);
  const obsidian = views
    .filter(view => view.schema.name === "capture.obsidian.document" && view.schema.version === 1)
    .sort(compareViews);
  if (codex.length === 0 || obsidian.length === 0) {
    throw new PersonalizedSourceSmokeError(
      "workflow_source_group_empty",
      "Full workflow requires at least one Codex message View and one Obsidian document View",
    );
  }
  if (obsidian.length > PERSONALIZED_WORKFLOW_SOURCE_LIMITS.obsidian
    || codex.length + obsidian.length > PERSONALIZED_WORKFLOW_SOURCE_LIMITS.total) {
    throw new PersonalizedSourceSmokeError(
      "workflow_source_limit_exceeded",
      "Selected Obsidian documents exceed the explicit personalized workflow source limit",
    );
  }
  return { codex, obsidian };
}

function monotonicClock(start: string): () => string {
  const epoch = Date.parse(start);
  let sequence = 0;
  return () => new Date(epoch + sequence++).toISOString();
}

function authoringPrompt(
  selected: { codex: View[]; obsidian: View[] },
  runtimeId: string,
  externalModelApproved: boolean,
  createdAt: string,
): string {
  const sourceRefs = [...selected.codex, ...selected.obsidian].map(exactViewRef).sort((left, right) => (
    left.view_id.localeCompare(right.view_id, "en") || left.revision - right.revision
  ));
  const accessUse = externalModelApproved ? "external_model" : "local_execution";
  return [
    "Create exactly one strict Transformation proposal as JSON with kind=transformation.",
    "It must synthesize the frozen exact source Views into a personalized working-state View without inventing evidence.",
    `Use transformation id transformation:${WORKFLOW_ID}:working-state, revision 1, and name Personalized Evidence Working State.`,
    `Use one Agent Operator with id operator:${WORKFLOW_ID}:working-state, revision 1, adapter agent-execution, profile personalized-working-state, and configuration runtime_override=${runtimeId}, execution_mode=invoke, output_mode=schema_value, autonomy=suggest, allow_network=false, allow_write=false.`,
    "Declare exactly one required input role named sources, with one exact view source for every ref below and no selector.",
    "Declare strict output Schema personal.working_state@1 with required fields summary:string, confirmed_decisions:string[], open_questions:string[], next_actions:string[], and sources:exact View ref[]. Disallow additional properties.",
    `Copy this exact output Schema object without additions or changes: ${JSON.stringify(WORKING_STATE_SCHEMA)}`,
    "Use access policy id policy:personalized-real-source revision 1 with view_access approve_all and no rules.",
    "Use a bounded budget: timeout_ms 120000, max_attempts 1, max_input_tokens 30000, max_output_tokens 4000, with empty extensions.",
    `Set created_at exactly to ${createdAt} and metadata to an empty object.`,
    `Set expected_revision to 0 and include execute parameters run_id=run:${WORKFLOW_ID}:working-state, correlation_id=correlation:${WORKFLOW_ID}:working-state, access_use=${accessUse}, idempotency_key=execution:${WORKFLOW_ID}:working-state, the same access policy, and invocation_inputs containing the complete sources role below.`,
    "Return only the candidate JSON object, without Markdown or commentary.",
    `Exact source refs: ${JSON.stringify(sourceRefs)}`,
  ].join("\n");
}

async function restartReplayForget(input: {
  workflow: PersonalizedWorkflowResult;
  repository: SqliteViewRepository;
  host: Awaited<ReturnType<typeof createPersonalizedWorkflowHost>>;
  database: string;
  agent_runtime: AgentRuntimeAdapter;
  local_agent_runtime?: boolean;
  now: () => string;
  agent_access: PersonalizedAgentAccessEvidence;
  graph_explorer: PersonalizedViewExplorerAcceptanceEvidence;
}): Promise<NonNullable<z.infer<typeof SmokeEvidencePayloadSchema>["workflow"]>> {
  const run = await input.repository.getRun(input.workflow.authoring.run_id);
  if (!run || run.status !== "succeeded") {
    throw new PersonalizedSourceSmokeError("workflow_run_missing", "The authored successful Run is missing before restart");
  }
  const attemptsBefore = await input.repository.getAttempts(run.id);
  if (attemptsBefore.length === 0) {
    throw new PersonalizedSourceSmokeError("workflow_attempt_missing", "The authored Run has no durable attempt before restart");
  }

  try {
    input.host.close();
  } finally {
    input.repository.close();
  }

  let reopened: SqliteViewRepository | undefined;
  let reopenedHost: Awaited<ReturnType<typeof createPersonalizedWorkflowHost>> | undefined;
  try {
    reopened = new SqliteViewRepository(input.database, { now: input.now });
    const capture = new ConnectorRuntime(
      reopened,
      new CaptureIngress({ repository: reopened, now: input.now }),
      { now: input.now },
    );
    reopenedHost = await createPersonalizedWorkflowHost({
      database_path: input.database,
      views: reopened,
      capture,
      agent_runtime: input.agent_runtime,
      workflow_id: WORKFLOW_ID,
      now: input.now,
      local_agent_runtime: input.local_agent_runtime,
    });
    const replayParameters = {
      run_id: run.id,
      correlation_id: run.correlation_id,
      access_policy: run.frozen.access_policy,
      access_use: run.frozen.access_use,
      ...(run.frozen.invocation_inputs ? { invocation_inputs: run.frozen.invocation_inputs } : {}),
      ...(run.frozen.runtime_override ? { runtime_override: run.frozen.runtime_override } : {}),
      ...(run.frozen.idempotency_key ? { idempotency_key: run.frozen.idempotency_key } : {}),
      ...(run.frozen.repair ? { repair_context: run.frozen.repair } : {}),
      ...(run.frozen.output_policy ? { output_policy: run.frozen.output_policy } : {}),
      ...(run.frozen.failure_policy ? { failure_policy: run.frozen.failure_policy } : {}),
      ...(run.frozen.previous_attempt_id ? { previous_attempt_id: run.frozen.previous_attempt_id } : {}),
      ...(run.frozen.cascade ? { cascade: run.frozen.cascade } : {}),
      ...(run.frozen.pre_execution_failure ? { pre_execution_failure: run.frozen.pre_execution_failure } : {}),
    };
    await executeOperation(reopenedHost.operations, "run.execute", {
      transformation: exactTransformationRef(input.workflow.authoring.transformation),
      parameters: replayParameters,
    }, "request:personalized-real-source:restart-replay");
    const replayedRun = await reopened.getRun(run.id);
    const attemptsAfter = await reopened.getAttempts(run.id);
    if (!replayedRun
      || replayedRun.status !== "succeeded"
      || digestJson(replayedRun.output_views) !== digestJson(run.output_views)
      || attemptsAfter.length !== attemptsBefore.length) {
      throw new PersonalizedSourceSmokeError(
        "workflow_restart_replay_mismatch",
        "Restart replay did not preserve the frozen terminal Run and attempt set",
      );
    }

    const forgottenSource = input.workflow.source_views.codex[0];
    if (!forgottenSource) {
      throw new PersonalizedSourceSmokeError("workflow_forget_source_missing", "No selected Codex source is available for Privacy Forget");
    }
    const preview = await executeOperation(reopenedHost.operations, "privacy.forget.request", {
      request_id: `forget:${WORKFLOW_ID}:codex-source`,
      requested_at: input.now(),
      targets: [{ kind: "exact_view", ref: exactViewRef(forgottenSource) }],
      mixed_source_rule: "purge",
    }, "request:personalized-real-source:forget-preview");
    const planDigest = (preview.data as { plan?: { plan_digest?: unknown } }).plan?.plan_digest;
    if (typeof planDigest !== "string") {
      throw new PersonalizedSourceSmokeError("workflow_forget_plan_invalid", "Privacy Forget preview omitted its plan digest");
    }
    const forgotten = await executeOperation(reopenedHost.operations, "privacy.forget.execute", {
      request_id: `forget:${WORKFLOW_ID}:codex-source`,
      authorization: { kind: "confirmed_preview", plan_digest: planDigest },
    }, "request:personalized-real-source:forget-execute");
    if ((forgotten.data as { status?: unknown }).status !== "succeeded") {
      throw new PersonalizedSourceSmokeError("workflow_forget_failed", "Privacy Forget did not reach its durable succeeded state");
    }
    for (const ref of [
      exactViewRef(forgottenSource),
      exactViewRef(input.workflow.working_state),
      exactViewRef(input.workflow.application_space),
    ]) {
      if (await reopened.get(ref)) {
        throw new PersonalizedSourceSmokeError("workflow_forget_incomplete", "Privacy Forget left governed downstream View evidence behind");
      }
    }

    const projected = projectPersonalizedWorkflowEvidence(input.workflow);
    if (projected.surface_parity.surfaces.join(",") !== "in-process,cli,http,mcp") {
      throw new PersonalizedSourceSmokeError("workflow_surface_parity_invalid", "Workflow did not verify every canonical Operation surface");
    }
    return {
      source_count: projected.source_counts.total,
      source_manifest_sha256: projected.source_manifest_sha256,
      fragment_count: projected.fragment_refs.length,
      graph_node_count: input.workflow.graph.projection.nodes.length,
      search_hit_counts: projected.search_hit_counts,
      surface_parity: true,
      transformation_revisions: [1, 2],
      restart_exact_replay: true,
      privacy_forget: true,
      semantic: "not_run_no_authorized_embedding",
      agent_access: {
        transport: input.agent_access.transport,
        citation_count: input.agent_access.citation_count,
        operation_counts: input.agent_access.operation_counts,
        evidence_sha256: digestJson(input.agent_access),
      },
      graph_explorer: {
        graph_ready: input.graph_explorer.graph_ready,
        exact_working_state_selected: input.graph_explorer.exact_working_state_selected,
        accessible_dom_synchronized: input.graph_explorer.accessible_dom_synchronized,
        node_count: input.graph_explorer.node_count,
        edge_count: input.graph_explorer.edge_count,
        evidence_sha256: digestJson(input.graph_explorer),
      },
    };
  } finally {
    try {
      reopenedHost?.close();
    } finally {
      reopened?.close();
    }
  }
}

async function executeOperation(
  operations: OperationService,
  operation: OperationName,
  operationInput: unknown,
  requestId: string,
) {
  const envelope = await operations.execute(
    { operation, input: operationInput },
    { request_id: requestId, principal: { id: "user:local", grants: ["*"] } },
  );
  if (!envelope.ok) {
    throw new PersonalizedSourceSmokeError(
      "workflow_operation_failed",
      `Operation ${operation} failed with ${envelope.error.code}`,
    );
  }
  return envelope;
}

function storedRefs(results: CommitCaptureBatchResult[]): ExactViewRef[] {
  const unique = new Map<string, ExactViewRef>();
  for (const result of results) {
    for (const receipt of result.receipts) {
      if (receipt.status !== "stored") continue;
      const ref = ExactViewRefSchema.parse({ view_id: receipt.view_id, revision: receipt.revision });
      unique.set(`${ref.view_id}@${ref.revision}`, ref);
    }
  }
  return [...unique.values()];
}

function storedReceiptCount(results: CommitCaptureBatchResult[]): number {
  return results.reduce((count, result) => count + result.receipts.filter(receipt => receipt.status === "stored").length, 0);
}

function viewEvidence(view: View) {
  if (view.role !== "raw") {
    throw new PersonalizedSourceSmokeError("committed_view_role_invalid", "Connector committed a non-Raw View");
  }
  return ViewEvidenceSchema.parse({
    ref: { view_id: view.id, revision: view.revision },
    schema: { name: view.schema.name, version: view.schema.version },
    role: "raw",
  });
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new PersonalizedSourceSmokeError("clock_invalid", "Smoke clock must return a canonical ISO timestamp");
  }
  return value;
}

async function assertRemoved(workspace: string, database: string): Promise<void> {
  for (const path of [workspace, database]) {
    try {
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new PersonalizedSourceSmokeError("cleanup_unverifiable", "Smoke cleanup could not be verified", { cause: error });
    }
    throw new PersonalizedSourceSmokeError("cleanup_failed", "Disposable smoke state still exists after cleanup");
  }
}

function parseCliConfigPath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) {
    throw new PersonalizedSourceSmokeError("usage_invalid", "Usage: pnpm smoke:personalized-sources --config /absolute/path/to/config.json");
  }
  return argv[1];
}

async function main(): Promise<void> {
  let agentRuntime: AcpStdioAgentRuntimeAdapter | undefined;
  try {
    const config = await readPersonalizedSourceSmokeConfig(parseCliConfigPath(process.argv.slice(2)));
    if (config.workflow) {
      const command = resolveAmbientAcpCommand();
      agentRuntime = new AcpStdioAgentRuntimeAdapter({
        id: command.id,
        command: command.command,
        args: command.args,
        env: command.env,
        lifecycle: "persistent",
      });
      await agentRuntime.warmup();
    }
    const evidence = await runPersonalizedSourceSmoke(config, { agent_runtime: agentRuntime });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    const known = error instanceof PersonalizedSourceSmokeError
      || error instanceof CaptureRuntimeError
      || error instanceof PersonalizedWorkflowError
      || error instanceof PersonalizedAgentAccessError
      || error instanceof PersonalizedViewExplorerAcceptanceError;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: known ? error.code : "personalized_source_smoke_failed",
      message: known ? error.message : "Personalized source smoke failed",
      ...(error instanceof PersonalizedAgentAccessError || error instanceof PersonalizedViewExplorerAcceptanceError
        ? { details: error.details }
        : {}),
    })}\n`);
    process.exitCode = 1;
  } finally {
    await agentRuntime?.close();
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked === import.meta.url) await main();

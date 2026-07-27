import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
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
import { SqliteViewRepository } from "@info/storage-sqlite";
import { ExactViewRefSchema, type ExactViewRef, type View } from "@info/view";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_VIEW_EVIDENCE_SAMPLES = 20;
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
  version: z.literal(2),
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
    const allViews = await readViewEvidence(repository, first);
    const connectorEvidence = await Promise.all([
      connectorEvidenceFor(repository, "codex-history", CONNECTIONS.codex, first.codex, exactReplay.codex, postCheckpoint.codex, firstCheckpoints.codex, replayCheckpoints.codex),
      connectorEvidenceFor(repository, "obsidian-capture", CONNECTIONS.obsidian, first.obsidian, exactReplay.obsidian, postCheckpoint.obsidian, firstCheckpoints.obsidian, replayCheckpoints.obsidian),
    ]);
    const committedBatches = first.codex.length + first.obsidian.length;
    const storedViews = allViews.length;
    if (committedBatches < 1 || storedViews < 1) {
      throw new PersonalizedSourceSmokeError("capture_empty", "Selected sources did not produce any committed Raw Views");
    }
    payload = {
      version: 2,
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
      cleanup: { workspace_removed: true, database_removed: true },
    };
  } finally {
    try {
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
  const codexConnection = codexHistorySourceConnection({ id: CONNECTIONS.codex, source_root: "sessions", content_mode: "messages" });
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
      privacy: {
        owner: "user:local",
        visibility: "private",
        privacy: "sensitive",
        retention: "normal",
        allow_external_model: false,
        allow_embedding: false,
        allow_local_search: true,
        labels: ["personalized-source-smoke"],
      },
  });
  const codex = new CaptureTap(new CodexHistoryCaptureConnector({ codex_home: codexHome, now: () => capturedAt }));
  const obsidian = new CaptureTap(new ObsidianCaptureAdapter({ now: () => capturedAt, watcher: new ContentFreeWatcher() }));
  runtime.registerConnector(codex);
  await runtime.registerConnection(codexConnection);
  runtime.registerConnector(obsidian);
  await runtime.registerConnection(obsidianConnection);
  return { codex, obsidian };
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

async function readViewEvidence(
  repository: SqliteViewRepository,
  first: { codex: CommitCaptureBatchResult[]; obsidian: CommitCaptureBatchResult[] },
) {
  const refs = storedRefs([...first.codex, ...first.obsidian]);
  const views = await Promise.all(refs.map(async ref => {
    const view = await repository.get(ref);
    if (!view) throw new PersonalizedSourceSmokeError("committed_view_missing", "A committed exact View could not be read back");
    return view;
  }));
  return views.map(viewEvidence).sort((left, right) => {
    const byId = left.ref.view_id.localeCompare(right.ref.view_id, "en");
    return byId || left.ref.revision - right.ref.revision;
  });
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
  try {
    const config = await readPersonalizedSourceSmokeConfig(parseCliConfigPath(process.argv.slice(2)));
    const evidence = await runPersonalizedSourceSmoke(config);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    const known = error instanceof PersonalizedSourceSmokeError || error instanceof CaptureRuntimeError;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: known ? error.code : "personalized_source_smoke_failed",
      message: known ? error.message : "Personalized source smoke failed",
    })}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked === import.meta.url) await main();

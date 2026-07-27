import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Stats } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { lstat, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import {
  CaptureRuntimeError,
  defineConnectorKit,
  type CaptureBatch,
  type ConnectorOpenRequest,
  type ConnectorPort,
  type ConnectorRuntime,
  type SourceConnection,
} from "@info/capture";
import {
  CODEX_MAX_BATCH_RECORDS,
  CODEX_ROLLOUT_PARSER_CONTRACT,
  CODEX_SECRET_POLICY,
  CodexHistoryConfigurationSchema,
  CodexHistoryCursorSchema,
  CodexHistoryOpenParametersSchema,
  CodexHistorySourcePayloadSchema,
  emptyCodexExcludedRecordCounts,
  type CodexHistoryConfiguration,
  type CodexHistoryCursor,
  type CodexHistorySourcePayload,
  type CodexSafeRecord,
} from "./contracts.js";
import {
  applyExclusions,
  inspectFirstSessionMetadata,
  openCodexRollout,
  parseAndGateCodexRolloutLine,
  readCompleteRolloutLines,
  verifyCommittedPrefix,
} from "./parser.js";
import { SecretlintRecommendedContentGate, type CodexContentGate } from "./secret-gate.js";

const EMPTY_SHA256 = createHash("sha256").digest("hex");

const CODEX_SESSION_SCHEMA = {
  name: "capture.codex.session",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    required: [
      "kind", "byte_offset", "byte_length", "record_sha256", "timestamp", "session_id", "source",
      "originator", "cli_version", "workspace_path",
    ],
    properties: {
      kind: { const: "session_meta" },
      byte_offset: { type: "integer", minimum: 0 },
      byte_length: { type: "integer", minimum: 1 },
      record_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      timestamp: { type: "string" },
      session_id: { type: "string" },
      source: { type: "string" },
      originator: { type: "string" },
      cli_version: { type: "string" },
      model_provider: { type: "string" },
      workspace_path: { type: "string" },
    },
    additionalProperties: false,
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/workspace_path", category: "title" },
      { path: "/representation/value/timestamp", category: "timestamp" },
      { path: "/provenance/capture/source_id", category: "provenance" },
    ],
  },
} as const;

const CODEX_MESSAGE_SCHEMA = {
  name: "capture.codex.message",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    required: [
      "kind", "byte_offset", "byte_length", "record_sha256", "timestamp", "session_id", "role",
      "text_parts", "omitted_non_text_parts",
    ],
    properties: {
      kind: { const: "message" },
      byte_offset: { type: "integer", minimum: 0 },
      byte_length: { type: "integer", minimum: 1 },
      record_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      timestamp: { type: "string" },
      session_id: { type: "string" },
      turn_id: { type: "string" },
      role: { enum: ["user", "assistant"] },
      text_parts: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
      omitted_non_text_parts: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/role", category: "identifier" },
      { path: "/representation/value/text_parts/*", category: "text" },
      { path: "/representation/value/timestamp", category: "timestamp" },
      { path: "/provenance/capture/source_id", category: "provenance" },
    ],
  },
} as const;

export const CODEX_HISTORY_CONNECTOR_KIT = defineConnectorKit({
  manifest: {
    id: "codex-history",
    version: "1.0.0",
    display_name: "Codex History Capture",
    protocols: ["filesystem"],
    capabilities: ["pull", "append_cursor", "privacy_gate", "archive_continuity"],
    delivery_kinds: ["pull"],
    emitted_schemas: [CODEX_SESSION_SCHEMA, CODEX_MESSAGE_SCHEMA],
  },
  configuration_schema: CodexHistoryConfigurationSchema,
  payload_schema: CodexHistorySourcePayloadSchema,
  adapt(payload, context) {
    return payload.records.map(record => ({
      idempotency_key: candidateKey(context.connection.id, payload.session_id, record.byte_offset),
      name: record.kind === "session_meta"
        ? "Codex session metadata"
        : `Codex ${record.role} message`,
      purpose: record.kind === "session_meta"
        ? "Preserve privacy-gated source metadata for one Codex session"
        : "Preserve one privacy-gated Codex message occurrence as immutable source evidence",
      aliases: [],
      schema: record.kind === "session_meta" ? CODEX_SESSION_SCHEMA : CODEX_MESSAGE_SCHEMA,
      observed_at: record.timestamp,
      source: record.kind === "session_meta"
        ? context.stableSource({ source_id: `codex-session:${record.session_id}`, source_kind: "codex_session" })
        : context.occurrence({
            source_id: `codex-message:${record.session_id}:${record.byte_offset}`,
            source_kind: "codex_message",
          }),
      representation: {
        form: "inline" as const,
        kind: record.kind === "session_meta" ? "codex_session_metadata" : "codex_message",
        media_type: "application/json",
        value: record,
        metadata: {},
      },
      metadata: {
        parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT,
        secret_policy: CODEX_SECRET_POLICY,
        record_sha256: record.record_sha256,
        byte_offset: record.byte_offset,
      },
    }));
  },
});

export type CodexHistoryConnectorOptions = {
  codex_home?: string;
  now?: () => string;
  content_gate?: CodexContentGate;
};

type DiscoveredRollout = {
  absolute_path: string;
  scope_root: string;
  scope_root_dev: number | bigint;
  scope_root_ino: number | bigint;
  scope: "sessions" | "archived_sessions";
  relative_path: string;
  session_id: string;
  observed_dev: number | bigint;
  observed_ino: number | bigint;
  observed_size: number;
  observed_mtime_ms: number;
  observed_ctime_ms: number;
};

type ResolvedScopeRoot = {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
};

export class CodexHistoryCaptureConnector implements ConnectorPort {
  readonly manifest = CODEX_HISTORY_CONNECTOR_KIT.manifest;
  private readonly configuredCodexHome: string;
  private readonly now: () => string;
  private readonly contentGate: CodexContentGate;
  private readonly resolvedHomes = new Map<string, string>();

  constructor(options: CodexHistoryConnectorOptions = {}) {
    this.configuredCodexHome = options.codex_home ?? join(homedir(), ".codex");
    if (!isAbsolute(this.configuredCodexHome)) throw new TypeError("Codex home must be an absolute path");
    this.now = options.now ?? (() => new Date().toISOString());
    this.contentGate = options.content_gate ?? new SecretlintRecommendedContentGate();
  }

  async health(connection: SourceConnection): Promise<{ capabilities: string[]; details: Record<string, unknown> }> {
    const configuration = parseConfiguration(connection);
    const codexHome = await resolveDirectory(this.configuredCodexHome, "codex_home_unavailable");
    for (const scope of selectedScopes(configuration.source_root)) {
      await resolveScopeRoot(codexHome, scope);
    }
    this.resolvedHomes.set(connection.id, codexHome);
    return {
      capabilities: [...this.manifest.capabilities],
      details: {
        parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT,
        source_root: configuration.source_root,
        content_mode: configuration.content_mode,
      },
    };
  }

  async *open(connection: SourceConnection, request: ConnectorOpenRequest): AsyncIterable<CaptureBatch> {
    if (request.delivery !== "pull") {
      throw new CaptureRuntimeError("Codex history supports pull delivery only", "unsupported_delivery", "connector", false);
    }
    if (!CodexHistoryOpenParametersSchema.safeParse(request.parameters).success) {
      throw new CaptureRuntimeError(
        "Codex history open parameters are incompatible",
        "codex_source_contract_incompatible",
        "connector",
        false,
        {},
      );
    }
    const configuration = parseConfiguration(connection);
    const codexHome = this.resolvedHomes.get(connection.id);
    if (!codexHome) {
      throw new CaptureRuntimeError(
        "Codex history capture opened before a successful health check",
        "codex_source_not_negotiated",
        "connector",
        false,
      );
    }
    const discovery = await discoverRollouts(codexHome, configuration);
    let logicalCursor = parseCursor(request.checkpoint.cursor);
    const discoveredSessionIds = new Set(discovery.map(file => file.session_id));
    for (const sessionId of Object.keys(logicalCursor.files)) {
      if (discoveredSessionIds.has(sessionId)) continue;
      throw new CaptureRuntimeError(
        "A tracked Codex session is missing from every selected source root",
        "codex_tracked_session_missing",
        "connector",
        false,
        { session_id: sessionId },
      );
    }
    let previousCursor = request.checkpoint.cursor;
    let checkpointRevision = request.checkpoint.revision;

    for (const file of discovery) {
      const prior = logicalCursor.files[file.session_id];
      const committedOffset = prior?.committed_offset ?? 0;
      const committedPrefixSha256 = prior?.committed_prefix_sha256 ?? EMPTY_SHA256;
      if (committedOffset > file.observed_size) {
        throw new CaptureRuntimeError(
          "Codex rollout is shorter than its committed prefix",
          "codex_append_history_rewritten",
          "connector",
          false,
          { session_id: file.session_id, committed_offset: committedOffset, observed_size: file.observed_size },
        );
      }
      const handle = await openCodexRollout(file.absolute_path);
      try {
        const before = await assertDiscoveredRolloutIdentity(handle, file);
        const verified = await verifyCommittedPrefix({
          handle,
          committed_offset: committedOffset,
          expected_sha256: committedPrefixSha256,
          expected_session_id: file.session_id,
          configuration,
        });
        const prefixHash = verified.hash;
        let turnId = verified.turn_id;
        const historyThreadIds = new Set(verified.history_thread_ids);
        let batchFromOffset = committedOffset;
        let batchHash = createHash("sha256");
        let batchBytes = 0;
        let records: CodexSafeRecord[] = [];
        let exclusions = emptyCodexExcludedRecordCounts();
        let checkpointableThroughOffset = committedOffset;
        let checkpointablePrefixSha256 = committedPrefixSha256;
        let checkpointableExclusions = emptyCodexExcludedRecordCounts();
        let lastCompleteThroughOffset = committedOffset;

        for await (const line of readCompleteRolloutLines({
          handle,
          start: committedOffset,
          end: file.observed_size,
          max_record_bytes: configuration.max_record_bytes,
        })) {
          prefixHash.update(line.bytes).update("\n");
          batchHash.update(line.bytes).update("\n");
          lastCompleteThroughOffset = line.through_offset;
          batchBytes += line.byte_length + 1;
          const outcome = await parseAndGateCodexRolloutLine({
            line,
            expected_session_id: file.session_id,
            ...(turnId ? { current_turn_id: turnId } : {}),
            allowed_history_thread_ids: historyThreadIds,
            gate: this.contentGate,
          });
          if (outcome.turn_id !== undefined) turnId = outcome.turn_id;
          if (outcome.history_parent_id !== undefined) historyThreadIds.add(outcome.history_parent_id);
          if (outcome.record) records.push(outcome.record);
          applyExclusions(exclusions, outcome.exclusions);
          if (records.length > 0) {
            checkpointableThroughOffset = line.through_offset;
            checkpointablePrefixSha256 = prefixHash.copy().digest("hex");
            checkpointableExclusions = { ...exclusions };
          }
          const shouldFlush = records.length >= CODEX_MAX_BATCH_RECORDS
            || (records.length > 0 && batchBytes >= configuration.max_record_bytes);
          if (!shouldFlush) continue;
          await assertBatchSnapshotCompatible({
            handle,
            before,
            file,
            from_offset: batchFromOffset,
            through_offset: line.through_offset,
            expected_sha256: batchHash.copy().digest("hex"),
          });
          const transition = createTransition({
            connection,
            configuration,
            file,
            records,
            exclusions,
            from_offset: batchFromOffset,
            through_offset: line.through_offset,
            prefix_sha256: prefixHash.copy().digest("hex"),
            logical_cursor: logicalCursor,
            previous_cursor: previousCursor,
            checkpoint_revision: checkpointRevision,
            created_at: this.now(),
          });
          yield transition.batch;
          logicalCursor = transition.next_cursor;
          previousCursor = transition.next_cursor;
          checkpointRevision += 1;
          batchFromOffset = line.through_offset;
          batchHash = createHash("sha256");
          batchBytes = 0;
          records = [];
          exclusions = emptyCodexExcludedRecordCounts();
          checkpointableThroughOffset = line.through_offset;
          checkpointablePrefixSha256 = prefixHash.copy().digest("hex");
          checkpointableExclusions = emptyCodexExcludedRecordCounts();
        }
        if (records.length > 0) {
          await assertBatchSnapshotCompatible({
            handle,
            before,
            file,
            from_offset: batchFromOffset,
            through_offset: checkpointableThroughOffset,
            expected_sha256: batchHash.copy().digest("hex"),
          });
          const transition = createTransition({
            connection,
            configuration,
            file,
            records,
            exclusions: checkpointableExclusions,
            from_offset: batchFromOffset,
            through_offset: checkpointableThroughOffset,
            prefix_sha256: checkpointablePrefixSha256,
            logical_cursor: logicalCursor,
            previous_cursor: previousCursor,
            checkpoint_revision: checkpointRevision,
            created_at: this.now(),
          });
          yield transition.batch;
          logicalCursor = transition.next_cursor;
          previousCursor = transition.next_cursor;
          checkpointRevision += 1;
        } else if (lastCompleteThroughOffset > batchFromOffset) {
          throw new CaptureRuntimeError(
            "Codex excluded-only suffix cannot advance without canonical checkpoint-only Capture support",
            "codex_checkpoint_only_transition_unsupported",
            "connector",
            false,
            {
              session_id: file.session_id,
              from_offset: batchFromOffset,
              through_offset: lastCompleteThroughOffset,
            },
          );
        }
        await assertFileSnapshotCompatible(handle, before, file);
      } catch (error) {
        if (error instanceof CaptureRuntimeError) throw error;
        throw new CaptureRuntimeError(
          "Codex rollout read failed",
          "codex_source_read_failed",
          "connector",
          true,
          { session_id: file.session_id },
        );
      } finally {
        await handle.close();
      }
    }
  }
}

export function codexHistorySourceConnection(input: {
  id?: string;
  display_name?: string;
  source_root?: CodexHistoryConfiguration["source_root"];
  content_mode?: CodexHistoryConfiguration["content_mode"];
  max_record_bytes?: number;
  max_files?: number;
  privacy?: SourceConnection["privacy"];
} = {}): SourceConnection {
  return CODEX_HISTORY_CONNECTOR_KIT.createConnection({
    id: input.id ?? "codex-history:local",
    display_name: input.display_name ?? "Local Codex history",
    delivery_kinds: ["pull"],
    secret_refs: {},
    configuration: {
      source_root: input.source_root ?? "both",
      content_mode: input.content_mode ?? "messages",
      max_record_bytes: input.max_record_bytes ?? 1_000_000,
      max_files: input.max_files ?? 20_000,
      secret_policy: CODEX_SECRET_POLICY,
    },
    privacy: input.privacy ?? {
      owner: "user:local",
      visibility: "private",
      privacy: "sensitive",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      allow_local_search: true,
      labels: ["codex-history"],
    },
  });
}

export async function configureCodexHistoryCapture(input: {
  runtime: ConnectorRuntime;
  connector?: CodexHistoryCaptureConnector;
  connection?: SourceConnection;
}): Promise<{ connector: CodexHistoryCaptureConnector; connection: SourceConnection }> {
  const connector = input.connector ?? new CodexHistoryCaptureConnector();
  const connection = input.connection ?? codexHistorySourceConnection();
  input.runtime.registerConnector(connector);
  await input.runtime.registerConnection(connection);
  return { connector, connection };
}

async function discoverRollouts(codexHome: string, configuration: CodexHistoryConfiguration): Promise<DiscoveredRollout[]> {
  const discovered: DiscoveredRollout[] = [];
  for (const scope of selectedScopes(configuration.source_root)) {
    const scopeRoot = await resolveScopeRoot(codexHome, scope);
    let paths: string[];
    try {
      paths = scope === "sessions"
        ? await walkSessionRollouts(scopeRoot.path)
        : await walkArchiveRollouts(scopeRoot.path);
    } catch (error) {
      if (error instanceof CaptureRuntimeError) throw error;
      throw new CaptureRuntimeError(
        "Codex rollout discovery failed",
        "codex_source_discovery_failed",
        "connector",
        true,
        { scope },
      );
    }
    for (const absolutePath of paths) {
      if (discovered.length >= configuration.max_files) {
        throw new CaptureRuntimeError(
          "Codex rollout discovery exceeded max_files",
          "codex_source_file_limit_exceeded",
          "connector",
          false,
          { max_files: configuration.max_files },
        );
      }
      const relativePath = toSafeRelativePath(scopeRoot.path, absolutePath);
      const handle = await openCodexRollout(absolutePath);
      try {
        const observed = await assertCanonicalRolloutIdentity({
          handle,
          absolute_path: absolutePath,
          scope_root: scopeRoot,
          scope,
        });
        if (!observed.isFile()) continue;
        const header = await inspectFirstSessionMetadata({ handle, observed_size: observed.size, configuration });
        assertFileStatsEqual(
          observed,
          await assertCanonicalRolloutIdentity({
            handle,
            absolute_path: absolutePath,
            scope_root: scopeRoot,
            scope,
          }),
          header?.session_id,
        );
        if (!header) continue;
        discovered.push({
          absolute_path: absolutePath,
          scope_root: scopeRoot.path,
          scope_root_dev: scopeRoot.dev,
          scope_root_ino: scopeRoot.ino,
          scope,
          relative_path: relativePath,
          session_id: header.session_id,
          observed_dev: observed.dev,
          observed_ino: observed.ino,
          observed_size: observed.size,
          observed_mtime_ms: observed.mtimeMs,
          observed_ctime_ms: observed.ctimeMs,
        });
      } finally {
        await handle.close();
      }
    }
  }
  discovered.sort((left, right) => left.session_id.localeCompare(right.session_id));
  for (let index = 1; index < discovered.length; index += 1) {
    if (discovered[index - 1]!.session_id === discovered[index]!.session_id) {
      throw new CaptureRuntimeError(
        "Multiple Codex rollout files claim the same session identity",
        "codex_source_contract_incompatible",
        "connector",
        false,
        { session_id: discovered[index]!.session_id },
      );
    }
  }
  return discovered;
}

async function walkSessionRollouts(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw sourceSymlinkForbidden();
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) results.push(path);
    }
  }
  await walk(root);
  return results;
}

async function walkArchiveRollouts(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) throw sourceSymlinkForbidden();
  return entries
    .filter(entry => entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => join(root, entry.name));
}

function createTransition(input: {
  connection: SourceConnection;
  configuration: CodexHistoryConfiguration;
  file: DiscoveredRollout;
  records: CodexSafeRecord[];
  exclusions: ReturnType<typeof emptyCodexExcludedRecordCounts>;
  from_offset: number;
  through_offset: number;
  prefix_sha256: string;
  logical_cursor: CodexHistoryCursor;
  previous_cursor: NonNullable<CaptureBatch["checkpoint"]>["previous"];
  checkpoint_revision: number;
  created_at: string;
}): { batch: CaptureBatch; next_cursor: CodexHistoryCursor } {
  const payload: CodexHistorySourcePayload = CodexHistorySourcePayloadSchema.parse({
    version: 1,
    parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT,
    scope: input.file.scope,
    relative_path: input.file.relative_path,
    session_id: input.file.session_id,
    from_offset: input.from_offset,
    through_offset: input.through_offset,
    committed_prefix_sha256: input.prefix_sha256,
    observed_file_size: input.file.observed_size,
    observed_mtime_ms: input.file.observed_mtime_ms,
    records: input.records,
    excluded_record_counts: input.exclusions,
  });
  const nextFiles = {
    ...input.logical_cursor.files,
    [input.file.session_id]: {
      scope: input.file.scope,
      relative_path: input.file.relative_path,
      session_id: input.file.session_id,
      committed_offset: input.through_offset,
      committed_prefix_sha256: input.prefix_sha256,
      observed_size: input.file.observed_size,
    },
  };
  const nextCursor = CodexHistoryCursorSchema.parse({
    ...input.logical_cursor,
    discovery_manifest_sha256: cursorManifestDigest(nextFiles),
    files: nextFiles,
  });
  const fingerprint = digest({
    connection_id: input.connection.id,
    session_id: input.file.session_id,
    from_offset: input.from_offset,
    through_offset: input.through_offset,
    committed_prefix_sha256: input.prefix_sha256,
  });
  return {
    batch: CODEX_HISTORY_CONNECTOR_KIT.createBatch({
      connection: input.connection,
      payload,
      id: `codex-history-batch:${fingerprint}`,
      idempotency_key: `codex-history-delivery:${fingerprint}`,
      delivery: "pull",
      sequence: input.checkpoint_revision + 1,
      created_at: input.created_at,
      captured_at: input.created_at,
      checkpoint: {
        expected_revision: input.checkpoint_revision,
        previous: input.previous_cursor,
        next: nextCursor,
      },
      metadata: {
        parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT,
        secret_policy: CODEX_SECRET_POLICY,
        session_id: input.file.session_id,
        from_offset: input.from_offset,
        through_offset: input.through_offset,
        committed_prefix_sha256: input.prefix_sha256,
        excluded_record_counts: input.exclusions,
      },
    }),
    next_cursor: nextCursor,
  };
}

function parseConfiguration(connection: SourceConnection): CodexHistoryConfiguration {
  if (connection.connector_id !== CODEX_HISTORY_CONNECTOR_KIT.manifest.id
    || connection.connector_version !== CODEX_HISTORY_CONNECTOR_KIT.manifest.version) {
    throw new CaptureRuntimeError(
      "Source connection does not belong to the Codex history connector",
      "connection_connector_mismatch",
      "connector",
      false,
      { connection_id: connection.id },
    );
  }
  const parsed = CodexHistoryConfigurationSchema.safeParse(connection.configuration);
  if (!parsed.success) {
    throw new CaptureRuntimeError(
      "Codex history connection configuration is incompatible",
      "codex_source_contract_incompatible",
      "connector",
      false,
      { issue_count: parsed.error.issues.length },
    );
  }
  return parsed.data;
}

function parseCursor(value: Record<string, unknown>): CodexHistoryCursor {
  if (Object.keys(value).length === 0) {
    return CodexHistoryCursorSchema.parse({
      version: 1,
      parser_contract: CODEX_ROLLOUT_PARSER_CONTRACT,
      discovery_manifest_sha256: cursorManifestDigest({}),
      files: {},
    });
  }
  const parsed = CodexHistoryCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new CaptureRuntimeError(
      "Codex history checkpoint is incompatible with the parser contract",
      "codex_checkpoint_incompatible",
      "connector",
      false,
      { issue_count: parsed.error.issues.length },
    );
  }
  const expectedManifest = cursorManifestDigest(parsed.data.files);
  if (parsed.data.discovery_manifest_sha256 !== expectedManifest) {
    throw new CaptureRuntimeError(
      "Codex history checkpoint manifest digest is inconsistent",
      "codex_checkpoint_incompatible",
      "connector",
      false,
      {},
    );
  }
  return parsed.data;
}

function cursorManifestDigest(files: CodexHistoryCursor["files"]): string {
  return digest(Object.entries(files)
    .map(([key, file]) => ({
      key,
      session_id: file.session_id,
      scope: file.scope,
      relative_path: file.relative_path,
      committed_offset: file.committed_offset,
      committed_prefix_sha256: file.committed_prefix_sha256,
      observed_size: file.observed_size,
    }))
    .sort((left, right) => left.key.localeCompare(right.key)));
}

function selectedScopes(sourceRoot: CodexHistoryConfiguration["source_root"]): Array<"sessions" | "archived_sessions"> {
  if (sourceRoot === "both") return ["sessions", "archived_sessions"];
  return [sourceRoot];
}

async function resolveDirectory(path: string, code: string): Promise<string> {
  try {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) throw new TypeError("not a directory");
    return resolved;
  } catch {
    throw new CaptureRuntimeError("Required Codex source directory is unavailable", code, "connector", false, {});
  }
}

async function resolveScopeRoot(
  codexHome: string,
  scope: "sessions" | "archived_sessions",
): Promise<ResolvedScopeRoot> {
  const path = join(codexHome, scope);
  let resolved: string;
  let observed: Stats;
  try {
    resolved = await realpath(path);
    observed = await lstat(path);
  } catch {
    throw new CaptureRuntimeError(
      "Required Codex source directory is unavailable",
      "codex_source_root_unavailable",
      "connector",
      false,
      { scope },
    );
  }
  if (resolved !== path || observed.isSymbolicLink()) throw sourceSymlinkForbidden(scope);
  if (!observed.isDirectory()) {
    throw new CaptureRuntimeError(
      "Required Codex source directory is unavailable",
      "codex_source_root_unavailable",
      "connector",
      false,
      { scope },
    );
  }
  return { path, dev: observed.dev, ino: observed.ino };
}

function toSafeRelativePath(root: string, path: string): string {
  const platformRelative = relative(root, path);
  if (platformRelative.startsWith(`..${sep}`) || platformRelative === ".." || isAbsolute(platformRelative)) {
    throw new CaptureRuntimeError("Codex rollout escaped its selected source root", "codex_source_path_invalid", "connector", false);
  }
  const normalized = platformRelative.split(sep).join(posix.sep);
  return normalized;
}

function candidateKey(connectionId: string, sessionId: string, byteOffset: number): string {
  return `codex-history-candidate:${digest({ connection_id: connectionId, session_id: sessionId, byte_offset: byteOffset })}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

async function assertFileSnapshotCompatible(
  handle: FileHandle,
  before: Stats,
  file: DiscoveredRollout,
): Promise<void> {
  const after = await assertDiscoveredRolloutIdentity(handle, file);
  assertFileStatsEqual(before, after, file.session_id);
}

async function assertBatchSnapshotCompatible(input: {
  handle: FileHandle;
  before: Stats;
  file: DiscoveredRollout;
  from_offset: number;
  through_offset: number;
  expected_sha256: string;
}): Promise<void> {
  await assertFileSnapshotCompatible(input.handle, input.before, input.file);
  const actualSha256 = await hashFileRange(input.handle, input.from_offset, input.through_offset);
  if (actualSha256 !== input.expected_sha256) throw sourceChangedDuringRead(input.file.session_id);
  await assertFileSnapshotCompatible(input.handle, input.before, input.file);
}

async function hashFileRange(handle: FileHandle, start: number, end: number): Promise<string> {
  const hash = createHash("sha256");
  let position = start;
  while (position < end) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw sourceChangedDuringRead();
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function assertDiscoveredRolloutIdentity(handle: FileHandle, file: DiscoveredRollout): Promise<Stats> {
  const observed = await assertCanonicalRolloutIdentity({
    handle,
    absolute_path: file.absolute_path,
    scope_root: {
      path: file.scope_root,
      dev: file.scope_root_dev,
      ino: file.scope_root_ino,
    },
    scope: file.scope,
    session_id: file.session_id,
  });
  if (observed.dev !== file.observed_dev
    || observed.ino !== file.observed_ino
    || observed.size !== file.observed_size
    || observed.mtimeMs !== file.observed_mtime_ms
    || observed.ctimeMs !== file.observed_ctime_ms) {
    throw sourceChangedDuringRead(file.session_id);
  }
  return observed;
}

async function assertCanonicalRolloutIdentity(input: {
  handle: FileHandle;
  absolute_path: string;
  scope_root: ResolvedScopeRoot;
  scope: "sessions" | "archived_sessions";
  session_id?: string;
}): Promise<Stats> {
  let currentScope: Stats;
  let resolvedScope: string;
  let resolvedFile: string;
  let named: Stats;
  let opened: Stats;
  try {
    [currentScope, resolvedScope, resolvedFile, named, opened] = await Promise.all([
      lstat(input.scope_root.path),
      realpath(input.scope_root.path),
      realpath(input.absolute_path),
      lstat(input.absolute_path),
      input.handle.stat(),
    ]);
  } catch {
    throw sourceChangedDuringRead(input.session_id);
  }
  if (currentScope.isSymbolicLink()
    || named.isSymbolicLink()
    || resolvedScope !== input.scope_root.path
    || resolvedFile !== input.absolute_path) {
    throw sourceSymlinkForbidden(input.scope);
  }
  if (currentScope.dev !== input.scope_root.dev || currentScope.ino !== input.scope_root.ino) {
    throw sourceChangedDuringRead(input.session_id);
  }
  toSafeRelativePath(input.scope_root.path, resolvedFile);
  if (!named.isFile() || !opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
    throw sourceChangedDuringRead(input.session_id);
  }
  return opened;
}

function assertFileStatsEqual(
  before: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
  after: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
  sessionId?: string,
): void {
  if (before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs) return;
  throw sourceChangedDuringRead(sessionId);
}

function sourceChangedDuringRead(sessionId?: string): CaptureRuntimeError {
  return new CaptureRuntimeError(
    "Codex rollout changed while it was being read",
    "codex_source_changed_during_read",
    "connector",
    true,
    sessionId ? { session_id: sessionId } : {},
  );
}

function sourceSymlinkForbidden(
  scope?: "sessions" | "archived_sessions",
): CaptureRuntimeError {
  return new CaptureRuntimeError(
    "Symbolic links are forbidden in selected Codex rollout roots",
    "codex_source_symlink_forbidden",
    "connector",
    false,
    scope ? { scope } : {},
  );
}

import { z } from "zod";
import {
  CaptureRuntimeError,
  type CaptureBatch,
  type ConnectorContext,
  type ConnectorOpenRequest,
  type ConnectorPort,
  type ConnectorRuntime,
  type SourceConnection,
} from "@info/capture";
import {
  OBSIDIAN_MAX_DOCUMENTS,
  ObsidianConfigurationSchema,
  type ObsidianConfiguration,
} from "./contracts.js";
import {
  discoverMarkdownFiles,
  readSafeMarkdownFile,
  resolveVaultRoot,
  type ObsidianFileReadHooks,
  type ObsidianReadFile,
  type ObsidianRootIdentity,
} from "./filesystem.js";
import { parseObsidianCursor, planObsidianOperations } from "./identity.js";
import { OBSIDIAN_CONNECTOR_KIT } from "./kit.js";
import { SecretlintObsidianSecretGate, type ObsidianSecretGate } from "./secret-gate.js";
import { ParcelObsidianWatcherAccelerator, type ObsidianWatcherAccelerator } from "./watcher.js";

const OpenParametersSchema = z.object({}).strict();

export type ObsidianCaptureAdapterOptions = {
  now?: () => string;
  secret_gate?: ObsidianSecretGate;
  watcher?: ObsidianWatcherAccelerator;
  file_read_hooks?: ObsidianFileReadHooks;
};

export class ObsidianCaptureAdapter implements ConnectorPort {
  readonly manifest = OBSIDIAN_CONNECTOR_KIT.manifest;
  private readonly roots = new Map<string, ObsidianRootIdentity>();
  private readonly now: () => string;
  private readonly secretGate: ObsidianSecretGate;
  private readonly watcher: ObsidianWatcherAccelerator;
  private readonly fileReadHooks?: ObsidianFileReadHooks;

  constructor(options: ObsidianCaptureAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.secretGate = options.secret_gate ?? new SecretlintObsidianSecretGate();
    this.watcher = options.watcher ?? new ParcelObsidianWatcherAccelerator();
    this.fileReadHooks = options.file_read_hooks;
  }

  async health(connection: SourceConnection, _context: ConnectorContext): Promise<{ capabilities: string[]; details: Record<string, string> }> {
    const configuration = parseConfiguration(connection);
    const root = await resolveVaultRoot(configuration);
    const prior = this.roots.get(connection.id);
    if (prior && (prior.real_path !== root.real_path || prior.device !== root.device || prior.resource_id !== root.resource_id)) {
      throw new CaptureRuntimeError(
        "Obsidian vault root identity changed after negotiation",
        "obsidian_root_identity_changed",
        "connector",
        false,
        { expected_resource_id: prior.resource_id, actual_resource_id: root.resource_id },
      );
    }
    this.roots.set(connection.id, root);
    return {
      capabilities: this.manifest.capabilities,
      details: { root_device: root.device, root_resource_id: root.resource_id },
    };
  }

  async *open(
    connection: SourceConnection,
    request: ConnectorOpenRequest,
    _context: ConnectorContext,
  ): AsyncIterable<CaptureBatch> {
    if (request.delivery !== "pull") {
      throw new CaptureRuntimeError("Obsidian capture supports pull delivery only", "unsupported_delivery", "connector", false);
    }
    const parameters = OpenParametersSchema.safeParse(request.parameters);
    if (!parameters.success) {
      throw new CaptureRuntimeError("Obsidian pull parameters are incompatible", "obsidian_open_parameters_invalid", "connector", false, { issue_count: parameters.error.issues.length });
    }
    const configuration = parseConfiguration(connection);
    const root = this.roots.get(connection.id);
    if (!root) {
      throw new CaptureRuntimeError("Obsidian capture opened before successful root negotiation", "obsidian_root_not_negotiated", "connector", false);
    }
    const cursor = parseObsidianCursor(request.checkpoint.cursor, configuration.vault_id, root);
    const watcherState = await this.watcher.load({ root, connection_id: connection.id });
    const discovered = await discoverMarkdownFiles(root, OBSIDIAN_MAX_DOCUMENTS);
    const changed = new Set(watcherState.changed_paths);
    discovered.sort((left, right) => {
      const priority = Number(changed.has(right.relative_path)) - Number(changed.has(left.relative_path));
      return priority || left.relative_path.localeCompare(right.relative_path, "en");
    });
    const files: ObsidianReadFile[] = [];
    for (const file of discovered) {
      files.push(await readSafeMarkdownFile({
        root,
        connection_id: connection.id,
        file,
        max_file_bytes: configuration.max_file_bytes,
        secret_gate: this.secretGate,
        hooks: this.fileReadHooks,
      }));
    }
    files.sort((left, right) => left.relative_path.localeCompare(right.relative_path, "en"));

    const missingPaths = new Set(Object.values(cursor.documents).map(entry => entry.current_relative_path));
    for (const file of files) missingPaths.delete(file.relative_path);
    if (missingPaths.size > 0) await confirmDeletions(root, missingPaths);

    const capturedAt = this.now();
    const operations = planObsidianOperations({
      connection_id: connection.id,
      vault_id: configuration.vault_id,
      previous: cursor,
      files,
      observed_at: capturedAt,
      watcher_snapshot: watcherState.reference,
    });
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const revision = request.checkpoint.revision + index;
      const operationDigest = operation.next_cursor.logical_manifest_sha256;
      yield OBSIDIAN_CONNECTOR_KIT.createBatch({
        connection,
        payload: operation.payload,
        id: `obsidian-batch:${operation.payload.document_id}:${revision + 1}`,
        idempotency_key: `obsidian-delivery:${operation.payload.document_id}:${operationDigest}:${operation.payload.operation}:${operation.payload.relative_path}`,
        delivery: "pull",
        sequence: revision + 1,
        created_at: capturedAt,
        captured_at: capturedAt,
        checkpoint: {
          expected_revision: revision,
          previous: index === 0 ? request.checkpoint.cursor : operation.previous_cursor,
          next: operation.next_cursor,
        },
        metadata: {
          operation: operation.payload.operation,
          logical_manifest_sha256: operation.next_cursor.logical_manifest_sha256,
          discovery: watcherState.recovered ? "full_rescan_after_watcher_recovery" : "watcher_prioritized_full_rescan",
        },
      });
    }
    if (operations.length > 0) {
      try {
        await this.watcher.write({
          root,
          connection_id: connection.id,
          checkpoint_revision: request.checkpoint.revision + operations.length,
        });
      } catch (error) {
        throw new CaptureRuntimeError(
          "Obsidian watcher snapshot failed after Capture commit",
          "obsidian_watcher_snapshot_write_failed",
          "connector",
          true,
          { committed_checkpoint_revision: request.checkpoint.revision + operations.length },
          { cause: error },
        );
      }
    }
  }
}

export async function configureObsidianCapture(input: {
  runtime: ConnectorRuntime;
  connection: SourceConnection;
  connector?: ObsidianCaptureAdapter;
}): Promise<ObsidianCaptureAdapter> {
  const connector = input.connector ?? new ObsidianCaptureAdapter();
  input.runtime.registerConnector(connector);
  await input.runtime.registerConnection(input.connection);
  return connector;
}

async function confirmDeletions(root: ObsidianRootIdentity, missingPaths: Set<string>): Promise<void> {
  const confirmation = await discoverMarkdownFiles(root, OBSIDIAN_MAX_DOCUMENTS);
  const confirmedPaths = new Set(confirmation.map(file => file.relative_path));
  for (const path of missingPaths) {
    if (confirmedPaths.has(path)) {
      throw new CaptureRuntimeError(
        "Obsidian deletion changed during confirmation rescan",
        "obsidian_deletion_not_confirmed",
        "connector",
        true,
        { relative_path: path },
      );
    }
  }
}

function parseConfiguration(connection: SourceConnection): ObsidianConfiguration {
  if (connection.connector_id !== OBSIDIAN_CONNECTOR_KIT.manifest.id || connection.connector_version !== OBSIDIAN_CONNECTOR_KIT.manifest.version) {
    throw new CaptureRuntimeError("Obsidian connection ownership is incompatible", "connector_mismatch", "connector", false);
  }
  const parsed = ObsidianConfigurationSchema.safeParse(connection.configuration);
  if (!parsed.success) {
    throw new CaptureRuntimeError("Obsidian connection configuration is incompatible", "obsidian_configuration_invalid", "connector", false, { issue_count: parsed.error.issues.length });
  }
  return parsed.data;
}

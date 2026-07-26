import { createHash } from "node:crypto";
import { CaptureRuntimeError } from "@info/capture";
import { canonicalJson, type JsonObject } from "@info/view";
import {
  OBSIDIAN_MAX_DOCUMENTS,
  OBSIDIAN_MAX_PRIOR_PATHS,
  OBSIDIAN_PARSER_CONTRACT,
  ObsidianCursorSchema,
  type ObsidianCursor,
  type ObsidianIdentityEntry,
  type ObsidianSourcePayload,
} from "./contracts.js";
import type { ObsidianReadFile } from "./filesystem.js";

export type ObsidianPlannedOperation = {
  payload: ObsidianSourcePayload;
  previous_cursor: ObsidianCursor;
  next_cursor: ObsidianCursor;
};

export function parseObsidianCursor(
  input: JsonObject,
  vaultId: string,
  root: { device: string; resource_id: string },
): ObsidianCursor {
  if (Object.keys(input).length === 0) {
    return cursorFromDocuments(vaultId, {}, null, { root_device: root.device, root_resource_id: root.resource_id }, {});
  }
  const parsed = ObsidianCursorSchema.safeParse(input);
  if (!parsed.success || parsed.data.vault_id !== vaultId
    || parsed.data.root_device !== root.device || parsed.data.root_resource_id !== root.resource_id
    || parsed.data.logical_manifest_sha256 !== logicalManifestDigest(
      parsed.data.root_device,
      parsed.data.root_resource_id,
      parsed.data.documents,
      parsed.data.retired_paths,
    )) {
    throw new CaptureRuntimeError(
      "Obsidian checkpoint is incompatible with this vault contract",
      "obsidian_checkpoint_incompatible",
      "connector",
      false,
      { issue_count: parsed.success ? 1 : parsed.error.issues.length },
    );
  }
  return parsed.data;
}

export function planObsidianOperations(input: {
  connection_id: string;
  vault_id: string;
  previous: ObsidianCursor;
  files: ObsidianReadFile[];
  observed_at: string;
  watcher_snapshot: ObsidianCursor["watcher_snapshot"];
}): ObsidianPlannedOperation[] {
  if (input.files.length > OBSIDIAN_MAX_DOCUMENTS) {
    throw identityError("Obsidian logical manifest exceeds its bounded document limit", "obsidian_manifest_limit_exceeded", { max_documents: OBSIDIAN_MAX_DOCUMENTS });
  }
  assertUniqueCurrentFiles(input.files);
  const identityPathOwners = identityPathOwnersFromCursor(input.previous);
  const previousByPath = new Map(Object.values(input.previous.documents).map(entry => [entry.current_relative_path, entry]));
  const assignments = new Map<string, ObsidianIdentityEntry>();
  const unmatchedPrevious = new Map(Object.entries(input.previous.documents));

  matchOneToOneEvidence(
    unmatchedPrevious,
    input.files,
    entry => entry.file_resource_id,
    file => file.file_resource_id,
    assignments,
  );
  matchOneToOneEvidence(
    unmatchedPrevious,
    input.files,
    entry => entry.last_sha256,
    file => file.sha256,
    assignments,
  );

  const pathCandidates = input.files.filter(file => !assignments.has(file.relative_path));
  for (const file of pathCandidates) {
    const existing = previousByPath.get(file.relative_path);
    if (!existing || !unmatchedPrevious.has(existing.document_id)) continue;
    assertPathEvidenceCompatible(file, existing, unmatchedPrevious, pathCandidates);
  }
  for (const file of pathCandidates) {
    const existing = previousByPath.get(file.relative_path);
    if (!existing || !unmatchedPrevious.has(existing.document_id)) continue;
    unmatchedPrevious.delete(existing.document_id);
    assignments.set(file.relative_path, entryFromFile(file, existing.document_id, existing.prior_paths));
  }

  const remainingFiles = input.files.filter(file => !assignments.has(file.relative_path));
  assertNoAmbiguousEvidence(unmatchedPrevious, remainingFiles);
  if (remainingFiles.length > 0 && unmatchedPrevious.size > 0) {
    throw identityError(
      "Obsidian delete/create set cannot be proven as independent or as a rename",
      "obsidian_identity_unresolved",
      { deleted_count: unmatchedPrevious.size, created_count: remainingFiles.length },
    );
  }
  for (const file of remainingFiles) {
    const documentId = `obsidian-doc:${digest([input.connection_id, input.vault_id, file.relative_path])}`;
    if (identityPathOwners.has(file.relative_path) || input.previous.documents[documentId]) {
      throw identityError(
        "Obsidian path reappeared after deletion or after its deterministic identity moved elsewhere",
        "obsidian_retired_path_reappeared",
        { relative_path: file.relative_path },
      );
    }
    assignments.set(file.relative_path, entryFromFile(file, documentId, []));
  }

  for (const file of input.files) {
    if (input.previous.retired_paths[file.relative_path]) {
      throw identityError(
        "Obsidian retired source path cannot be admitted without explicit reconciliation",
        "obsidian_retired_path_reappeared",
        { relative_path: file.relative_path },
      );
    }
    const assigned = assignments.get(file.relative_path)!;
    const owner = identityPathOwners.get(file.relative_path);
    if (owner && owner !== assigned.document_id) {
      throw identityError(
        "Obsidian source path is already identity evidence for another document",
        "obsidian_identity_path_collision",
        { relative_path: file.relative_path },
      );
    }
  }

  const changes: Array<{ path: string; payload: ObsidianSourcePayload; entry?: ObsidianIdentityEntry; delete_entry?: ObsidianIdentityEntry }> = [];
  for (const file of input.files) {
    const assigned = assignments.get(file.relative_path)!;
    const prior = input.previous.documents[assigned.document_id];
    if (!prior || prior.last_sha256 !== file.sha256 || prior.current_relative_path !== file.relative_path
      || prior.file_resource_id !== file.file_resource_id) {
      changes.push({
        path: file.relative_path,
        entry: assigned,
        payload: {
          version: 1,
          operation: "upsert",
          vault_id: input.vault_id,
          document_id: assigned.document_id,
          relative_path: file.relative_path,
          observed_at: input.observed_at,
          revision: {
            sha256: file.sha256,
            byte_length: file.size,
            mtime_ms: file.mtime_ms,
            file_resource_id: file.file_resource_id,
          },
          encoding: "utf-8",
          markdown: file.markdown,
        },
      });
    }
  }
  for (const entry of unmatchedPrevious.values()) {
    changes.push({
      path: entry.current_relative_path,
      delete_entry: entry,
      payload: {
        version: 1,
        operation: "delete",
        vault_id: input.vault_id,
        document_id: entry.document_id,
        relative_path: entry.current_relative_path,
        observed_at: input.observed_at,
        prior_sha256: entry.last_sha256,
      },
    });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const operations: ObsidianPlannedOperation[] = [];
  let cursor = input.previous;
  for (const change of changes) {
    const documents = structuredClone(cursor.documents);
    const retiredPaths = structuredClone(cursor.retired_paths);
    if (change.delete_entry) {
      delete documents[change.delete_entry.document_id];
      retireIdentityPaths(retiredPaths, documents, change.delete_entry);
    }
    if (change.entry) documents[change.entry.document_id] = change.entry;
    const next = cursorFromDocuments(
      input.vault_id,
      documents,
      input.watcher_snapshot,
      { root_device: cursor.root_device, root_resource_id: cursor.root_resource_id },
      retiredPaths,
    );
    operations.push({ payload: change.payload, previous_cursor: cursor, next_cursor: next });
    cursor = next;
  }
  return operations;
}

export function cursorFromDocuments(
  vaultId: string,
  documents: Record<string, ObsidianIdentityEntry>,
  watcherSnapshot: ObsidianCursor["watcher_snapshot"],
  root: { root_device: string; root_resource_id: string },
  retiredPaths: Record<string, string>,
): ObsidianCursor {
  const sorted = Object.fromEntries(Object.entries(documents).sort(([left], [right]) => left.localeCompare(right, "en")));
  const sortedRetired = Object.fromEntries(Object.entries(retiredPaths).sort(([left], [right]) => left.localeCompare(right, "en")));
  return ObsidianCursorSchema.parse({
    version: 1,
    vault_id: vaultId,
    parser_contract: OBSIDIAN_PARSER_CONTRACT,
    ...root,
    logical_manifest_sha256: logicalManifestDigest(root.root_device, root.root_resource_id, sorted, sortedRetired),
    documents: sorted,
    retired_paths: sortedRetired,
    watcher_snapshot: watcherSnapshot,
  });
}

function matchOneToOneEvidence(
  previous: Map<string, ObsidianIdentityEntry>,
  files: ObsidianReadFile[],
  previousKey: (entry: ObsidianIdentityEntry) => string | undefined,
  fileKey: (file: ObsidianReadFile) => string | undefined,
  assignments: Map<string, ObsidianIdentityEntry>,
): void {
  const priorGroups = group([...previous.values()], previousKey);
  const fileGroups = group(files.filter(file => !assignments.has(file.relative_path)), fileKey);
  for (const [key, currentFiles] of fileGroups) {
    const priorEntries = priorGroups.get(key) ?? [];
    if (priorEntries.length === 0) continue;
    if (priorEntries.length !== 1 || currentFiles.length !== 1) continue;
    const prior = priorEntries[0]!;
    const file = currentFiles[0]!;
    previous.delete(prior.document_id);
    assignments.set(file.relative_path, entryFromFile(file, prior.document_id, [...prior.prior_paths, prior.current_relative_path]));
  }
}

function assertNoAmbiguousEvidence(previous: Map<string, ObsidianIdentityEntry>, files: ObsidianReadFile[]): void {
  assertEvidenceUnambiguous(previous, files, entry => entry.file_resource_id, file => file.file_resource_id, "resource_id");
  assertEvidenceUnambiguous(previous, files, entry => entry.last_sha256, file => file.sha256, "sha256");
}

function assertPathEvidenceCompatible(
  file: ObsidianReadFile,
  pathOwner: ObsidianIdentityEntry,
  previous: Map<string, ObsidianIdentityEntry>,
  files: ObsidianReadFile[],
): void {
  assertPathEvidenceKeyCompatible(file.file_resource_id, entry => entry.file_resource_id, file => file.file_resource_id, "resource_id");
  assertPathEvidenceKeyCompatible(file.sha256, entry => entry.last_sha256, file => file.sha256, "sha256");

  function assertPathEvidenceKeyCompatible(
    key: string | undefined,
    previousKey: (entry: ObsidianIdentityEntry) => string | undefined,
    fileKey: (candidate: ObsidianReadFile) => string | undefined,
    evidence: string,
  ): void {
    if (!key) return;
    const priorMatches = [...previous.values()].filter(entry => previousKey(entry) === key);
    if (!priorMatches.some(entry => entry.document_id !== pathOwner.document_id)) return;
    throw identityError(
      `Obsidian same-path ${evidence} conflicts with another document identity`,
      "obsidian_identity_ambiguous",
      {
        evidence,
        prior_count: priorMatches.length,
        current_count: files.filter(candidate => fileKey(candidate) === key).length,
      },
    );
  }
}

function assertEvidenceUnambiguous(
  previous: Map<string, ObsidianIdentityEntry>,
  files: ObsidianReadFile[],
  previousKey: (entry: ObsidianIdentityEntry) => string | undefined,
  fileKey: (file: ObsidianReadFile) => string | undefined,
  evidence: string,
): void {
  const priorGroups = group([...previous.values()], previousKey);
  const fileGroups = group(files, fileKey);
  for (const [key, currentFiles] of fileGroups) {
    const priorEntries = priorGroups.get(key) ?? [];
    if (priorEntries.length === 0) continue;
    throw identityError(
      `Obsidian rename ${evidence} has multiple possible matches`,
      "obsidian_identity_ambiguous",
      { evidence, prior_count: priorEntries.length, current_count: currentFiles.length },
    );
  }
}

function group<T>(values: T[], keyFor: (value: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    if (!key) continue;
    const groupValues = groups.get(key) ?? [];
    groupValues.push(value);
    groups.set(key, groupValues);
  }
  return groups;
}

function entryFromFile(file: ObsidianReadFile, documentId: string, priorPaths: string[]): ObsidianIdentityEntry {
  const retainedPriorPaths = [...new Set(priorPaths.filter(path => path !== file.relative_path))];
  if (retainedPriorPaths.length > OBSIDIAN_MAX_PRIOR_PATHS) {
    throw identityError(
      "Obsidian document identity history exceeds its bounded path limit",
      "obsidian_identity_history_limit_exceeded",
      { max_prior_paths: OBSIDIAN_MAX_PRIOR_PATHS, attempted_prior_paths: retainedPriorPaths.length },
    );
  }
  return {
    document_id: documentId,
    current_relative_path: file.relative_path,
    prior_paths: retainedPriorPaths,
    file_resource_id: file.file_resource_id,
    last_sha256: file.sha256,
    byte_length: file.size,
    mtime_ms: file.mtime_ms,
  };
}

function retireIdentityPaths(
  retiredPaths: Record<string, string>,
  activeDocuments: Record<string, ObsidianIdentityEntry>,
  deleted: ObsidianIdentityEntry,
): void {
  const activeOwners = identityPathOwnersFromDocuments(activeDocuments);
  for (const path of new Set([deleted.current_relative_path, ...deleted.prior_paths])) {
    const activeOwner = activeOwners.get(path);
    const retiredOwner = retiredPaths[path];
    if ((activeOwner && activeOwner !== deleted.document_id) || (retiredOwner && retiredOwner !== deleted.document_id)) {
      throw identityError(
        "Obsidian source path is already identity evidence for another document",
        "obsidian_identity_path_collision",
        { relative_path: path },
      );
    }
    retiredPaths[path] = deleted.document_id;
  }
}

function identityPathOwnersFromCursor(cursor: ObsidianCursor): Map<string, string> {
  const owners = identityPathOwnersFromDocuments(cursor.documents);
  for (const [path, documentId] of Object.entries(cursor.retired_paths)) {
    claimIdentityPath(owners, path, documentId);
  }
  return owners;
}

function identityPathOwnersFromDocuments(documents: Record<string, ObsidianIdentityEntry>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const entry of Object.values(documents)) {
    claimIdentityPath(owners, entry.current_relative_path, entry.document_id);
    for (const path of entry.prior_paths) claimIdentityPath(owners, path, entry.document_id);
  }
  return owners;
}

function claimIdentityPath(owners: Map<string, string>, path: string, documentId: string): void {
  const owner = owners.get(path);
  if (owner && owner !== documentId) {
    throw identityError(
      "Obsidian source path is claimed by multiple document identities",
      "obsidian_identity_path_collision",
      { relative_path: path },
    );
  }
  owners.set(path, documentId);
}

function assertUniqueCurrentFiles(files: ObsidianReadFile[]): void {
  const normalized = new Set<string>();
  for (const file of files) {
    const path = file.relative_path.normalize("NFC");
    if (normalized.has(path)) {
      throw identityError("Obsidian paths collide after Unicode normalization", "obsidian_path_ambiguous", { relative_path: path });
    }
    normalized.add(path);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function logicalManifestDigest(
  rootDevice: string,
  rootResourceId: string,
  documents: Record<string, ObsidianIdentityEntry>,
  retiredPaths: Record<string, string>,
): string {
  return digest({
    root_device: rootDevice,
    root_resource_id: rootResourceId,
    documents,
    retired_paths: retiredPaths,
  });
}

function identityError(message: string, code: string, details: JsonObject): CaptureRuntimeError {
  return new CaptureRuntimeError(message, code, "connector", false, details);
}

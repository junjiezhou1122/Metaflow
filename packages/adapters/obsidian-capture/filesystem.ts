import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { CaptureRuntimeError } from "@info/capture";
import type { ObsidianConfiguration } from "./contracts.js";
import { parseObsidianMarkdown, ObsidianParserError, type ParsedObsidianMarkdown } from "./parser.js";
import type { ObsidianSecretGate } from "./secret-gate.js";

export type ObsidianRootIdentity = {
  real_path: string;
  device: string;
  resource_id: string;
};

export type ObsidianDiscoveredFile = {
  relative_path: string;
  absolute_path: string;
  root_device: string;
  root_resource_id: string;
  discovered_device: string;
  discovered_inode: string;
  file_resource_id: string;
  size: number;
  mtime_ms: number;
};

export type ObsidianReadFile = ObsidianDiscoveredFile & {
  markdown: string;
  sha256: string;
  parsed: ParsedObsidianMarkdown;
};

export type ObsidianFileReadHooks = {
  beforeOpen?(input: { relative_path: string; absolute_path: string }): void | Promise<void>;
  afterRead?(input: { relative_path: string; absolute_path: string }): void | Promise<void>;
};

export async function resolveVaultRoot(configuration: ObsidianConfiguration): Promise<ObsidianRootIdentity> {
  if (!isAbsolute(configuration.vault_root)) {
    throw fileError("Obsidian vault root must be absolute", "obsidian_root_invalid", false);
  }
  let resolved: string;
  let rootStat: Stats;
  try {
    resolved = await realpath(configuration.vault_root);
    rootStat = await stat(resolved);
  } catch (error) {
    throw fileError("Obsidian vault root is unavailable", "obsidian_root_unavailable", true, {}, error);
  }
  if (!rootStat.isDirectory()) throw fileError("Obsidian vault root is not a directory", "obsidian_root_invalid", false);
  return { real_path: resolved, device: String(rootStat.dev), resource_id: `${rootStat.dev}:${rootStat.ino}` };
}

export async function discoverMarkdownFiles(root: ObsidianRootIdentity, maxFiles: number): Promise<ObsidianDiscoveredFile[]> {
  const results: ObsidianDiscoveredFile[] = [];
  await assertCurrentRootIdentity(root);
  await walk(root.real_path, "");
  await assertCurrentRootIdentity(root);
  return results.sort((left, right) => left.relative_path.localeCompare(right.relative_path, "en"));

  async function walk(directory: string, prefix: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw fileError("Obsidian directory discovery failed", "obsidian_discovery_failed", true, { relative_directory: prefix || "." }, error);
    }
    entries.sort((left, right) => left.name.normalize("NFC").localeCompare(right.name.normalize("NFC"), "en"));
    for (const entry of entries) {
      const relativePath = normalizeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (isUnavailablePlaceholder(entry.name)) {
        throw fileError("Obsidian Markdown file is an unavailable cloud placeholder", "obsidian_file_unavailable", true, { relative_path: relativePath });
      }
      if (isHardDenied(relativePath, entry)) continue;
      const absolutePath = resolve(root.real_path, ...relativePath.split("/"));
      assertContained(root.real_path, absolutePath, relativePath);
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink() || entry.isSymbolicLink()) {
        throw fileError("Obsidian source symlinks are forbidden", "obsidian_symlink_forbidden", false, { relative_path: relativePath });
      }
      if (entryStat.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entryStat.isFile() || !relativePath.toLowerCase().endsWith(".md")) continue;
      results.push({
        relative_path: relativePath,
        absolute_path: absolutePath,
        root_device: root.device,
        root_resource_id: root.resource_id,
        discovered_device: String(entryStat.dev),
        discovered_inode: String(entryStat.ino),
        file_resource_id: `${entryStat.dev}:${entryStat.ino}`,
        size: entryStat.size,
        mtime_ms: Math.trunc(entryStat.mtimeMs),
      });
      if (results.length > maxFiles) {
        throw fileError("Obsidian logical manifest exceeds its bounded document limit", "obsidian_manifest_limit_exceeded", false, { max_files: maxFiles });
      }
    }
  }
}

export async function readSafeMarkdownFile(input: {
  root: ObsidianRootIdentity;
  connection_id: string;
  file: ObsidianDiscoveredFile;
  max_file_bytes: number;
  secret_gate: ObsidianSecretGate;
  hooks?: ObsidianFileReadHooks;
}): Promise<ObsidianReadFile> {
  const { root, file } = input;
  assertContained(root.real_path, file.absolute_path, file.relative_path);
  assertDiscoveredRootIdentity(root, file);
  await assertCurrentRootIdentity(root);
  await assertNoSymlinkComponents(root.real_path, file.relative_path);
  if (file.size > input.max_file_bytes) {
    throw fileError("Obsidian Markdown file exceeds max_file_bytes", "obsidian_file_too_large", false, { relative_path: file.relative_path, byte_length: file.size });
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    await input.hooks?.beforeOpen?.({ relative_path: file.relative_path, absolute_path: file.absolute_path });
    handle = await open(file.absolute_path, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw fileError("Obsidian Markdown file could not be opened without following links", "obsidian_file_open_failed", true, { relative_path: file.relative_path }, error);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fileError("Obsidian source path is not a regular file", "obsidian_file_invalid", false, { relative_path: file.relative_path });
    if (String(before.dev) !== file.discovered_device || String(before.ino) !== file.discovered_inode) {
      throw fileError("Obsidian Markdown file identity changed after discovery", "obsidian_file_identity_changed", true, { relative_path: file.relative_path });
    }
    await assertCurrentRootIdentity(root);
    await assertPathNamesOpenedFile(root, file, before);
    if (before.size > input.max_file_bytes) {
      throw fileError("Obsidian Markdown file exceeds max_file_bytes", "obsidian_file_too_large", false, { relative_path: file.relative_path, byte_length: before.size });
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) throw fileError("Obsidian Markdown file ended before its declared size", "obsidian_file_changed_during_read", true, { relative_path: file.relative_path });
    await input.hooks?.afterRead?.({ relative_path: file.relative_path, absolute_path: file.absolute_path });
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after)) {
      throw fileError("Obsidian Markdown file changed during read", "obsidian_file_changed_during_read", true, { relative_path: file.relative_path });
    }
    await assertCurrentRootIdentity(root);
    await assertPathNamesOpenedFile(root, file, after);
    const markdown = decodeUtf8(bytes, file.relative_path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let parsed: ParsedObsidianMarkdown;
    try {
      parsed = parseObsidianMarkdown(markdown);
    } catch (error) {
      if (error instanceof ObsidianParserError) {
        throw fileError("Obsidian Markdown parser rejected the source contract", error.code, false, { relative_path: file.relative_path, content_sha256: sha256, ...error.details }, error);
      }
      throw error;
    }
    await input.secret_gate.assertSafe({
      connection_id: input.connection_id,
      relative_path: file.relative_path,
      markdown,
      content_sha256: sha256,
      frontmatter: parsed.frontmatter,
    });
    return {
      ...file,
      size: before.size,
      mtime_ms: Math.trunc(before.mtimeMs),
      markdown,
      sha256,
      parsed,
    };
  } finally {
    await handle.close();
  }
}

async function assertCurrentRootIdentity(root: ObsidianRootIdentity): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(root.real_path);
  } catch (error) {
    throw fileError("Obsidian vault root identity is unavailable", "obsidian_root_identity_changed", false, {}, error);
  }
  if (!current.isDirectory() || current.isSymbolicLink()
    || String(current.dev) !== root.device || `${current.dev}:${current.ino}` !== root.resource_id) {
    throw fileError("Obsidian vault root identity changed during capture", "obsidian_root_identity_changed", false);
  }
}

function assertDiscoveredRootIdentity(root: ObsidianRootIdentity, file: ObsidianDiscoveredFile): void {
  if (file.root_device !== root.device || file.root_resource_id !== root.resource_id) {
    throw fileError("Obsidian discovered file belongs to a different vault root identity", "obsidian_root_identity_changed", false, { relative_path: file.relative_path });
  }
}

async function assertPathNamesOpenedFile(root: ObsidianRootIdentity, file: ObsidianDiscoveredFile, opened: Stats): Promise<void> {
  let resolved: string;
  let pathStat: Stats;
  try {
    resolved = await realpath(file.absolute_path);
    pathStat = await stat(resolved);
  } catch (error) {
    throw fileError("Obsidian source path identity changed during capture", "obsidian_file_identity_changed", true, { relative_path: file.relative_path }, error);
  }
  assertContained(root.real_path, resolved, file.relative_path);
  if (!sameFileIdentity(opened, pathStat)) {
    throw fileError("Obsidian source path no longer names the opened file", "obsidian_file_identity_changed", true, { relative_path: file.relative_path });
  }
}

function decodeUtf8(bytes: Buffer, relativePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw fileError("Obsidian Markdown file is not valid UTF-8", "obsidian_invalid_utf8", false, { relative_path: relativePath, byte_length: bytes.length }, error);
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) {
      throw fileError("Obsidian source symlinks are forbidden", "obsidian_symlink_forbidden", false, { relative_path: relativePath });
    }
  }
}

function assertContained(root: string, candidate: string, relativePath: string): void {
  const relation = relative(root, candidate);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) return;
  throw fileError("Obsidian source path escapes the configured vault root", "obsidian_path_escape", false, { relative_path: relativePath });
}

function normalizeRelative(value: string): string {
  const normalized = value.split(sep).join("/").normalize("NFC");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw fileError("Obsidian source path is not a normalized relative path", "obsidian_path_invalid", false);
  }
  return normalized;
}

function isHardDenied(relativePath: string, entry: Dirent): boolean {
  if (entry.isSymbolicLink()) return false;
  const parts = relativePath.split("/");
  if (parts.some(part => part.startsWith("."))) return true;
  if (entry.isDirectory()) return false;
  const lower = entry.name.toLowerCase();
  if (!lower.endsWith(".md")) return true;
  return lower.endsWith(".tmp.md")
    || lower.endsWith(".conflict.md")
    || lower.includes("conflicted copy")
    || lower.startsWith("~")
    || lower.endsWith("~");
}

function isUnavailablePlaceholder(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(".") && lower.endsWith(".icloud") && lower.includes(".md");
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && Math.trunc(left.mtimeMs) === Math.trunc(right.mtimeMs);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileError(
  message: string,
  code: string,
  retryable: boolean,
  details: Record<string, string | number> = {},
  cause?: unknown,
): CaptureRuntimeError {
  return new CaptureRuntimeError(message, code, "connector", retryable, details, cause ? { cause } : undefined);
}

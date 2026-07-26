import * as parcelWatcher from "@parcel/watcher";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ObsidianCursor } from "./contracts.js";
import type { ObsidianRootIdentity } from "./filesystem.js";

const LatestSnapshotSchema = z.object({
  path: z.string().regex(/^snapshot-\d+\.bin$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ObsidianAdapterDiagnostic = {
  code: "obsidian_watcher_snapshot_recovered" | "obsidian_watcher_snapshot_written";
  connection_id: string;
  details: Record<string, string | number | boolean>;
};

export interface ObsidianWatcherAccelerator {
  load(input: { root: ObsidianRootIdentity; connection_id: string }): Promise<{
    reference: ObsidianCursor["watcher_snapshot"];
    changed_paths: string[];
    recovered: boolean;
  }>;
  write(input: { root: ObsidianRootIdentity; connection_id: string; checkpoint_revision: number }): Promise<ObsidianCursor["watcher_snapshot"]>;
}

export class ParcelObsidianWatcherAccelerator implements ObsidianWatcherAccelerator {
  constructor(private readonly onDiagnostic: (event: ObsidianAdapterDiagnostic) => void = defaultDiagnostic) {}

  async load(input: { root: ObsidianRootIdentity; connection_id: string }) {
    const directory = snapshotDirectory(input.connection_id);
    try {
      const latest = LatestSnapshotSchema.parse(JSON.parse(await readFile(join(directory, "latest.json"), "utf8")) as unknown);
      const snapshotPath = join(directory, latest.path);
      await access(snapshotPath);
      const digest = createHash("sha256").update(await readFile(snapshotPath)).digest("hex");
      if (digest !== latest.sha256) throw new Error("snapshot digest mismatch");
      const events = await parcelWatcher.getEventsSince(input.root.real_path, snapshotPath);
      const changedPaths = events.map(event => safeRelative(input.root.real_path, event.path)).sort((left, right) => left.localeCompare(right, "en"));
      return { reference: latest, changed_paths: [...new Set(changedPaths)], recovered: false };
    } catch {
      this.onDiagnostic({
        code: "obsidian_watcher_snapshot_recovered",
        connection_id: input.connection_id,
        details: { fallback: "logical_manifest_full_rescan" },
      });
      return { reference: null, changed_paths: [], recovered: true };
    }
  }

  async write(input: { root: ObsidianRootIdentity; connection_id: string; checkpoint_revision: number }) {
    const directory = snapshotDirectory(input.connection_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `snapshot-${input.checkpoint_revision}.bin`;
    const snapshotPath = join(directory, name);
    await parcelWatcher.writeSnapshot(input.root.real_path, snapshotPath);
    const sha256 = createHash("sha256").update(await readFile(snapshotPath)).digest("hex");
    const temporaryIndex = join(directory, `latest-${process.pid}.tmp`);
    await writeFile(temporaryIndex, JSON.stringify({ path: name, sha256 }), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryIndex, join(directory, "latest.json"));
    await removeOldSnapshots(directory, name);
    this.onDiagnostic({
      code: "obsidian_watcher_snapshot_written",
      connection_id: input.connection_id,
      details: { checkpoint_revision: input.checkpoint_revision },
    });
    return { path: name, sha256 };
  }
}

function snapshotDirectory(connectionId: string): string {
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 24);
  return join(tmpdir(), "metaflow-obsidian-watcher-v1", digest);
}

function safeRelative(root: string, candidate: string): string {
  const resolved = resolve(candidate);
  const relation = relative(root, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error("watcher event escaped root");
  return relation.split(sep).join("/").normalize("NFC");
}

async function removeOldSnapshots(directory: string, retainedName: string): Promise<void> {
  const snapshots = (await readdir(directory))
    .filter(name => /^snapshot-\d+\.bin$/.test(name) && basename(name) === name && name !== retainedName)
    .sort();
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - 1))) {
    await unlink(join(directory, name));
  }
}

function defaultDiagnostic(event: ObsidianAdapterDiagnostic): void {
  console.warn(JSON.stringify({ component: "obsidian-capture", ...event }));
}

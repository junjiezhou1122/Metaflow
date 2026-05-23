import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ContextRecord } from "../core/types.js";

export type LocalProjectSnapshotOptions = {
  cwd?: string;
  acquisitionMode?: NonNullable<ContextRecord["acquisition"]>["mode"];
  actor?: NonNullable<ContextRecord["acquisition"]>["actor"];
  reason?: string;
};

function sh(cmd: string, args: string[], cwd = process.cwd()) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function readIfExists(path: string, max = 80_000) {
  if (!existsSync(path)) return undefined;
  const st = statSync(path);
  if (!st.isFile() || st.size > max) return undefined;
  return readFileSync(path, "utf8");
}

export function buildLocalProjectSnapshotRecord(options: LocalProjectSnapshotOptions = {}): ContextRecord {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = sh("git", ["rev-parse", "--show-toplevel"], cwd) || cwd;
  const branch = sh("git", ["branch", "--show-current"], root);
  const repoRemote = sh("git", ["config", "--get", "remote.origin.url"], root);
  const status = sh("git", ["status", "--short"], root);
  const diffStat = sh("git", ["diff", "--stat"], root);
  const diff = sh("git", ["diff", "--", ":(exclude)pnpm-lock.yaml"], root).slice(0, 120_000);
  const recentFiles = sh("git", ["ls-files", "-m", "-o", "--exclude-standard"], root).split("\n").filter(Boolean).slice(0, 100);

  const docs = ["AGENTS.md", "CLAUDE.md", "README.md", "package.json"]
    .map(name => ({ name, text: readIfExists(join(root, name)) }))
    .filter((x): x is { name: string; text: string } => Boolean(x.text));

  return {
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: basename(root), repo: repoRemote || undefined, app: "terminal", project_path: root },
    content: {
      title: `Local project snapshot: ${basename(root)}`,
      path: root,
      text: [
        `cwd: ${cwd}`,
        `root: ${root}`,
        `branch: ${branch}`,
        `remote: ${repoRemote}`,
        `status:\n${status}`,
        `diff stat:\n${diffStat}`,
        `recent files:\n${recentFiles.join("\n")}`,
        `diff:\n${diff}`,
        ...docs.map(d => `${d.name}:\n${d.text}`),
      ].filter(Boolean).join("\n\n---\n\n"),
    },
    acquisition: {
      mode: options.acquisitionMode ?? "sync",
      actor: options.actor ?? "system",
      reason: options.reason ?? "local project snapshot for runtime tick",
    },
    signal: { importance: 0.85, confidence: 0.95, status: "accepted" },
    privacy: { level: "private", retention: "normal", allow_embedding: true, allow_llm_summary: true },
    memory: { kind: "observation", stability: "session" },
    payload: { cwd, root, branch, repoRemote, status, diffStat, recentFiles, doc_names: docs.map(d => d.name) },
  };
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.9";
const SUPPORTED_PLATFORM_PACKAGES = new Map([
  ["darwin-arm64", `sqlite-vec-darwin-arm64@${VERSION}`],
  ["darwin-x64", `sqlite-vec-darwin-x64@${VERSION}`],
  ["linux-arm64", `sqlite-vec-linux-arm64@${VERSION}`],
  ["linux-x64", `sqlite-vec-linux-x64@${VERSION}`],
  ["win32-x64", `sqlite-vec-windows-x64@${VERSION}`],
]);

if (!process.versions.node.startsWith("24.")) {
  throw new Error(`Semantic deploy verification requires Node 24.x, received ${process.version}`);
}
const platformKey = `${process.platform}-${process.arch}`;
const platformPackage = SUPPORTED_PLATFORM_PACKAGES.get(platformKey);
if (!platformPackage) {
  throw new Error(`sqlite-vec 0.1.9 has no supported Metaflow binary tuple for ${platformKey}`);
}
const lockfile = readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8");
for (const packageName of SUPPORTED_PLATFORM_PACKAGES.values()) {
  if (!lockfile.includes(`${packageName}:`)) {
    throw new Error(`Lockfile does not exact-pin supported optional package ${packageName}`);
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "metaflow-semantic-deploy-"));
const artifact = join(temporaryRoot, "artifact");
try {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint) throw new Error("npm_execpath is required to invoke the exact active pnpm executable");
  const deployed = spawnSync(process.execPath, [
    pnpmEntrypoint,
    "--filter",
    "metaflow",
    "deploy",
    "--prod",
    "--legacy",
    artifact,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (deployed.error) throw deployed.error;
  if (deployed.status !== 0) {
    throw new Error(`Production deploy failed\n${deployed.stdout}\n${deployed.stderr}`);
  }
  if (existsSync(join(artifact, "node_modules", "tsx"))) {
    throw new Error("Production deploy unexpectedly contains dev dependency tsx");
  }
  const adapterArtifact = join(artifact, "node_modules", "@info", "storage-sqlite");
  const notice = join(adapterArtifact, "THIRD_PARTY_NOTICES.md");
  if (!existsSync(notice)) throw new Error(`Production deploy omits sqlite-vec notice at ${notice}`);
  const noticeText = readFileSync(notice, "utf8");
  if (!noticeText.includes("MIT License") || !noticeText.includes("Copyright (c) 2024 Alex Garcia")) {
    throw new Error("Deployed sqlite-vec notice is incomplete");
  }

  const probe = spawnSync(process.execPath, [
    "--experimental-sqlite",
    "--input-type=module",
    "--eval",
    `
      import { DatabaseSync } from "node:sqlite";
      import { getLoadablePath, load } from "sqlite-vec";
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      load(db);
      const version = db.prepare("select vec_version() as version").get().version;
      process.stdout.write(JSON.stringify({ version, extension_path: getLoadablePath() }));
      db.close();
    `,
  ], { cwd: adapterArtifact, encoding: "utf8" });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`Deployed sqlite-vec probe failed\n${probe.stdout}\n${probe.stderr}`);
  const evidence = JSON.parse(probe.stdout) as { version?: unknown; extension_path?: unknown };
  if (evidence.version !== `v${VERSION}`) {
    throw new Error(`Deployed sqlite-vec returned ${String(evidence.version)}, expected v${VERSION}`);
  }
  if (typeof evidence.extension_path !== "string" || !evidence.extension_path.includes(platformPackage)) {
    throw new Error(`Deployed extension path does not resolve ${platformPackage}: ${String(evidence.extension_path)}`);
  }
  console.info(JSON.stringify({
    ok: true,
    node: process.version,
    executed_platform: platformKey,
    platform_package: platformPackage,
    extension_version: evidence.version,
    production_only: true,
    license_notice: "@info/storage-sqlite/THIRD_PARTY_NOTICES.md",
    lockfile_only_platforms: [...SUPPORTED_PLATFORM_PACKAGES.keys()].filter(key => key !== platformKey),
  }));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

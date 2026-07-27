import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function mfWireBuildPaths(moduleUrl = import.meta.url) {
  const repositoryRoot = resolve(dirname(fileURLToPath(moduleUrl)), "../..");
  return {
    absWorkingDir: repositoryRoot,
    outfile: resolve(repositoryRoot, "apps/mf-cli/bin/wire.mjs"),
  };
}

export async function buildMfWire() {
  const paths = mfWireBuildPaths();
  await build({
    absWorkingDir: paths.absWorkingDir,
    entryPoints: ["packages/adapters/operation-surfaces/wire-contract.ts"],
    outfile: paths.outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildMfWire();

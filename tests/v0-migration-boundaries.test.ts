import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_V1_TEST_FILES } from "../scripts/v1/run-tests.ts";

const repositoryRoot = join(import.meta.dirname, "..");
const legacyPackages = [
  "ambient-layer",
  "capabilities",
  "core",
  "iii-runtime",
  "processor-runtime",
  "programs",
  "runtime",
  "scheduled-batch",
  "sensors",
  "server",
  "view-system",
  "views",
] as const;
const activeSourceRoots = [
  "packages/view",
  "packages/view-package",
  "packages/transformation",
  "packages/execution",
  "packages/automation",
  "packages/capture",
  "packages/search",
  "packages/operations",
  "packages/adapters",
  "view-packages",
  "apps/ambient-daemon",
  "apps/view-explorer",
  "scripts/v1",
] as const;

test("canonical workspace exposes only v1 capability owners", () => {
  const workspace = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const packages = [...workspace.matchAll(/^\s*-\s+"([^"]+)"\s*$/gm)].map(match => match[1]);
  assert.deepEqual(packages, [
    "packages/view",
    "packages/view-package",
    "packages/transformation",
    "packages/execution",
    "packages/automation",
    "packages/capture",
    "packages/search",
    "packages/operations",
    "packages/screenpipe-contracts",
    "packages/adapters/*",
    "view-packages/*",
    "apps/ambient-daemon",
    "apps/view-explorer",
    "apps/website",
  ]);
  for (const name of legacyPackages) {
    assert.equal(packages.includes(`packages/${name}`), false, `${name} must remain outside the active workspace`);
  }
});

test("root dependencies and default commands have no archived v0 owner", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  for (const name of legacyPackages) {
    assert.equal(manifest.dependencies?.[`@info/${name}`], undefined, `root still depends on archived @info/${name}`);
  }
  const forbiddenPaths = [
    "packages/server/",
    "packages/iii-runtime/",
    "scripts/daemon.ts",
    "scripts/mf.ts",
    "scripts/runtime-tick.ts",
    "apps/ui",
  ];
  for (const [name, command] of Object.entries(manifest.scripts as Record<string, string>)) {
    for (const path of forbiddenPaths) {
      assert.equal(command.includes(path), false, `${name} still launches archived path ${path}`);
    }
  }
});

test("active source roots cannot import archived package owners", () => {
  const violations: string[] = [];
  const legacyImport = new RegExp(`@info/(${legacyPackages.join("|")})(?:/|[\"'])`);
  for (const root of activeSourceRoots) {
    for (const file of sourceFiles(join(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      if (legacyImport.test(source)) violations.push(file.slice(repositoryRoot.length + 1));
    }
  }
  assert.deepEqual(violations, []);
});

test("default test manifest contains only existing non-legacy tests", () => {
  const violations: string[] = [];
  const legacyPath = new RegExp(`from\\s+[\"'][^\"']*(?:@info/|packages/)(${legacyPackages.join("|")})(?:/|[\"'])`);
  for (const relative of ACTIVE_V1_TEST_FILES) {
    const file = join(repositoryRoot, relative);
    assert.equal(existsSync(file), true, `active test is missing: ${relative}`);
    const source = readFileSync(file, "utf8");
    if (legacyPath.test(source)) {
      violations.push(relative);
    }
  }
  assert.deepEqual(violations, []);
});

test("retained Chrome v0 records and canonical Browser Capture use separate routes", () => {
  const extension = readFileSync(
    join(repositoryRoot, "apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts"),
    "utf8",
  );
  const transport = readFileSync(
    join(repositoryRoot, "apps/chrome-acp/packages/chrome-extension/src/lib/browser-capture.ts"),
    "utf8",
  );
  const adapterIndex = readFileSync(
    join(repositoryRoot, "packages/adapters/browser-capture/index.ts"),
    "utf8",
  );
  const archivedServer = readFileSync(join(repositoryRoot, "packages/server/http-server.ts"), "utf8");
  assert.match(extension, /endpoint: "http:\/\/localhost:3111"/);
  assert.match(extension, /url\.pathname = "\/context\/ingest"/);
  assert.match(transport, /url\.pathname = "\/capture\/v1\/browser-events"/);
  assert.equal(existsSync(join(repositoryRoot, "packages/adapters/browser-capture/legacy.ts")), false);
  assert.doesNotMatch(adapterIndex, /legacy/);
  assert.doesNotMatch(archivedServer, /normalizeBrowserCapture|\/context\/v1\/observations/);
});

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry)) files.push(path);
  }
  return files;
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const depcruise = join(repositoryRoot, "node_modules", ".bin", "depcruise");
const tsx = join(repositoryRoot, "node_modules", ".bin", "tsx");
const config = join(repositoryRoot, "dependency-cruiser.config.cjs");
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "package-boundaries");

function cruise(paths: string[]) {
  return spawnSync(depcruise, ["--config", config, ...paths], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("v1 packages obey the declared dependency direction", () => {
  const result = cruise([
    "packages/view",
    "packages/view-package",
    "packages/transformation",
    "packages/execution",
    "packages/automation",
    "packages/capture",
    "packages/operations",
    "packages/adapters",
    "view-packages",
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

const invalidSourceCases = [
  ["View Core -> Execution", "view-to-execution", "v1-view-inward-only"],
  ["Transformation -> Capture", "transformation-to-capture", "v1-transformation-depends-only-on-view"],
  ["Capture -> Transformation", "capture-to-transformation", "v1-capture-depends-only-on-view"],
  ["Execution -> Capture", "execution-to-capture", "v1-execution-depends-only-on-contracts"],
  ["Automation -> Capture", "automation-to-capture", "v1-automation-depends-only-on-runtime-contracts"],
  ["Operations -> adapter", "operations-to-adapter", "v1-operations-depends-only-on-v1-ports"],
  ["Adapter -> legacy package", "adapter-to-legacy", "v1-adapters-depend-only-on-v1-ports"],
  ["III adapter -> legacy package", "iii-adapter-to-legacy", "v1-adapters-depend-only-on-v1-ports"],
  ["Adapter -> sibling adapter", "adapter-to-sibling", "v1-adapter-agent-runtime-is-independent"],
  ["v1 package -> composition root", "v1-to-composition-root", "v1-packages-do-not-import-composition-roots"],
  ["circular dependency", "circular", "no-circular-v1-dependencies"],
  ["unresolvable dependency", "unresolvable", "no-unresolvable-v1-dependencies"],
] as const;

for (const [label, fixture, expectedRule] of invalidSourceCases) {
  test(`dependency rules reject ${label}`, () => {
    const result = cruise([join(fixtureRoot, fixture)]);
    assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(expectedRule));
  });
}

const invalidManifestCases = [
  ["View Core -> legacy runtime", "manifest-view-to-runtime", "v1-view-manifest-inward-only"],
  ["Transformation -> Capture", "manifest-transformation-to-capture", "v1-transformation-manifest-depends-only-on-view"],
  ["Capture -> Transformation", "manifest-capture-to-transformation", "v1-capture-manifest-depends-only-on-view"],
  ["Execution -> Capture", "manifest-execution-to-capture", "v1-execution-manifest-depends-only-on-contracts"],
  ["Automation -> Capture", "manifest-automation-to-capture", "v1-automation-manifest-depends-only-on-runtime-contracts"],
  ["Operations -> adapter", "manifest-operations-to-adapter", "v1-operations-manifest-depends-only-on-v1-ports"],
  ["Adapter -> sibling adapter", "manifest-adapter-to-sibling", "v1-adapter-manifest-depends-only-on-v1-ports"],
  ["III adapter -> legacy package", "manifest-iii-adapter-to-legacy", "v1-adapter-manifest-depends-only-on-v1-ports"],
] as const;

for (const [label, fixtureName, expectedRule] of invalidManifestCases) {
  test(`manifest rules reject ${label}`, () => {
    const fixture = join(fixtureRoot, fixtureName);
    const result = spawnSync(tsx, ["scripts/check-v1-package-manifests.ts", "--allow-partial", fixture], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(expectedRule));
  });
}

test("manifest rules reject a missing required v1 package manifest", () => {
  const fixture = join(fixtureRoot, "manifest-missing-required-package");
  const result = spawnSync(tsx, ["scripts/check-v1-package-manifests.ts", fixture], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "the missing required package manifest unexpectedly passed");
  assert.match(`${result.stdout}\n${result.stderr}`, /v1-required-package-manifests/);
});

test("manifest rules reject an adapter implementation without a package manifest", () => {
  const fixture = join(fixtureRoot, "adapter-to-sibling");
  const result = spawnSync(tsx, ["scripts/check-v1-package-manifests.ts", "--allow-partial", fixture], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "the unpackaged adapter implementations unexpectedly passed");
  assert.match(`${result.stdout}\n${result.stderr}`, /v1-adapter-package-manifest-required/);
});

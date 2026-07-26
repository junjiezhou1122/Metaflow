const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const adaptersDirectory = join(__dirname, "packages", "adapters");
const adapterDirectories = readdirSync(adaptersDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const adaptersWithoutManifest = adapterDirectories.filter(
  (adapterName) => !existsSync(join(adaptersDirectory, adapterName, "package.json")),
);

if (adaptersWithoutManifest.length > 0) {
  throw new Error(`Adapter directories require package.json: ${adaptersWithoutManifest.join(", ")}`);
}

const adapterNames = adapterDirectories;

if (adapterNames.length === 0) {
  throw new Error("No adapter workspace packages found under packages/adapters");
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const adapterIndependenceRules = adapterNames.map((adapterName) => {
  const escapedName = escapeRegExp(adapterName);
  return {
    name: `v1-adapter-${adapterName}-is-independent`,
    severity: "error",
    comment: `The ${adapterName} adapter cannot import a sibling adapter package.`,
    from: { path: `(^|/)packages/adapters/${escapedName}/` },
    to: { path: `(^|/)packages/adapters/(?!${escapedName}(?:/|$))` },
  };
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular-v1-dependencies",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable-v1-dependencies",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "v1-view-inward-only",
      severity: "error",
      comment: "View Core cannot depend on runtime, capture, adapters, apps, or legacy packages.",
      from: { path: "(^|/)packages/view/" },
      to: { path: "(^|/)packages/(?!view/)" },
    },
    {
      name: "v1-transformation-depends-only-on-view",
      severity: "error",
      from: { path: "(^|/)packages/transformation/" },
      to: { path: "(^|/)packages/(?!(view|transformation)/)" },
    },
    {
      name: "v1-view-package-depends-only-on-view-and-transformation",
      severity: "error",
      from: { path: "(^|/)packages/view-package/" },
      to: { path: "(^|/)packages/(?!(view|transformation|view-package)/)" },
    },
    {
      name: "v1-view-package-bundles-depend-only-on-authoring-contracts",
      severity: "error",
      from: { path: "(^|/)view-packages/" },
      to: { path: "(^|/)packages/(?!(view|transformation|view-package)/)" },
    },
    {
      name: "v1-capture-depends-only-on-view",
      severity: "error",
      from: { path: "(^|/)packages/capture/" },
      to: { path: "(^|/)packages/(?!(view|capture)/)" },
    },
    {
      name: "v1-execution-depends-only-on-contracts",
      severity: "error",
      from: { path: "(^|/)packages/execution/" },
      to: { path: "(^|/)packages/(?!(view|transformation|execution)/)" },
    },
    {
      name: "v1-automation-depends-only-on-runtime-contracts",
      severity: "error",
      from: { path: "(^|/)packages/automation/" },
      to: { path: "(^|/)packages/(?!(view|transformation|execution|automation)/)" },
    },
    {
      name: "v1-operations-depends-only-on-v1-ports",
      severity: "error",
      from: { path: "(^|/)packages/operations/" },
      to: { path: "(^|/)packages/(?!(view|transformation|execution|capture|operations)/)" },
    },
    {
      name: "v1-adapters-depend-only-on-v1-ports",
      severity: "error",
      from: { path: "(^|/)packages/adapters/" },
      to: { path: "(^|/)packages/(?!(view|transformation|execution|automation|capture|operations|adapters)/)" },
    },
    ...adapterIndependenceRules,
    {
      name: "v1-packages-do-not-import-composition-roots",
      severity: "error",
      from: { path: "(^|/)(?:packages/(view|view-package|transformation|execution|automation|capture|operations|adapters)|view-packages)/" },
      to: { path: "(^|/)(apps|scripts|tests)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.v1.json" },
    enhancedResolveOptions: {
      // iii-sdk@0.19.2 publishes ESM declarations beside index.mjs but its
      // `types` export points at a non-existent index.d.ts. Dependency-cruiser
      // resolves the real runtime branch; TypeScript verifies declarations.
      conditionNames: ["import", "default"],
      exportsFields: ["exports"],
    },
  },
};

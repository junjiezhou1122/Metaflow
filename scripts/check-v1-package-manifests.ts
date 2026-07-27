import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Manifest = {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
};

type PackageBoundary = {
  directory: string;
  rule: string;
  allowedInternalDependencies: ReadonlySet<string>;
};

type Violation = {
  rule: string;
  manifestPath: string;
  dependency?: string;
  message: string;
};

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function readManifest(manifestPath: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  return parsed as Manifest;
}

function walkManifestPaths(directory: string): string[] {
  if (!existsSync(directory)) return [];

  const results: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkManifestPaths(entryPath));
    } else if (entry.isFile() && entry.name === "package.json") {
      results.push(entryPath);
    }
  }
  return results;
}

function collectWorkspacePackageNames(root: string): Set<string> {
  const names = new Set<string>();
  const manifests = [
    ...walkManifestPaths(join(root, "packages")),
    ...walkManifestPaths(join(root, "view-packages")),
    ...walkManifestPaths(join(root, "apps")),
  ];

  for (const manifestPath of manifests) {
    const manifest = readManifest(manifestPath);
    if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
    if (names.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    }
    names.add(manifest.name);
  }
  return names;
}

function adapterBoundaries(root: string): PackageBoundary[] {
  const adaptersDirectory = join(root, "packages", "adapters");
  if (!existsSync(adaptersDirectory)) return [];

  return readdirSync(adaptersDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(adaptersDirectory, entry.name, "package.json")))
    .map((entry) => ({
      directory: join(adaptersDirectory, entry.name),
      rule: "v1-adapter-manifest-depends-only-on-v1-ports",
      allowedInternalDependencies: new Set([
        "@info/view",
        "@info/transformation",
        "@info/execution",
        "@info/automation",
        "@info/capture",
        "@info/search",
        "@info/authoring",
        "@info/operations",
        "@info/screenpipe-contracts",
      ]),
    }));
}

function adapterManifestViolations(root: string): Violation[] {
  const adaptersDirectory = join(root, "packages", "adapters");
  if (!existsSync(adaptersDirectory)) return [];

  return readdirSync(adaptersDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !existsSync(join(adaptersDirectory, entry.name, "package.json")))
    .map((entry) => ({
      rule: "v1-adapter-package-manifest-required",
      manifestPath: join(adaptersDirectory, entry.name, "package.json"),
      message: "adapter implementation must be an independent workspace package",
    }));
}

function configuredBoundaries(root: string): PackageBoundary[] {
  return [
    {
      directory: join(root, "packages", "view"),
      rule: "v1-view-manifest-inward-only",
      allowedInternalDependencies: new Set(),
    },
    {
      directory: join(root, "packages", "view-package"),
      rule: "v1-view-package-manifest-depends-only-on-view-and-transformation",
      allowedInternalDependencies: new Set(["@info/view", "@info/transformation"]),
    },
    {
      directory: join(root, "packages", "transformation"),
      rule: "v1-transformation-manifest-depends-only-on-view",
      allowedInternalDependencies: new Set(["@info/view"]),
    },
    {
      directory: join(root, "packages", "capture"),
      rule: "v1-capture-manifest-depends-only-on-view",
      allowedInternalDependencies: new Set(["@info/view"]),
    },
    {
      directory: join(root, "packages", "execution"),
      rule: "v1-execution-manifest-depends-only-on-contracts",
      allowedInternalDependencies: new Set(["@info/view", "@info/transformation"]),
    },
    {
      directory: join(root, "packages", "automation"),
      rule: "v1-automation-manifest-depends-only-on-runtime-contracts",
      allowedInternalDependencies: new Set(["@info/view", "@info/transformation", "@info/execution"]),
    },
    {
      directory: join(root, "packages", "search"),
      rule: "v1-search-manifest-depends-only-on-view",
      allowedInternalDependencies: new Set(["@info/view"]),
    },
    {
      directory: join(root, "packages", "authoring"),
      rule: "v1-authoring-manifest-depends-only-on-v1-contracts",
      allowedInternalDependencies: new Set(["@info/view", "@info/transformation", "@info/execution", "@info/view-package"]),
    },
    {
      directory: join(root, "packages", "operations"),
      rule: "v1-operations-manifest-depends-only-on-v1-ports",
      allowedInternalDependencies: new Set(["@info/view", "@info/transformation", "@info/execution", "@info/capture", "@info/search", "@info/authoring"]),
    },
    {
      directory: join(root, "packages", "screenpipe-contracts"),
      rule: "v1-screenpipe-contracts-manifest-depends-only-on-view",
      allowedInternalDependencies: new Set(["@info/view"]),
    },
    ...viewPackageBoundaries(root),
    ...adapterBoundaries(root),
  ];
}

function viewPackageBoundaries(root: string): PackageBoundary[] {
  const directory = join(root, "view-packages");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, "package.json")))
    .map(entry => ({
      directory: join(directory, entry.name),
      rule: "v1-view-package-bundle-manifest-depends-only-on-authoring-contracts",
      allowedInternalDependencies: new Set(["@info/view", "@info/transformation", "@info/view-package"]),
    }));
}

function dependencyEntries(manifestPath: string, manifest: Manifest): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const field of dependencyFields) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${manifestPath} field ${field} must be an object`);
    }
    for (const [name, specifier] of Object.entries(value)) {
      if (typeof specifier !== "string") {
        throw new Error(`${manifestPath} dependency ${name} must have a string specifier`);
      }
      entries.push([name, specifier]);
    }
  }
  return entries;
}

function validate(root: string, allowPartial: boolean): Violation[] {
  const workspaceNames = collectWorkspacePackageNames(root);
  const boundaries = configuredBoundaries(root);
  const violations: Violation[] = adapterManifestViolations(root);

  for (const boundary of boundaries) {
    const manifestPath = join(boundary.directory, "package.json");
    if (!existsSync(manifestPath)) {
      if (!allowPartial) {
        violations.push({
          rule: "v1-required-package-manifests",
          manifestPath,
          message: "required v1 workspace manifest is missing",
        });
      }
      continue;
    }
    if (!statSync(manifestPath).isFile()) {
      throw new Error(`${manifestPath} is not a file`);
    }

    const manifest = readManifest(manifestPath);
    for (const [name, specifier] of dependencyEntries(manifestPath, manifest)) {
      const isInternal = workspaceNames.has(name) || name.startsWith("@info/") || /^(workspace:|file:|link:)/.test(specifier);
      if (isInternal && !boundary.allowedInternalDependencies.has(name)) {
        violations.push({
          rule: boundary.rule,
          manifestPath,
          dependency: name,
          message: `forbidden internal dependency ${name}@${specifier}`,
        });
      }
    }
  }

  return violations;
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const args = process.argv.slice(2);
const allowPartial = args[0] === "--allow-partial";
const rootArgument = allowPartial ? args[1] : args[0];
const root = resolve(scriptDirectory, "..", rootArgument ?? ".");
const violations = validate(root, allowPartial);

if (violations.length > 0) {
  for (const violation of violations) {
    const target = relative(root, violation.manifestPath);
    console.error(`${violation.rule}: ${target}: ${violation.message}`);
  }
  process.exitCode = 1;
} else {
  console.log("v1 package manifests satisfy dependency boundaries");
}

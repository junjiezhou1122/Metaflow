import { canonicalJson, type ViewSchemaRef } from "@info/view";
import {
  ViewPackageManifestSchema,
  schemaKey,
  type ViewPackage,
  type ViewPackageManifest,
  type ViewPackageMethod,
  type ViewPackageRenderer,
  type ViewPackageSchemaKey,
} from "./contracts.js";

export type ViewPackageErrorCode =
  | "invalid_manifest"
  | "duplicate_package"
  | "missing_package"
  | "missing_schema"
  | "missing_operation"
  | "missing_renderer"
  | "missing_transformation"
  | "transformation_output_mismatch"
  | "invalid_fixture"
  | "representation_profile_mismatch";

export class ViewPackageError extends Error {
  constructor(
    message: string,
    readonly code: ViewPackageErrorCode,
    readonly details: Record<string, string | number> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewPackageError";
  }
}

export function defineViewPackage(input: unknown): ViewPackage {
  const parsed = ViewPackageManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ViewPackageError(
      "View Package manifest failed validation",
      "invalid_manifest",
      { issue_count: parsed.error.issues.length },
      { cause: parsed.error },
    );
  }
  const manifest = parsed.data;
  const schemas = new Map(manifest.schemas.map(schema => [schemaKey(schema), schema]));
  const methods = new Map(manifest.methods.map(method => [method.id, method]));

  return Object.freeze({
    manifest,
    schema(key: ViewPackageSchemaKey): ViewSchemaRef {
      const schema = schemas.get(schemaKey(key));
      if (!schema) {
        throw new ViewPackageError(
          `View Package ${manifest.id}@${manifest.version} does not declare Schema ${schemaKey(key)}`,
          "missing_schema",
          { package_id: manifest.id, package_version: manifest.version, schema: schemaKey(key) },
        );
      }
      return schema;
    },
    supports(key: ViewPackageSchemaKey): boolean {
      return schemas.has(schemaKey(key));
    },
    renderers(key: ViewPackageSchemaKey, surface?: ViewPackageRenderer["surfaces"][number]): ViewPackageRenderer[] {
      return manifest.renderers
        .filter(renderer => schemaKey(renderer.schema) === schemaKey(key))
        .filter(renderer => surface === undefined || renderer.surfaces.includes(surface))
        .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    },
    method(id: string): ViewPackageMethod | undefined {
      return methods.get(id);
    },
  });
}

export class ViewPackageCatalog {
  private readonly packages = new Map<string, ViewPackage>();
  private readonly schemaOwners = new Map<string, Set<string>>();

  register(viewPackage: ViewPackage): void {
    const key = packageKey(viewPackage.manifest);
    if (this.packages.has(key)) {
      throw new ViewPackageError(`Duplicate View Package registration: ${key}`, "duplicate_package", { package: key });
    }
    this.packages.set(key, viewPackage);
    for (const schema of viewPackage.manifest.schemas) {
      const owners = this.schemaOwners.get(schemaKey(schema)) ?? new Set<string>();
      owners.add(key);
      this.schemaOwners.set(schemaKey(schema), owners);
    }
  }

  get(id: string, version: number): ViewPackage {
    const key = `${id}@${version}`;
    const viewPackage = this.packages.get(key);
    if (!viewPackage) throw new ViewPackageError(`View Package is not registered: ${key}`, "missing_package", { package: key });
    return viewPackage;
  }

  latest(id: string): ViewPackage | undefined {
    return this.list().filter(item => item.manifest.id === id).sort((left, right) => right.manifest.version - left.manifest.version)[0];
  }

  forSchema(key: ViewPackageSchemaKey): ViewPackage[] {
    const owners = this.schemaOwners.get(schemaKey(key));
    if (!owners) return [];
    return [...owners].map(owner => this.packages.get(owner)!).sort(comparePackages);
  }

  list(): ViewPackage[] {
    return [...this.packages.values()].sort(comparePackages);
  }
}

function packageKey(manifest: ViewPackageManifest): string {
  return `${manifest.id}@${manifest.version}`;
}

function comparePackages(left: ViewPackage, right: ViewPackage): number {
  return left.manifest.id.localeCompare(right.manifest.id) || left.manifest.version - right.manifest.version
    || canonicalJson(left.manifest).localeCompare(canonicalJson(right.manifest));
}

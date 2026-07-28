import { canonicalJson, type ViewRepresentation, type ViewSchemaRef } from "@info/view";
import {
  ViewPackageManifestSchema,
  normalizeMediaType,
  parserKey,
  processorKey,
  rendererKey,
  schemaKey,
  type ViewPackage,
  type ViewPackageManifest,
  type ViewPackageMethod,
  type ViewPackageParser,
  type ViewPackageProcessor,
  type ViewPackageRenderer,
  type ViewPackageSchemaKey,
} from "./contracts.js";

export type ViewPackageErrorCode =
  | "invalid_manifest"
  | "duplicate_package"
  | "duplicate_parser"
  | "missing_package"
  | "missing_schema"
  | "missing_operation"
  | "missing_renderer"
  | "missing_parser"
  | "invalid_representation_media_type"
  | "ambiguous_parser"
  | "missing_transformation"
  | "transformation_reference_mismatch"
  | "transformation_output_mismatch"
  | "transformation_input_mismatch"
  | "invalid_fixture"
  | "representation_profile_mismatch"
  | "parser_profile_mismatch"
  | "missing_parser_fixture";

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
  const manifest = deepFreeze(parsed.data);
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
        .sort((left, right) => right.priority - left.priority
          || left.id.localeCompare(right.id)
          || right.version - left.version
          || rendererKey(left).localeCompare(rendererKey(right)));
    },
    parsers(key: ViewPackageSchemaKey, representation?: ViewRepresentation): ViewPackageParser[] {
      if (representation !== undefined) assertRepresentationMediaType(key, representation);
      return manifest.parsers
        .filter(parser => schemaKey(parser.input_schema) === schemaKey(key))
        .filter(parser => representation === undefined || acceptsRepresentation(parser, representation))
        .sort(compareParsers);
    },
    processors(key: ViewPackageSchemaKey): ViewPackageProcessor[] {
      return manifest.processors
        .filter(processor => schemaKey(processor.output_schema) === schemaKey(key))
        .sort(compareProcessors);
    },
    method(id: string): ViewPackageMethod | undefined {
      return methods.get(id);
    },
  });
}

export class ViewPackageCatalog {
  private readonly packages = new Map<string, ViewPackage>();
  private readonly schemaOwners = new Map<string, Set<string>>();
  private readonly parserDescriptors = new Map<string, string>();

  register(viewPackage: ViewPackage): void {
    const canonicalPackage = defineViewPackage(viewPackage.manifest);
    const key = packageKey(canonicalPackage.manifest);
    if (this.packages.has(key)) {
      throw new ViewPackageError(`Duplicate View Package registration: ${key}`, "duplicate_package", { package: key });
    }

    for (const parser of canonicalPackage.manifest.parsers) {
      const identity = parserKey(parser);
      const descriptor = canonicalJson(parser);
      const registered = this.parserDescriptors.get(identity);
      if (registered !== undefined && registered !== descriptor) {
        throw new ViewPackageError(
          `Parser identity ${identity} is already registered with a different exact descriptor`,
          "duplicate_parser",
          { parser: identity, package: key },
        );
      }
    }

    this.packages.set(key, canonicalPackage);
    for (const parser of canonicalPackage.manifest.parsers) {
      this.parserDescriptors.set(parserKey(parser), canonicalJson(parser));
    }
    for (const schema of canonicalPackage.manifest.schemas) {
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

  resolveParser(key: ViewPackageSchemaKey, representation: ViewRepresentation): ViewPackageParser {
    const candidates = this.forSchema(key)
      .flatMap(viewPackage => viewPackage.parsers(key, representation))
      .sort(compareParsers);
    if (candidates.length === 0) {
      throw new ViewPackageError(
        `No Parser is registered for Schema ${schemaKey(key)} and Representation ${representation.kind}`,
        "missing_parser",
        { schema: schemaKey(key), representation_kind: representation.kind },
      );
    }
    const highestPriority = candidates[0]!.priority;
    const preferred = candidates.filter(candidate => candidate.priority === highestPriority);
    const identities = new Set(preferred.map(parserKey));
    if (identities.size !== 1) {
      throw new ViewPackageError(
        `Parser selection is ambiguous for Schema ${schemaKey(key)} and Representation ${representation.kind}`,
        "ambiguous_parser",
        { schema: schemaKey(key), representation_kind: representation.kind, candidate_count: preferred.length },
      );
    }
    return preferred.sort(compareParsers)[0]!;
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

function acceptsRepresentation(parser: ViewPackageParser, representation: ViewRepresentation): boolean {
  return parser.accepts.forms.includes(representation.form)
    && parser.accepts.representation_kinds.includes(representation.kind)
    && (parser.accepts.media_types.length === 0
      || (representation.media_type !== undefined
        && parser.accepts.media_types.map(normalizeMediaType).includes(normalizeMediaType(representation.media_type))));
}

function assertRepresentationMediaType(key: ViewPackageSchemaKey, representation: ViewRepresentation): void {
  if (representation.media_type === undefined) return;
  try {
    normalizeMediaType(representation.media_type);
  } catch (error) {
    throw new ViewPackageError(
      `Representation has an invalid media type: ${representation.media_type}`,
      "invalid_representation_media_type",
      { schema: schemaKey(key), representation_kind: representation.kind },
      { cause: error },
    );
  }
}

function compareParsers(left: ViewPackageParser, right: ViewPackageParser): number {
  return right.priority - left.priority
    || left.id.localeCompare(right.id)
    || right.version - left.version
    || parserKey(left).localeCompare(parserKey(right));
}

function compareProcessors(left: ViewPackageProcessor, right: ViewPackageProcessor): number {
  return right.priority - left.priority
    || left.id.localeCompare(right.id)
    || right.version - left.version
    || processorKey(left).localeCompare(processorKey(right));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

import { z } from "zod";
import {
  IdentifierSchema,
  ViewRepresentationSchema,
  ViewSchemaRefSchema,
  type ViewRepresentation,
  type ViewSchemaRef,
} from "@info/view";
import {
  ExactTransformationRefSchema,
  type ExactTransformationRef,
} from "@info/transformation";

export const ViewPackageSchemaKeySchema = z.object({
  name: IdentifierSchema,
  version: z.number().int().positive(),
}).strict();

export const ViewPackageRepresentationProfileSchema = z.object({
  id: IdentifierSchema,
  schema: ViewPackageSchemaKeySchema,
  forms: z.array(z.enum(["inline", "external_reference"])).min(1),
  kinds: z.array(IdentifierSchema).min(1),
  media_types: z.array(z.string().trim().min(1)).default([]),
}).strict();

export const ViewPackageMaterializationProfileSchema = z.object({
  id: IdentifierSchema,
  schema: ViewPackageSchemaKeySchema,
  formats: z.array(IdentifierSchema).min(1),
  media_types: z.array(z.string().trim().min(1)).min(1),
  locations: z.array(z.enum(["inline", "uri", "content_addressed"])).min(1),
}).strict();

export const ViewPackageRendererSchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().positive(),
  abi_version: z.literal(1),
  schema: ViewPackageSchemaKeySchema,
  surfaces: z.array(z.enum(["web", "native", "generic"])).min(1),
  representation_kinds: z.array(IdentifierSchema).min(1),
  media_types: z.array(z.string().trim().min(1)).min(1).optional(),
  priority: z.number().int().default(0),
}).strict();

export const ViewPackageMethodEffectSchema = z.enum([
  "read",
  "creates_view",
  "external_side_effect",
  "destructive",
]);

export const ViewPackageMethodTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("operation"),
    operation: IdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("transformation"),
    transformation: ExactTransformationRefSchema,
  }).strict(),
]);

export const ViewPackageMethodSchema = z.object({
  id: IdentifierSchema,
  description: z.string().trim().min(1).max(2_000),
  schema: ViewPackageSchemaKeySchema,
  effect: ViewPackageMethodEffectSchema,
  target: ViewPackageMethodTargetSchema,
}).strict();

export const ViewPackageEvolutionSchema = z.object({
  id: IdentifierSchema,
  from: ViewPackageSchemaKeySchema,
  to: ViewPackageSchemaKeySchema,
  transformation: ExactTransformationRefSchema,
}).strict();

export const ViewPackageManifestSchema = z.object({
  manifest_version: z.literal(1),
  id: IdentifierSchema,
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(2_000),
  schemas: z.array(ViewSchemaRefSchema).min(1),
  representations: z.array(ViewPackageRepresentationProfileSchema).min(1),
  materializations: z.array(ViewPackageMaterializationProfileSchema).min(1),
  renderers: z.array(ViewPackageRendererSchema).default([]),
  methods: z.array(ViewPackageMethodSchema).default([]),
  evolutions: z.array(ViewPackageEvolutionSchema).default([]),
}).strict().superRefine((manifest, context) => {
  assertUnique(manifest.schemas.map(schemaKey), "Schema", ["schemas"], context);
  assertUnique(manifest.representations.map(item => item.id), "Representation profile", ["representations"], context);
  assertUnique(manifest.materializations.map(item => item.id), "Materialization profile", ["materializations"], context);
  assertUnique(manifest.renderers.map(rendererKey), "Renderer", ["renderers"], context);
  assertUnique(manifest.methods.map(item => item.id), "Method", ["methods"], context);
  assertUnique(manifest.evolutions.map(item => item.id), "Evolution", ["evolutions"], context);

  const declaredSchemas = new Set(manifest.schemas.map(schemaKey));
  for (const [collection, items] of [
    ["representations", manifest.representations],
    ["materializations", manifest.materializations],
    ["renderers", manifest.renderers],
    ["methods", manifest.methods],
  ] as const) {
    items.forEach((item, index) => assertDeclaredSchema(item.schema, declaredSchemas, [collection, index, "schema"], context));
  }
  manifest.evolutions.forEach((evolution, index) => {
    assertDeclaredSchema(evolution.from, declaredSchemas, ["evolutions", index, "from"], context);
    assertDeclaredSchema(evolution.to, declaredSchemas, ["evolutions", index, "to"], context);
  });
});

export const ViewPackageFixtureSchema = z.object({
  id: IdentifierSchema,
  schema: ViewPackageSchemaKeySchema,
  representation: ViewRepresentationSchema,
}).strict();

export type ViewPackageSchemaKey = z.infer<typeof ViewPackageSchemaKeySchema>;
export type ViewPackageRepresentationProfile = z.infer<typeof ViewPackageRepresentationProfileSchema>;
export type ViewPackageMaterializationProfile = z.infer<typeof ViewPackageMaterializationProfileSchema>;
export type ViewPackageRenderer = z.infer<typeof ViewPackageRendererSchema>;
export type ViewPackageMethodEffect = z.infer<typeof ViewPackageMethodEffectSchema>;
export type ViewPackageMethod = z.infer<typeof ViewPackageMethodSchema>;
export type ViewPackageEvolution = z.infer<typeof ViewPackageEvolutionSchema>;
export type ViewPackageManifest = z.infer<typeof ViewPackageManifestSchema>;
export type ViewPackageFixture = z.infer<typeof ViewPackageFixtureSchema>;

export type ViewPackage = {
  readonly manifest: ViewPackageManifest;
  schema(key: ViewPackageSchemaKey): ViewSchemaRef;
  supports(key: ViewPackageSchemaKey): boolean;
  renderers(key: ViewPackageSchemaKey, surface?: ViewPackageRenderer["surfaces"][number]): ViewPackageRenderer[];
  method(id: string): ViewPackageMethod | undefined;
};

export type ViewPackageConformanceInput = {
  package: ViewPackage;
  fixtures: readonly unknown[];
  operations: ReadonlySet<string>;
  renderers: ReadonlySet<string>;
  transformations: ReadonlyMap<string, {
    ref: ExactTransformationRef;
    output_schema: ViewPackageSchemaKey;
  }>;
};

export type ViewPackageConformanceReport = {
  package_id: string;
  package_version: number;
  schemas: number;
  fixtures: number;
  methods: number;
  renderers: number;
  evolutions: number;
};

export function schemaKey(schema: ViewSchemaRef | ViewPackageSchemaKey): string {
  return `${schema.name}@${schema.version}`;
}

export function rendererKey(renderer: Pick<ViewPackageRenderer, "id" | "version" | "abi_version">): string {
  return `${renderer.id}@${renderer.version}@${renderer.abi_version}`;
}

export function transformationKey(ref: ExactTransformationRef): string {
  return `${ref.transformation_id}@${ref.revision}`;
}

function assertUnique(values: readonly string[], label: string, path: Array<string | number>, context: z.RefinementCtx): void {
  if (new Set(values).size === values.length) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `${label} identities must be unique`,
  });
}

function assertDeclaredSchema(
  schema: ViewPackageSchemaKey,
  declared: ReadonlySet<string>,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (declared.has(schemaKey(schema))) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `Schema ${schemaKey(schema)} is not declared by this View Package`,
  });
}

export type { ViewRepresentation };

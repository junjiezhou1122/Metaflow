import { z } from "zod";
import {
  IdentifierSchema,
  JsonValueSchema,
  ViewRelationTargetSchema,
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

const MediaTypeEssenceSchema = z.string().trim().regex(
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u,
  "Media type declarations must be a type/subtype essence without parameters",
);

export const ViewPackageRepresentationProfileSchema = z.object({
  id: IdentifierSchema,
  schema: ViewPackageSchemaKeySchema,
  forms: z.array(z.enum(["inline", "external_reference"])).min(1),
  kinds: z.array(IdentifierSchema).min(1),
  media_types: z.array(MediaTypeEssenceSchema).default([]),
}).strict().superRefine((profile, context) => {
  assertUnique(profile.forms, "Representation form", ["forms"], context);
  assertUnique(profile.kinds, "Representation kind", ["kinds"], context);
  assertUnique(profile.media_types.map(value => value.toLowerCase()), "Representation media type", ["media_types"], context);
});

export const ViewPackageMaterializationProfileSchema = z.object({
  id: IdentifierSchema,
  schema: ViewPackageSchemaKeySchema,
  formats: z.array(IdentifierSchema).min(1),
  media_types: z.array(MediaTypeEssenceSchema).min(1),
  locations: z.array(z.enum(["inline", "uri", "content_addressed"])).min(1),
}).strict();

export const ViewPackageRendererSchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().positive(),
  abi_version: z.literal(1),
  schema: ViewPackageSchemaKeySchema,
  surfaces: z.array(z.enum(["web", "native", "generic"])).min(1),
  representation_kinds: z.array(IdentifierSchema).min(1),
  media_types: z.array(MediaTypeEssenceSchema).min(1).optional(),
  priority: z.number().int().default(0),
}).strict();

export const ViewPackageMethodEffectSchema = z.enum([
  "read",
  "creates_view",
  "external_side_effect",
  "destructive",
]);

export const ViewPackageMethodParametersSchema = z.object({
  dialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
  json_schema: JsonValueSchema,
  pagination: z.object({
    kind: z.literal("cursor"),
    max_page_size: z.number().int().positive().max(1_000),
  }).strict().optional(),
}).strict();

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
  parameters: ViewPackageMethodParametersSchema.optional(),
}).strict();

export const ViewPackageEvolutionSchema = z.object({
  id: IdentifierSchema,
  from: ViewPackageSchemaKeySchema,
  to: ViewPackageSchemaKeySchema,
  transformation: ExactTransformationRefSchema,
}).strict();

const ViewPackageAcceptedRepresentationSchema = z.object({
  forms: z.array(z.enum(["inline", "external_reference"])).min(1),
  representation_kinds: z.array(IdentifierSchema).min(1),
  media_types: z.array(MediaTypeEssenceSchema).default([]),
}).strict().superRefine((profile, context) => {
  assertUnique(profile.forms, "Accepted Representation form", ["forms"], context);
  assertUnique(profile.representation_kinds, "Accepted Representation kind", ["representation_kinds"], context);
  assertUnique(profile.media_types.map(value => value.toLowerCase()), "Accepted media type", ["media_types"], context);
});

export const ViewPackageParserSchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().positive(),
  abi_version: z.literal(1),
  input_schema: ViewPackageSchemaKeySchema,
  accepts: ViewPackageAcceptedRepresentationSchema,
  transformation: ExactTransformationRefSchema,
  output_schema: ViewPackageSchemaKeySchema,
  priority: z.number().int().default(0),
}).strict();

export const ViewPackageProcessorInputSchema = z.object({
  role: IdentifierSchema,
  schemas: z.array(ViewPackageSchemaKeySchema).min(1),
  required: z.boolean().default(true),
}).strict().superRefine((input, context) => {
  assertUnique(input.schemas.map(schemaKey), "Processor input Schema", ["schemas"], context);
});

export const ViewPackageProcessorSchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().positive(),
  inputs: z.array(ViewPackageProcessorInputSchema).min(1),
  output_schema: ViewPackageSchemaKeySchema,
  transformation: ExactTransformationRefSchema,
  priority: z.number().int().default(0),
}).strict().superRefine((processor, context) => {
  assertUnique(processor.inputs.map(input => input.role), "Processor input role", ["inputs"], context);
});

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
  parsers: z.array(ViewPackageParserSchema).default([]),
  processors: z.array(ViewPackageProcessorSchema).default([]),
  methods: z.array(ViewPackageMethodSchema).default([]),
  evolutions: z.array(ViewPackageEvolutionSchema).default([]),
}).strict().superRefine((manifest, context) => {
  assertUnique(manifest.schemas.map(schemaKey), "Schema", ["schemas"], context);
  assertUnique(manifest.representations.map(item => item.id), "Representation profile", ["representations"], context);
  assertUnique(manifest.materializations.map(item => item.id), "Materialization profile", ["materializations"], context);
  assertUnique(manifest.renderers.map(rendererKey), "Renderer", ["renderers"], context);
  assertUnique(manifest.parsers.map(parserKey), "Parser", ["parsers"], context);
  assertUnique(manifest.processors.map(processorKey), "Processor", ["processors"], context);
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
  manifest.parsers.forEach((parser, index) => {
    assertDeclaredSchema(parser.input_schema, declaredSchemas, ["parsers", index, "input_schema"], context);
    const profiles = manifest.representations.filter(profile => schemaKey(profile.schema) === schemaKey(parser.input_schema));
    if (!parserAcceptanceIsCovered(parser, profiles)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parsers", index, "accepts"],
        message: `Parser ${parserKey(parser)} accepts a Representation tuple not declared by this View Package`,
      });
    }
  });
  manifest.processors.forEach((processor, index) => {
    assertDeclaredSchema(processor.output_schema, declaredSchemas, ["processors", index, "output_schema"], context);
  });
  manifest.evolutions.forEach((evolution, index) => {
    assertDeclaredSchema(evolution.from, declaredSchemas, ["evolutions", index, "from"], context);
    assertDeclaredSchema(evolution.to, declaredSchemas, ["evolutions", index, "to"], context);
  });
});

export const ViewPackageFixtureSchema = z.object({
  id: IdentifierSchema,
  schema: ViewPackageSchemaKeySchema,
  representation: ViewRepresentationSchema,
  relations: z.array(ViewRelationTargetSchema).default([]),
}).strict();

export type ViewPackageSchemaKey = z.infer<typeof ViewPackageSchemaKeySchema>;
export type ViewPackageRepresentationProfile = z.infer<typeof ViewPackageRepresentationProfileSchema>;
export type ViewPackageMaterializationProfile = z.infer<typeof ViewPackageMaterializationProfileSchema>;
export type ViewPackageRenderer = z.infer<typeof ViewPackageRendererSchema>;
export type ViewPackageParser = z.infer<typeof ViewPackageParserSchema>;
export type ViewPackageProcessorInput = z.infer<typeof ViewPackageProcessorInputSchema>;
export type ViewPackageProcessor = z.infer<typeof ViewPackageProcessorSchema>;
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
  parsers(key: ViewPackageSchemaKey, representation?: ViewRepresentation): ViewPackageParser[];
  processors(key: ViewPackageSchemaKey): ViewPackageProcessor[];
  method(id: string): ViewPackageMethod | undefined;
};

export type ViewPackageTransformationConformance = {
  ref: ExactTransformationRef;
  output_schema: ViewPackageSchemaKey;
  input_roles?: ReadonlyArray<{
    role: string;
    required: boolean;
    schemas: ReadonlyArray<ViewPackageSchemaKey>;
  }>;
};

export type ViewPackageConformanceInput = {
  package: ViewPackage;
  fixtures: readonly unknown[];
  operations: ReadonlySet<string>;
  renderers: ReadonlySet<string>;
  transformations: ReadonlyMap<string, ViewPackageTransformationConformance>;
};

export type ViewPackageConformanceReport = {
  package_id: string;
  package_version: number;
  schemas: number;
  fixtures: number;
  methods: number;
  renderers: number;
  parsers: number;
  processors: number;
  evolutions: number;
};

export function schemaKey(schema: ViewSchemaRef | ViewPackageSchemaKey): string {
  return `${schema.name}@${schema.version}`;
}

export function rendererKey(renderer: Pick<ViewPackageRenderer, "id" | "version" | "abi_version">): string {
  return `${renderer.id}@${renderer.version}@${renderer.abi_version}`;
}

export function parserKey(parser: Pick<ViewPackageParser, "id" | "version" | "abi_version">): string {
  return `${parser.id}@${parser.version}@${parser.abi_version}`;
}

export function processorKey(processor: Pick<ViewPackageProcessor, "id" | "version">): string {
  return `${processor.id}@${processor.version}`;
}

export function transformationKey(ref: ExactTransformationRef): string {
  return `${ref.transformation_id}@${ref.revision}`;
}

export function normalizeMediaType(value: string): string {
  const essence = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!MediaTypeEssenceSchema.safeParse(essence).success) {
    throw new TypeError(`Invalid media type essence: ${value}`);
  }
  return essence;
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

function parserAcceptanceIsCovered(
  parser: ViewPackageParser,
  profiles: readonly ViewPackageRepresentationProfile[],
): boolean {
  return parser.accepts.forms.every(form =>
    parser.accepts.representation_kinds.every(kind => {
      const matchingProfiles = profiles.filter(profile => profile.forms.includes(form) && profile.kinds.includes(kind));
      if (parser.accepts.media_types.length === 0) {
        return matchingProfiles.some(profile => profile.media_types.length === 0);
      }
      return parser.accepts.media_types.every(mediaType =>
        matchingProfiles.some(profile => profile.media_types.length === 0
          || profile.media_types.map(value => value.toLowerCase()).includes(mediaType.toLowerCase())));
    }));
}

export type { ViewRepresentation };

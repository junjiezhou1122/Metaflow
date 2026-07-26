import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(JsonValueSchema),
]));

export const IdentifierSchema = z.string().trim().min(1).max(240);
export const TimestampSchema = z.string().datetime({ offset: true });

export const ExactViewRefSchema = z.object({
  view_id: IdentifierSchema,
  revision: z.number().int().positive(),
}).strict();

export const ViewSearchProjectionFieldSchema = z.object({
  path: z.string().trim().regex(/^\/(?:[^/~]|~[01]|\/)*$/u, "search projection path must be an RFC 6901-compatible JSON Pointer"),
  category: z.enum(["title", "text", "identifier", "url", "timestamp", "provenance"]),
}).strict();

export const ViewSearchProjectionSchema = z.object({
  version: z.literal(1),
  fields: z.array(ViewSearchProjectionFieldSchema).min(1).max(64),
}).strict().superRefine((value, context) => {
  const identities = value.fields.map(field => `${field.category}:${field.path}`);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fields"],
      message: "search projection fields must be unique by category and path",
    });
  }
});

const ViewSearchProjectionShape = {
  search_projection: ViewSearchProjectionSchema.optional(),
} as const;

const FreeformViewSchemaRefSchema = z.object({
  name: IdentifierSchema,
  version: z.number().int().positive(),
  mode: z.literal("freeform"),
  ...ViewSearchProjectionShape,
}).strict();

const StrictViewSchemaRefSchema = z.object({
  name: IdentifierSchema,
  version: z.number().int().positive(),
  mode: z.literal("strict"),
  dialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
  json_schema: JsonValueSchema,
  ...ViewSearchProjectionShape,
}).strict();

export const ViewSchemaRefSchema = z.discriminatedUnion("mode", [
  FreeformViewSchemaRefSchema,
  StrictViewSchemaRefSchema,
]);

export const ContentDigestSchema = z.object({
  algorithm: IdentifierSchema,
  value: z.string().trim().min(1),
}).strict();

const RepresentationBaseShape = {
  kind: IdentifierSchema,
  media_type: z.string().trim().min(1).optional(),
  metadata: z.record(JsonValueSchema).default({}),
} as const;

const InlineRepresentationSchema = z.object({
  ...RepresentationBaseShape,
  form: z.literal("inline"),
  value: JsonValueSchema,
}).strict();

const ExternalReferenceRepresentationSchema = z.object({
  ...RepresentationBaseShape,
  form: z.literal("external_reference"),
  uri: z.string().trim().min(1),
  digest: ContentDigestSchema.optional(),
}).strict();

export const ViewRepresentationSchema = z.discriminatedUnion("form", [
  InlineRepresentationSchema,
  ExternalReferenceRepresentationSchema,
]);

export const MaterializationLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline") }).strict(),
  z.object({ kind: z.literal("uri"), uri: z.string().trim().min(1) }).strict(),
  z.object({
    kind: z.literal("content_addressed"),
    store: IdentifierSchema,
    key: z.string().trim().min(1),
  }).strict(),
]);

export const ViewMaterializationSchema = z.object({
  id: IdentifierSchema,
  format: IdentifierSchema,
  media_type: z.string().trim().min(1),
  location: MaterializationLocationSchema,
  digest: ContentDigestSchema.optional(),
}).strict();

export const ViewMaterializationManifestSchema = z.object({
  primary: ViewMaterializationSchema,
  alternatives: z.array(ViewMaterializationSchema).default([]),
}).strict().superRefine((value, context) => {
  const ids = [value.primary.id, ...value.alternatives.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "materialization ids must be unique",
      path: ["alternatives"],
    });
  }
});

export const ViewPolicySchema = z.object({
  owner: IdentifierSchema,
  visibility: z.enum(["private", "shared", "public"]),
  privacy: z.enum(["public", "private", "sensitive"]),
  retention: z.enum(["do_not_store", "session", "normal", "archive"]),
  allow_external_model: z.boolean(),
  allow_embedding: z.boolean(),
  /** Omitted legacy policies allow local search; explicit false is a hard non-weakening constraint. */
  allow_local_search: z.boolean().optional(),
  labels: z.array(IdentifierSchema).default([]),
}).strict();

export const SOURCE_TOMBSTONE_REPRESENTATION_KIND = "metaflow.source_tombstone";

export const SourceTombstoneRepresentationValueSchema = z.object({
  source_deleted: z.literal(true),
  reason: IdentifierSchema,
  changed_at: TimestampSchema,
}).strict();

export const CaptureProvenanceSchema = z.object({
  connector: IdentifierSchema,
  connection_id: IdentifierSchema,
  source_id: IdentifierSchema,
  source_kind: IdentifierSchema,
  identity: z.enum(["stable_source", "occurrence"]),
  assertion: z.enum(["direct", "source_derived"]),
}).strict();

export const ViewProvenanceSchema = z.object({
  inputs: z.array(ExactViewRefSchema).default([]),
  capture: CaptureProvenanceSchema.optional(),
  operator_run_id: IdentifierSchema.optional(),
  actor: IdentifierSchema,
  trace_id: IdentifierSchema.optional(),
}).strict();

export const ViewRelationTargetSchema = z.object({
  type: IdentifierSchema,
  target: ExactViewRefSchema,
  metadata: z.record(JsonValueSchema).default({}),
}).strict();

const ViewBaseShape = {
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(2_000),
  aliases: z.array(z.string().trim().min(1).max(500)).default([]),
  schema: ViewSchemaRefSchema,
  role: z.enum(["raw", "derived"]),
  time: z.object({
    observed_at: TimestampSchema.optional(),
    created_at: TimestampSchema,
  }).strict(),
  representation: ViewRepresentationSchema,
  materialization: ViewMaterializationManifestSchema,
  relations: z.array(ViewRelationTargetSchema).default([]),
  provenance: ViewProvenanceSchema,
  policy: ViewPolicySchema,
  metadata: z.record(JsonValueSchema).default({}),
} as const;

function enforceRoleProvenance(
  value: {
    role: "raw" | "derived";
    provenance: z.infer<typeof ViewProvenanceSchema>;
    representation: z.infer<typeof ViewRepresentationSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (value.role === "raw" && !value.provenance.capture) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Raw View provenance requires capture attribution",
      path: ["provenance", "capture"],
    });
  }
  if (value.role === "raw" && value.provenance.operator_run_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Raw Views cannot claim a Transformation Run",
      path: ["provenance", "operator_run_id"],
    });
  }
  if (value.role === "derived" && value.provenance.capture) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Derived Views reference captured inputs instead of claiming capture provenance",
      path: ["provenance", "capture"],
    });
  }
  if (value.representation.kind === SOURCE_TOMBSTONE_REPRESENTATION_KIND && value.role !== "raw") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only Raw Views can append a source tombstone revision",
      path: ["representation", "kind"],
    });
  }
}

export const ViewDraftSchema = z.object(ViewBaseShape).strict().superRefine(enforceRoleProvenance);

export const ViewRevisionSchema = z.object({
  ...ViewBaseShape,
  revision: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  enforceRoleProvenance(value, context);
  if (value.policy.retention === "do_not_store") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A committed View revision cannot use do_not_store retention",
      path: ["policy", "retention"],
    });
  }
});

export const ViewSchema = ViewRevisionSchema;

export const ViewRelationSchema = z.object({
  id: IdentifierSchema,
  type: IdentifierSchema,
  source: ExactViewRefSchema,
  target: ExactViewRefSchema,
  created_at: TimestampSchema,
  metadata: z.record(JsonValueSchema).default({}),
}).strict();

export type ExactViewRef = z.infer<typeof ExactViewRefSchema>;
export type ViewSearchProjectionField = z.infer<typeof ViewSearchProjectionFieldSchema>;
export type ViewSearchProjection = z.infer<typeof ViewSearchProjectionSchema>;
export type ViewSchemaRef = z.infer<typeof ViewSchemaRefSchema>;
export type ViewRepresentation = z.infer<typeof ViewRepresentationSchema>;
export type ViewMaterialization = z.infer<typeof ViewMaterializationSchema>;
export type ViewMaterializationManifest = z.infer<typeof ViewMaterializationManifestSchema>;
export type ViewPolicy = z.infer<typeof ViewPolicySchema>;
export type CaptureProvenance = z.infer<typeof CaptureProvenanceSchema>;
export type ViewProvenance = z.infer<typeof ViewProvenanceSchema>;
export type ViewRelationTarget = z.infer<typeof ViewRelationTargetSchema>;
export type ViewDraft = z.infer<typeof ViewDraftSchema>;
export type View = z.infer<typeof ViewRevisionSchema>;
export type ViewRelation = z.infer<typeof ViewRelationSchema>;

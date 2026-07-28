import { z } from "zod";
import {
  ExactViewRefSchema,
  JsonPointerSchema,
  JsonValueSchema,
  ViewMaterializationManifestSchema,
  ViewRepresentationSchema,
  type ViewSchemaRef,
} from "@info/view";

export const STRUCTURED_PARSER_REFS = {
  json: { parser_id: "parser.json", version: 1, abi_version: 1 },
  table: { parser_id: "parser.table", version: 1, abi_version: 1 },
  graph: { parser_id: "parser.graph", version: 1, abi_version: 1 },
  external_reference: { parser_id: "parser.external-reference", version: 1, abi_version: 1 },
} as const;

export type StructuredParserKind = keyof typeof STRUCTURED_PARSER_REFS;

export const ExactStructuredParserRefSchema = z.discriminatedUnion("parser_id", [
  exactParserRef(STRUCTURED_PARSER_REFS.json),
  exactParserRef(STRUCTURED_PARSER_REFS.table),
  exactParserRef(STRUCTURED_PARSER_REFS.graph),
  exactParserRef(STRUCTURED_PARSER_REFS.external_reference),
]);

export const StructuredParserLimitsSchema = z.object({
  max_input_bytes: z.number().int().min(1).max(8_000_000),
  max_fragments: z.number().int().min(1).max(4_096),
  max_fragment_bytes: z.number().int().min(1).max(1_000_000),
}).strict();

export const StructuredParserConfigurationSchema = z.object({
  parser: ExactStructuredParserRefSchema,
  limits: StructuredParserLimitsSchema,
}).strict();

export const StructuredFragmentLocationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("json_pointer"),
    path: JsonPointerSchema,
  }).strict(),
  z.object({
    kind: z.literal("table_cell"),
    path: JsonPointerSchema,
    row: z.number().int().nonnegative().max(4_095),
    column: z.number().int().nonnegative().max(4_095),
    row_id: z.string().trim().min(1).max(240).optional(),
    column_id: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({
    kind: z.literal("graph_element"),
    path: JsonPointerSchema,
    element_kind: z.enum(["node", "edge"]),
    element_id: z.string().trim().min(1).max(240),
    property: JsonPointerSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("external_reference"),
    path: JsonPointerSchema,
  }).strict(),
]);

export const StructuredViewFragmentSchema = z.object({
  contract_version: z.literal(2),
  kind: z.enum(["field", "table_cell", "graph_node", "graph_edge", "reference", "metadata"]),
  location: StructuredFragmentLocationSchema,
  content: z.object({ kind: z.literal("text"), text: z.string().min(1).max(1_000_000) }).strict(),
  metadata: z.record(JsonValueSchema).default({}),
}).strict();

export const StructuredParserInvocationSchema = z.object({
  contract_version: z.literal(2),
  parser: ExactStructuredParserRefSchema,
  run_id: z.string().trim().min(1).max(240),
  attempt_id: z.string().trim().min(1).max(240),
  input: z.object({
    ref: ExactViewRefSchema,
    representation: ViewRepresentationSchema,
    materialization: ViewMaterializationManifestSchema,
  }).strict(),
  limits: StructuredParserLimitsSchema,
}).strict();

export const StructuredParserResultSchema = z.object({
  contract_version: z.literal(2),
  source: ExactViewRefSchema,
  fragments: z.array(StructuredViewFragmentSchema).max(4_096),
  diagnostics: z.object({
    parser: ExactStructuredParserRefSchema,
    warnings: z.array(z.object({
      code: z.string().trim().min(1).max(240),
      message: z.string().trim().min(1).max(2_000),
      location: JsonValueSchema.optional(),
    }).strict()).max(100),
  }).strict(),
}).strict();

export type ExactStructuredParserRef = z.infer<typeof ExactStructuredParserRefSchema>;
export type StructuredParserLimits = z.infer<typeof StructuredParserLimitsSchema>;
export type StructuredParserConfiguration = z.infer<typeof StructuredParserConfigurationSchema>;
export type StructuredFragmentLocation = z.infer<typeof StructuredFragmentLocationSchema>;
export type StructuredViewFragment = z.infer<typeof StructuredViewFragmentSchema>;
export type StructuredParserInvocation = z.infer<typeof StructuredParserInvocationSchema>;
export type StructuredParserResult = z.infer<typeof StructuredParserResultSchema>;

const exactRefJsonSchema = {
  type: "object",
  required: ["view_id", "revision"],
  additionalProperties: false,
  properties: {
    view_id: { type: "string", minLength: 1, maxLength: 240 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

const jsonPointerSchema = { type: "string", pattern: "^/(?:[^/~]|~[01]|/)*$" } as const;
const optionalId = { type: "string", minLength: 1, maxLength: 240 } as const;

export const STRUCTURED_FRAGMENT_SET_SCHEMA: ViewSchemaRef = {
  name: "metaflow.view.fragment-set",
  version: 2,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: JsonValueSchema.parse({
    type: "object",
    required: ["contract_version", "parser", "sources", "fragments", "diagnostics"],
    additionalProperties: false,
    properties: {
      contract_version: { const: 2 },
      parser: {
        oneOf: Object.values(STRUCTURED_PARSER_REFS).map(parser => ({
          type: "object",
          required: ["parser_id", "version", "abi_version"],
          additionalProperties: false,
          properties: {
            parser_id: { const: parser.parser_id },
            version: { const: parser.version },
            abi_version: { const: parser.abi_version },
          },
        })),
      },
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          required: ["relation", "view"],
          additionalProperties: false,
          properties: { relation: { const: "derived_from" }, view: exactRefJsonSchema },
        },
      },
      fragments: {
        type: "array",
        maxItems: 4_096,
        items: fragmentJsonSchema(),
      },
      diagnostics: {
        type: "object",
        required: ["warnings"],
        additionalProperties: false,
        properties: {
          warnings: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              required: ["code", "message"],
              additionalProperties: false,
              properties: {
                code: optionalId,
                message: { type: "string", minLength: 1, maxLength: 2_000 },
                location: {},
              },
            },
          },
        },
      },
    },
  }),
  relation_projection: {
    version: 1,
    entries_path: "/sources",
    ref_path: "/view",
    discriminator_path: "/relation",
    mappings: [{ discriminator: "derived_from", relation_type: "derived_from", metadata: {} }],
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/representation/value/fragments/*/content/text", category: "text" },
    ],
  },
};

export function structuredParserKind(ref: ExactStructuredParserRef): StructuredParserKind {
  const entry = Object.entries(STRUCTURED_PARSER_REFS).find(([, candidate]) => candidate.parser_id === ref.parser_id);
  if (!entry) throw new TypeError(`Unknown structured Parser: ${ref.parser_id}`);
  return entry[0] as StructuredParserKind;
}

function exactParserRef<const T extends {
  parser_id: string;
  version: number;
  abi_version: number;
}>(ref: T) {
  return z.object({
    parser_id: z.literal(ref.parser_id),
    version: z.literal(ref.version),
    abi_version: z.literal(ref.abi_version),
  }).strict();
}

function fragmentJsonSchema() {
  return {
    type: "object",
    required: ["contract_version", "kind", "location", "content", "metadata"],
    additionalProperties: false,
    properties: {
      contract_version: { const: 2 },
      kind: { enum: ["field", "table_cell", "graph_node", "graph_edge", "reference", "metadata"] },
      location: {
        oneOf: [
          {
            type: "object",
            required: ["kind", "path"],
            additionalProperties: false,
            properties: { kind: { const: "json_pointer" }, path: jsonPointerSchema },
          },
          {
            type: "object",
            required: ["kind", "path", "row", "column", "column_id"],
            additionalProperties: false,
            properties: {
              kind: { const: "table_cell" },
              path: jsonPointerSchema,
              row: { type: "integer", minimum: 0, maximum: 4_095 },
              column: { type: "integer", minimum: 0, maximum: 4_095 },
              row_id: optionalId,
              column_id: optionalId,
            },
          },
          {
            type: "object",
            required: ["kind", "path", "element_kind", "element_id"],
            additionalProperties: false,
            properties: {
              kind: { const: "graph_element" },
              path: jsonPointerSchema,
              element_kind: { enum: ["node", "edge"] },
              element_id: optionalId,
              property: jsonPointerSchema,
            },
          },
          {
            type: "object",
            required: ["kind", "path"],
            additionalProperties: false,
            properties: { kind: { const: "external_reference" }, path: jsonPointerSchema },
          },
        ],
      },
      content: {
        type: "object",
        required: ["kind", "text"],
        additionalProperties: false,
        properties: {
          kind: { const: "text" },
          text: { type: "string", minLength: 1, maxLength: 1_000_000 },
        },
      },
      metadata: { type: "object" },
    },
  } as const;
}

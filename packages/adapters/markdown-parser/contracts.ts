import { z } from "zod";
import {
  ExactViewRefSchema,
  JsonValueSchema,
  ViewRepresentationSchema,
  type ViewSchemaRef,
} from "@info/view";

export const MARKDOWN_PARSER_REF = {
  parser_id: "parser.markdown",
  version: 1,
  abi_version: 1,
} as const;

export const ExactParserRefSchema = z.object({
  parser_id: z.string().trim().min(1).max(240),
  version: z.number().int().positive(),
  abi_version: z.literal(1),
}).strict();

export const ParserLimitsSchema = z.object({
  max_input_bytes: z.number().int().min(1).max(8_000_000),
  max_fragments: z.number().int().min(1).max(4_096),
  max_fragment_bytes: z.number().int().min(1).max(1_000_000),
}).strict();

export const MarkdownParserConfigurationSchema = z.object({
  parser: z.object({
    parser_id: z.literal(MARKDOWN_PARSER_REF.parser_id),
    version: z.literal(MARKDOWN_PARSER_REF.version),
    abi_version: z.literal(MARKDOWN_PARSER_REF.abi_version),
  }).strict(),
  limits: ParserLimitsSchema,
}).strict();

export const ViewFragmentLocationSchema = z.object({
  kind: z.literal("text_range"),
  path: z.string().regex(/^\/(?:[^/~]|~[01]|\/)*$/u),
  start: z.number().int().nonnegative().max(8_000_000),
  length: z.number().int().nonnegative().max(8_000_000),
}).strict();

export const ViewFragmentSchema = z.object({
  contract_version: z.literal(1),
  kind: z.enum(["text", "title", "code", "table", "metadata"]),
  location: ViewFragmentLocationSchema,
  content: z.object({ kind: z.literal("text"), text: z.string().min(1).max(1_000_000) }).strict(),
  metadata: z.record(JsonValueSchema).default({}),
}).strict();

export const ParserInvocationSchema = z.object({
  contract_version: z.literal(1),
  parser: ExactParserRefSchema,
  run_id: z.string().trim().min(1).max(240),
  attempt_id: z.string().trim().min(1).max(240),
  input: z.object({
    ref: ExactViewRefSchema,
    representation: ViewRepresentationSchema,
  }).strict(),
  limits: ParserLimitsSchema,
}).strict();

export const ParserResultSchema = z.object({
  contract_version: z.literal(1),
  source: ExactViewRefSchema,
  fragments: z.array(ViewFragmentSchema).max(4_096),
  diagnostics: z.object({
    parser: ExactParserRefSchema,
    warnings: z.array(z.object({
      code: z.string().trim().min(1).max(240),
      message: z.string().trim().min(1).max(2_000),
      location: JsonValueSchema.optional(),
    }).strict()).max(100),
  }).strict(),
}).strict();

export type ExactParserRef = z.infer<typeof ExactParserRefSchema>;
export type ParserLimits = z.infer<typeof ParserLimitsSchema>;
export type MarkdownParserConfiguration = z.infer<typeof MarkdownParserConfigurationSchema>;
export type ViewFragment = z.infer<typeof ViewFragmentSchema>;
export type ParserInvocation = z.infer<typeof ParserInvocationSchema>;
export type ParserResult = z.infer<typeof ParserResultSchema>;

const exactRefJsonSchema = {
  type: "object",
  required: ["view_id", "revision"],
  additionalProperties: false,
  properties: {
    view_id: { type: "string", minLength: 1, maxLength: 240 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

export const MARKDOWN_FRAGMENT_SET_SCHEMA: ViewSchemaRef = {
  name: "metaflow.view.fragment-set",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: JsonValueSchema.parse({
    type: "object",
    required: ["contract_version", "parser", "sources", "fragments", "diagnostics"],
    additionalProperties: false,
    properties: {
      contract_version: { const: 1 },
      parser: {
        type: "object",
        required: ["parser_id", "version", "abi_version"],
        additionalProperties: false,
        properties: {
          parser_id: { const: MARKDOWN_PARSER_REF.parser_id },
          version: { const: MARKDOWN_PARSER_REF.version },
          abi_version: { const: MARKDOWN_PARSER_REF.abi_version },
        },
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
        maxItems: 4096,
        items: {
          type: "object",
          required: ["contract_version", "kind", "location", "content", "metadata"],
          additionalProperties: false,
          properties: {
            contract_version: { const: 1 },
            kind: { enum: ["text", "title", "code", "table", "metadata"] },
            location: {
              type: "object",
              required: ["kind", "path", "start", "length"],
              additionalProperties: false,
              properties: {
                kind: { const: "text_range" },
                path: { type: "string", pattern: "^/(?:[^/~]|~[01]|/)*$" },
                start: { type: "integer", minimum: 0, maximum: 8_000_000 },
                length: { type: "integer", minimum: 0, maximum: 8_000_000 },
              },
            },
            content: {
              type: "object",
              required: ["kind", "text"],
              additionalProperties: false,
              properties: { kind: { const: "text" }, text: { type: "string", minLength: 1, maxLength: 1_000_000 } },
            },
            metadata: { type: "object" },
          },
        },
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
                code: { type: "string", minLength: 1, maxLength: 240 },
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

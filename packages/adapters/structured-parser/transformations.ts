import { parseTransformation, type Transformation } from "@info/transformation";
import { STRUCTURED_FRAGMENT_SET_SCHEMA, STRUCTURED_PARSER_REFS, type StructuredParserKind } from "./contracts.js";
import { STRUCTURED_PARSER_FUNCTIONS } from "./operator.js";

const createdAt = "2026-07-27T00:00:00.000Z";
const inputSchemas = {
  json: "content.json.document",
  table: "content.table",
  graph: "content.property_graph",
  external_reference: "content.external_reference",
} as const;

export const structuredParserTransformations = Object.fromEntries(
  (Object.keys(STRUCTURED_PARSER_REFS) as StructuredParserKind[]).map(kind => [kind, parserTransformation(kind)]),
) as Record<StructuredParserKind, Transformation>;

export function structuredParserTransformation(kind: StructuredParserKind): Transformation {
  return structuredClone(structuredParserTransformations[kind]);
}

function parserTransformation(kind: StructuredParserKind): Transformation {
  const parser = STRUCTURED_PARSER_REFS[kind];
  return parseTransformation({
    id: `transformation.${parser.parser_id}`,
    revision: 1,
    name: `Project ${kind.replaceAll("_", " ")} View into search fragments`,
    instruction: {
      format: "natural_language",
      language: "en",
      text: "Project one exact committed View into deterministic bounded search fragments without fetching or mutating the source.",
      parameters: {},
    },
    operator: {
      id: `operator.${parser.parser_id}`,
      revision: 1,
      reference: STRUCTURED_PARSER_FUNCTIONS[kind],
      configuration: {
        parser,
        limits: {
          max_input_bytes: 8_000_000,
          max_fragments: 4_096,
          max_fragment_bytes: 1_000_000,
        },
      },
      required_capabilities: [],
    },
    inputs: [{
      role: "source",
      required: true,
      sources: [{
        kind: "selector",
        selector: {
          id: `selector.${parser.parser_id}`,
          revision: 1,
          query: {
            scope: "matching",
            schema_names: [inputSchemas[kind]],
            roles: ["raw", "derived"],
            revision_scope: "latest",
            order: "newest",
            limit: 1,
            where: { "schema.version": 1 },
          },
        },
      }],
    }],
    output: {
      schema: STRUCTURED_FRAGMENT_SET_SCHEMA,
      schema_origin: "declared",
      cardinality: { min: 1, max: 1 },
    },
    policy: {
      id: `policy.${parser.parser_id}.view_access`,
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    budget: {
      id: `budget.${parser.parser_id}`,
      revision: 1,
      limits: { timeout_ms: 10_000, max_attempts: 1 },
      extensions: {},
    },
    created_at: createdAt,
    metadata: {
      processor_kind: "parser",
      parser_id: parser.parser_id,
      parser_version: parser.version,
      parser_abi_version: parser.abi_version,
      deterministic: true,
    },
  });
}

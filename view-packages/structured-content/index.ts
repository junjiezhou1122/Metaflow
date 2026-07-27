import { defineViewPackage } from "@info/view-package";

const nonEmptyString = { type: "string", minLength: 1, maxLength: 240 } as const;
const jsonValue = {
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: {} },
    { type: "object" },
  ],
} as const;

export const structuredContentSchemas = {
  json: {
    name: "content.json.document",
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: {},
  },
  table: {
    name: "content.table",
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["columns", "rows"],
      properties: {
        columns: {
          type: "array",
          maxItems: 4_096,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: nonEmptyString, label: nonEmptyString },
          },
        },
        rows: {
          type: "array",
          maxItems: 4_096,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["cells"],
            properties: {
              id: nonEmptyString,
              cells: { type: "array", maxItems: 4_096, items: jsonValue },
            },
          },
        },
      },
    },
  },
  graph: {
    name: "content.property_graph",
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["nodes", "edges"],
      properties: {
        nodes: {
          type: "array",
          maxItems: 4_096,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: nonEmptyString, label: nonEmptyString, properties: { type: "object" } },
          },
        },
        edges: {
          type: "array",
          maxItems: 4_096,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "source", "target"],
            properties: {
              id: nonEmptyString,
              source: nonEmptyString,
              target: nonEmptyString,
              label: nonEmptyString,
              properties: { type: "object" },
            },
          },
        },
      },
    },
  },
  external_reference: {
    name: "content.external_reference",
    version: 1,
    mode: "strict",
    dialect: "https://json-schema.org/draft/2020-12/schema",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: { type: "string", minLength: 1 },
        media_type: { type: "string", minLength: 1 },
        digest: {
          type: "object",
          additionalProperties: false,
          required: ["algorithm", "value"],
          properties: { algorithm: nonEmptyString, value: { type: "string", minLength: 1 } },
        },
        metadata: { type: "object" },
      },
    },
  },
} as const;

export const structuredContentSchemaKeys = Object.fromEntries(
  Object.entries(structuredContentSchemas).map(([kind, schema]) => [kind, { name: schema.name, version: schema.version }]),
) as {
  [Kind in keyof typeof structuredContentSchemas]: {
    name: (typeof structuredContentSchemas)[Kind]["name"];
    version: 1;
  };
};

const parserDeclarations = [
  ["json", "parser.json", "json_document", "transformation.parser.json"],
  ["table", "parser.table", "data_table", "transformation.parser.table"],
  ["graph", "parser.graph", "property_graph", "transformation.parser.graph"],
  ["external_reference", "parser.external-reference", "external_resource", "transformation.parser.external-reference"],
] as const;

export const structuredContentViewPackage = defineViewPackage({
  manifest_version: 1,
  id: "view-package.structured-content",
  version: 1,
  name: "Structured Content",
  description: "Strict heterogeneous Views with exact Parser Transformations into committed search fragments.",
  schemas: Object.values(structuredContentSchemas),
  representations: parserDeclarations.map(([kind, , representationKind]) => ({
    id: `representation.content.${kind}`,
    schema: structuredContentSchemaKeys[kind],
    forms: kind === "external_reference" ? ["external_reference" as const] : ["inline" as const],
    kinds: [representationKind],
    media_types: kind === "external_reference" ? [] : ["application/json"],
  })),
  materializations: parserDeclarations.map(([kind]) => ({
    id: `materialization.content.${kind}`,
    schema: structuredContentSchemaKeys[kind],
    formats: kind === "external_reference" ? ["external-reference"] : ["json"],
    media_types: kind === "external_reference" ? ["application/octet-stream"] : ["application/json"],
    locations: kind === "external_reference" ? ["uri" as const] : ["inline" as const, "content_addressed" as const],
  })),
  parsers: parserDeclarations.map(([kind, parserId, representationKind, transformationId]) => ({
    id: parserId,
    version: 1,
    abi_version: 1,
    input_schema: structuredContentSchemaKeys[kind],
    accepts: {
      forms: kind === "external_reference" ? ["external_reference" as const] : ["inline" as const],
      representation_kinds: [representationKind],
      media_types: kind === "external_reference" ? [] : ["application/json"],
    },
    transformation: { transformation_id: transformationId, revision: 1 },
    output_schema: { name: "metaflow.view.fragment-set", version: 2 },
    priority: 100,
  })),
  methods: Object.values(structuredContentSchemaKeys).flatMap(schema => [
    {
      id: `inspect.${schema.name}`,
      description: `Read one exact ${schema.name} View.`,
      schema,
      effect: "read" as const,
      target: { kind: "operation" as const, operation: "view.get" },
    },
    {
      id: `search.${schema.name}`,
      description: `Search committed Parser projections for an exact ${schema.name} View scope.`,
      schema,
      effect: "read" as const,
      target: { kind: "operation" as const, operation: "view.search" },
    },
  ]),
});

export const structuredContentFixtures = [
  {
    id: "fixture.content.json.learning",
    schema: structuredContentSchemaKeys.json,
    representation: {
      form: "inline",
      kind: "json_document",
      media_type: "application/json",
      value: { topic: "English learning", nested: { phrase: "spaced repetition" } },
      metadata: {},
    },
  },
  {
    id: "fixture.content.table.vocabulary",
    schema: structuredContentSchemaKeys.table,
    representation: {
      form: "inline",
      kind: "data_table",
      media_type: "application/json",
      value: {
        columns: [{ id: "phrase", label: "Phrase" }, { id: "status", label: "Status" }],
        rows: [{ id: "row:1", cells: ["spaced repetition", "learning"] }],
      },
      metadata: {},
    },
  },
  {
    id: "fixture.content.graph.learning",
    schema: structuredContentSchemaKeys.graph,
    representation: {
      form: "inline",
      kind: "property_graph",
      media_type: "application/json",
      value: {
        nodes: [{ id: "video", label: "YouTube lesson", properties: { topic: "English" } }],
        edges: [],
      },
      metadata: {},
    },
  },
  {
    id: "fixture.content.external-reference.video",
    schema: structuredContentSchemaKeys.external_reference,
    representation: {
      form: "external_reference",
      kind: "external_resource",
      media_type: "video/mp4",
      uri: "https://media.example.test/english-lesson.mp4",
      metadata: { title: "English lesson" },
    },
  },
] as const;

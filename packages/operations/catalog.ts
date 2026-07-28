import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { JsonValueSchema, type JsonObject, type JsonValue } from "@info/view";
import {
  OPERATION_DESCRIPTIONS,
  OPERATION_NAMES,
  OperationInputSchemas,
  OperationNameSchema,
  type OperationName,
} from "./contracts.js";

export const OperationEffectSchema = z.enum([
  "read",
  "write",
  "external_side_effect",
  "destructive",
]);

export type OperationEffect = z.infer<typeof OperationEffectSchema>;

export const OPERATION_EFFECTS: Record<OperationName, OperationEffect> = {
  "catalog.list": "read",
  "connector.list": "read",
  "connector.inspect": "read",
  "capture.ingest": "write",
  "capture.connection.list": "read",
  "capture.connection.create": "write",
  "capture.connection.check": "external_side_effect",
  "capture.connection.discover": "external_side_effect",
  "capture.connection.activate": "write",
  "capture.connection.update": "write",
  "capture.connection.pause": "write",
  "capture.connection.run": "external_side_effect",
  "capture.dlq.list": "read",
  "capture.dlq.replay": "external_side_effect",
  "view.get": "read",
  "view.graph.project": "read",
  "view.search": "read",
  "view.search.reindex": "write",
  "view.traverse": "read",
  "view.tombstone": "write",
  "view.authoring.request": "write",
  "view.authoring.propose": "external_side_effect",
  "view.authoring.inspect": "read",
  "view.authoring.approve": "write",
  "view.authoring.reject": "write",
  "view.authoring.apply": "external_side_effect",
  "transformation.submit": "write",
  "transformation.get": "read",
  "run.execute": "external_side_effect",
  "run.inspect": "read",
  "run.cancel": "destructive",
  "feedback.submit": "write",
  "feedback.apply": "write",
  "failure.inspect": "read",
  "policy.decision.get": "read",
  "privacy.forget.request": "destructive",
  "privacy.forget.execute": "destructive",
  "privacy.forget.inspect": "read",
  "trace.read": "read",
};

const AGENT_ACCESS_EXAMPLES: Partial<Record<OperationName, JsonValue>> = {
  "catalog.list": {},
  "view.get": {
    ref: { view_id: "view:example", revision: 1 },
  },
  "view.graph.project": {
    request: {
      roots: [{ view_id: "view:example", revision: 1 }],
      direction: "both",
      edge_types: ["application_member"],
      max_depth: 1,
      max_nodes: 100,
      max_edges: 250,
    },
  },
  "view.search": {
    request: {
      contract_version: 1,
      query: { text: "project decision" },
      scope: { kind: "all_visible", max_nodes: 100, max_scan: 1_000 },
      target: { envelope: true, internal: true, related_views: false },
      modes: ["keyword"],
      fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
      failure_mode: "require_all",
      page: { limit: 20 },
    },
  },
};

export const OperationCatalogEntrySchema = z.object({
  name: OperationNameSchema,
  description: z.string().trim().min(1),
  effect: OperationEffectSchema,
  read_only: z.boolean(),
  input_schema: z.record(JsonValueSchema),
  input_example: JsonValueSchema.optional(),
}).strict();

export type OperationCatalogEntry = z.infer<typeof OperationCatalogEntrySchema>;

export const OPERATION_INPUT_JSON_SCHEMAS: Readonly<Record<OperationName, JsonObject>> = Object.fromEntries(
  OPERATION_NAMES.map(name => [name, jsonSchemaFor(name)]),
) as Record<OperationName, JsonObject>;

export const OPERATION_CATALOG: readonly OperationCatalogEntry[] = OPERATION_NAMES.map(name => {
  const example = AGENT_ACCESS_EXAMPLES[name];
  if (example !== undefined) OperationInputSchemas[name].parse(example);
  return OperationCatalogEntrySchema.parse({
    name,
    description: OPERATION_DESCRIPTIONS[name],
    effect: OPERATION_EFFECTS[name],
    read_only: OPERATION_EFFECTS[name] === "read",
    input_schema: OPERATION_INPUT_JSON_SCHEMAS[name],
    ...(example === undefined ? {} : { input_example: example }),
  });
});

function jsonSchemaFor(operation: OperationName): JsonObject {
  const generated = zodToJsonSchema(OperationInputSchemas[operation], {
    $refStrategy: "root",
    target: "jsonSchema7",
  });
  if (!("type" in generated) && "anyOf" in generated) {
    return JsonValueSchema.parse({ ...generated, type: "object" }) as JsonObject;
  }
  return JsonValueSchema.parse(generated) as JsonObject;
}

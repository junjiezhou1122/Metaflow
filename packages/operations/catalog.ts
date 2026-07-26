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
  "capture.ingest": "write",
  "view.get": "read",
  "view.graph.project": "read",
  "view.search": "read",
  "view.search.reindex": "write",
  "view.traverse": "read",
  "view.tombstone": "write",
  "transformation.submit": "write",
  "transformation.get": "read",
  "run.execute": "external_side_effect",
  "run.inspect": "read",
  "run.cancel": "destructive",
  "feedback.submit": "write",
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
  input_schema: z.record(JsonValueSchema).optional(),
  input_example: JsonValueSchema.optional(),
}).strict();

export type OperationCatalogEntry = z.infer<typeof OperationCatalogEntrySchema>;

export const OPERATION_CATALOG: readonly OperationCatalogEntry[] = OPERATION_NAMES.map(name => {
  const example = AGENT_ACCESS_EXAMPLES[name];
  if (example !== undefined) OperationInputSchemas[name].parse(example);
  return OperationCatalogEntrySchema.parse({
    name,
    description: OPERATION_DESCRIPTIONS[name],
    effect: OPERATION_EFFECTS[name],
    read_only: OPERATION_EFFECTS[name] === "read",
    ...(example === undefined ? {} : { input_schema: jsonSchemaFor(name) }),
    ...(example === undefined ? {} : { input_example: example }),
  });
});

function jsonSchemaFor(operation: OperationName): JsonObject {
  return JsonValueSchema.parse(zodToJsonSchema(OperationInputSchemas[operation], {
    $refStrategy: "none",
    target: "jsonSchema7",
  })) as JsonObject;
}

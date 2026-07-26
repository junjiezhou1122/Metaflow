import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  TimestampSchema,
  type JsonValue,
  SOURCE_TOMBSTONE_REPRESENTATION_KIND,
  type View,
  type ViewSearchProjectionField,
} from "./schema.js";

export const VIEW_SEARCH_PROJECTION_IMPLEMENTATION_VERSION = 1 as const;

export const ViewSearchDocumentSchema = z.object({
  projection_version: z.literal(VIEW_SEARCH_PROJECTION_IMPLEMENTATION_VERSION),
  view_id: z.string().trim().min(1),
  revision: z.number().int().positive(),
  schema_name: z.string().trim().min(1),
  schema_version: z.number().int().positive(),
  title: z.array(z.string()),
  text: z.array(z.string()),
  identifiers: z.array(z.string()),
  urls: z.array(z.string()),
  timestamps: z.array(z.string()),
  provenance: z.array(z.string()),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type ViewSearchDocument = z.infer<typeof ViewSearchDocumentSchema>;

export function projectViewForSearch(view: View): ViewSearchDocument | undefined {
  const declaration = view.schema.search_projection;
  if (!declaration
    || view.policy.allow_local_search === false
    || view.representation.kind === SOURCE_TOMBSTONE_REPRESENTATION_KIND) return undefined;

  const projected = {
    title: [] as string[],
    text: [] as string[],
    identifiers: [] as string[],
    urls: [] as string[],
    timestamps: [] as string[],
    provenance: [] as string[],
  };
  const seen = new Map<keyof typeof projected, Set<string>>(
    (Object.keys(projected) as Array<keyof typeof projected>).map(category => [category, new Set<string>()]),
  );

  for (const field of declaration.fields) {
    const values = resolveSearchPath(view as unknown as JsonValue, field.path);
    for (const value of values) {
      const normalized = normalizeSearchValue(field, value, view);
      if (normalized === undefined) continue;
      const target = categoryTarget(field.category);
      const targetSeen = seen.get(target)!;
      if (!targetSeen.has(normalized)) {
        projected[target].push(normalized);
        targetSeen.add(normalized);
      }
    }
  }

  const base = {
    projection_version: VIEW_SEARCH_PROJECTION_IMPLEMENTATION_VERSION,
    view_id: view.id,
    revision: view.revision,
    schema_name: view.schema.name,
    schema_version: view.schema.version,
    ...projected,
  };
  return ViewSearchDocumentSchema.parse({
    ...base,
    digest: createHash("sha256").update(canonicalJson({ declaration, document: base })).digest("hex"),
  });
}

export function compileViewSearchMatchExpression(input: string): string {
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = [...new Set(tokens.map(token => token.toLocaleLowerCase("und")))];
  if (unique.length === 0) throw new TypeError("search text must contain at least one letter, number, or underscore token");
  return unique.map(token => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function resolveSearchPath(root: JsonValue, pointer: string): JsonValue[] {
  const tokens = pointer.slice(1).split("/").map(token => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let values: JsonValue[] = [root];
  for (const token of tokens) {
    const next: JsonValue[] = [];
    for (const value of values) {
      if (Array.isArray(value)) {
        if (token === "*") {
          next.push(...value);
          continue;
        }
        if (!/^(0|[1-9]\d*)$/u.test(token)) continue;
        const selected = value[Number(token)];
        if (selected !== undefined) next.push(selected);
        continue;
      }
      if (value !== null && typeof value === "object" && token !== "*") {
        const selected = value[token];
        if (selected !== undefined) next.push(selected);
      }
    }
    values = next;
  }
  return values;
}

function normalizeSearchValue(field: ViewSearchProjectionField, value: JsonValue, view: View): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new TypeError(
      `Search projection ${field.category}:${field.path} for ${view.id}@${view.revision} resolved to a non-scalar value`,
    );
  }
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (field.category === "url") {
    try {
      new URL(normalized);
    } catch (error) {
      throw new TypeError(`Search projection ${field.path} for ${view.id}@${view.revision} is not a valid URL`, { cause: error });
    }
  }
  if (field.category === "timestamp") TimestampSchema.parse(normalized);
  return normalized;
}

function categoryTarget(category: ViewSearchProjectionField["category"]):
  "title" | "text" | "identifiers" | "urls" | "timestamps" | "provenance" {
  if (category === "identifier") return "identifiers";
  if (category === "url") return "urls";
  if (category === "timestamp") return "timestamps";
  return category;
}

import {
  ExactViewRefSchema,
  type ExactViewRef,
  type ViewRelationTarget,
} from "@info/view";
import { defineViewPackage } from "@info/view-package";

export const APPLICATION_SPACE_REPRESENTATION_KIND = "application_space";
export const APPLICATION_SPACE_MEMBERSHIP_RELATION = "application_member";
export const APPLICATION_SPACE_COMPOSITION_RELATION = "application_composition";

export type ApplicationSpaceEntry = {
  ref: ExactViewRef;
  semantics: "membership" | "composition";
};

export const applicationSpaceSchema = {
  name: "application.space",
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "entries"],
    properties: {
      version: { const: 1 },
      entries: {
        type: "array",
        maxItems: 2_000,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "semantics"],
          properties: {
            ref: {
              type: "object",
              additionalProperties: false,
              required: ["view_id", "revision"],
              properties: {
                view_id: { type: "string", minLength: 1, maxLength: 240, pattern: "\\S" },
                revision: { type: "integer", minimum: 1 },
              },
            },
            semantics: { enum: ["membership", "composition"] },
          },
        },
      },
    },
  },
  relation_projection: {
    version: 1,
    entries_path: "/entries",
    ref_path: "/ref",
    discriminator_path: "/semantics",
    mappings: [
      {
        discriminator: "membership",
        relation_type: APPLICATION_SPACE_MEMBERSHIP_RELATION,
        metadata: { application_semantics: "membership" },
      },
      {
        discriminator: "composition",
        relation_type: APPLICATION_SPACE_COMPOSITION_RELATION,
        metadata: { application_semantics: "composition" },
      },
    ],
  },
  search_projection: {
    version: 1,
    fields: [
      { path: "/name", category: "title" },
      { path: "/purpose", category: "text" },
    ],
  },
} as const;

export const applicationSpaceSchemaKey = {
  name: applicationSpaceSchema.name,
  version: applicationSpaceSchema.version,
} as const;

export const applicationSpaceViewPackage = defineViewPackage({
  manifest_version: 1,
  id: "view-package.application-space",
  version: 1,
  name: "Application Space",
  description: "Ordinary immutable View graph roots with exact reusable entries and declared membership or composition semantics.",
  schemas: [applicationSpaceSchema],
  representations: [{
    id: "representation.application-space.graph-root",
    schema: applicationSpaceSchemaKey,
    forms: ["inline"],
    kinds: [APPLICATION_SPACE_REPRESENTATION_KIND],
    media_types: ["application/json"],
  }],
  materializations: [{
    id: "materialization.application-space.json",
    schema: applicationSpaceSchemaKey,
    formats: ["json"],
    media_types: ["application/json"],
    locations: ["inline", "content_addressed"],
  }],
  renderers: [{
    id: "renderer.web.json",
    version: 1,
    abi_version: 1,
    schema: applicationSpaceSchemaKey,
    surfaces: ["web", "generic"],
    representation_kinds: [APPLICATION_SPACE_REPRESENTATION_KIND],
    media_types: ["application/json"],
    priority: 10,
  }],
  methods: [
    {
      id: "inspect",
      description: "Read this exact immutable Application Space revision.",
      schema: applicationSpaceSchemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.get" },
    },
    {
      id: "project",
      description: "Project a bounded authorized graph from this exact Application Space revision.",
      schema: applicationSpaceSchemaKey,
      effect: "read",
      target: { kind: "operation", operation: "view.graph.project" },
    },
  ],
  evolutions: [],
});

export function normalizeApplicationSpaceEntries(entries: readonly ApplicationSpaceEntry[]): ApplicationSpaceEntry[] {
  const normalized = entries.map(entry => {
    if (entry.semantics !== "membership" && entry.semantics !== "composition") {
      throw new TypeError("Application Space entry semantics must be membership or composition");
    }
    return {
      ref: ExactViewRefSchema.parse(entry.ref),
      semantics: entry.semantics,
    };
  });
  const identities = normalized.map(entryIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError("Application Space entries must be unique by exact ref and semantics");
  }
  return normalized.sort(compareEntries);
}

export function applicationSpaceRelations(entries: readonly ApplicationSpaceEntry[]): ViewRelationTarget[] {
  return normalizeApplicationSpaceEntries(entries).map(entry => ({
    type: entry.semantics === "membership"
      ? APPLICATION_SPACE_MEMBERSHIP_RELATION
      : APPLICATION_SPACE_COMPOSITION_RELATION,
    target: entry.ref,
    metadata: { application_semantics: entry.semantics },
  }));
}

const englishLearningEntries = normalizeApplicationSpaceEntries([
  { ref: { view_id: "view:learning:material", revision: 2 }, semantics: "membership" },
  { ref: { view_id: "view:learning:plan", revision: 1 }, semantics: "composition" },
]);

export const applicationSpaceFixtures = [{
  id: "fixture.application-space.english-learning",
  schema: applicationSpaceSchemaKey,
  representation: {
    form: "inline",
    kind: APPLICATION_SPACE_REPRESENTATION_KIND,
    media_type: "application/json",
    value: {
      version: 1,
      entries: englishLearningEntries,
    },
    metadata: {},
  },
  relations: applicationSpaceRelations(englishLearningEntries),
}] as const;

function entryIdentity(entry: ApplicationSpaceEntry): string {
  return `${entry.semantics}:${entry.ref.view_id}@${entry.ref.revision}`;
}

function compareEntries(left: ApplicationSpaceEntry, right: ApplicationSpaceEntry): number {
  return compareText(left.semantics, right.semantics)
    || compareText(left.ref.view_id, right.ref.view_id)
    || left.ref.revision - right.ref.revision;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

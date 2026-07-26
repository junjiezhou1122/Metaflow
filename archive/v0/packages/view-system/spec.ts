import type { ContextQuery, ContextView } from "@info/core";

export type ViewLifecycle = "ephemeral" | "session" | "project" | "long_term";

export type ViewProducerKind = "processor" | "agent" | "manual" | "runtime" | "legacy";
export type ViewWriteActor = "user" | "agent" | "processor" | "runtime" | "plugin" | "connector" | "system";
export type ViewStorageKind = "inline_json" | "markdown" | "artifact" | "external";

export type ViewSubjectSpec = {
  description?: string;
  examples?: Array<Record<string, unknown>>;
};

export type ViewProducerSpec = {
  id: string;
  kind: ViewProducerKind;
  description?: string;
};

export type ViewStorageSpec = {
  kind: ViewStorageKind;
  description?: string;
  content_key?: string;
  path_template?: string;
  artifact_kind?: string;
  uri_key?: string;
};

export type ViewConsumptionSpec = {
  observations?: string[];
  views?: string[];
};

export type ViewGraphOperation =
  | "create"
  | "update"
  | "fork"
  | "archive"
  | "delete"
  | "merge"
  | "split"
  | "promote"
  | "demote"
  | "supersede"
  | "diff"
  | "retain"
  | "retire";

export type ViewWritePolicySpec = {
  actor_agnostic?: boolean;
  allowed_actors?: readonly ViewWriteActor[];
  operations?: readonly ViewGraphOperation[];
  requires_provenance?: boolean;
  default_status_by_actor?: Partial<Record<ViewWriteActor, NonNullable<ContextView["status"]>>>;
};

export type ViewAliasSpec = {
  canonical: string;
  reason?: string;
};

export type ViewSpec = {
  view_type: string;
  title: string;
  purpose: string;
  lifecycle: ViewLifecycle;
  subject?: ViewSubjectSpec;
  producers?: ViewProducerSpec[];
  storage?: ViewStorageSpec;
  write_policy?: ViewWritePolicySpec;
  consumes?: ViewConsumptionSpec;
  content_schema?: unknown;
  examples?: Array<Partial<ContextView> & { view_type?: string }>;
  default_query?: Partial<ContextQuery>;
  tags?: string[];
  aliases?: readonly string[];
  alias_of?: ViewAliasSpec;
  graph_operations?: readonly ViewGraphOperation[];
  metadata?: Record<string, unknown>;
};

export type LegacyViewFamilyDefinition = {
  view_type: string;
  label: string;
  purpose: string;
  category?: ViewFamilyCategory | string;
  producers?: string[];
  consumes?: ViewConsumptionSpec;
  default_page_size?: number;
  manual_create?: boolean;
  lifecycle?: ViewLifecycle;
  producer_ids?: string[];
  tags?: string[];
  aliases?: readonly string[];
  alias_of?: string;
  graph_operations?: readonly ViewGraphOperation[];
  storage?: ViewStorageSpec;
  write_policy?: ViewWritePolicySpec;
};

export type ViewFamilyCategory = "semantic" | "project" | "ambient" | "runtime" | "memory" | "manual" | "learning" | "core" | "misc";

export function namespaceOf(viewType: string): string {
  const index = viewType.indexOf(".");
  return index > 0 ? viewType.slice(0, index) : viewType;
}

export function normalizeViewSpec(spec: ViewSpec): ViewSpec {
  return {
    ...spec,
    view_type: spec.view_type.trim(),
    storage: normalizeViewStorage(spec.storage),
    write_policy: normalizeViewWritePolicy(spec.write_policy, spec.graph_operations),
    tags: [...new Set(spec.tags ?? [])].sort(),
  };
}

export function legacyViewFamilyToSpec(definition: LegacyViewFamilyDefinition): ViewSpec {
  return normalizeViewSpec({
    view_type: definition.view_type,
    title: definition.label,
    purpose: definition.purpose,
    lifecycle: definition.lifecycle ?? lifecycleForLegacyCategory(definition.category),
    producers: (definition.producers ?? []).map(producer => ({
      id: definition.producer_ids?.find(id => id.includes(producer)) ?? `legacy.${producer}`,
      kind: "legacy",
    })),
    default_query: {
      view_types: [definition.view_type],
      limit: definition.default_page_size,
    },
    tags: [...new Set(["legacy", definition.category, ...(definition.tags ?? [])].filter((tag): tag is string => Boolean(tag)))],
    aliases: definition.aliases,
    alias_of: definition.alias_of ? { canonical: definition.alias_of } : undefined,
    graph_operations: definition.graph_operations,
    storage: definition.storage,
    write_policy: definition.write_policy,
    metadata: {
      legacy_category: definition.category,
      manual_create: definition.manual_create ?? false,
      default_page_size: definition.default_page_size,
      category: definition.category,
    },
  });
}

export function viewSpecToLegacyViewFamily(spec: ViewSpec): LegacyViewFamilyDefinition {
  const category = stringMetadata(spec.metadata?.category) ?? categoryForViewSpec(spec);
  const defaultLimit = typeof spec.default_query?.limit === "number" && Number.isFinite(spec.default_query.limit)
    ? Math.max(1, Math.floor(spec.default_query.limit))
    : undefined;
  return {
    view_type: spec.view_type,
    label: spec.title,
    purpose: spec.purpose,
    category,
    producers: legacyProducerKinds(spec),
    producer_ids: spec.producers?.map(producer => producer.id),
    consumes: spec.consumes,
    default_page_size: numberMetadata(spec.metadata?.default_page_size) ?? defaultLimit,
    manual_create: booleanMetadata(spec.metadata?.manual_create) ?? spec.producers?.some(producer => producer.kind === "manual") ?? false,
    lifecycle: spec.lifecycle,
    tags: spec.tags,
    aliases: spec.aliases,
    alias_of: spec.alias_of?.canonical,
    graph_operations: spec.graph_operations,
    storage: spec.storage,
    write_policy: spec.write_policy,
  };
}

export function viewStorageFor(spec: Pick<ViewSpec, "storage">): ViewStorageSpec {
  return normalizeViewStorage(spec.storage);
}

export function viewWritePolicyFor(spec: Pick<ViewSpec, "write_policy" | "graph_operations">): Required<Pick<ViewWritePolicySpec, "actor_agnostic" | "allowed_actors" | "operations" | "requires_provenance">> & Pick<ViewWritePolicySpec, "default_status_by_actor"> {
  return normalizeViewWritePolicy(spec.write_policy, spec.graph_operations);
}

export function canActorWriteView(spec: Pick<ViewSpec, "write_policy" | "graph_operations">, actor: ViewWriteActor): boolean {
  return viewWritePolicyFor(spec).allowed_actors.includes(actor);
}

const DEFAULT_VIEW_WRITE_ACTORS: readonly ViewWriteActor[] = ["user", "agent", "processor", "runtime", "plugin", "connector", "system"];

function normalizeViewStorage(storage?: ViewStorageSpec): ViewStorageSpec {
  return storage ?? { kind: "inline_json" };
}

function normalizeViewWritePolicy(writePolicy?: ViewWritePolicySpec, graphOperations?: readonly ViewGraphOperation[]) {
  const operations = writePolicy?.operations ?? graphOperations ?? [];
  return {
    actor_agnostic: writePolicy?.actor_agnostic ?? true,
    allowed_actors: [...new Set(writePolicy?.allowed_actors ?? DEFAULT_VIEW_WRITE_ACTORS)],
    operations,
    requires_provenance: writePolicy?.requires_provenance ?? true,
    default_status_by_actor: writePolicy?.default_status_by_actor,
  };
}

function legacyProducerKinds(spec: ViewSpec): string[] {
  const kinds = spec.producers?.map(producer => {
    if (producer.kind === "processor") return "compiler";
    return producer.kind;
  }) ?? [];
  return [...new Set(kinds)];
}

function categoryForViewSpec(spec: ViewSpec): ViewFamilyCategory {
  const tags = new Set(spec.tags ?? []);
  if (tags.has("core") || spec.view_type === "state.surface" || spec.view_type === "work.focus_set") return "core";
  if (spec.view_type.startsWith("project.") || spec.view_type === "project_timeline" || spec.view_type === "thread.active_work") return "project";
  if (spec.view_type.startsWith("memory.") || spec.view_type === "memory" || spec.view_type === "agent.case_memory") return "memory";
  if (spec.view_type.startsWith("learning.")) return "learning";
  if (spec.view_type.startsWith("task.") || spec.view_type.startsWith("draft.") || spec.view_type.startsWith("advice.") || spec.view_type.startsWith("brief.") || spec.view_type.startsWith("research.") || spec.view_type.startsWith("writing.") || spec.view_type.startsWith("opportunity.")) return "ambient";
  if (spec.lifecycle === "ephemeral" || spec.lifecycle === "session") return "runtime";
  return "misc";
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanMetadata(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function lifecycleForLegacyCategory(category?: string): ViewLifecycle {
  if (category === "memory") return "long_term";
  if (category === "runtime" || category === "ambient") return "session";
  if (category === "project") return "project";
  return "session";
}

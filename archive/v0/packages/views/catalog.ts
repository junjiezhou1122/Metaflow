import { builtinViewSpecs, viewSpecToLegacyViewFamily, type ViewFamilyCategory, type ViewStorageSpec, type ViewWritePolicySpec } from "@info/view-system";

export type ViewProducerKind = "compiler" | "program" | "runtime" | "manual" | "agent" | "legacy";
export type ViewGraphOperation = "create" | "update" | "fork" | "archive" | "delete" | "merge" | "split" | "promote" | "demote" | "supersede" | "diff" | "retain" | "retire";

export type ViewFamilyDefinition = {
  view_type: string;
  label: string;
  purpose: string;
  category: ViewFamilyCategory | string;
  producers: ViewProducerKind[];
  consumes?: {
    observations?: string[];
    views?: string[];
  };
  producer_ids?: string[];
  default_page_size?: number;
  manual_create?: boolean;
  lifecycle?: "ephemeral" | "session" | "project" | "long_term";
  tags?: string[];
  aliases?: string[];
  alias_of?: string;
  graph_operations?: ViewGraphOperation[];
  storage?: ViewStorageSpec;
  write_policy?: ViewWritePolicySpec;
};

// Compatibility bridge: new code owns the catalog in @info/view-system.
// Keep these exports while older server/UI code still imports @info/views/catalog.js.
export const VIEW_FAMILY_DEFINITIONS: readonly ViewFamilyDefinition[] = builtinViewSpecs()
  .map(spec => viewSpecToLegacyViewFamily(spec) as ViewFamilyDefinition);

export const VIEW_FAMILY_ORDER = VIEW_FAMILY_DEFINITIONS
  .filter(definition => !definition.alias_of)
  .map(definition => definition.view_type);

const VIEW_FAMILY_BY_TYPE = new Map(VIEW_FAMILY_DEFINITIONS.map(definition => [definition.view_type, definition]));
const VIEW_FAMILY_BY_ALIAS = new Map(
  VIEW_FAMILY_DEFINITIONS.flatMap(definition => [
    ...(definition.aliases ?? []).map(alias => [alias, definition] as const),
    ...(definition.alias_of ? [[definition.view_type, VIEW_FAMILY_BY_TYPE.get(definition.alias_of) ?? definition] as const] : []),
  ]),
);

export function viewFamilyDefinition(viewType: string): ViewFamilyDefinition | undefined {
  return VIEW_FAMILY_BY_TYPE.get(viewType) ?? VIEW_FAMILY_BY_ALIAS.get(viewType);
}

export function viewFamilyLabel(viewType: string): string {
  return viewFamilyDefinition(viewType)?.label ?? viewType;
}

export function viewFamilyPurpose(viewType: string): string {
  return viewFamilyDefinition(viewType)?.purpose ?? "view";
}

export function viewFamilyPageSize(viewType: string): number {
  return viewFamilyDefinition(viewType)?.default_page_size ?? 60;
}

export function manualViewFamilies(): ViewFamilyDefinition[] {
  return VIEW_FAMILY_DEFINITIONS.filter(definition => definition.manual_create);
}

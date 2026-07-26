import { legacyViewFamilyToSpec, namespaceOf, normalizeViewSpec, type LegacyViewFamilyDefinition, type ViewSpec } from "./spec.js";

export type ViewRegistry = {
  register(spec: ViewSpec): ViewRegistry;
  registerMany(specs: ViewSpec[]): ViewRegistry;
  mergeLegacy(definitions: LegacyViewFamilyDefinition[]): ViewRegistry;
  get(viewType: string): ViewSpec | undefined;
  has(viewType: string): boolean;
  list(options?: ViewSpecListOptions): ViewSpec[];
  namespaces(): string[];
};

export type ViewSpecListOptions = {
  namespace?: string;
  prefix?: string;
  tag?: string;
  lifecycle?: ViewSpec["lifecycle"];
};

export function createViewRegistry(initialSpecs: ViewSpec[] = []): ViewRegistry {
  const byType = new Map<string, ViewSpec>();

  const api: ViewRegistry = {
    register(spec) {
      const normalized = normalizeViewSpec(spec);
      if (!normalized.view_type) {
        throw new Error("ViewSpec.view_type is required");
      }
      byType.set(normalized.view_type, normalized);
      return api;
    },
    registerMany(specs) {
      for (const spec of specs) api.register(spec);
      return api;
    },
    mergeLegacy(definitions) {
      for (const definition of definitions) api.register(legacyViewFamilyToSpec(definition));
      return api;
    },
    get(viewType) {
      return byType.get(viewType);
    },
    has(viewType) {
      return byType.has(viewType);
    },
    list(options = {}) {
      return [...byType.values()]
        .filter(spec => {
          if (options.namespace && namespaceOf(spec.view_type) !== options.namespace) return false;
          if (options.prefix && !spec.view_type.startsWith(options.prefix)) return false;
          if (options.tag && !(spec.tags ?? []).includes(options.tag)) return false;
          if (options.lifecycle && spec.lifecycle !== options.lifecycle) return false;
          return true;
        })
        .sort((a, b) => a.view_type.localeCompare(b.view_type));
    },
    namespaces() {
      return [...new Set([...byType.keys()].map(namespaceOf))].sort();
    },
  };

  return api.registerMany(initialSpecs);
}

export function createDefaultViewRegistry(specs: ViewSpec[] = []): ViewRegistry {
  return createViewRegistry(specs);
}

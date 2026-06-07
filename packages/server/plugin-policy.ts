import { filterEventsForPlugin, filterRecordsForPlugin, filterViewsForPlugin, readPluginManifest } from "@info/core";
import { viewFamilyDefinition } from "@info/views/catalog.js";
import type { ContextArtifact, ContextRecord, ContextView, StoredContextRecord } from "@info/core";
import type { ContextStore } from "@info/core";
import type { collectViewProvenance } from "@info/runtime/view-provenance.js";
import { isHttpVisibleRecord } from "./http-util.js";

type PluginManifest = ReturnType<typeof readPluginManifest>;
type PolicyResult = { ok: true } | { ok: false; error: string };

export function canPluginWriteAgentTaskView(plugin: PluginManifest, viewType: string | undefined): PolicyResult {
  if (!plugin?.permissions?.allow_write_views) return { ok: false, error: "plugin cannot write views" };
  if (viewType && plugin.view_types_produced?.length && !plugin.view_types_produced.includes(viewType)) return { ok: false, error: "plugin cannot write this view_type" };
  return { ok: true };
}

export function filterArtifactsForPlugin<T extends Pick<ContextArtifact, "record_id">>(artifacts: T[], store: ContextStore, plugin?: PluginManifest): T[] {
  return artifacts.filter(artifact => {
    const record = store.getRecord(artifact.record_id);
    if (!record || !isHttpVisibleRecord(record)) return false;
    return Boolean(filterRecordsForPlugin([record], plugin)[0]);
  });
}

export function pluginCanWriteView(plugin: PluginManifest, view: ContextView, store: ContextStore): PolicyResult {
  if (!plugin?.permissions?.allow_write_views) return { ok: false, error: "plugin cannot write views" };
  if (plugin.view_types_produced?.length && !plugin.view_types_produced.includes(view.view_type)) return { ok: false, error: "plugin cannot write this view_type" };
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (!record) return { ok: false, error: "plugin cannot reference this view provenance" };
    if (record && !filterRecordsForPlugin([record], plugin).length) return { ok: false, error: "plugin cannot reference this view provenance" };
  }
  for (const id of view.source_views ?? []) {
    const sourceView = store.getView(id);
    if (!sourceView) return { ok: false, error: "plugin cannot reference this view provenance" };
    if (sourceView && !filterViewsForPlugin([sourceView], store, plugin).length) return { ok: false, error: "plugin cannot reference this view provenance" };
  }
  return { ok: true };
}

export function normalizeCreatedView(view: ContextView, options: { plugin_id?: string | null; source?: string }): ContextView {
  const definition = viewFamilyDefinition(view.view_type);
  const manual = options.source === "manual";
  return {
    ...view,
    scope: options.plugin_id ? { ...(view.scope ?? {}), plugin_id: options.plugin_id } : view.scope,
    compiler: manual && !view.compiler
      ? { id: "manual.create_view", version: "1", mode: "deterministic" }
      : view.compiler,
    metadata: {
      ...(view.metadata ?? {}),
      ...(definition ? {
        view_family: {
          label: definition.label,
          category: definition.category,
          producers: definition.producers,
          manual_create: Boolean(definition.manual_create),
        },
      } : {}),
      ...(manual ? { created_via: "manual_create_view" } : {}),
    },
  };
}

export function viewReferencesAllowedRecords(view: { source_records?: string[] }, store: ContextStore): boolean {
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !isHttpVisibleRecord(record)) return false;
  }
  return true;
}

export function viewReferencesExistingViews(view: { source_views?: string[] }, store: ContextStore): boolean {
  for (const id of view.source_views ?? []) {
    if (!store.getView(id)) return false;
  }
  return true;
}

export function viewScopeMatchesProvenance(view: { scope?: ContextView["scope"]; source_records?: string[]; source_views?: string[] }, store: ContextStore): boolean {
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (record && !scopeCompatible(view.scope, record.scope)) return false;
  }
  for (const id of view.source_views ?? []) {
    const sourceView = store.getView(id);
    if (sourceView && !scopeCompatible(view.scope, sourceView.scope)) return false;
  }
  return true;
}

export function scopeCompatible(target?: ContextView["scope"], source?: ContextView["scope"]): boolean {
  if (!target || !source) return true;
  for (const key of ["project", "project_path", "repo", "domain", "app", "session"] as const) {
    if (target[key] && source[key] && target[key] !== source[key]) return false;
  }
  return true;
}

export function pluginCanWriteEvent(plugin: PluginManifest, event: Record<string, unknown>, store: ContextStore): PolicyResult {
  if (!plugin) return { ok: false, error: "plugin cannot write events" };
  const allowedEventTypes = plugin.permissions?.allowed_event_types;
  if (!allowedEventTypes?.includes(String(event.event_type))) return { ok: false, error: "plugin cannot write this event_type" };
  const candidate = {
    ...event,
    plugin_id: plugin.id,
    id: "policy-check",
    created_at: new Date().toISOString(),
  } as any;
  for (const id of Array.isArray(candidate.related_records) ? candidate.related_records : []) {
    if (!store.getRecord(String(id))) return { ok: false, error: "plugin cannot reference this event context" };
  }
  for (const id of Array.isArray(candidate.related_views) ? candidate.related_views : []) {
    if (!store.getView(String(id))) return { ok: false, error: "plugin cannot reference this event context" };
  }
  if (!filterEventsForPlugin([candidate], store, plugin).length) return { ok: false, error: "plugin cannot reference this event context" };
  return { ok: true };
}

export function eventReferencesAllowedRecords(event: { related_records?: string[] }, store: ContextStore): boolean {
  for (const id of event.related_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !isHttpVisibleRecord(record)) return false;
  }
  return true;
}

export function eventReferencesAllowedViews(event: { related_views?: string[] }, store: ContextStore): boolean {
  for (const id of event.related_views ?? []) {
    const view = store.getView(id);
    if (!view || !filterViewsForPlugin([view], store)[0]) return false;
  }
  return true;
}

export function pluginCanWriteRecord(plugin: PluginManifest, record: ContextRecord): PolicyResult {
  if (!plugin) return { ok: false, error: "plugin cannot write records" };
  const candidate = {
    ...record,
    id: record.id ?? "policy-check",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as StoredContextRecord;
  if (!filterRecordsForPlugin([candidate], plugin).length) return { ok: false, error: "plugin cannot write this record" };
  return { ok: true };
}

export function filterViewProvenanceForPlugin(result: ReturnType<typeof collectViewProvenance>, store: ContextStore, plugin?: PluginManifest) {
  const views = filterViewsForPlugin(result.views, store, plugin);
  const allowedViewIds = new Set(views.map(view => view.id));
  const records = filterRecordsForPlugin(result.records, plugin)
    .filter(record => views.some(view => view.source_records?.includes(record.id) && allowedViewIds.has(view.id)));
  return { ...result, views, records };
}

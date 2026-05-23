import { ContextStore } from "./store.js";
import { mergePluginQuery, readPluginManifest } from "./plugins.js";
import type { ContextBrokerPack, ContextQuery, PluginManifest, StoredContextRecord, StoredContextView } from "./types.js";

export function buildContextPack(query: ContextQuery, store = new ContextStore()): ContextBrokerPack {
  const plugin = query.plugin_id ? readPluginManifest(query.plugin_id) : undefined;
  const effectiveQuery = mergePluginQuery(plugin, query);
  const mode = effectiveQuery.mode ?? inferMode(effectiveQuery);
  const limit = effectiveQuery.limit ?? 40;
  const includeRecords = effectiveQuery.include_records ?? true;
  const includeViews = effectiveQuery.include_views ?? true;
  const rawRecords = includeRecords ? store.queryRecords({ ...effectiveQuery, mode, limit }) : [];
  const rawViews = includeViews ? store.listViews({ view_types: effectiveQuery.view_types, limit, scope: effectiveQuery.scope, timeWindow: effectiveQuery.time_window }) : [];
  const records = applyRecordPermissions(rawRecords, plugin);
  const views = applyViewPermissions(rawViews, plugin);
  const clippedRecords = records.slice(0, limit);
  const clippedViews = views.slice(0, Math.max(0, limit - clippedRecords.length));

  return {
    version: 1,
    mode,
    goal: effectiveQuery.goal,
    query: effectiveQuery.query,
    plugin_id: effectiveQuery.plugin_id,
    generated_at: new Date().toISOString(),
    records: clippedRecords,
    views: clippedViews,
    markdown: renderBrokerMarkdown(effectiveQuery, clippedRecords, clippedViews),
    diagnostics: {
      mode,
      record_count: clippedRecords.length,
      view_count: clippedViews.length,
      thread_optional: true,
      provenance_required: true,
      plugin_loaded: Boolean(plugin),
      plugin_permissions: plugin?.permissions,
      effective_query: effectiveQuery,
    },
    sources: [
      ...clippedRecords.map(record => ({
        id: record.id,
        kind: "record" as const,
        title: record.content?.title,
        uri: `context://records/${record.id}`,
        observed_at: record.time?.observed_at,
        created_at: record.created_at,
      })),
      ...clippedViews.map(view => ({
        id: view.id,
        kind: "view" as const,
        title: view.title,
        uri: `context://views/${view.id}`,
        created_at: view.created_at,
      })),
    ],
  };
}


function applyRecordPermissions(records: StoredContextRecord[], plugin?: PluginManifest): StoredContextRecord[] {
  if (!plugin?.permissions) return records;
  const allowedSources = plugin.permissions.allowed_sources;
  const allowedSchemas = plugin.permissions.allowed_schemas;
  const maxPrivacy = plugin.permissions.max_privacy_level ?? "private";
  return records
    .filter(record => !allowedSources?.length || allowedSources.includes(record.source.type) || (record.source.connector ? allowedSources.includes(record.source.connector) : false))
    .filter(record => !allowedSchemas?.length || allowedSchemas.includes(record.schema.name))
    .filter(record => privacyAllowed(record.privacy?.level, maxPrivacy));
}

function applyViewPermissions(views: StoredContextView[], plugin?: PluginManifest): StoredContextView[] {
  if (!plugin?.permissions) return views;
  const allowedViewTypes = plugin.permissions.allowed_view_types;
  const maxPrivacy = plugin.permissions.max_privacy_level ?? "private";
  return views
    .filter(view => !allowedViewTypes?.length || allowedViewTypes.includes(view.view_type))
    .filter(view => privacyAllowed(view.privacy?.level, maxPrivacy));
}

function privacyAllowed(level: string | undefined, max: NonNullable<PluginManifest["permissions"]>["max_privacy_level"]): boolean {
  const rank = { public: 0, workspace: 1, private: 2, secret: 3 } as const;
  const current = rank[(level ?? "private") as keyof typeof rank] ?? 2;
  const ceiling = rank[(max ?? "private") as keyof typeof rank] ?? 2;
  return current <= ceiling;
}

function inferMode(query: ContextQuery): NonNullable<ContextQuery["mode"]> {
  if (query.thread_id) return "thread";
  if (query.scope?.project_path || query.scope?.project) return "workspace";
  if (query.query || query.goal) return "semantic";
  if (query.sources?.length || query.schemas?.length) return "source";
  return "timeline";
}

function renderBrokerMarkdown(query: ContextQuery, records: StoredContextRecord[], views: StoredContextView[]): string {
  const budget = query.token_budget ?? 6000;
  const maxChars = Math.max(1200, budget * 4);
  const parts: string[] = [
    "# Context Broker Pack",
    "",
    query.plugin_id ? `Plugin: ${query.plugin_id}` : "",
    query.goal ? `Goal: ${query.goal}` : "",
    query.query ? `Query: ${query.query}` : "",
    query.thread_id ? `Thread: ${query.thread_id}` : "Thread: optional / not required",
    "",
  ].filter(Boolean);

  if (views.length) {
    parts.push("## Views");
    for (const view of views) {
      parts.push(
        "",
        `### ${view.title ?? view.view_type}`,
        `- id: ${view.id}`,
        `- view_type: ${view.view_type}`,
        view.purpose ? `- purpose: ${view.purpose}` : "",
        view.confidence !== undefined ? `- confidence: ${view.confidence}` : "",
        view.summary ? `\n${view.summary}` : "",
      );
      if (parts.join("\n").length > maxChars) return parts.filter(Boolean).join("\n");
    }
  }

  if (records.length) {
    parts.push("", "## Observations");
    for (const record of records) {
      const text = (record.content?.text ?? JSON.stringify(record.payload ?? {})).replace(/\s+/g, " ").trim();
      parts.push(
        "",
        `### ${record.content?.title ?? record.schema.name}`,
        `- id: ${record.id}`,
        `- schema: ${record.schema.name}@v${record.schema.version}`,
        `- source: ${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
        record.content?.url ? `- url: ${record.content.url}` : "",
        record.content?.path ? `- path: ${record.content.path}` : "",
        `- time: ${record.time?.observed_at ?? record.created_at}`,
        text ? `\n${text.slice(0, 900)}${text.length > 900 ? "…" : ""}` : "",
      );
      if (parts.join("\n").length > maxChars) break;
    }
  }

  return parts.filter(Boolean).join("\n");
}

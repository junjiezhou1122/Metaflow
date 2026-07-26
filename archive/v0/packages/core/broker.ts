import { ContextStore } from "./store.js";
import { workThreadViewToMarkdown } from "./work-thread-view-markdown.js";
import { mergePluginQuery, readPluginManifest } from "./plugin-registry.js";
import { activeContextView } from "./view-lifecycle.js";
import { viewMatchesQuery } from "./view-query.js";
import { rankViewsForSurfacing, surfacingPreferencesFromMemoryViews } from "./view-surfacing.js";
import type { ContextBrokerPack, ContextQuery, PluginManifest, RuntimeEvent, StoredContextRecord, StoredContextView, StoredRuntimeEvent } from "./types.js";
import { analysisTextFromView, keyPointsFromView } from "./view-kinds.js";

export function buildContextPack(query: ContextQuery, store = new ContextStore()): ContextBrokerPack {
  const plugin = query.plugin_id ? readPluginManifest(query.plugin_id) : undefined;
  if (query.plugin_id && !plugin && !isRuntimePluginId(query.plugin_id)) return missingPluginPack(query);
  const effectiveQuery = mergePluginQuery(plugin, query);
  const mode = effectiveQuery.mode ?? inferMode(effectiveQuery);
  const limit = effectiveQuery.limit ?? 40;
  const includeRecords = effectiveQuery.include_records ?? true;
  const includeViews = effectiveQuery.include_views ?? true;
  const includeEvents = effectiveQuery.include_events ?? false;
  const allowExternalLlm = Boolean(effectiveQuery.allow_external_llm || plugin?.permissions?.allow_external_llm);
  const candidateLimit = contextPackCandidateLimit(limit, Boolean(plugin));
  const surfacingPreferences = surfacingPreferencesForDiagnostics(store, plugin);
  const rawViews = includeViews
    ? rankViewsForSurfacing(filterExternalDeniedViews(store, filterScopeConflictingViews(store, expandSourceViews(store, queryContextViews(store, effectiveQuery, candidateLimit, plugin), candidateLimit)), plugin, allowExternalLlm), surfacingPreferences)
    : [];
  const rawRecords = includeRecords ? mergeRecords(
    recordsForViews(store, rawViews, candidateLimit),
    store.queryRecords({ ...effectiveQuery, mode, limit: candidateLimit }),
  ) : [];
  const rawEvents = includeEvents ? store.listRuntimeEvents({
    event_types: effectiveQuery.event_types,
    actor_types: effectiveQuery.actor_types,
    plugin_id: effectiveQuery.plugin_id,
    limit: candidateLimit,
    timeWindow: effectiveQuery.time_window,
  }) : [];
  const views = applyViewPermissions(rawViews, plugin);
  const allowedViewIds = new Set(views.map(view => view.id));
  const records = applyRecordPermissions(
    rawRecords
      .filter(isContextPackRecord)
      .filter(record => recordAllowedByViewProvenance(record, rawViews, allowedViewIds)),
    plugin,
    allowExternalLlm,
  );
  const events = filterEventsForPlugin(rawEvents, store, plugin);
  const explicitViewQuery = Boolean(effectiveQuery.view_types?.length || effectiveQuery.view_type_prefix);
  const viewBudget = includeViews
    ? explicitViewQuery
      ? Math.min(limit, views.length)
      : includeRecords
        ? Math.min(5, Math.max(1, Math.ceil(limit * 0.25)))
        : limit
    : 0;
  const clippedViews = views.slice(0, viewBudget);
  const remainingAfterViews = Math.max(0, limit - clippedViews.length);
  const clippedRecords = records.slice(0, includeRecords ? remainingAfterViews : 0);
  const clippedEvents = events.slice(0, Math.max(0, remainingAfterViews - clippedRecords.length));

  const pack: ContextBrokerPack = {
    version: 1,
    mode,
    goal: effectiveQuery.goal,
    query: effectiveQuery.query,
    plugin_id: effectiveQuery.plugin_id,
    generated_at: new Date().toISOString(),
    records: clippedRecords,
    views: clippedViews,
    events: clippedEvents,
    markdown: renderBrokerMarkdown(effectiveQuery, clippedRecords, clippedViews, clippedEvents),
    diagnostics: {
      mode,
      record_count: clippedRecords.length,
      view_count: clippedViews.length,
      event_count: clippedEvents.length,
      view_priority: "active work_thread first, then recent matching views, then records",
      active_work_thread_view_id: store.getRuntimeState("active_work_thread_view")?.value?.view_id,
      thread_optional: true,
      provenance_required: true,
      plugin_loaded: Boolean(plugin),
      plugin_permissions: plugin?.permissions,
      allow_external_llm: allowExternalLlm,
      effective_query: effectiveQuery,
      surfacing_preferences: surfacingPreferences,
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
      ...clippedEvents.map(event => ({
        id: event.id,
        kind: "event" as const,
        title: event.event_type,
        uri: `context://events/${event.id}`,
        created_at: event.created_at,
      })),
    ],
  };
  if (effectiveQuery.plugin_id) {
    store.appendRuntimeEvent({
      event_type: "context_query_completed",
      actor: "plugin",
      status: "completed",
      subject_type: "query",
      plugin_id: effectiveQuery.plugin_id,
      related_records: clippedRecords.map(r => r.id),
      related_views: clippedViews.map(v => v.id),
      payload: { ...pack.diagnostics, event_ids: clippedEvents.map(e => e.id) },
    });
  }
  return pack;
}

function isRuntimePluginId(id: string): boolean {
  return id.startsWith("program.") || id.startsWith("capability.");
}

function missingPluginPack(query: ContextQuery): ContextBrokerPack {
  const generatedAt = new Date().toISOString();
  return {
    version: 1,
    mode: inferMode(query),
    goal: query.goal,
    query: query.query,
    plugin_id: query.plugin_id,
    generated_at: generatedAt,
    records: [],
    views: [],
    events: [],
    markdown: [
      "# Context Broker Pack",
      "",
      `Plugin: ${query.plugin_id}`,
      "",
      "No context returned: plugin not found.",
    ].join("\n"),
    diagnostics: {
      mode: inferMode(query),
      record_count: 0,
      view_count: 0,
      event_count: 0,
      plugin_loaded: false,
      error: `plugin not found: ${query.plugin_id}`,
      effective_query: query,
      surfacing_preferences: { show_more_view_types: [], show_less_view_types: [], source_view_ids: [] },
    },
    sources: [],
  };
}

function contextPackCandidateLimit(limit: number, pluginScoped: boolean): number {
  return pluginScoped ? Math.max(limit * 20, 200) : limit;
}

function queryContextViews(store: ContextStore, query: ContextQuery, limit: number, plugin?: PluginManifest): StoredContextView[] {
  const views: StoredContextView[] = [];
  const viewTypes = query.view_types;
  const wantsActiveWorkThread = (!viewTypes?.length && !query.view_type_prefix) || viewTypes?.includes("work_thread") || query.view_type_prefix === "work_thread";
  const activeViewId = typeof store.getRuntimeState("active_work_thread_view")?.value?.view_id === "string"
    ? store.getRuntimeState("active_work_thread_view")?.value.view_id as string
    : undefined;
  if (wantsActiveWorkThread && activeViewId) {
    const active = store.getView(activeViewId);
    if (active && activeContextView(active)) views.push(active);
  }

  const listed = rankViewsForSurfacing(store.listViews({ view_types: viewTypes, view_type_prefix: query.view_type_prefix, limit: Math.max(limit * 3, 20), scope: query.scope, timeWindow: query.time_window }), surfacingPreferences(store, plugin));
  for (const view of listed) {
    if (!activeContextView(view)) continue;
    if (query.query && !viewMatchesQuery(view, query.query)) continue;
    if (!views.some(existing => existing.id === view.id)) views.push(view);
  }
  return views.slice(0, Math.max(limit, 1));
}

function surfacingPreferencesForDiagnostics(store: ContextStore, plugin?: PluginManifest) {
  return surfacingPreferences(store, plugin);
}

export function surfacingPreferencesForPlugin(store: ContextStore, plugin?: PluginManifest) {
  return surfacingPreferences(store, plugin);
}

export function filterViewsForPlugin(views: StoredContextView[], store: ContextStore, plugin?: PluginManifest): StoredContextView[] {
  return applyViewPermissions(filterExternalDeniedViews(store, filterScopeConflictingViews(store, views), plugin), plugin);
}

export function filterRecordsForPlugin(records: StoredContextRecord[], plugin?: PluginManifest): StoredContextRecord[] {
  return applyRecordPermissions(records, plugin);
}

export function filterEventsForPlugin(events: StoredRuntimeEvent[], store: ContextStore, plugin?: PluginManifest): StoredRuntimeEvent[] {
  return applyEventPermissions(events, plugin)
    .filter(event => (event.related_records ?? []).every(id => {
      const record = store.getRecord(id);
      return Boolean(record && isBrokerVisibleRecord(record) && filterRecordsForPlugin([record], plugin)[0]);
    }))
    .filter(event => (event.related_views ?? []).every(id => {
      const view = store.getView(id);
      return Boolean(view && filterViewsForPlugin([view], store, plugin)[0]);
    }));
}

function isBrokerVisibleRecord(record: StoredContextRecord): boolean {
  return /^(observation|feedback)(\.|$)/.test(record.schema.name);
}

function surfacingPreferences(store: ContextStore, plugin?: PluginManifest) {
  const memories = store.listViews({ view_types: ["memory.surfacing_preference"], active_only: true, limit: plugin ? 200 : 50 })
    .filter(memory => controlMemoryAllowed(memory, store, plugin));
  return surfacingPreferencesFromMemoryViews(memories);
}

function controlMemoryAllowed(memory: StoredContextView, store: ContextStore, plugin?: PluginManifest): boolean {
  if (!viewScopeMatchesProvenance(store, memory)) return false;
  if (!plugin?.permissions) return true;
  const maxPrivacy = plugin.permissions.max_privacy_level ?? "private";
  if (!privacyAllowed(memory.privacy?.level, maxPrivacy)) return false;
  if (plugin.permissions.allow_external_llm && memory.privacy?.allow_external_llm === false) return false;
  if (plugin.permissions.allow_external_reader && memory.privacy?.allow_external_reader === false) return false;
  return viewAllowsPluginProvenance(store, memory, plugin);
}


function recordsForViews(store: ContextStore, views: StoredContextView[], limit: number): StoredContextRecord[] {
  const records: StoredContextRecord[] = [];
  for (const view of views) {
    for (const id of view.source_records ?? []) {
      const record = store.getRecord(id);
      if (record) records.push(record);
      if (records.length >= limit) return mergeRecords(records);
    }
  }
  return mergeRecords(records);
}

function sourceViewsForViews(store: ContextStore, views: StoredContextView[], limit: number): StoredContextView[] {
  const sourceViews: StoredContextView[] = [];
  for (const view of views) {
    for (const id of view.source_views ?? []) {
      const sourceView = store.getView(id);
      if (sourceView && activeContextView(sourceView)) sourceViews.push(sourceView);
      if (sourceViews.length >= limit) return mergeViews(sourceViews);
    }
  }
  return mergeViews(sourceViews);
}

function expandSourceViews(store: ContextStore, views: StoredContextView[], limit: number): StoredContextView[] {
  let expanded = mergeViews(views);
  for (let depth = 0; depth < 3; depth += 1) {
    const previousCount = expanded.length;
    expanded = mergeViews(expanded, sourceViewsForViews(store, expanded, limit));
    if (expanded.length === previousCount || expanded.length >= limit) break;
  }
  return expanded.slice(0, Math.max(limit, 1));
}

function filterScopeConflictingViews(store: ContextStore, views: StoredContextView[]): StoredContextView[] {
  return views.filter(view => viewScopeMatchesProvenance(store, view));
}

function viewScopeMatchesProvenance(store: ContextStore, view: StoredContextView): boolean {
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !scopeCompatible(view.scope, record.scope)) return false;
  }
  for (const id of view.source_views ?? []) {
    const sourceView = store.getView(id);
    if (!sourceView || !scopeCompatible(view.scope, sourceView.scope)) return false;
  }
  return true;
}

function scopeCompatible(target?: StoredContextView["scope"], source?: StoredContextView["scope"]): boolean {
  if (!target || !source) return true;
  for (const key of ["project", "project_path", "repo", "domain", "app", "session"] as const) {
    if (target[key] && source[key] && target[key] !== source[key]) return false;
  }
  return true;
}

function mergeViews(...groups: StoredContextView[][]): StoredContextView[] {
  const byId = new Map<string, StoredContextView>();
  for (const view of groups.flat()) {
    const previous = byId.get(view.id);
    if (!previous || Date.parse(view.updated_at) >= Date.parse(previous.updated_at)) byId.set(view.id, view);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

function mergeRecords(...groups: StoredContextRecord[][]): StoredContextRecord[] {
  const byId = new Map<string, StoredContextRecord>();
  for (const record of groups.flat()) {
    const previous = byId.get(record.id);
    if (!previous || Date.parse(record.updated_at) >= Date.parse(previous.updated_at)) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.time?.observed_at ?? b.created_at) - Date.parse(a.time?.observed_at ?? a.created_at));
}

function recordAllowedByViewProvenance(record: StoredContextRecord, rawViews: StoredContextView[], allowedViewIds: Set<string>): boolean {
  const sourceViews = rawViews.filter(view => view.source_records?.includes(record.id));
  return sourceViews.every(view => allowedViewIds.has(view.id));
}

function isContextPackRecord(record: StoredContextRecord): boolean {
  return /^(observation|feedback)(\.|$)/.test(record.schema.name);
}

function applyRecordPermissions(records: StoredContextRecord[], plugin?: PluginManifest, allowExternalLlm = Boolean(plugin?.permissions?.allow_external_llm)): StoredContextRecord[] {
  const allowedSources = plugin?.permissions?.allowed_sources;
  const allowedSchemas = plugin?.permissions?.allowed_schemas;
  const maxPrivacy = plugin?.permissions?.max_privacy_level ?? "private";
  return records
    .filter(record => !allowedSources?.length || allowedSources.includes(record.source.type) || (record.source.connector ? allowedSources.includes(record.source.connector) : false))
    .filter(record => !allowedSchemas?.length || allowedSchemas.includes(record.schema.name))
    .filter(record => !plugin?.permissions || privacyAllowed(record.privacy?.level, maxPrivacy))
    .filter(record => !allowExternalLlm || record.privacy?.allow_external_llm !== false)
    .filter(record => !plugin?.permissions?.allow_external_reader || record.privacy?.allow_external_reader !== false);
}

function applyViewPermissions(views: StoredContextView[], plugin?: PluginManifest): StoredContextView[] {
  if (!plugin?.permissions) return views;
  const allowedViewTypes = plugin.permissions.allowed_view_types;
  const maxPrivacy = plugin.permissions.max_privacy_level ?? "private";
  return views
    .filter(view => !allowedViewTypes?.length || allowedViewTypes.includes(view.view_type))
    .filter(view => privacyAllowed(view.privacy?.level, maxPrivacy))
    .filter(view => !plugin.permissions?.allow_external_llm || view.privacy?.allow_external_llm !== false)
    .filter(view => !plugin.permissions?.allow_external_reader || view.privacy?.allow_external_reader !== false);
}

function filterExternalDeniedViews(store: ContextStore, views: StoredContextView[], plugin?: PluginManifest, allowExternalLlm = Boolean(plugin?.permissions?.allow_external_llm)): StoredContextView[] {
  if (!plugin?.permissions && !allowExternalLlm) return views;
  return views.filter(view => viewAllowsPluginProvenance(store, view, plugin, allowExternalLlm));
}

function viewAllowsPluginProvenance(store: ContextStore, view: StoredContextView, plugin?: PluginManifest, allowExternalLlm = Boolean(plugin?.permissions?.allow_external_llm), seen = new Set<string>(), depth = 0): boolean {
  const maxPrivacy = plugin?.permissions?.max_privacy_level ?? "private";
  if (plugin?.permissions && !privacyAllowed(view.privacy?.level, maxPrivacy)) return false;
  if (allowExternalLlm && view.privacy?.allow_external_llm === false) return false;
  if (plugin?.permissions?.allow_external_reader && view.privacy?.allow_external_reader === false) return false;
  if (depth > 3 || seen.has(view.id)) return true;
  seen.add(view.id);
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (allowExternalLlm && record?.privacy?.allow_external_llm === false) return false;
    if (plugin?.permissions?.allow_external_reader && record?.privacy?.allow_external_reader === false) return false;
    if (record && !applyRecordPermissions([record], plugin, allowExternalLlm).length) return false;
  }
  for (const id of view.source_views ?? []) {
    const sourceView = store.getView(id);
    if (sourceView && !viewAllowsPluginProvenance(store, sourceView, plugin, allowExternalLlm, seen, depth + 1)) return false;
  }
  return true;
}

function applyEventPermissions(events: StoredRuntimeEvent[], plugin?: PluginManifest): StoredRuntimeEvent[] {
  if (!plugin?.permissions) return events;
  const allowedEventTypes = plugin.permissions.allowed_event_types;
  return events.filter(event => !allowedEventTypes?.length || allowedEventTypes.includes(event.event_type));
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

function renderBrokerMarkdown(query: ContextQuery, records: StoredContextRecord[], views: StoredContextView[], events: StoredRuntimeEvent[]): string {
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
      const rendered = renderViewContent(view);
      if (rendered) parts.push("", rendered);
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
      if (parts.join("\n").length > maxChars) return parts.filter(Boolean).join("\n");
    }
  }

  if (events.length) {
    parts.push("", "## Runtime Events");
    for (const event of events) {
      parts.push(
        "",
        `### ${event.event_type}`,
        `- id: ${event.id}`,
        `- actor: ${event.actor}`,
        event.status ? `- status: ${event.status}` : "",
        event.subject_type ? `- subject: ${event.subject_type}${event.subject_id ? `/${event.subject_id}` : ""}` : "",
        event.plugin_id ? `- plugin: ${event.plugin_id}` : "",
        `- time: ${event.created_at}`,
        `- related: records=${event.related_records?.length ?? 0}, views=${event.related_views?.length ?? 0}, threads=${event.related_threads?.length ?? 0}`,
        Object.keys(event.payload ?? {}).length ? `\n${JSON.stringify(compactEventPayload(event), null, 2).slice(0, 700)}` : "",
      );
      if (parts.join("\n").length > maxChars) break;
    }
  }

  return parts.filter(Boolean).join("\n");
}

function renderViewContent(view: StoredContextView): string {
  if (view.view_type === "work_thread") return workThreadViewToMarkdown(view);
  const content = view.content ?? {};
  const lines: string[] = [];
  const analysis = analysisTextFromView(view);
  const keyPoints = keyPointsFromView(view, 8);
  if (analysis) {
    lines.push("#### Analysis", "", analysis);
  }
  if (keyPoints.length) {
    lines.push("", "#### Key points", "", ...keyPoints.map(point => `- ${String(point)}`));
  }
  if (Array.isArray(content.tags) && content.tags.length) {
    lines.push("", "#### Tags", "", content.tags.slice(0, 12).map(tag => `\`${String(tag)}\``).join(", "));
  }
  if (Array.isArray(content.next_actions) && content.next_actions.length) {
    lines.push("#### Next actions", "", ...content.next_actions.slice(0, 8).map(action => `- ${String(action)}`));
  }
  if (content.current_status && typeof content.current_status === "object") {
    lines.push("", "#### Current status", "", "```json", JSON.stringify(content.current_status, null, 2).slice(0, 1200), "```");
  }
  if (Array.isArray(content.evidence) && content.evidence.length) {
    lines.push("", "#### Evidence", "", ...content.evidence.slice(0, 8).map((item: any) => `- ${item.observed_at ?? ""} ${item.schema ?? ""} ${item.title ?? item.url ?? item.path ?? ""}`.trim()));
  }
  if (Array.isArray(content.related_records) && content.related_records.length) {
    lines.push("", "#### Related records", "", ...content.related_records.slice(0, 8).map((item: any) => {
      const label = item.title ?? item.url ?? item.path ?? item.id ?? "";
      return `- ${[item.schema, item.source, label].filter(Boolean).map(String).join(" · ")}`;
    }));
  }
  return lines.join("\n").trim();
}


function compactEventPayload(event: RuntimeEvent): Record<string, unknown> {
  const payload = event.payload ?? {};
  const compact: Record<string, unknown> = {};
  for (const key of ["schema", "source", "title", "view_type", "records_used", "vocabulary_count", "views_written", "bucket_count", "candidate_count", "error"] as const) {
    if (payload[key] !== undefined) compact[key] = payload[key];
  }
  return Object.keys(compact).length ? compact : payload;
}

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "./env.js";
import { ContextStore } from "@info/core";
import { ContextArtifactSchema, ContextConnectorSchema, ContextPackRequestSchema, ContextQuerySchema, ContextRecordSchema, ContextSchemaSchema, ContextViewSchema, FeedbackInputSchema, RuntimeEventSchema } from "@info/core";
import { enrichWithJinaReader, shouldAutoEnrichBrowserRecord } from "@info/sensors";
import { fetchScreenpipeFrameImage, fetchScreenpipeRecords } from "@info/sensors";
import { aiSessionRefToRecord, locateAiSessions } from "@info/sensors";
import { publicRuntimeSettings, runtimeSettings, runtimeStatus, runtimeTick, saveRuntimeSettings } from "@info/runtime/runtime.js";
import { compileObservationTimeline } from "@info/views/timeline/timeline.js";
import { compileActivityTimeline } from "@info/views/timeline/activity-timeline.js";
import { compileProjectTimeline } from "@info/views/timeline/project-timeline.js";
import { activeThreadId, interpretThread } from "@info/views/threads/thread-interpreter.js";
import { persistThreadEvidenceMap } from "@info/views/threads/thread-evidence.js";
import { mergeThreads, splitThread } from "@info/views/threads/thread-ops.js";
import { buildContextPack, filterEventsForPlugin, filterRecordsForPlugin, filterViewsForPlugin, surfacingPreferencesForPlugin } from "@info/core";
import { listPluginManifests, readPluginManifest } from "@info/core";
import { runLanguageLearningPlugin } from "@info/core";
import { createDefaultProgramRuntime, listDefaultCapabilities, listDefaultPrograms } from "@info/programs/registry.js";
import { signalFromObject } from "@info/programs/signals.js";
import { ingestFeedback } from "@info/runtime/feedback.js";
import { collectViewProvenance } from "@info/runtime/view-provenance.js";
import { filterViewsByQuery } from "@info/core";
import { rankViewsForSurfacing } from "@info/core";
import { VIEW_FAMILY_DEFINITIONS, VIEW_FAMILY_ORDER, manualViewFamilies, viewFamilyDefinition } from "@info/views/catalog.js";
import type { ContextArtifact, ContextPackRequest, ContextQuery, ContextRecord, ContextView, StoredContextRecord } from "@info/core";
import {
  artifactCandidateLimit, compactScope, contextRecordCandidateLimit, isHttpVisibleRecord, isPlainObject,
  latestViewCandidateLimit, nextViewCursor, pluginNotFoundBody, positiveInteger, readJson,
  recordSchemaIngestError, runtimeEventCandidateLimit, sanitizeHttpIngestRecord, scopeFromSearchParams,
  send, sendBytes, stringValue, summarizeViewForList, viewListCandidateLimit,
} from "./http-util.js";
import {
  cascadeDepth, cascadeGeneratedViews, contextQueryFromPackRequest, runClaudeAcpChat,
  summarizePackForChat, withDefaultAgentTaskContextPack, agentTaskOutputViewType,
  type ContextChatHttpBody,
} from "./agent-task-http.js";
import {
  canPluginWriteAgentTaskView, eventReferencesAllowedRecords, eventReferencesAllowedViews,
  filterArtifactsForPlugin, filterViewProvenanceForPlugin, normalizeCreatedView, pluginCanWriteEvent,
  pluginCanWriteRecord, pluginCanWriteView, viewReferencesAllowedRecords, viewReferencesExistingViews,
  viewScopeMatchesProvenance,
} from "./plugin-policy.js";

loadLocalEnv();

const port = Number(process.env.CONTEXT_HTTP_PORT ?? 3111);

export function createContextHttpHandler(store: ContextStore) {
  return async (req: any, res: any) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }

    const frameMatch = url.pathname.match(/^\/screenpipe\/frames\/([^/]+)$/);
    if (req.method === "GET" && frameMatch) {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot read raw Screenpipe frames", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const result = await fetchScreenpipeFrameImage(decodeURIComponent(frameMatch[1]));
      if (!result.ok) return send(res, result.status ?? 502, { ok: false, error: result.error });
      return sendBytes(res, 200, result.bytes, result.contentType);
    }

    if (req.method === "POST" && url.pathname === "/context/ingest") {
      const parsed = ContextRecordSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const schemaError = recordSchemaIngestError(parsed.data.schema.name);
      if (schemaError) return send(res, 400, { ok: false, error: schemaError });
      const pluginParam = url.searchParams.get("plugin_id") ?? parsed.data.scope?.plugin_id;
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      const withDefaults = store.withConnectorDefaults(parsed.data);
      const inputWithPluginScope = pluginParam
        ? { ...withDefaults, scope: { ...(withDefaults.scope ?? {}), plugin_id: pluginParam } }
        : withDefaults;
      const input = sanitizeHttpIngestRecord(inputWithPluginScope);
      if (pluginParam) {
        const allowed = pluginCanWriteRecord(plugin, input);
        if (!allowed.ok) return send(res, 403, { ok: false, error: allowed.error, plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      if (input.privacy?.retention === "do_not_store") return send(res, 202, { ok: true, stored: false });
      const ingest = store.insertRecordWithDedupe(input);
      const record = ingest.record;
      if (!record) return send(res, 500, { ok: false, error: "ingest failed" });
      store.appendRuntimeEvent({
        event_type: ingest.deduped ? "record_deduped" : "record_ingested",
        actor: input.source.type === "browser" || input.source.type === "screenpipe" ? "connector" : "user",
        status: "completed",
        subject_type: "record",
        subject_id: record.id,
        payload: { schema: input.schema.name, source: input.source, title: input.content?.title, duplicate_of: ingest.duplicate_of, reason: ingest.reason },
      });
      if (!ingest.deduped && shouldAutoEnrichBrowserRecord(input)) {
        enrichWithJinaReader(store, record).catch((error) => {
          console.error("[reader-enrichment] failed", error);
        });
      }
      const base = {
        ok: true,
        id: record.id,
        record,
        deduped: Boolean(ingest.deduped),
        duplicate_of: ingest.duplicate_of,
        enrichment: !ingest.deduped && shouldAutoEnrichBrowserRecord(input) ? "scheduled" : "skipped",
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      };
      if (url.searchParams.get("process") !== "true" || ingest.deduped) return send(res, ingest.deduped ? 200 : 201, base);
      const runtime = createDefaultProgramRuntime(store);
      const processing = await runtime.processObject(record, { context_plugin_id: pluginParam });
      if (url.searchParams.get("cascade_views") !== "true") return send(res, 201, { ...base, processing });

      const generatedViewIds = [...new Set([
        ...processing.runs.flatMap(run => run.written_views),
        ...store.listViews({ source_record_id: record.id }).map(view => view.id),
      ])];
      const cascade_processing = await cascadeGeneratedViews({
        runtime,
        store,
        viewIds: generatedViewIds,
        contextPluginId: pluginParam,
        maxDepth: cascadeDepth(url, undefined),
      });
      return send(res, 201, { ...base, processing, cascade_processing });
    }

    if (req.method === "GET" && url.pathname === "/context/recent") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const records = filterRecordsForPlugin(
        store.recent(contextRecordCandidateLimit({ limit, pluginScoped: Boolean(pluginParam) })).filter(isHttpVisibleRecord),
        plugin,
      ).slice(0, limit);
      return send(res, 200, {
        ok: true,
        records,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/context/records/")) {
      const recordId = decodeURIComponent(url.pathname.slice("/context/records/".length));
      const record = store.getRecord(recordId);
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const allowed = record && isHttpVisibleRecord(record) ? filterRecordsForPlugin([record], plugin)[0] : undefined;
      return send(res, allowed ? 200 : 404, allowed
        ? { ok: true, record: allowed, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined }
        : { ok: false, error: "record not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "POST" && url.pathname === "/context/search") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const limit = Number(body.limit ?? 50);
      const records = filterRecordsForPlugin(
        store.search(String(body.query ?? ""), contextRecordCandidateLimit({ limit, pluginScoped: Boolean(pluginParam) }), body.scope).filter(isHttpVisibleRecord),
        plugin,
      ).slice(0, limit);
      return send(res, 200, {
        ok: true,
        records,
        plugin_id: pluginParam,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
    }

    if (req.method === "POST" && url.pathname === "/context/pack") {
      const parsed = ContextPackRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pluginParam = url.searchParams.get("plugin_id") ?? parsed.data.plugin_id;
      const packRequest = pluginParam ? { ...parsed.data, plugin_id: pluginParam } : parsed.data;
      if (packRequest.plugin_id) return send(res, 200, { ok: true, pack: buildContextPack(contextQueryFromPackRequest(packRequest), store) });
      const extraRecords = [];
      const diagnostics: Record<string, unknown> = {};
      const includeScreenpipe = packRequest.include_screenpipe || packRequest.screenpipe?.enabled;
      if (includeScreenpipe) {
        const screenpipe = await fetchScreenpipeRecords({
          ...packRequest.screenpipe,
          q: packRequest.screenpipe?.q ?? packRequest.goal,
          limit: packRequest.screenpipe?.limit ?? Math.min(8, packRequest.limit ?? 8),
          start_time: packRequest.screenpipe?.start_time ?? packRequest.time_window?.start_time,
          end_time: packRequest.screenpipe?.end_time ?? packRequest.time_window?.end_time,
          app_name: packRequest.screenpipe?.app_name ?? packRequest.scope?.app,
          browser_url: packRequest.screenpipe?.browser_url ?? packRequest.scope?.domain,
        });
        diagnostics.screenpipe = { ok: screenpipe.ok, url: screenpipe.url, query: screenpipe.query, count: screenpipe.records.length, error: screenpipe.error };
        extraRecords.push(...screenpipe.records);
      }
      if (packRequest.include_ai_sessions) {
        const projectPath = packRequest.scope?.project_path ?? packRequest.scope?.project ?? process.cwd();
        const located = locateAiSessions({
          project_path: projectPath,
          start_time: packRequest.time_window?.start_time,
          end_time: packRequest.time_window?.end_time,
          minutes: packRequest.time_window?.minutes,
          tools: packRequest.ai_sessions?.tools,
          limit: packRequest.ai_sessions?.limit ?? 8,
          include_snippets: packRequest.ai_sessions?.snippets,
        });
        diagnostics.ai_sessions = { count: located.sessions.length, time_window: located.time_window, diagnostics: located.diagnostics };
        extraRecords.push(...located.sessions.map(aiSessionRefToRecord));
      }
      return send(res, 200, { ok: true, pack: store.buildPack(packRequest, extraRecords, diagnostics) });
    }


    if (req.method === "POST" && url.pathname === "/context/views") {
      const parsed = ContextViewSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pluginParam = url.searchParams.get("plugin_id") ?? parsed.data.scope?.plugin_id;
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      const sourceParam = url.searchParams.get("source") ?? undefined;
      if (pluginParam) {
        if (!plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
        const allowed = pluginCanWriteView(plugin, parsed.data, store);
        if (!allowed.ok) return send(res, 403, { ok: false, error: allowed.error, plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      if (!viewReferencesAllowedRecords(parsed.data, store)) return send(res, 403, { ok: false, error: "view cannot reference this record", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      if (!viewReferencesExistingViews(parsed.data, store)) return send(res, 403, { ok: false, error: "view cannot reference this source view", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      if (!viewScopeMatchesProvenance(parsed.data, store)) return send(res, 403, { ok: false, error: "view scope conflicts with provenance", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const viewInput = normalizeCreatedView(parsed.data, { plugin_id: pluginParam, source: sourceParam });
      const view = store.upsertView(viewInput);
      return send(res, 201, { ok: true, id: view.id, view, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "GET" && url.pathname === "/context/views/catalog") {
      return send(res, 200, {
        ok: true,
        order: VIEW_FAMILY_ORDER,
        families: VIEW_FAMILY_DEFINITIONS,
        manual_create: manualViewFamilies(),
      });
    }

    if (req.method === "GET" && url.pathname === "/context/views/families") {
      const viewTypes = url.searchParams.get("view_types")?.split(",").map(x => x.trim()).filter(Boolean);
      const activeOnly = url.searchParams.get("active_only") !== "false";
      const requestedTypes = viewTypes?.length ? viewTypes : VIEW_FAMILY_ORDER;
      const listed = new Map(store.listViewFamilySummaries({ view_types: requestedTypes, active_only: activeOnly }).map(family => [family.family, family]));
      const families = requestedTypes
        .map(familyType => {
          const family = listed.get(familyType);
          const definition = viewFamilyDefinition(familyType);
          return {
            family: familyType,
            count: family?.count ?? 0,
            kinds: family?.kinds ?? [],
            latest: family?.latest ? summarizeViewForList(family.latest) : undefined,
            definition,
          };
        })
        .filter(family => family.count > 0 || viewFamilyDefinition(family.family))
        .map(family => ({
          family: family.family,
          count: family.count,
          kinds: family.kinds,
          latest: family.latest,
          definition: family.definition,
        }));
      return send(res, 200, { ok: true, families });
    }

    if (req.method === "GET" && url.pathname === "/context/views") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam === "all" ? 0 : Number(limitParam ?? 50);
      const viewTypes = url.searchParams.get("view_types")?.split(",").map(x => x.trim()).filter(Boolean);
      const updatedAfter = url.searchParams.get("cursor") ?? url.searchParams.get("updated_after") ?? undefined;
      const query = url.searchParams.get("query") ?? undefined;
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const surfacingPreferences = surfacingPreferencesForPlugin(store, plugin);
      const listedViews = store.listViews({
        limit: viewListCandidateLimit({ limit, query, pluginScoped: Boolean(pluginParam) }),
        view_types: viewTypes,
        view_type_prefix: url.searchParams.get("view_type_prefix") ?? undefined,
        active_only: url.searchParams.get("active_only") === "true",
        status: url.searchParams.get("status") as any || undefined,
        compiler_id: url.searchParams.get("compiler_id") ?? undefined,
        source_record_id: url.searchParams.get("source_record_id") ?? undefined,
        source_view_id: url.searchParams.get("source_view_id") ?? undefined,
        updated_after: updatedAfter,
        scope: scopeFromSearchParams(url.searchParams),
      });
      const policyViews = filterViewsForPlugin(listedViews, store, plugin);
      const filteredViews = filterViewsByQuery(rankViewsForSurfacing(policyViews, surfacingPreferences), query);
      const views = limit <= 0 ? filteredViews : filteredViews.slice(0, limit);
      const responseViews = url.searchParams.get("summary_only") === "true" ? views.map(summarizeViewForList) : views;
      const nextCursor = nextViewCursor(views, updatedAfter);
      return send(res, 200, {
        ok: true,
        views: responseViews,
        next_cursor: nextCursor,
        subscription: {
          cursor: nextCursor,
          returned_count: views.length,
          surfacing_preferences: surfacingPreferences,
          plugin_id: pluginParam ?? undefined,
          plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/context/views/latest") {
      const viewTypes = url.searchParams.get("view_types")?.split(",").map(x => x.trim()).filter(Boolean);
      const query = url.searchParams.get("query") ?? undefined;
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const surfacingPreferences = surfacingPreferencesForPlugin(store, plugin);
      const listedViews = store.listViews({
        limit: latestViewCandidateLimit({ query, pluginScoped: Boolean(pluginParam) }),
        view_types: viewTypes,
        view_type_prefix: url.searchParams.get("view_type_prefix") ?? undefined,
        active_only: true,
        status: url.searchParams.get("status") as any || undefined,
        compiler_id: url.searchParams.get("compiler_id") ?? undefined,
        source_record_id: url.searchParams.get("source_record_id") ?? undefined,
        source_view_id: url.searchParams.get("source_view_id") ?? undefined,
        updated_after: url.searchParams.get("updated_after") ?? undefined,
        scope: scopeFromSearchParams(url.searchParams),
      });
      const policyViews = filterViewsForPlugin(listedViews, store, plugin);
      const view = filterViewsByQuery(rankViewsForSurfacing(policyViews, surfacingPreferences), query)[0];
      if (!view) return send(res, 404, { ok: false, error: "view not found" });
      const includeProvenance = url.searchParams.get("include_provenance") === "true";
      return send(res, 200, {
        ok: true,
        view,
        surfacing_preferences: surfacingPreferences,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
        ...(includeProvenance ? { provenance: filterViewProvenanceForPlugin(collectViewProvenance(store, view.id, Number(url.searchParams.get("max_depth") ?? 3)), store, plugin) } : {}),
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/context/views/") && url.pathname.endsWith("/provenance")) {
      const viewId = decodeURIComponent(url.pathname.slice("/context/views/".length, -"/provenance".length));
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const root = store.getView(viewId);
      const allowedRoot = root ? filterViewsForPlugin([root], store, plugin)[0] : undefined;
      if (!allowedRoot) {
        return send(res, 404, {
          ok: false,
          error: "view not found",
          view_id: viewId,
          plugin_id: pluginParam ?? undefined,
          plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
        });
      }
      const result = filterViewProvenanceForPlugin(collectViewProvenance(store, viewId, Number(url.searchParams.get("max_depth") ?? 3)), store, plugin);
      return send(res, result.ok ? 200 : 404, {
        ...result,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/context/views/")) {
      const viewId = decodeURIComponent(url.pathname.slice("/context/views/".length));
      const view = store.getView(viewId);
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const allowed = view ? filterViewsForPlugin([view], store, plugin)[0] : undefined;
      return send(res, allowed ? 200 : 404, allowed
        ? { ok: true, view: allowed, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined }
        : { ok: false, error: "view not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "POST" && url.pathname === "/context/query") {
      const parsed = ContextQuerySchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pluginParam = url.searchParams.get("plugin_id") ?? parsed.data.plugin_id;
      const query = pluginParam ? { ...parsed.data, plugin_id: pluginParam } : parsed.data;
      const pack = buildContextPack(query, store);
      return send(res, 200, { ok: true, pack });
    }

    if (req.method === "POST" && url.pathname === "/context/chat") {
      const body = await readJson(req) as ContextChatHttpBody;
      const question = String(body.question ?? "").trim();
      if (!question) return send(res, 400, { ok: false, error: "question is required" });
      const page = isPlainObject(body.page_context) ? body.page_context : {};
      const pageTitle = stringValue(page.title);
      const pageUrl = stringValue(page.url);
      const pageText = stringValue(page.selected_text) || stringValue(page.text);
      const query = [question, pageTitle, pageUrl].filter(Boolean).join(" ");
      const pack = buildContextPack({
        goal: question,
        query,
        scope: body.scope,
        include_records: true,
        include_views: true,
        include_events: false,
        limit: positiveInteger(body.limit) ?? 8,
        token_budget: 6000,
      }, store);
      const contextMarkdown = [
        pageTitle || pageUrl || pageText ? "# Current page" : undefined,
        pageTitle ? `Title: ${pageTitle}` : undefined,
        pageUrl ? `URL: ${pageUrl}` : undefined,
        pageText ? `Text:\n${pageText.slice(0, 12000)}` : undefined,
        pack.markdown,
      ].filter(Boolean).join("\n\n");
      const chat = await runClaudeAcpChat({
        prompt: [
          "You are metaflow in a Chrome side panel, backed by Claude Code through ACP.",
          "Answer the user's question directly and conversationally.",
          "Use the current page and retrieved context below as primary context.",
          "Do not return AgentTask JSON, output_contract, next_actions, tool plans, file diffs, or task metadata.",
          "If you use tools internally, only show the final user-facing answer.",
          "",
          `User question: ${question}`,
          "",
          contextMarkdown,
        ].join("\n"),
      });
      if (!chat.ok) {
        return send(res, 502, {
          ok: false,
          error: chat.error ?? "Claude ACP chat failed",
          runtime: chat.runtime,
          command: chat.command,
          session_id: chat.session_id,
          stderr: chat.stderr,
          pack: summarizePackForChat(pack),
        });
      }
      return send(res, 200, {
        ok: true,
        answer: chat.answer,
        runtime: chat.runtime,
        command: chat.command,
        session_id: chat.session_id,
        stop_reason: chat.stop_reason,
        update_count: chat.update_count,
        agent_info: chat.agent_info,
        sources: pack.sources,
      });
    }

    if (req.method === "POST" && url.pathname === "/feedback") {
      const parsed = FeedbackInputSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pluginParam = url.searchParams.get("plugin_id") ?? parsed.data.plugin_id;
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const targetView = parsed.data.view_id ? store.getView(parsed.data.view_id) : undefined;
      const targetRecord = parsed.data.record_id ? store.getRecord(parsed.data.record_id) : undefined;
      if (parsed.data.view_id && !targetView) return send(res, 404, { ok: false, error: "feedback target view not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      if (parsed.data.record_id && !targetRecord) return send(res, 404, { ok: false, error: "feedback target record not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      if (targetRecord && !isHttpVisibleRecord(targetRecord)) return send(res, 404, { ok: false, error: "feedback target record not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const allowedTargetView = targetView ? filterViewsForPlugin([targetView], store, plugin)[0] : undefined;
      if (parsed.data.view_id && !allowedTargetView) {
        if (pluginParam && targetView) {
          return send(res, 403, { ok: false, error: "plugin cannot write feedback for this view", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
        }
        return send(res, 404, { ok: false, error: "feedback target view not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      }
      if (pluginParam && targetRecord && !filterRecordsForPlugin([targetRecord], plugin)[0]) {
        return send(res, 403, { ok: false, error: "plugin cannot write feedback for this record", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      const result = ingestFeedback(pluginParam ? { ...parsed.data, plugin_id: pluginParam } : parsed.data, store);
      if (url.searchParams.get("process") !== "true") return send(res, 201, { ...result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const processing = await createDefaultProgramRuntime(store).processObject(result.record);
      return send(res, 201, { ...result, processing, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "POST" && url.pathname === "/context/artifacts") {
      const parsed = ContextArtifactSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      if (!filterArtifactsForPlugin([parsed.data], store, plugin)[0]) {
        return send(res, 403, { ok: false, error: "plugin cannot write artifact for this record", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      const artifact = store.insertArtifact(parsed.data);
      return send(res, 201, { ok: true, id: artifact.id, artifact, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "GET" && url.pathname === "/context/artifacts") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const artifacts = filterArtifactsForPlugin(store.listArtifacts({
        record_id: url.searchParams.get("record_id") ?? undefined,
        limit: artifactCandidateLimit({ limit, pluginScoped: Boolean(pluginParam) }),
      }), store, plugin).slice(0, limit);
      return send(res, 200, {
        ok: true,
        artifacts,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/context/artifacts/")) {
      const artifactId = decodeURIComponent(url.pathname.slice("/context/artifacts/".length));
      const artifact = store.getArtifact(artifactId);
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const allowed = artifact ? filterArtifactsForPlugin([artifact], store, plugin)[0] : undefined;
      return send(res, allowed ? 200 : 404, allowed
        ? { ok: true, artifact: allowed, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined }
        : { ok: false, error: "artifact not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }


    if (req.method === "POST" && url.pathname === "/context/connectors") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (body.actor === "plugin" && typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot access raw context registry", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const parsed = ContextConnectorSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const connector = store.registerConnector(parsed.data);
      return send(res, 201, { ok: true, connector });
    }

    if (req.method === "GET" && url.pathname === "/context/connectors") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot access raw context registry", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      return send(res, 200, { ok: true, connectors: store.listConnectors() });
    }

    if (req.method === "POST" && url.pathname === "/context/schemas") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot access raw context registry", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const parsed = ContextSchemaSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const schema = store.registerSchema(parsed.data);
      return send(res, 201, { ok: true, schema });
    }

    if (req.method === "GET" && url.pathname === "/context/schemas") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot access raw context registry", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const version = url.searchParams.get("version");
      return send(res, 200, { ok: true, schemas: store.listSchemas({
        name: url.searchParams.get("name") ?? undefined,
        version: version ? Number(version) : undefined,
        limit: Number(url.searchParams.get("limit") ?? 100),
      }) });
    }


    if (req.method === "GET" && url.pathname === "/plugins") {
      return send(res, 200, { ok: true, plugins: listPluginManifests() });
    }

    if (req.method === "GET" && url.pathname.startsWith("/plugins/")) {
      const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      const plugin = readPluginManifest(id);
      return send(res, plugin ? 200 : 404, plugin ? { ok: true, plugin } : { ok: false, error: "plugin not found" });
    }

    if (req.method === "POST" && url.pathname === "/plugins/language-learning/run") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot run plugin entrypoints directly", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const result = runLanguageLearningPlugin({ days: body.days, limit: body.limit, write: body.write, min_count: body.min_count }, store);
      return send(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/programs") {
      return send(res, 200, { ok: true, programs: listDefaultPrograms(), capabilities: listDefaultCapabilities() });
    }

    if (req.method === "POST" && url.pathname === "/programs/process") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const runtime = createDefaultProgramRuntime(store);
      const record = body.record_id ? store.getRecord(String(body.record_id)) : undefined;
      const view = body.view_id ? store.getView(String(body.view_id)) : undefined;
      if (body.record_id && !record) return send(res, 404, { ok: false, error: "record not found" });
      if (record && !isHttpVisibleRecord(record)) return send(res, 404, { ok: false, error: "record not found" });
      if (body.view_id && !view) return send(res, 404, { ok: false, error: "view not found" });
      const allowedView = view ? filterViewsForPlugin([view], store, plugin)[0] : undefined;
      if (body.view_id && !allowedView) return send(res, 404, { ok: false, error: "view not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const fallback = pluginParam
        ? filterRecordsForPlugin(store.recent(contextRecordCandidateLimit({ limit: 50, pluginScoped: true })).filter(isHttpVisibleRecord), plugin)[0]
        : store.recent(50).filter(isHttpVisibleRecord)[0];
      const object = record ?? allowedView ?? fallback;
      if (!object) return send(res, 404, { ok: false, error: "no context object to process" });
      if (pluginParam) {
        const allowed = record
          ? filterRecordsForPlugin([record], plugin)[0]
          : allowedView ?? filterRecordsForPlugin([object as StoredContextRecord], plugin)[0];
        if (!allowed) return send(res, 403, { ok: false, error: "plugin cannot access program process source", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      const result = await runtime.processObject(object, {
        dry_run: Boolean(body.dry_run),
        speed: body.speed,
        autonomy: body.autonomy,
        max_programs: body.max_programs,
        program_id: body.program_id ?? body.programId,
        context_plugin_id: pluginParam,
      });
      return send(res, 200, { ...result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "POST" && url.pathname === "/agent-tasks") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const record = body.record_id ? store.getRecord(String(body.record_id)) : undefined;
      const view = body.view_id ? store.getView(String(body.view_id)) : undefined;
      if (body.record_id && !record) return send(res, 404, { ok: false, error: "record not found" });
      if (record && !isHttpVisibleRecord(record)) return send(res, 404, { ok: false, error: "record not found" });
      if (body.view_id && !view) return send(res, 404, { ok: false, error: "view not found" });
      const allowedView = view ? filterViewsForPlugin([view], store, plugin)[0] : undefined;
      if (body.view_id && !allowedView) return send(res, 404, { ok: false, error: "view not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const object = record ?? allowedView;
      if (!object) return send(res, 400, { ok: false, error: "record_id or view_id is required" });
      if (pluginParam) {
        const allowed = record
          ? filterRecordsForPlugin([record], plugin)[0]
          : allowedView;
        if (!allowed) return send(res, 403, { ok: false, error: "plugin cannot access agent task source", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      const signal = signalFromObject(object);
      const task = withDefaultAgentTaskContextPack(body.task, signal, store, body, pluginParam);
      if (pluginParam) {
        const writePermission = canPluginWriteAgentTaskView(plugin, agentTaskOutputViewType(task));
        if (!writePermission.ok) return send(res, 403, { ok: false, error: writePermission.error, plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      const runtime = createDefaultProgramRuntime(store);
      const result = await runtime.runCapability("capability.agent_task.submit", {
        signal,
        autonomy: body.autonomy ?? "suggest",
        speed: body.speed,
        dry_run: Boolean(body.dry_run),
        payload: { task },
      });
      if (!result.ok || url.searchParams.get("cascade_views") !== "true" || body.dry_run) {
        return send(res, result.ok ? 201 : 400, { ok: result.ok, result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      }
      const cascade_processing = await cascadeGeneratedViews({
        runtime,
        store,
        viewIds: result.written_views ?? [],
        contextPluginId: pluginParam,
        maxDepth: cascadeDepth(url, body),
      });
      return send(res, 201, { ok: true, result, cascade_processing, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }



    if (req.method === "POST" && url.pathname === "/timeline/observations/compile") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const limit = Number(body.limit ?? 200);
      const minutes = body.minutes;
      const records = pluginParam ? filterRecordsForPlugin(
        store.recent(contextRecordCandidateLimit({ limit, pluginScoped: true }), undefined, { minutes }),
        plugin,
      ).slice(0, limit) : undefined;
      const result = compileObservationTimeline({ minutes, limit, write: body.write, records, pluginId: pluginParam }, store);
      return send(res, 200, { ...result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }


    if (req.method === "POST" && url.pathname === "/timeline/activity/compile") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const limit = Number(body.limit ?? 300);
      const eventLimit = Number(body.event_limit ?? body.eventLimit ?? 80);
      const minutes = body.minutes;
      const records = pluginParam ? filterRecordsForPlugin(
        store.recent(contextRecordCandidateLimit({ limit, pluginScoped: true }), undefined, { minutes }),
        plugin,
      ).slice(0, limit) : undefined;
      const runtimeEvents = pluginParam
        ? filterEventsForPlugin(store.listRuntimeEvents({ limit: runtimeEventCandidateLimit({ limit: eventLimit, pluginScoped: true }), timeWindow: { minutes } }), store, plugin).slice(0, eventLimit)
        : undefined;
      const result = compileActivityTimeline({
        minutes,
        limit,
        eventLimit,
        bucketMinutes: body.bucket_minutes ?? body.bucketMinutes,
        write: body.write,
        includeRuntimeEvents: body.include_runtime_events ?? body.includeRuntimeEvents,
        includeLowLevelScreenpipe: body.include_low_level_screenpipe ?? body.includeLowLevelScreenpipe,
        dedupe: body.dedupe,
        bucketItemLimit: body.bucket_item_limit ?? body.bucketItemLimit,
        summarizeHeartbeats: body.summarize_heartbeats ?? body.summarizeHeartbeats,
        sourceFilter: body.source_filter ?? body.sourceFilter,
        mergeContinuous: body.merge_continuous ?? body.mergeContinuous,
        mergeGapMinutes: body.merge_gap_minutes ?? body.mergeGapMinutes,
        records,
        runtimeEvents,
        pluginId: pluginParam,
      }, store);
      return send(res, 200, { ...result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "POST" && url.pathname === "/timeline/project/compile") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const limit = Number(body.limit ?? 300);
      const eventLimit = Number(body.event_limit ?? body.eventLimit ?? 80);
      const minutes = body.minutes;
      const projectRecordLimit = Math.max(limit * 2, limit);
      const records = pluginParam ? filterRecordsForPlugin(
        store.recent(contextRecordCandidateLimit({ limit: projectRecordLimit, pluginScoped: true }), undefined, { minutes }),
        plugin,
      ).slice(0, projectRecordLimit) : undefined;
      const runtimeEvents = pluginParam
        ? filterEventsForPlugin(store.listRuntimeEvents({ limit: runtimeEventCandidateLimit({ limit: eventLimit, pluginScoped: true }), timeWindow: { minutes } }), store, plugin).slice(0, eventLimit)
        : undefined;
      const workThreadViews = pluginParam
        ? filterViewsForPlugin(store.listViews({ view_types: ["work_thread"], limit: viewListCandidateLimit({ limit: 80, pluginScoped: true }), timeWindow: { minutes } }), store, plugin).slice(0, 80)
        : undefined;
      const result = compileProjectTimeline({
        projectPath: body.project_path ?? body.projectPath,
        project: body.project,
        minutes,
        limit,
        eventLimit,
        bucketMinutes: body.bucket_minutes ?? body.bucketMinutes,
        write: body.write,
        records,
        runtimeEvents,
        workThreadViews,
        includeStoredWorkThreads: pluginParam ? false : undefined,
        pluginId: pluginParam,
      }, store);
      return send(res, 200, { ...result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "GET" && url.pathname === "/runtime/events") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const events = filterEventsForPlugin(store.listRuntimeEvents({
        limit: runtimeEventCandidateLimit({ limit, pluginScoped: Boolean(pluginParam) }),
        event_type: url.searchParams.get("type") ?? undefined,
        event_types: url.searchParams.get("types")?.split(",").map(x => x.trim()).filter(Boolean),
        plugin_id: url.searchParams.get("plugin") ?? undefined,
        actor: url.searchParams.get("actor") as any || undefined,
        actor_types: url.searchParams.get("actors")?.split(",").map(x => x.trim()).filter(Boolean) as any,
        timeWindow: url.searchParams.get("minutes") ? { minutes: Number(url.searchParams.get("minutes")) } : undefined,
        subject_type: url.searchParams.get("subject_type") ?? undefined,
        subject_id: url.searchParams.get("subject_id") ?? undefined,
      }), store, plugin).slice(0, limit);
      return send(res, 200, {
        ok: true,
        events,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
    }

    if (req.method === "POST" && url.pathname === "/runtime/events") {
      const body = await readJson(req);
      const parsed = RuntimeEventSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pluginParam = url.searchParams.get("plugin_id") ?? (body.actor === "plugin" && typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (!pluginParam && !eventReferencesAllowedRecords(parsed.data, store)) return send(res, 403, { ok: false, error: "event cannot reference this record", plugin_id: undefined, plugin_loaded: undefined });
      if (!pluginParam && !eventReferencesAllowedViews(parsed.data, store)) return send(res, 403, { ok: false, error: "event cannot reference this view", plugin_id: undefined, plugin_loaded: undefined });
      if (pluginParam) {
        const allowed = pluginCanWriteEvent(plugin, parsed.data, store);
        if (!allowed.ok) return send(res, 403, { ok: false, error: allowed.error, plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      const eventInput = pluginParam ? { ...parsed.data, plugin_id: pluginParam } : parsed.data;
      const event = store.appendRuntimeEvent(eventInput);
      return send(res, 201, { ok: true, event, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "POST" && url.pathname === "/runtime/tick") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot run runtime tick", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const result = await runtimeTick({
        window_minutes: Number(body.window_minutes ?? body.window ?? 10),
        project_hints: Array.isArray(body.project_hints) ? body.project_hints : body.project ? [String(body.project)] : undefined,
        include_screenpipe: body.include_screenpipe,
        include_ai_sessions: body.include_ai_sessions,
        include_git: body.include_git,
        write: body.write,
        force: body.force,
        min_score: body.min_score,
        max_threads: body.max_threads,
        screenpipe_limit: body.screenpipe_limit,
        ai_session_limit: body.ai_session_limit,
        project_snapshot_interval_seconds: body.project_snapshot_interval_seconds,
        ai_session_interval_seconds: body.ai_session_interval_seconds,
        compile_views: body.compile_views,
        ai_view_compression: body.ai_view_compression,
        visual_view_compression: body.visual_view_compression,
        visual_frame_limit: body.visual_frame_limit,
        visual_frame_concurrency: body.visual_frame_concurrency,
        visual_frame_sample_seconds: body.visual_frame_sample_seconds,
        llm: body.llm,
        vision_llm: body.vision_llm,
        view_compile_interval_seconds: body.view_compile_interval_seconds,
        work_thread_view_minutes: body.work_thread_view_minutes,
        activity_timeline_minutes: body.activity_timeline_minutes,
        project_timeline_minutes: body.project_timeline_minutes,
      }, store);
      store.appendRuntimeEvent({ event_type: "runtime_tick_completed", actor: "system", status: "completed", subject_type: "runtime", subject_id: "runtime_tick", related_threads: result.written_threads, related_records: result.evidence.written_records, payload: { active_workspace: result.active_workspace, evidence: result.evidence, candidate_count: result.candidate_threads.length } });
      return send(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/runtime/settings") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot read raw runtime settings", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      return send(res, 200, { ok: true, settings: publicRuntimeSettings(runtimeSettings(store)) });
    }

    if (req.method === "POST" && url.pathname === "/runtime/settings") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot update runtime settings", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const settings = saveRuntimeSettings(body, store);
      store.appendRuntimeEvent({ event_type: "runtime_settings_updated", actor: "user", status: "completed", subject_type: "runtime", subject_id: "runtime_settings", payload: { settings: publicRuntimeSettings(settings) } });
      return send(res, 200, { ok: true, settings: publicRuntimeSettings(settings) });
    }

    if (req.method === "GET" && url.pathname === "/runtime/status") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot read raw runtime status", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      return send(res, 200, runtimeStatus(store));
    }

    if (req.method === "POST" && url.pathname === "/thread/interpret") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot operate on WorkThreads", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const threadId = body.thread_id === "active" || !body.thread_id ? activeThreadId(store) : String(body.thread_id);
      if (!threadId) return send(res, 404, { ok: false, error: "no active thread" });
      const result = await interpretThread({
        thread_id: threadId,
        write: body.write,
        update_thread: body.update_thread,
        max_records: body.max_records,
        llm: {
          base_url: body.llm?.base_url,
          api_key: body.llm?.api_key,
          model: body.llm?.model,
          temperature: body.llm?.temperature,
          max_tokens: body.llm?.max_tokens,
          allow_external: body.llm?.allow_external,
        },
      }, store);
      store.appendRuntimeEvent({ event_type: result.ok ? "thread_interpreted" : "thread_interpret_failed", actor: "system", status: result.ok ? "completed" : "failed", subject_type: "thread", subject_id: threadId, related_records: result.prompt_evidence_ids, related_views: result.updated_thread?.metadata?.display_title ? [`view:thread-display:${threadId}`] : [], payload: { error: result.error, interpretation: result.interpretation } });
      return send(res, result.ok ? 200 : 500, result);
    }

    if (req.method === "GET" && url.pathname === "/thread/evidence") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot operate on WorkThreads", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const rawId = url.searchParams.get("thread_id") ?? "active";
      const threadId = rawId === "active" ? activeThreadId(store) : rawId;
      if (!threadId) return send(res, 404, { ok: false, error: "no active thread" });
      const result = persistThreadEvidenceMap(threadId, store);
      return send(res, result.ok ? 200 : 404, result);
    }

    if (req.method === "POST" && url.pathname === "/thread/merge") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot operate on WorkThreads", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const result = mergeThreads(String(body.target_id), Array.isArray(body.source_ids) ? body.source_ids.map(String) : [], { title: body.title, write: body.write }, store);
      return send(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/thread/split") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot operate on WorkThreads", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const result = splitThread(String(body.thread_id), Array.isArray(body.evidence_ids) ? body.evidence_ids.map(String) : [], { title: body.title, write: body.write }, store);
      return send(res, result.ok ? 200 : 400, result);
    }

    return send(res, 404, { ok: false, error: "not found" });
  } catch (error: any) {
    return send(res, 500, { ok: false, error: error?.message ?? String(error) });
  }
  };
}


export function createContextHttpServer(store = new ContextStore()) {
  return createServer(createContextHttpHandler(store));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createContextHttpServer().listen(port, () => {
    console.log(`[context-layer] standalone HTTP server listening on http://localhost:${port}`);
  });
}

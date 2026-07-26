import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadLocalEnv } from "./env.js";
import { ContextStore } from "@info/core";
import { ContextArtifactSchema, ContextConnectorSchema, ContextPackRequestSchema, ContextQuerySchema, ContextRecordSchema, ContextSchemaSchema, ContextViewSchema, FeedbackInputSchema, RuntimeEventSchema } from "@info/core";
import { enrichWithJinaReader, shouldAutoEnrichBrowserRecord } from "@info/sensors";
import { fetchScreenpipeFrameImage, fetchScreenpipeRecords } from "@info/sensors";
import { aiSessionRefToRecord, locateAiSessions } from "@info/sensors";
import { publicRuntimeSettings, runtimeSettings, runtimeStatus, saveRuntimeSettings } from "@info/runtime/runtime.js";
import { buildAgentTaskList, queueOrProcessAgentTasks, updateAgentTaskLifecycle } from "@info/runtime/agent-tasks.js";
import { activeThreadId, interpretThread } from "@info/views/threads/thread-interpreter.js";
import { persistThreadEvidenceMap } from "@info/views/threads/thread-evidence.js";
import { mergeThreads, splitThread } from "@info/views/threads/thread-ops.js";
import { buildContextPack, filterEventsForPlugin, filterRecordsForPlugin, filterViewsForPlugin, surfacingPreferencesForPlugin } from "@info/core";
import { listPluginManifests, readPluginManifest } from "@info/core";
import { runLanguageLearningPlugin } from "@info/core";
import { createDefaultProgramRuntime, listDefaultCapabilities, listDefaultPrograms } from "@info/programs/registry.js";
import { ProcessorRuntime, matchesAny, processorCatalog, upsertDynamicProcessorSpec, type ProcessorDefinition } from "@info/processor-runtime";
import { signalFromObject } from "@info/programs/signals.js";
import { III_CASCADE_FUNCTIONS, III_CONTEXT_FUNCTIONS, III_PROGRAM_FUNCTIONS, III_RUNTIME_FUNCTIONS, InProcessIiiRuntimeClient, VIEW_WORKER_FUNCTIONS, registerInfoIiiRuntime, type ContextIngestResult } from "@info/iii-runtime";
import { ingestFeedback } from "@info/runtime/feedback.js";
import { collectViewProvenance } from "@info/runtime/view-provenance.js";
import { filterViewsByQuery } from "@info/core";
import { rankViewsForSurfacing } from "@info/core";
import { SqliteViewRepository } from "@info/storage-sqlite";
import type { ViewRepository } from "@info/view";
import { VIEW_FAMILY_DEFINITIONS, VIEW_FAMILY_ORDER, manualViewFamilies, viewFamilyDefinition } from "@info/views/catalog.js";
import type { ContextArtifact, ContextPackRequest, ContextQuery, ContextRecord, ContextView, StoredContextRecord, StoredRuntimeEvent } from "@info/core";
import {
  artifactCandidateLimit, compactScope, contextRecordCandidateLimit, isHttpVisibleRecord, isPlainObject,
  latestViewCandidateLimit, nextViewCursor, pluginNotFoundBody, positiveInteger, readJson,
  recordSchemaIngestError, runtimeEventCandidateLimit, sanitizeHttpIngestRecord, scopeFromSearchParams,
  send, sendBytes, stringValue, summarizeViewForList, viewListCandidateLimit,
} from "./http-util.js";
import {
  cascadeDepth, contextQueryFromPackRequest, runClaudeAcpChat,
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
const FRAME_CACHE_MAX = 80;
const FRAME_CACHE_TTL_MS = 5 * 60_000;
const frameImageCache = new Map<string, { contentType: string; bytes: Uint8Array; expiresAt: number }>();

export type BrowserAutomationHttpController = {
  submit(input: unknown): Promise<unknown>;
  listDeliveries?(input: { after?: string; limit?: number }): Promise<unknown> | unknown;
  interact?(input: unknown): Promise<unknown>;
};

export type BrowserCaptureHttpController = {
  submit(input: unknown): Promise<unknown>;
};

export type MacAutomationHttpController = {
  submit(input: unknown): Promise<unknown>;
  listDeliveries?(input: { after?: string; limit?: number }): Promise<unknown> | unknown;
  interact?(input: unknown): Promise<unknown>;
  listBrowserContextRequests?(): Promise<unknown> | unknown;
  respondBrowserContext?(input: unknown): Promise<unknown> | unknown;
};

export type InboxAutomationHttpController = {
  listDeliveries(input: { after?: string; limit?: number }): Promise<unknown> | unknown;
  interact(input: unknown): Promise<unknown>;
};

export function createContextHttpHandler(store: ContextStore, options: {
  viewRepository?: ViewRepository;
  browserCapture?: BrowserCaptureHttpController;
  browserAutomation?: BrowserAutomationHttpController;
  macAutomation?: MacAutomationHttpController;
  inboxAutomation?: InboxAutomationHttpController;
} = {}) {
  let viewRepository = options.viewRepository;
  const resolveViewRepository = () => {
    if (!viewRepository) viewRepository = new SqliteViewRepository();
    return viewRepository;
  };
  return async (req: any, res: any) => {
  const requestStartedAt = Date.now();
  const requestUrl = req.url ?? "";
  const originalEnd = res.end.bind(res);
  res.end = (chunk?: any, encoding?: any, cb?: any) => {
    const elapsed = Date.now() - requestStartedAt;
    if (elapsed > 500) console.warn(`[context-http] slow ${req.method} ${requestUrl} ${elapsed}ms`);
    return originalEnd(chunk, encoding, cb);
  };
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }

    const exactViewMatch = url.pathname.match(/^\/context\/v1\/views\/([^/]+)$/);
    if (req.method === "GET" && exactViewMatch) {
      const revision = Number(url.searchParams.get("revision"));
      if (!Number.isInteger(revision) || revision < 1) {
        return send(res, 400, { ok: false, code: "exact_view_revision_required", error: "A positive exact View revision is required" });
      }
      const viewId = decodeURIComponent(exactViewMatch[1]!);
      try {
        const view = await resolveViewRepository().get({ view_id: viewId, revision });
        if (!view) {
          return send(res, 404, { ok: false, code: "exact_view_not_found", error: `View is missing: ${viewId}@${revision}` });
        }
        return send(res, 200, { ok: true, view });
      } catch (error) {
        console.error(JSON.stringify({
          component: "view-http",
          event: "view.exact_read_failed",
          view_id: viewId,
          revision,
          error: error instanceof Error ? error.message : String(error),
        }));
        return send(res, 500, { ok: false, code: "exact_view_read_failed", error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === "/capture/v1/browser-events" && req.method === "POST") {
      if (!options.browserCapture) {
        return send(res, 503, { ok: false, code: "browser_capture_unavailable", error: "Browser Capture is not configured" });
      }
      try {
        const result = await options.browserCapture.submit(await readJson(req));
        return send(res, browserCaptureSuccessStatus(result), { ok: true, result });
      } catch (error) {
        const status = browserCaptureHttpStatus(error);
        console[status >= 500 ? "error" : "warn"](JSON.stringify({
          component: "browser-capture-http",
          event: "browser_capture.submit_failed",
          status,
          code: errorCode(error),
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        }));
        return send(res, status, {
          ok: false,
          code: errorCode(error),
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        });
      }
    }

    if (url.pathname === "/automation/v1/browser-signals" && req.method === "POST") {
      if (!options.browserAutomation) {
        return send(res, 503, { ok: false, code: "browser_automation_unavailable", error: "Browser Automation is not configured" });
      }
      try {
        const result = await options.browserAutomation.submit(await readJson(req));
        return send(res, 200, { ok: true, result });
      } catch (error) {
        const status = browserAutomationHttpStatus(error);
        console[status >= 500 ? "error" : "warn"](JSON.stringify({
          component: "browser-automation-http",
          event: "browser_automation.submit_failed",
          status,
          code: errorCode(error),
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        }));
        return send(res, status, {
          ok: false,
          code: errorCode(error),
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        });
      }
    }

    if (url.pathname === "/automation/v1/browser-deliveries" && req.method === "GET") {
      if (!options.browserAutomation?.listDeliveries) {
        return send(res, 503, { ok: false, code: "browser_delivery_unavailable", error: "Browser Delivery is not configured" });
      }
      try {
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        const deliveries = await options.browserAutomation.listDeliveries({
          after: url.searchParams.get("after") ?? undefined,
          limit,
        });
        return send(res, 200, { ok: true, deliveries });
      } catch (error) {
        return send(res, 400, { ok: false, code: "invalid_browser_delivery_query", error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === "/automation/v1/browser-interactions" && req.method === "POST") {
      if (!options.browserAutomation?.interact) {
        return send(res, 503, { ok: false, code: "browser_feedback_unavailable", error: "Browser feedback is not configured" });
      }
      try {
        const result = await options.browserAutomation.interact(await readJson(req));
        return send(res, 200, { ok: true, result });
      } catch (error) {
        const code = errorCode(error);
        const status = code === "unknown_delivery" ? 404 : code === "trace_failed" ? 500 : 400;
        return send(res, status, {
          ok: false,
          code,
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        });
      }
    }

    if (url.pathname === "/automation/v1/macos/voice-signals" && req.method === "POST") {
      if (!options.macAutomation) {
        return send(res, 503, { ok: false, code: "macos_automation_unavailable", error: "macOS Automation is not configured" });
      }
      try {
        const result = await options.macAutomation.submit(await readJson(req));
        return send(res, 200, { ok: true, result });
      } catch (error) {
        const status = macAutomationHttpStatus(error);
        console[status >= 500 ? "error" : "warn"](JSON.stringify({
          component: "macos-automation-http",
          event: "macos_automation.submit_failed",
          status,
          code: errorCode(error),
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        }));
        return send(res, status, {
          ok: false,
          code: errorCode(error),
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        });
      }
    }

    if (url.pathname === "/automation/v1/macos/deliveries" && req.method === "GET") {
      if (!options.macAutomation?.listDeliveries) {
        return send(res, 503, { ok: false, code: "macos_delivery_unavailable", error: "macOS Delivery is not configured" });
      }
      try {
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        const deliveries = await options.macAutomation.listDeliveries({
          after: url.searchParams.get("after") ?? undefined,
          limit,
        });
        return send(res, 200, { ok: true, deliveries });
      } catch (error) {
        return send(res, 400, { ok: false, code: "invalid_macos_delivery_query", error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === "/automation/v1/macos/interactions" && req.method === "POST") {
      if (!options.macAutomation?.interact) {
        return send(res, 503, { ok: false, code: "macos_feedback_unavailable", error: "macOS feedback is not configured" });
      }
      try {
        const result = await options.macAutomation.interact(await readJson(req));
        return send(res, 200, { ok: true, result });
      } catch (error) {
        const code = errorCode(error);
        const status = code === "unknown_delivery" ? 404 : code === "trace_failed" ? 500 : 400;
        return send(res, status, {
          ok: false,
          code,
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        });
      }
    }

    if (url.pathname === "/automation/v1/macos/browser-context-requests" && req.method === "GET") {
      if (!options.macAutomation?.listBrowserContextRequests) {
        return send(res, 503, { ok: false, code: "browser_context_bridge_unavailable", error: "Browser context bridge is not configured" });
      }
      return send(res, 200, { ok: true, requests: await options.macAutomation.listBrowserContextRequests() });
    }

    if (url.pathname === "/automation/v1/macos/browser-context-responses" && req.method === "POST") {
      if (!options.macAutomation?.respondBrowserContext) {
        return send(res, 503, { ok: false, code: "browser_context_bridge_unavailable", error: "Browser context bridge is not configured" });
      }
      try {
        return send(res, 200, { ok: true, result: await options.macAutomation.respondBrowserContext(await readJson(req)) });
      } catch (error) {
        return send(res, 400, { ok: false, code: "browser_context_response_rejected", error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === "/automation/v1/inbox/deliveries" && req.method === "GET") {
      if (!options.inboxAutomation) {
        return send(res, 503, { ok: false, code: "inbox_delivery_unavailable", error: "Inbox Delivery is not configured" });
      }
      try {
        const limitValue = url.searchParams.get("limit");
        const limit = limitValue === null ? undefined : Number(limitValue);
        const deliveries = await options.inboxAutomation.listDeliveries({
          after: url.searchParams.get("after") ?? undefined,
          limit,
        });
        return send(res, 200, { ok: true, deliveries });
      } catch (error) {
        return send(res, 400, { ok: false, code: "invalid_inbox_delivery_query", error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === "/automation/v1/inbox/interactions" && req.method === "POST") {
      if (!options.inboxAutomation) {
        return send(res, 503, { ok: false, code: "inbox_feedback_unavailable", error: "Inbox feedback is not configured" });
      }
      try {
        const result = await options.inboxAutomation.interact(await readJson(req));
        return send(res, 200, { ok: true, result });
      } catch (error) {
        const code = errorCode(error);
        const status = code === "unknown_delivery" ? 404 : code === "trace_failed" ? 500 : 400;
        return send(res, status, {
          ok: false,
          code,
          error: error instanceof Error ? error.message : String(error),
          details: errorDetails(error),
        });
      }
    }

    const frameMatch = url.pathname.match(/^\/screenpipe\/frames\/([^/]+)$/);
    if (req.method === "GET" && frameMatch) {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot read raw Screenpipe frames", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const frameId = decodeURIComponent(frameMatch[1]);
      const cached = cachedFrameImage(frameId);
      if (cached) return sendBytes(res, 200, cached.bytes, cached.contentType);
      const result = await fetchScreenpipeFrameImage(frameId, { timeout_ms: 3_000 });
      if (!result.ok) return send(res, result.status ?? 502, { ok: false, error: result.error });
      rememberFrameImage(frameId, result);
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
      const shouldProcess = url.searchParams.get("process") === "true";
      const ingest = await runIiiHttpIngest(store, {
        record: input,
        cascade: shouldProcess,
        max_depth: cascadeDepth(url, undefined) + 1,
        context_plugin_id: pluginParam,
      });
      const record = ingest.record;
      if (!record) return send(res, 500, { ok: false, error: "ingest failed" });
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
      if (!shouldProcess || ingest.deduped) return send(res, ingest.deduped ? 200 : 201, base);
      const compatible = httpIngestProcessingPayload(ingest.cascade);
      return send(res, 201, {
        ...base,
        processing: compatible.processing,
        cascade_processing: url.searchParams.get("cascade_views") === "true" ? compatible.cascade_processing : undefined,
        iii_processing: ingest.cascade,
      });
    }

    if (req.method === "POST" && url.pathname === "/writing/assist") {
      const parsed = ContextRecordSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      if (parsed.data.schema.name !== "observation.editor.text_changed") {
        return send(res, 400, { ok: false, error: "writing assist requires observation.editor.text_changed" });
      }
      const schemaError = recordSchemaIngestError(parsed.data.schema.name);
      if (schemaError) return send(res, 400, { ok: false, error: schemaError });
      const input = sanitizeHttpIngestRecord(store.withConnectorDefaults(parsed.data));
      if (input.privacy?.retention === "do_not_store") return send(res, 202, { ok: true, stored: false });
      const ingest = await runIiiHttpIngest(store, {
        record: input,
        cascade: false,
        max_depth: 1,
      });
      const record = ingest.record;
      if (!record) return send(res, 500, { ok: false, error: "ingest failed" });
      if (ingest.deduped) {
        const views = store.listViews({
          view_types: ["draft.writing_continuation", "advice.writing_assist", "writing.advice"],
          source_record_id: record.id,
          active_only: true,
          limit: 4,
        });
        return send(res, 200, {
          ok: true,
          id: record.id,
          record,
          deduped: true,
          duplicate_of: ingest.duplicate_of,
          processing: { ok: true, generated_at: new Date().toISOString(), runs: [] },
          written_views: views.map(view => view.id),
          views,
          fast_path: true,
        });
      }
      const startedAt = Date.now();
      const processing = await createDefaultProgramRuntime(store).processObject(record, {
        program_id: "program.writing_ambient",
        max_programs: 1,
        speed: "glance",
        autonomy: "suggest",
      });
      const writtenViewIds = [...new Set(processing.runs.flatMap(run => run.written_views ?? []))];
      const views = writtenViewIds.map(id => store.getView(id)).filter((view): view is NonNullable<typeof view> => Boolean(view));
      return send(res, 201, {
        ok: true,
        id: record.id,
        record,
        deduped: false,
        processing,
        written_views: writtenViewIds,
        views,
        fast_path: true,
        elapsed_ms: Date.now() - startedAt,
      });
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

    if (req.method === "GET" && url.pathname === "/screenpipe/audio/transcripts") {
      const limit = positiveInteger(url.searchParams.get("limit")) ?? 120;
      const minutes = positiveInteger(url.searchParams.get("minutes")) ?? 60;
      const result = await fetchScreenpipeAudioTranscripts({ limit, minutes });
      if (!result.ok) return send(res, 502, { ok: false, error: result.error, query: result.query });
      return send(res, 200, {
        ok: true,
        query: result.query,
        count: result.transcripts.length,
        transcripts: result.transcripts,
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

    if (req.method === "GET" && url.pathname === "/processors") {
      const sourceKind = url.searchParams.get("source_kind");
      const sourceType = url.searchParams.get("source_type") ?? undefined;
      const processors = processorCatalog(store)
        .map(processor => summarizeProcessor(processor, sourceKind === "observation" || sourceKind === "view" ? { kind: sourceKind, type: sourceType } : undefined))
        .filter(processor => processor.compatible !== false);
      return send(res, 200, { ok: true, processors });
    }

    if (req.method === "POST" && url.pathname === "/processors") {
      const body = await readJson(req);
      try {
        const processor = upsertDynamicProcessorSpec(store, body.processor ?? body);
        store.appendRuntimeEvent({
          event_type: "processor.registered",
          actor: "agent",
          status: "completed",
          subject_type: "runtime",
          subject_id: processor.id,
          plugin_id: processor.id,
          payload: { processor },
        });
        return send(res, 201, { ok: true, processor: summarizeProcessor(processor as ProcessorDefinition) });
      } catch (error) {
        return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/processors/run") {
      const body = await readJson(req);
      const processorId = typeof body.processor_id === "string" ? body.processor_id : "";
      const recordId = typeof body.record_id === "string" ? body.record_id : undefined;
      const viewId = typeof body.view_id === "string" ? body.view_id : undefined;
      if (!processorId) return send(res, 400, { ok: false, error: "processor_id is required" });
      if (Boolean(recordId) === Boolean(viewId)) return send(res, 400, { ok: false, error: "provide exactly one of record_id or view_id" });
      const processor = processorCatalog(store).find(item => item.id === processorId);
      if (!processor) return send(res, 404, { ok: false, error: "processor not found", processor_id: processorId });
      const runtime = new ProcessorRuntime({ store, processors: [processor] });
      if (recordId) {
        const record = store.getRecord(recordId);
        if (!record || !isHttpVisibleRecord(record)) return send(res, 404, { ok: false, error: "record not found", record_id: recordId });
        if (!matchesAny(processor.consumes.observations, record.schema.name)) {
          return send(res, 400, { ok: false, error: "processor does not consume this observation type", processor_id: processorId, observation_type: record.schema.name });
        }
        const result = await runtime.processObservation(record, isPlainObject(body.payload) ? body.payload : {});
        return sendProcessorRunResult(res, store, result);
      }
      const view = store.getView(viewId!);
      if (!view) return send(res, 404, { ok: false, error: "view not found", view_id: viewId });
      if (!matchesAny(processor.consumes.views, view.view_type)) {
        return send(res, 400, { ok: false, error: "processor does not consume this view type", processor_id: processorId, view_type: view.view_type });
      }
      const result = await runtime.processView(view, isPlainObject(body.payload) ? body.payload : {});
      return sendProcessorRunResult(res, store, result);
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

    if ((req.method === "POST" || req.method === "PATCH" || req.method === "PUT") && url.pathname.startsWith("/context/views/")) {
      const viewId = decodeURIComponent(url.pathname.slice("/context/views/".length));
      if (!viewId || viewId.includes("/")) return send(res, 404, { ok: false, error: "view not found" });
      const existing = store.getView(viewId);
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (isPlainObject(body) && typeof body.plugin_id === "string" ? body.plugin_id : undefined) ?? existing?.scope?.plugin_id;
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const allowedExisting = existing ? filterViewsForPlugin([existing], store, plugin)[0] : undefined;
      if (!allowedExisting) return send(res, 404, { ok: false, error: "view not found", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const merged = mergeViewUpdate(allowedExisting, body);
      const parsed = ContextViewSchema.safeParse(merged);
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      if (pluginParam) {
        const allowed = pluginCanWriteView(plugin, parsed.data, store);
        if (!allowed.ok) return send(res, 403, { ok: false, error: allowed.error, plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      }
      if (!viewReferencesAllowedRecords(parsed.data, store)) return send(res, 403, { ok: false, error: "view cannot reference this record", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      if (!viewReferencesExistingViews(parsed.data, store)) return send(res, 403, { ok: false, error: "view cannot reference this source view", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      if (!viewScopeMatchesProvenance(parsed.data, store)) return send(res, 403, { ok: false, error: "view scope conflicts with provenance", plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      const view = store.upsertView(parsed.data);
      store.appendRuntimeEvent({
        event_type: "context.view_updated",
        actor: pluginParam ? "plugin" : "system",
        status: "completed",
        subject_type: "view",
        subject_id: view.id,
        plugin_id: pluginParam,
        related_records: view.source_records,
        related_views: view.source_views,
        payload: {
          view_type: view.view_type,
          status: view.status,
          patched_fields: isPlainObject(body) ? Object.keys(body).filter(key => key !== "plugin_id") : [],
        },
      });
      return send(res, 200, { ok: true, id: view.id, view, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "GET" && url.pathname === "/context/views/catalog") {
      return send(res, 200, {
        ok: true,
        order: VIEW_FAMILY_ORDER,
        families: VIEW_FAMILY_DEFINITIONS,
        manual_create: manualViewFamilies(),
      });
    }

    if (req.method === "GET" && url.pathname === "/agent/tasks") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const refresh = url.searchParams.get("refresh") === "true" && !pluginParam;
      const taskList = buildAgentTaskList({ write: refresh, limit: Number(url.searchParams.get("limit") ?? 100) }, store);
      const views = filterViewsForPlugin(taskList.items.map(item => store.getView(item.id)).filter((view): view is NonNullable<typeof view> => Boolean(view)), store, plugin);
      return send(res, 200, {
        ok: true,
        task_list: { ...taskList, items: taskList.items.filter(item => views.some(view => view.id === item.id)) },
        view: taskList.latest_view,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
    }

    if (req.method === "POST" && url.pathname === "/agent/tasks") {
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot queue or process agent tasks", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const mode = body.mode === "process" || body.mode === "queue" || body.mode === "queue_and_process" ? body.mode : "queue";
      const iii = mode === "queue" ? undefined : await createLocalInfoIiiRuntime(store);
      const result = await queueOrProcessAgentTasks({
        mode,
        iii,
        runtime: typeof body.runtime === "string" ? body.runtime : undefined,
        dry_run: body.dry_run === true,
        limit: Number(body.limit ?? 8),
        autonomy: body.autonomy,
        write: body.write !== false,
      }, store);
      return send(res, 200, result);
    }

    if (req.method === "POST" && url.pathname.startsWith("/agent/tasks/")) {
      const taskId = decodeURIComponent(url.pathname.slice("/agent/tasks/".length));
      const body = await readJson(req);
      const pluginParam = url.searchParams.get("plugin_id") ?? (typeof body.plugin_id === "string" ? body.plugin_id : undefined);
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam) return send(res, 403, { ok: false, error: "plugins cannot update agent tasks", plugin_id: pluginParam, plugin_loaded: Boolean(plugin) });
      const action = body.action === "retry" ? "retry" : body.action === "cancel" ? "cancel" : undefined;
      if (!action) return send(res, 400, { ok: false, error: "agent task action must be cancel or retry" });
      const actor = body.actor === "user" || body.actor === "connector" || body.actor === "system" || body.actor === "plugin" ? body.actor : "agent";
      const result = updateAgentTaskLifecycle(taskId, action, {
        actor,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        write: body.write !== false,
      }, store);
      return send(res, result.ok ? 200 : 404, result);
    }

    if (req.method === "GET" && url.pathname === "/context/views/families") {
      const viewTypes = url.searchParams.get("view_types")?.split(",").map(x => x.trim()).filter(Boolean);
      const activeOnly = url.searchParams.get("active_only") !== "false";
      const includeKinds = url.searchParams.get("include_kinds") === "true";
      const requestedTypes = viewTypes?.length ? viewTypes : VIEW_FAMILY_ORDER;
      const listed = new Map(store.listViewFamilySummaries({ view_types: requestedTypes, active_only: activeOnly, include_kinds: includeKinds }).map(family => [family.family, family]));
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
      const requestedSummaryOnly = url.searchParams.get("summary_only");
      const viewTypePrefix = url.searchParams.get("view_type_prefix") ?? undefined;
      const summaryOnly = requestedSummaryOnly === "true";
      const boundedSummary = Boolean(updatedAfter || viewTypePrefix || ((viewTypes?.length ?? 0) > 1 && limit > 0 && limit <= 20));
      const exactType = Boolean(viewTypes?.length && !viewTypePrefix && !query && !pluginParam && !url.searchParams.get("compiler_id") && !url.searchParams.get("source_record_id") && !url.searchParams.get("source_view_id") && !url.searchParams.get("scope") && !updatedAfter);
      const listedViews = summaryOnly && !query && !pluginParam && !url.searchParams.get("compiler_id") && !url.searchParams.get("source_record_id") && !url.searchParams.get("source_view_id") && !url.searchParams.get("scope")
        ? store.listViewSummaries({
            limit: viewListCandidateLimit({ limit, query, pluginScoped: Boolean(pluginParam), summaryOnly, boundedSummary, exactType }),
            view_types: viewTypes,
            view_type_prefix: viewTypePrefix,
            active_only: url.searchParams.get("active_only") === "true",
            status: url.searchParams.get("status") as any || undefined,
            updated_after: updatedAfter,
          })
        : store.listViews({
            limit: viewListCandidateLimit({ limit, query, pluginScoped: Boolean(pluginParam), summaryOnly, boundedSummary, exactType }),
            view_types: viewTypes,
            view_type_prefix: viewTypePrefix,
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
      const responseViews = summaryOnly ? views.map(summarizeViewForList) : views;
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
      const iii = await createLocalInfoIiiRuntime(store);
      const programResult = await iii.trigger({
        function_id: III_PROGRAM_FUNCTIONS.processRecord,
        payload: {
          record_id: result.record.id,
          context_plugin_id: pluginParam,
        },
      }) as { result?: Record<string, unknown> };
      const processing = programResult.result ?? programResult;
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
      const iii = await createLocalInfoIiiRuntime(store);
      const programResult = await iii.trigger({
        function_id: "view_type" in object ? III_PROGRAM_FUNCTIONS.processView : III_PROGRAM_FUNCTIONS.processRecord,
        payload: {
          record_id: "schema" in object ? object.id : undefined,
          view_id: "view_type" in object ? object.id : undefined,
          dry_run: Boolean(body.dry_run),
          speed: body.speed,
          autonomy: body.autonomy,
          max_programs: body.max_programs,
          program_id: body.program_id ?? body.programId,
          context_plugin_id: pluginParam,
        },
      }) as { result?: Record<string, unknown> };
      const result = programResult.result ?? programResult;
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
      const iii = await createLocalInfoIiiRuntime(store);
      const capabilityResult = await iii.trigger({
        function_id: III_PROGRAM_FUNCTIONS.agentTaskSubmit,
        payload: {
          signal,
          autonomy: body.autonomy ?? "suggest",
          speed: body.speed,
          dry_run: Boolean(body.dry_run),
          context_plugin_id: pluginParam,
          payload: { task },
        },
      }) as { result?: any };
      const result = capabilityResult.result ?? capabilityResult;
      if (!result.ok || url.searchParams.get("cascade_views") !== "true" || body.dry_run) {
        return send(res, result.ok ? 201 : 400, { ok: result.ok, result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
      }
      const cascade = await iii.trigger({
        function_id: III_CASCADE_FUNCTIONS.viewWritten,
        payload: {
          view_ids: result.written_views ?? [],
          source_view_ids: result.written_views ?? [],
          context_plugin_id: pluginParam,
          max_depth: cascadeDepth(url, body),
        },
      }) as ContextIngestResult["cascade"];
      return send(res, 201, {
        ok: true,
        result,
        cascade_processing: httpIngestProcessingPayload(cascade, { includeDepthOne: true }).cascade_processing,
        iii_processing: cascade,
        plugin_id: pluginParam ?? undefined,
        plugin_loaded: pluginParam ? Boolean(plugin) : undefined,
      });
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
      const result = await runIiiViewCompile(store, VIEW_WORKER_FUNCTIONS.observationTimeline, {
        minutes,
        limit,
        write: body.write,
        records,
        plugin_id: pluginParam,
      });
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
      const timeWindow = {
        minutes,
        start_time: body.start_time ?? body.startTime,
        end_time: body.end_time ?? body.endTime,
      };
      const records = pluginParam ? filterRecordsForPlugin(
        store.recent(contextRecordCandidateLimit({ limit, pluginScoped: true }), undefined, timeWindow),
        plugin,
      ).slice(0, limit) : undefined;
      const runtimeEvents = pluginParam
        ? filterEventsForPlugin(store.listRuntimeEvents({ limit: runtimeEventCandidateLimit({ limit: eventLimit, pluginScoped: true }), timeWindow }), store, plugin).slice(0, eventLimit)
        : undefined;
      const result = await runIiiViewCompile(store, VIEW_WORKER_FUNCTIONS.activityTimeline, {
        minutes,
        start_time: timeWindow.start_time,
        end_time: timeWindow.end_time,
        limit,
        event_limit: eventLimit,
        bucket_minutes: body.bucket_minutes ?? body.bucketMinutes,
        write: body.write,
        include_runtime_events: body.include_runtime_events ?? body.includeRuntimeEvents,
        include_low_level_screenpipe: body.include_low_level_screenpipe ?? body.includeLowLevelScreenpipe,
        dedupe: body.dedupe,
        bucket_item_limit: body.bucket_item_limit ?? body.bucketItemLimit,
        summarize_heartbeats: body.summarize_heartbeats ?? body.summarizeHeartbeats,
        source_filter: body.source_filter ?? body.sourceFilter,
        merge_continuous: body.merge_continuous ?? body.mergeContinuous,
        merge_gap_minutes: body.merge_gap_minutes ?? body.mergeGapMinutes,
        records,
        runtime_events: runtimeEvents,
        plugin_id: pluginParam,
      });
      return send(res, 200, { ...result, plugin_id: pluginParam ?? undefined, plugin_loaded: pluginParam ? Boolean(plugin) : undefined });
    }

    if (req.method === "GET" && url.pathname === "/timeline/activity/live") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 120), 1), 500);
      const bucketMinutes = Math.min(Math.max(Number(url.searchParams.get("bucket_minutes") ?? url.searchParams.get("bucketMinutes") ?? 15), 1), 120);
      const sourceFilter = url.searchParams.get("source_filter") ?? url.searchParams.get("sourceFilter") ?? "all";
      if (!["screenpipe", "browser", "runtime", "all"].includes(sourceFilter)) return send(res, 400, { ok: false, error: "invalid source_filter" });
      const minutes = Math.min(Math.max(Number(url.searchParams.get("minutes") ?? 60), 1), 24 * 60);
      const cutoffMs = Date.now() - minutes * 60_000;
      const records = store.recentByUpdatedAt(Math.max(limit * 40, 2_000))
        .filter(isTimelineLiveRecord)
        .filter(record => {
          const observedMs = Date.parse(record.time?.observed_at ?? record.updated_at ?? record.created_at);
          return Number.isFinite(observedMs) && observedMs >= cutoffMs;
        })
        .filter(record => recordMatchesTimelineSourceFilter(record, sourceFilter as any))
        .slice(0, limit);
      const buckets = liveTimelineBuckets(records, bucketMinutes);
      const latest = records[0];
      return send(res, 200, {
        ok: true,
        compiler_id: "builtin.activity-timeline-live",
        records_used: records.length,
        events_used: 0,
        buckets,
        view: {
          id: `view:timeline:activity:live:${latest?.updated_at ?? "empty"}`,
          view_type: "timeline.activity",
          title: "Live Activity Timeline",
          summary: `${records.length} live records across ${buckets.length} buckets.`,
          metadata: {
            live: true,
            record_count: records.length,
            item_count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
            latest_record_id: latest?.id,
            latest_record_updated_at: latest?.updated_at,
            generated_at: new Date().toISOString(),
          },
          updated_at: latest?.updated_at ?? new Date().toISOString(),
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/timeline/activity/watermark") {
      const pluginParam = url.searchParams.get("plugin_id");
      const plugin = pluginParam ? readPluginManifest(pluginParam) : undefined;
      if (pluginParam && !plugin) return send(res, 404, pluginNotFoundBody(pluginParam));
      const timeWindow = {
        minutes: url.searchParams.get("minutes") ? Number(url.searchParams.get("minutes")) : undefined,
        start_time: url.searchParams.get("start_time") ?? url.searchParams.get("startTime") ?? undefined,
        end_time: url.searchParams.get("end_time") ?? url.searchParams.get("endTime") ?? undefined,
      };
      const sourceFilter = url.searchParams.get("source_filter") ?? url.searchParams.get("sourceFilter") ?? "all";
      if (!["screenpipe", "browser", "runtime", "all"].includes(sourceFilter)) return send(res, 400, { ok: false, error: "invalid source_filter" });
      if (pluginParam) {
        const limit = Math.max(Number(url.searchParams.get("limit") ?? 12_000), 1);
        const eventLimit = Math.max(Number(url.searchParams.get("event_limit") ?? 400), 0);
        const records = filterRecordsForPlugin(
          store.recent(contextRecordCandidateLimit({ limit, pluginScoped: true }), undefined, timeWindow),
          plugin,
        ).filter(record => watermarkRecordMatchesSourceFilter(record, sourceFilter as any)).slice(0, limit);
        const events = filterEventsForPlugin(store.listRuntimeEvents({ limit: runtimeEventCandidateLimit({ limit: eventLimit, pluginScoped: true }), timeWindow }), store, plugin)
          .filter(event => event.event_type !== "view_compiled" && event.event_type !== "runtime_tick_completed")
          .slice(0, eventLimit);
        return send(res, 200, {
          ok: true,
          ...activityWatermarkFromRecords(records, events),
          plugin_id: pluginParam,
          plugin_loaded: true,
        });
      }
      const watermark = store.activityTimelineWatermark({
        timeWindow,
        sourceFilter: sourceFilter as "screenpipe" | "browser" | "runtime" | "all",
        includeRuntimeEvents: url.searchParams.get("include_runtime_events") === "true" || url.searchParams.get("includeRuntimeEvents") === "true",
      });
      return send(res, 200, { ok: true, ...watermark });
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
      const sourceViews = pluginParam
        ? filterViewsForPlugin(store.listViews({ view_types: ["work_thread"], limit: viewListCandidateLimit({ limit: 80, pluginScoped: true }), timeWindow: { minutes } }), store, plugin).slice(0, 80)
        : undefined;
      const result = await runIiiViewCompile(store, VIEW_WORKER_FUNCTIONS.projectTimeline, {
        project_path: body.project_path ?? body.projectPath,
        project: body.project,
        minutes,
        limit,
        event_limit: eventLimit,
        bucket_minutes: body.bucket_minutes ?? body.bucketMinutes,
        write: body.write,
        records,
        runtime_events: runtimeEvents,
        source_views: sourceViews,
        plugin_id: pluginParam,
      });
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
      const iii = await createLocalInfoIiiRuntime(store);
      const tick = await iii.trigger({
        function_id: III_RUNTIME_FUNCTIONS.tick,
        payload: {
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
        },
      }) as { result?: any };
      const result = tick.result ?? tick;
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

async function runIiiHttpIngest(store: ContextStore, input: { record: ContextRecord; cascade: boolean; max_depth: number; context_plugin_id?: string }): Promise<ContextIngestResult> {
  const iii = await createLocalInfoIiiRuntime(store);
  return iii.trigger({
    function_id: III_CONTEXT_FUNCTIONS.ingest,
    payload: input,
  }) as Promise<ContextIngestResult>;
}

async function runIiiViewCompile(store: ContextStore, functionId: string, payload: Record<string, unknown>) {
  const iii = await createLocalInfoIiiRuntime(store);
  const result = await iii.trigger({ function_id: functionId, payload }) as {
    ok?: boolean;
    views?: Array<Record<string, unknown>>;
    diagnostics?: Record<string, unknown>;
  };
  const view = result.views?.[0];
  return {
    ok: result.ok === true,
    view,
    records_used: numberValue(result.diagnostics?.records_used),
    events_used: numberValue(result.diagnostics?.events_used),
    buckets: Array.isArray((view?.content as Record<string, unknown> | undefined)?.buckets)
      ? (view?.content as Record<string, unknown>).buckets
      : [],
    work_threads: Array.isArray((view?.content as Record<string, unknown> | undefined)?.work_threads)
      ? (view?.content as Record<string, unknown>).work_threads
      : undefined,
    iii_processing: result,
  };
}

async function createLocalInfoIiiRuntime(store: ContextStore): Promise<InProcessIiiRuntimeClient> {
  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-http-runtime" });
  return iii;
}

function httpIngestProcessingPayload(cascade: ContextIngestResult["cascade"], options: { includeDepthOne?: boolean } = {}): {
  processing: Record<string, unknown>;
  cascade_processing: Array<Record<string, unknown>>;
} {
  const programResults = (cascade?.steps ?? [])
    .map(step => (step.raw_result as { result?: Record<string, unknown> } | undefined)?.result)
    .filter((result): result is Record<string, unknown> => Boolean(result));
  const primary = programResults[0] ?? {
    ok: true,
    generated_at: cascade?.generated_at ?? new Date().toISOString(),
    decisions: [],
    runs: [],
    diagnostics: { runtime: "@info/iii-runtime", mode: cascade?.mode },
  };
  const depthOffset = options.includeDepthOne ? 0 : 1;
  const cascadeProcessing = (cascade?.steps ?? [])
    .filter(step => options.includeDepthOne ? step.depth >= 1 : step.depth > 1)
    .map(step => {
      const result = (step.raw_result as { result?: Record<string, unknown> } | undefined)?.result;
      const cascadeDepth = step.depth - depthOffset;
      if (result) return { ...result, cascade_depth: cascadeDepth, iii_function_id: step.function_id };
      return {
        ok: true,
        generated_at: cascade?.generated_at,
        cascade_depth: cascadeDepth,
        iii_function_id: step.function_id,
        runs: step.result?.views_written?.length
          ? [{ program_id: step.function_id, written_views: step.result.views_written }]
          : [],
        diagnostics: step.result?.diagnostics ?? {},
      };
    });
  return {
    processing: { ...primary, iii_cascade: cascade },
    cascade_processing: cascadeProcessing,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function mergeViewUpdate(existing: ContextView & { id: string }, body: unknown): ContextView {
  if (!isPlainObject(body)) return existing;
  const contentInput = Object.prototype.hasOwnProperty.call(body, "content") ? body.content : existing.content;
  const metadataInput = Object.prototype.hasOwnProperty.call(body, "metadata") ? body.metadata : existing.metadata;
  const scopeInput = Object.prototype.hasOwnProperty.call(body, "scope") ? body.scope : existing.scope;
  const pluginId = typeof body.plugin_id === "string" ? body.plugin_id : undefined;
  return {
    ...existing,
    ...pickViewUpdateFields(body),
    id: existing.id,
    view_type: typeof body.view_type === "string" && body.view_type.trim() ? body.view_type.trim() : existing.view_type,
    content: mergeObjectPatch(contentInput, body.content_patch) ?? {},
    metadata: {
      ...(mergeObjectPatch(metadataInput, body.metadata_patch) ?? {}),
      updated_via: "context_http_update",
      updated_actor: pluginId ? "plugin" : "application",
    },
    scope: pluginId ? { ...(isPlainObject(scopeInput) ? scopeInput : existing.scope ?? {}), plugin_id: pluginId } : (isPlainObject(scopeInput) ? scopeInput : existing.scope),
  };
}

function pickViewUpdateFields(body: Record<string, unknown>): Partial<ContextView> {
  const out: Partial<ContextView> = {};
  const fields = [
    "title",
    "summary",
    "status",
    "source_records",
    "source_views",
    "compiler",
    "purpose",
    "confidence",
    "stability",
    "lossiness",
    "privacy",
    "validity",
  ] as const;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) (out as Record<string, unknown>)[field] = body[field];
  }
  return out;
}

function mergeObjectPatch(value: unknown, patch: unknown): Record<string, unknown> | undefined {
  const base = isPlainObject(value) ? value : undefined;
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) return base;
  return deepMergeObjects(base ?? {}, patch);
}

function deepMergeObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMergeObjects(current, value)
      : value;
  }
  return merged;
}

function watermarkRecordMatchesSourceFilter(record: StoredContextRecord, sourceFilter: "screenpipe" | "browser" | "runtime" | "all") {
  if (sourceFilter === "all") return true;
  const hay = `${record.source.type} ${record.source.connector ?? ""} ${record.schema.name}`.toLowerCase();
  return hay.includes(sourceFilter);
}

function activityWatermarkFromRecords(records: StoredContextRecord[], events: StoredRuntimeEvent[] = []) {
  const sortedRecords = [...records].sort((a, b) => {
    const observedDelta = Date.parse(b.time?.observed_at ?? b.created_at) - Date.parse(a.time?.observed_at ?? a.created_at);
    if (observedDelta) return observedDelta;
    const createdDelta = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (createdDelta) return createdDelta;
    return b.id.localeCompare(a.id);
  });
  const sortedEvents = [...events].sort((a, b) => {
    const createdDelta = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (createdDelta) return createdDelta;
    return b.id.localeCompare(a.id);
  });
  const latestRecord = sortedRecords[0];
  const latestEvent = sortedEvents[0];
  const latestObservedAt = sortedRecords.reduce<string | undefined>((latest, record) => maxIso(latest, record.time?.observed_at ?? record.created_at), undefined);
  const latestRecordCreatedAt = sortedRecords.reduce<string | undefined>((latest, record) => maxIso(latest, record.created_at), undefined);
  const latestEventCreatedAt = sortedEvents.reduce<string | undefined>((latest, event) => maxIso(latest, event.created_at), undefined);
  const watermark = [
    "records",
    records.length,
    latestObservedAt ?? "",
    latestRecordCreatedAt ?? "",
    latestRecord?.id ?? "",
    "events",
    events.length,
    latestEventCreatedAt ?? "",
    latestEvent?.id ?? "",
  ].join(":");
  return {
    record_count: records.length,
    latest_observed_at: latestObservedAt,
    latest_record_created_at: latestRecordCreatedAt,
    latest_record_id: latestRecord?.id,
    event_count: events.length,
    latest_event_created_at: latestEventCreatedAt,
    latest_event_id: latestEvent?.id,
    watermark,
  };
}

function maxIso(current: string | undefined, next: string | undefined) {
  if (!next) return current;
  if (!current) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function cachedFrameImage(frameId: string) {
  const cached = frameImageCache.get(frameId);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    frameImageCache.delete(frameId);
    return undefined;
  }
  return cached;
}

function rememberFrameImage(frameId: string, image: { contentType: string; bytes: Uint8Array }) {
  frameImageCache.set(frameId, { ...image, expiresAt: Date.now() + FRAME_CACHE_TTL_MS });
  while (frameImageCache.size > FRAME_CACHE_MAX) {
    const oldest = frameImageCache.keys().next().value;
    if (!oldest) break;
    frameImageCache.delete(oldest);
  }
}

function summarizeProcessor(processor: ProcessorDefinition, source?: { kind: "observation" | "view"; type?: string }) {
  const compatible = !source?.type
    ? true
    : source.kind === "observation"
      ? matchesAny(processor.consumes.observations, source.type)
      : matchesAny(processor.consumes.views, source.type);
  return {
    id: processor.id,
    title: processor.title,
    version: processor.version,
    description: processor.description,
    runtime: processor.runtime.kind,
    runtime_config: processor.runtime,
    consumes: processor.consumes,
    produces: processor.produces,
    policy: processor.policy,
    compatible,
  };
}

function sendProcessorRunResult(res: any, store: ContextStore, result: Awaited<ReturnType<ProcessorRuntime["processObservation"]>>) {
  const views = result.views_written.map(id => store.getView(id)).filter((view): view is NonNullable<typeof view> => Boolean(view));
  const observations = (result.observations_written ?? []).map(id => store.getRecord(id)).filter((record): record is NonNullable<typeof record> => Boolean(record));
  return send(res, 200, {
    ok: true,
    result,
    views,
    observations,
  });
}

function isTimelineLiveRecord(record: StoredContextRecord): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (record.schema.name === "observation.route_candidate") return false;
  if (record.schema.name === "observation.screenpipe_workspace_signal") return false;
  if (record.schema.name === "observation.screenpipe_input_event") return false;
  if (record.privacy?.retention === "do_not_store") return false;
  return true;
}

function recordMatchesTimelineSourceFilter(record: StoredContextRecord, filter: "screenpipe" | "browser" | "runtime" | "all"): boolean {
  if (filter === "all") return true;
  const hay = `${record.source.type} ${record.source.connector ?? ""} ${record.schema.name}`.toLowerCase();
  return hay.includes(filter);
}

function liveTimelineBuckets(records: StoredContextRecord[], bucketMinutes: number) {
  const byBucket = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    const item = liveTimelineItem(record);
    const label = bucketLabelForIso(String(item.observed_at), bucketMinutes);
    byBucket.set(label, [...(byBucket.get(label) ?? []), item]);
  }
  return [...byBucket.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([label, items]) => {
    const startMs = Date.parse(label);
    const start = Number.isFinite(startMs) ? new Date(startMs).toISOString() : label;
    const end = Number.isFinite(startMs) ? new Date(startMs + bucketMinutes * 60_000).toISOString() : label;
    const topSources = topStrings(items.map(item => String(item.source ?? "")).filter(Boolean), 5);
    const topApps = topStrings(items.map(item => String(item.app ?? "")).filter(Boolean), 5);
    const topDomains = topStrings(items.map(item => String(item.domain ?? "")).filter(Boolean), 5);
    const sorted = items.sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0) || Date.parse(String(b.observed_at ?? "")) - Date.parse(String(a.observed_at ?? "")));
    return {
      label,
      start,
      end,
      count: sorted.length,
      top_sources: topSources,
      top_apps: topApps,
      top_domains: topDomains,
      top_projects: [],
      summary: `${sorted.length} live items around ${topDomains[0] ?? topApps[0] ?? topSources[0] ?? "activity"}`,
      items: sorted.slice(0, 24),
    };
  });
}

function liveTimelineItem(record: StoredContextRecord) {
  const url = record.content?.url ?? stringValue(record.payload?.browser_url);
  const domain = record.scope?.domain ?? domainFromUrl(url);
  const app = record.scope?.app ?? stringValue(record.payload?.app_name) ?? stringValue(record.payload?.app);
  const observedAt = record.time?.observed_at ?? record.created_at;
  return {
    id: `record:${record.id}`,
    kind: "activity",
    source: `${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
    schema: record.schema.name,
    title: record.content?.title ?? stringValue(record.payload?.window_name) ?? stringValue(record.payload?.title) ?? record.schema.name,
    subtitle: domain ?? app ?? record.source.type,
    url,
    path: record.content?.path,
    app,
    domain,
    text: record.content?.text,
    observed_at: observedAt,
    importance: typeof record.signal?.importance === "number" ? record.signal.importance : record.source.type === "browser" ? 0.5 : 0.35,
    record_ids: [record.id],
    stats: {
      updated_at: record.updated_at,
      created_at: record.created_at,
    },
  };
}

function bucketLabelForIso(value: string, bucketMinutes: number): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const size = bucketMinutes * 60_000;
  return new Date(Math.floor(ms / size) * size).toISOString();
}

function topStrings(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([value]) => value);
}

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function fetchScreenpipeAudioTranscripts(input: { limit: number; minutes: number }): Promise<
  | { ok: true; query: Record<string, string>; transcripts: Array<Record<string, unknown>> }
  | { ok: false; query: Record<string, string>; error: string }
> {
  const minutes = Math.min(Math.max(input.minutes, 1), 24 * 60);
  const limit = Math.min(Math.max(input.limit, 1), 2_000);
  const query = { limit: String(limit), content_type: "audio", start_time: `${minutes}m ago`, source: "screenpipe_sqlite" };
  try {
    const db = new DatabaseSync(process.env.SCREENPIPE_DB_PATH ?? `${process.env.HOME ?? ""}/.screenpipe/db.sqlite`, { readOnly: true });
    try {
      const rows = db.prepare(`
        select
          t.id,
          t.audio_chunk_id,
          t.timestamp,
          t.transcription,
          t.device,
          t.speaker_id,
          t.start_time,
          t.end_time,
          c.file_path
        from audio_transcriptions t indexed by idx_audio_transcriptions_timestamp
        left join audio_chunks c on c.id = t.audio_chunk_id
        where t.timestamp >= datetime('now', ?)
          and t.redacted_at is null
          and length(trim(t.transcription)) > 0
        order by t.timestamp desc, t.audio_chunk_id desc, coalesce(t.start_time, 0) desc, t.id desc
        limit ?
      `).all(`-${minutes} minutes`, limit) as Array<Record<string, unknown>>;
      const transcripts = rows.map(row => ({
        id: `screenpipe:audio_transcription:${row.id}`,
        observed_at: sqliteTimestampToIso(stringValue(row.timestamp)),
        text: stringValue(row.transcription),
        speaker_label: row.speaker_id !== null && row.speaker_id !== undefined ? `speaker:${row.speaker_id}` : undefined,
        device_name: stringValue(row.device),
        chunk_id: row.audio_chunk_id,
        start_time: numberValue(row.start_time),
        end_time: numberValue(row.end_time),
        file_path: stringValue(row.file_path),
        source: "screenpipe_sqlite",
      })).filter(item => stringValue(item.text));
      return { ok: true, query, transcripts };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, query, error: error instanceof Error ? error.message : String(error) };
  }
}

function sqliteTimestampToIso(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d\d:?\d\d)$/.test(normalized);
  return hasZone ? normalized : `${normalized}+00:00`;
}

export function createContextHttpServer(store = new ContextStore()) {
  return createServer(createContextHttpHandler(store));
}

function browserAutomationHttpStatus(error: unknown): 400 | 409 | 422 | 500 {
  switch (errorCode(error)) {
    case "invalid_browser_event":
      return 400;
    case "required_evidence_not_stored":
      return 422;
    case "idempotency_conflict":
    case "source_identity_conflict":
      return 409;
    default:
      return 500;
  }
}

function browserCaptureSuccessStatus(result: unknown): 200 | 201 | 202 {
  if (!result || typeof result !== "object") return 200;
  const submission = result as {
    status?: unknown;
    replayed?: unknown;
    captured_views?: Array<{ created?: unknown }>;
  };
  if (submission.status === "skipped") return 202;
  if (submission.replayed !== true && submission.captured_views?.some(view => view.created === true)) return 201;
  return 200;
}

function browserCaptureHttpStatus(error: unknown): 400 | 409 | 429 | 500 {
  switch (errorCode(error)) {
    case "invalid_browser_capture_event":
    case "capture_validation_failed":
    case "connector_mismatch":
    case "unsupported_delivery":
      return 400;
    case "idempotency_conflict":
    case "source_identity_conflict":
    case "checkpoint_conflict":
    case "connection_paused":
      return 409;
    case "backpressure":
      return 429;
    default:
      return 500;
  }
}

function macAutomationHttpStatus(error: unknown): 400 | 403 | 409 | 422 | 504 | 500 {
  switch (errorCode(error)) {
    case "invalid_macos_event":
      return 400;
    case "accessibility_denied":
      return 403;
    case "asr_failed":
    case "unknown_agent":
      return 422;
    case "idempotency_conflict":
    case "source_identity_conflict":
      return 409;
    case "browser_context_failed":
      return 504;
    default:
      return 500;
  }
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "internal_error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? code : "internal_error";
}

function errorDetails(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as { details?: unknown }).details;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createContextHttpServer().listen(port, () => {
    console.log(`[context-layer] standalone HTTP server listening on http://localhost:${port}`);
  });
}

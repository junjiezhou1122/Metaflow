import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { loadLocalEnv } from "./env.js";
import { ContextStore } from "@info/core";
import { ContextArtifactSchema, ContextConnectorSchema, ContextPackRequestSchema, ContextQuerySchema, ContextRecordSchema, ContextSchemaSchema, ContextViewSchema, FeedbackInputSchema, RuntimeEventSchema } from "@info/core";
import { enrichWithJinaReader, shouldAutoEnrichBrowserRecord } from "../../packages/connectors/enrichment/index.js";
import { fetchScreenpipeFrameImage, fetchScreenpipeRecords } from "../../packages/connectors/screenpipe/index.js";
import { aiSessionRefToRecord, locateAiSessions } from "../../packages/connectors/ai-sessions/index.js";
import { publicRuntimeSettings, runtimeSettings, runtimeStatus, runtimeTick, saveRuntimeSettings } from "../runtime/runtime.js";
import { compileObservationTimeline } from "../runtime/timeline.js";
import { compileActivityTimeline } from "../runtime/activity-timeline.js";
import { compileProjectTimeline } from "../runtime/project-timeline.js";
import { activeThreadId, interpretThread } from "../threads/thread-interpreter.js";
import { persistThreadEvidenceMap } from "../threads/thread-evidence.js";
import { mergeThreads, splitThread } from "../threads/thread-ops.js";
import { buildContextPack, filterEventsForPlugin, filterRecordsForPlugin, filterViewsForPlugin, surfacingPreferencesForPlugin } from "@info/core";
import { listPluginManifests, readPluginManifest } from "@info/core";
import { runLanguageLearningPlugin } from "@info/core";
import { createDefaultProgramRuntime, listDefaultCapabilities, listDefaultPrograms } from "../programs/registry.js";
import { signalFromObject } from "../programs/signals.js";
import { ingestFeedback } from "../runtime/feedback.js";
import { collectViewProvenance } from "../runtime/view-provenance.js";
import { filterViewsByQuery } from "@info/core";
import { rankViewsForSurfacing, surfacingPreferencesFromMemoryViews } from "@info/core";
import { VIEW_FAMILY_DEFINITIONS, VIEW_FAMILY_ORDER, manualViewFamilies, viewFamilyDefinition } from "../../packages/views/catalog.js";
import type { ContextArtifact, ContextPackRequest, ContextQuery, ContextRecord, ContextView, StoredContextRecord } from "@info/core";

loadLocalEnv();

const port = Number(process.env.CONTEXT_HTTP_PORT ?? 3111);

async function readJson(req: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

type AgentTaskHttpBody = {
  task?: Record<string, unknown>;
  context_limit?: unknown;
  contextLimit?: unknown;
  cascade_depth?: unknown;
  cascadeDepth?: unknown;
};

type ContextChatHttpBody = {
  question?: unknown;
  page_context?: {
    title?: unknown;
    url?: unknown;
    text?: unknown;
    selected_text?: unknown;
    domain?: unknown;
  };
  scope?: ContextRecord["scope"];
  limit?: unknown;
};

type ProgramRuntimeInstance = ReturnType<typeof createDefaultProgramRuntime>;

const DEFAULT_CASCADE_DEPTH = 2;
const MAX_CASCADE_DEPTH = 4;

async function cascadeGeneratedViews(input: {
  runtime: ProgramRuntimeInstance;
  store: ContextStore;
  viewIds: string[];
  contextPluginId?: string;
  maxDepth?: number;
}) {
  const maxDepth = Math.min(MAX_CASCADE_DEPTH, Math.max(1, input.maxDepth ?? DEFAULT_CASCADE_DEPTH));
  const seen = new Set<string>();
  let queue = uniqueStrings(input.viewIds);
  const cascade = [];

  for (let depth = 1; depth <= maxDepth && queue.length; depth += 1) {
    const next: string[] = [];
    for (const id of queue) {
      if (seen.has(id)) continue;
      seen.add(id);
      const view = input.store.getView(id);
      if (!view) continue;
      const result = await input.runtime.processObject(view, { context_plugin_id: input.contextPluginId });
      cascade.push({ ...result, cascade_depth: depth });
      next.push(...result.runs.flatMap(run => run.written_views));
    }
    queue = uniqueStrings(next).filter(id => !seen.has(id));
  }

  return cascade;
}

function cascadeDepth(url: URL, body?: AgentTaskHttpBody): number {
  return Math.min(
    MAX_CASCADE_DEPTH,
    positiveInteger(url.searchParams.get("cascade_depth") ?? body?.cascade_depth ?? body?.cascadeDepth) ?? DEFAULT_CASCADE_DEPTH,
  );
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value)))];
}


function withDefaultAgentTaskContextPack(taskInput: unknown, signal: ReturnType<typeof signalFromObject>, store: ContextStore, body: AgentTaskHttpBody, pluginId?: string): Record<string, unknown> {
  const task = isPlainObject(taskInput) ? { ...taskInput } : {};
  if (!pluginId && isPlainObject(task.context_pack)) return task;

  const goal = typeof task.goal === "string" && task.goal.trim() ? task.goal : `Agent task for ${signal.object_type}`;
  const query = [
    signal.title,
    signal.text_preview,
    ...(signal.keywords ?? []).slice(0, 8),
    ...(signal.topics ?? []).slice(0, 8),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join(" ");
  const limit = positiveInteger(body.context_limit ?? body.contextLimit) ?? 12;
  const pack = buildContextPack({
    goal,
    query: query || goal,
    plugin_id: pluginId,
    include_records: true,
    include_views: true,
    include_events: false,
    scope: compactScope({
      domain: signal.domain,
      project: signal.project,
      project_path: signal.project_path,
      repo: signal.repo,
      app: signal.app,
    }),
    limit,
  }, store);

  return {
    ...task,
    context_pack: {
      markdown: pack.markdown,
      sources: pack.sources,
      diagnostics: {
        ...pack.diagnostics,
        auto_built_by: "http.agent_tasks",
        context_limit: limit,
      },
    },
  };
}

function compactScope(scope: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => Boolean(value))) as Record<string, string>;
}

function scopeFromSearchParams(params: URLSearchParams) {
  const scope = compactScope({
    domain: params.get("domain") ?? undefined,
    project: params.get("project") ?? undefined,
    project_path: params.get("project_path") ?? params.get("projectPath") ?? undefined,
    repo: params.get("repo") ?? undefined,
    app: params.get("app") ?? undefined,
    session: params.get("session") ?? undefined,
  });
  return Object.keys(scope).length ? scope : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizePackForChat(pack: ReturnType<typeof buildContextPack>) {
  return {
    source_count: pack.sources.length,
    record_count: pack.records.length,
    view_count: pack.views.length,
    diagnostics: pack.diagnostics,
  };
}

async function runClaudeAcpChat(input: { prompt: string; cwd?: string; timeoutMs?: number }) {
  const command = process.env.CONTEXT_CHAT_ACP_COMMAND || process.env.AGENT_TASK_ACP_COMMAND || "./node_modules/.bin/claude-agent-acp";
  const args = parseShellArgs(process.env.CONTEXT_CHAT_ACP_ARGS || process.env.AGENT_TASK_ACP_ARGS);
  const cwd = input.cwd || process.env.CONTEXT_CHAT_CWD || process.cwd();
  const timeoutMs = input.timeoutMs ?? Number(process.env.CONTEXT_CHAT_ACP_TIMEOUT_MS || 120000);
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const stderr: string[] = [];
  const updates: acp.SessionNotification[] = [];
  let sessionId = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    child.stderr?.on("data", chunk => stderr.push(String(chunk)));
    const inputStream = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
    const outputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const connection = new acp.ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
        async sessionUpdate(params) {
          updates.push(params);
        },
        async readTextFile() {
          return { content: "" };
        },
        async writeTextFile() {
          return {};
        },
      }),
      acp.ndJsonStream(inputStream, outputStream),
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Claude ACP chat timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const childError = new Promise<never>((_, reject) => {
      child.once("error", error => reject(error));
    });
    const result = await Promise.race([(async () => {
      const init = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "metaflow", title: "metaflow", version: "0.1.0" },
        clientCapabilities: {},
      });
      const session = await connection.newSession({ cwd, mcpServers: [] });
      sessionId = session.sessionId;
      const promptResult = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: input.prompt }],
      });
      if (init.agentCapabilities?.sessionCapabilities?.close) {
        await connection.closeSession({ sessionId }).catch(() => undefined);
      }
      return {
        answer: answerFromAcpUpdates(updates),
        stopReason: promptResult.stopReason,
        updateCount: updates.length,
        agentInfo: init.agentInfo,
      };
    })(), timeout, childError]);
    if (!result.answer.trim()) throw new Error("Claude ACP chat returned no assistant text");
    return {
      ok: true,
      answer: result.answer.trim(),
      runtime: "claude_acp",
      command,
      session_id: sessionId,
      stop_reason: result.stopReason,
      update_count: result.updateCount,
      agent_info: result.agentInfo,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      runtime: "claude_acp",
      command,
      session_id: sessionId || undefined,
      stderr: stderr.join("").slice(-4000) || undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (!child.killed) child.kill();
  }
}

function answerFromAcpUpdates(updates: acp.SessionNotification[]) {
  return updates.flatMap(update => {
    const item = update.update;
    if (item.sessionUpdate !== "agent_message_chunk") return [];
    if (item.content.type !== "text") return [];
    return [item.content.text];
  }).join("").trim();
}

function parseShellArgs(value: string | undefined): string[] {
  return value ? value.split(" ").filter(Boolean) : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentTaskOutputViewType(task: unknown): string | undefined {
  if (!isPlainObject(task)) return undefined;
  const outputContract = task.output_contract;
  if (!isPlainObject(outputContract)) return undefined;
  return typeof outputContract.view_type === "string" ? outputContract.view_type : undefined;
}

function canPluginWriteAgentTaskView(plugin: ReturnType<typeof readPluginManifest>, viewType: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!plugin?.permissions?.allow_write_views) return { ok: false, error: "plugin cannot write views" };
  if (viewType && plugin.view_types_produced?.length && !plugin.view_types_produced.includes(viewType)) return { ok: false, error: "plugin cannot write this view_type" };
  return { ok: true };
}

function contextQueryFromPackRequest(req: ContextPackRequest): ContextQuery {
  return {
    goal: req.goal,
    query: req.goal,
    plugin_id: req.plugin_id,
    thread_id: req.thread_id,
    scope: req.scope,
    view_types: req.view_types,
    view_type_prefix: req.view_type_prefix,
    include_views: req.include_views,
    include_records: true,
    include_events: req.include_events,
    event_types: req.event_types,
    actor_types: req.actor_types,
    time_window: req.time_window,
    limit: req.limit,
    token_budget: req.token_budget,
  };
}

function filterArtifactsForPlugin<T extends Pick<ContextArtifact, "record_id">>(artifacts: T[], store: ContextStore, plugin?: ReturnType<typeof readPluginManifest>): T[] {
  return artifacts.filter(artifact => {
    const record = store.getRecord(artifact.record_id);
    if (!record || !isHttpVisibleRecord(record)) return false;
    return Boolean(filterRecordsForPlugin([record], plugin)[0]);
  });
}

function pluginCanWriteView(plugin: ReturnType<typeof readPluginManifest>, view: ContextView, store: ContextStore): { ok: true } | { ok: false; error: string } {
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

function normalizeCreatedView(view: ContextView, options: { plugin_id?: string | null; source?: string }): ContextView {
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

function viewReferencesAllowedRecords(view: { source_records?: string[] }, store: ContextStore): boolean {
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !isHttpVisibleRecord(record)) return false;
  }
  return true;
}

function viewReferencesExistingViews(view: { source_views?: string[] }, store: ContextStore): boolean {
  for (const id of view.source_views ?? []) {
    if (!store.getView(id)) return false;
  }
  return true;
}

function viewScopeMatchesProvenance(view: { scope?: ContextView["scope"]; source_records?: string[]; source_views?: string[] }, store: ContextStore): boolean {
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

function scopeCompatible(target?: ContextView["scope"], source?: ContextView["scope"]): boolean {
  if (!target || !source) return true;
  for (const key of ["project", "project_path", "repo", "domain", "app", "session"] as const) {
    if (target[key] && source[key] && target[key] !== source[key]) return false;
  }
  return true;
}

function pluginCanWriteEvent(plugin: ReturnType<typeof readPluginManifest>, event: Record<string, unknown>, store: ContextStore): { ok: true } | { ok: false; error: string } {
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

function eventReferencesAllowedRecords(event: { related_records?: string[] }, store: ContextStore): boolean {
  for (const id of event.related_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !isHttpVisibleRecord(record)) return false;
  }
  return true;
}

function eventReferencesAllowedViews(event: { related_views?: string[] }, store: ContextStore): boolean {
  for (const id of event.related_views ?? []) {
    const view = store.getView(id);
    if (!view || !filterViewsForPlugin([view], store)[0]) return false;
  }
  return true;
}

function pluginCanWriteRecord(plugin: ReturnType<typeof readPluginManifest>, record: ContextRecord): { ok: true } | { ok: false; error: string } {
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

function nextViewCursor(views: Array<{ updated_at?: string }>, fallback?: string): string | undefined {
  return views.reduce((cursor, view) => {
    if (!view.updated_at) return cursor;
    if (!cursor) return view.updated_at;
    return Date.parse(view.updated_at) > Date.parse(cursor) ? view.updated_at : cursor;
  }, fallback);
}

function viewListCandidateLimit(input: { limit: number; query?: string; pluginScoped: boolean }): number {
  if (input.limit <= 0) return 0;
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  // View provenance/scope filtering can remove many recent candidates.
  // Use a wider pre-filter window so Application lists still return a full page.
  return input.query ? Math.max(input.limit * 8, input.limit) : Math.max(input.limit * 50, 500);
}

function latestViewCandidateLimit(input: { query?: string; pluginScoped: boolean }): number {
  if (input.pluginScoped) return 200;
  return input.query ? 50 : 20;
}

function runtimeEventCandidateLimit(input: { limit: number; pluginScoped: boolean }): number {
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  return input.limit;
}

function contextRecordCandidateLimit(input: { limit: number; pluginScoped: boolean }): number {
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  return input.limit;
}

function artifactCandidateLimit(input: { limit: number; pluginScoped: boolean }): number {
  if (input.pluginScoped) return Math.max(input.limit * 20, 200);
  return input.limit;
}

function send(res: any, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendBytes(res: any, status: number, body: Uint8Array, contentType: string) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "private, max-age=60",
  });
  res.end(Buffer.from(body));
}

function pluginNotFoundBody(pluginId: string) {
  return { ok: false, error: `plugin not found: ${pluginId}`, plugin_id: pluginId, plugin_loaded: false };
}

function recordSchemaIngestError(schemaName: string): string | undefined {
  if (!/^(observation|feedback)(\.|$)/.test(schemaName)) return `${schemaName} is not a raw observation/feedback Record schema; derived intelligence must be written as a View`;
  return undefined;
}

function isHttpVisibleRecord(record: { schema: { name: string } }): boolean {
  return /^(observation|feedback)(\.|$)/.test(record.schema.name);
}

function sanitizeHttpIngestRecord(record: ContextRecord): ContextRecord {
  if (!isBrowserSensorRecord(record)) return record;
  if (!record.scope) return record;
  const scope = compactScope({
    domain: record.scope.domain,
    app: record.scope.app,
    plugin_id: record.scope.plugin_id,
  });
  return { ...record, scope: Object.keys(scope).length ? scope : undefined };
}

function isBrowserSensorRecord(record: ContextRecord): boolean {
  return record.source.type === "browser" || record.source.connector === "chrome-extension" || record.schema.name.startsWith("observation.browser_");
}

function filterViewProvenanceForPlugin(result: ReturnType<typeof collectViewProvenance>, store: ContextStore, plugin?: ReturnType<typeof readPluginManifest>) {
  const views = filterViewsForPlugin(result.views, store, plugin);
  const allowedViewIds = new Set(views.map(view => view.id));
  const records = filterRecordsForPlugin(result.records, plugin)
    .filter(record => views.some(view => view.source_records?.includes(record.id) && allowedViewIds.has(view.id)));
  return { ...result, views, records };
}

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

function summarizeViewForList(view: ContextView) {
  return {
    id: view.id,
    view_type: view.view_type,
    title: view.title,
    summary: view.summary,
    status: view.status,
    source_record_count: view.source_records?.length ?? 0,
    source_view_count: view.source_views?.length ?? 0,
    confidence: view.confidence,
    stability: view.stability,
    lossiness: view.lossiness,
    compiler: view.compiler,
    updated_at: "updated_at" in view ? view.updated_at : undefined,
    created_at: "created_at" in view ? view.created_at : undefined,
    content: summarizeViewContent(view.content),
  };
}

function summarizeViewContent(content: ContextView["content"]) {
  const kind = typeof content?.kind === "string" ? content.kind : undefined;
  const category = typeof content?.category === "string" ? content.category : undefined;
  const timeRange = isPlainObject(content?.time_range) ? content.time_range : undefined;
  const summary: Record<string, unknown> = { kind, category, time_range: timeRange };
  if (kind === "audio" || kind === "transcript_semantics") {
    const transcriptExcerpt = stringSummary(content?.transcript_excerpt ?? content?.transcript, 360);
    if (transcriptExcerpt) summary.transcript_excerpt = transcriptExcerpt;
    if (typeof content?.speaker_label === "string") summary.speaker_label = content.speaker_label;
    if (typeof content?.device_name === "string") summary.device_name = content.device_name;
    if (typeof content?.transcript_quality === "string") summary.transcript_quality = content.transcript_quality;
    const topics = Array.isArray(content?.topics) ? content.topics.filter(item => typeof item === "string").slice(0, 5) : [];
    if (topics.length) summary.topics = topics;
    const intents = Array.isArray(content?.stated_intents) ? content.stated_intents.filter(item => typeof item === "string").slice(0, 3) : [];
    if (intents.length) summary.stated_intents = intents;
  }
  return summary;
}

function stringSummary(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function createContextHttpServer(store = new ContextStore()) {
  return createServer(createContextHttpHandler(store));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createContextHttpServer().listen(port, () => {
    console.log(`[context-layer] standalone HTTP server listening on http://localhost:${port}`);
  });
}

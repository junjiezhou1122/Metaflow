import { createServer } from "node:http";
import { ContextStore } from "../core/store.js";
import { ContextArtifactSchema, ContextConnectorSchema, ContextPackRequestSchema, ContextQuerySchema, ContextRecordSchema, ContextSchemaSchema, ContextViewSchema, RuntimeEventSchema } from "../core/schema.js";
import { enrichWithJinaReader, shouldAutoEnrichBrowserRecord } from "../connectors/enrichment.js";
import { fetchScreenpipeRecords } from "../connectors/screenpipe.js";
import { aiSessionRefToRecord, locateAiSessions } from "../connectors/ai-sessions.js";
import { runtimeStatus, runtimeTick } from "../runtime/runtime.js";
import { compileObservationTimeline } from "../runtime/timeline.js";
import { activeThreadId, interpretThread } from "../threads/thread-interpreter.js";
import { persistThreadEvidenceMap } from "../threads/thread-evidence.js";
import { mergeThreads, splitThread } from "../threads/thread-ops.js";
import { buildContextPack } from "../broker/context-broker.js";
import { listPluginManifests, readPluginManifest } from "../plugins/registry.js";
import { runLanguageLearningPlugin } from "../plugins/language-learning.js";

const store = new ContextStore();
const port = Number(process.env.CONTEXT_HTTP_PORT ?? 3111);

async function readJson(req: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
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

createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/context/ingest") {
      const parsed = ContextRecordSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      if (parsed.data.privacy?.retention === "do_not_store") return send(res, 202, { ok: true, stored: false });
      const record = store.insertRecord(parsed.data);
      store.appendRuntimeEvent({
        event_type: "record_ingested",
        actor: parsed.data.source.type === "browser" || parsed.data.source.type === "screenpipe" ? "connector" : "user",
        status: "completed",
        subject_type: "record",
        subject_id: record.id,
        payload: { schema: record.schema.name, source: record.source, title: record.content?.title },
      });
      if (shouldAutoEnrichBrowserRecord(parsed.data)) {
        enrichWithJinaReader(store, record).catch((error) => {
          console.error("[reader-enrichment] failed", error);
        });
      }
      return send(res, 201, { ok: true, id: record.id, record, enrichment: shouldAutoEnrichBrowserRecord(parsed.data) ? "scheduled" : "skipped" });
    }

    if (req.method === "GET" && url.pathname === "/context/recent") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return send(res, 200, { ok: true, records: store.recent(limit) });
    }

    if (req.method === "POST" && url.pathname === "/context/search") {
      const body = await readJson(req);
      return send(res, 200, { ok: true, records: store.search(String(body.query ?? ""), Number(body.limit ?? 50), body.scope) });
    }

    if (req.method === "POST" && url.pathname === "/context/pack") {
      const parsed = ContextPackRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const extraRecords = [];
      const diagnostics: Record<string, unknown> = {};
      const includeScreenpipe = parsed.data.include_screenpipe || parsed.data.screenpipe?.enabled;
      if (includeScreenpipe) {
        const screenpipe = await fetchScreenpipeRecords({
          ...parsed.data.screenpipe,
          q: parsed.data.screenpipe?.q ?? parsed.data.goal,
          limit: parsed.data.screenpipe?.limit ?? Math.min(8, parsed.data.limit ?? 8),
          start_time: parsed.data.screenpipe?.start_time ?? parsed.data.time_window?.start_time,
          end_time: parsed.data.screenpipe?.end_time ?? parsed.data.time_window?.end_time,
          app_name: parsed.data.screenpipe?.app_name ?? parsed.data.scope?.app,
          browser_url: parsed.data.screenpipe?.browser_url ?? parsed.data.scope?.domain,
        });
        diagnostics.screenpipe = { ok: screenpipe.ok, url: screenpipe.url, query: screenpipe.query, count: screenpipe.records.length, error: screenpipe.error };
        extraRecords.push(...screenpipe.records);
      }
      if (parsed.data.include_ai_sessions) {
        const projectPath = parsed.data.scope?.project_path ?? parsed.data.scope?.project ?? process.cwd();
        const located = locateAiSessions({
          project_path: projectPath,
          start_time: parsed.data.time_window?.start_time,
          end_time: parsed.data.time_window?.end_time,
          minutes: parsed.data.time_window?.minutes,
          tools: parsed.data.ai_sessions?.tools,
          limit: parsed.data.ai_sessions?.limit ?? 8,
          include_snippets: parsed.data.ai_sessions?.snippets,
        });
        diagnostics.ai_sessions = { count: located.sessions.length, time_window: located.time_window, diagnostics: located.diagnostics };
        extraRecords.push(...located.sessions.map(aiSessionRefToRecord));
      }
      return send(res, 200, { ok: true, pack: store.buildPack(parsed.data, extraRecords, diagnostics) });
    }


    if (req.method === "POST" && url.pathname === "/context/views") {
      const parsed = ContextViewSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const view = store.upsertView(parsed.data);
      return send(res, 201, { ok: true, id: view.id, view });
    }

    if (req.method === "GET" && url.pathname === "/context/views") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const viewTypes = url.searchParams.get("view_types")?.split(",").map(x => x.trim()).filter(Boolean);
      return send(res, 200, { ok: true, views: store.listViews({ limit, view_types: viewTypes }) });
    }

    if (req.method === "POST" && url.pathname === "/context/query") {
      const parsed = ContextQuerySchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const pack = buildContextPack(parsed.data, store);
      return send(res, 200, { ok: true, pack });
    }

    if (req.method === "POST" && url.pathname === "/context/artifacts") {
      const parsed = ContextArtifactSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const artifact = store.insertArtifact(parsed.data);
      return send(res, 201, { ok: true, id: artifact.id, artifact });
    }


    if (req.method === "POST" && url.pathname === "/context/connectors") {
      const parsed = ContextConnectorSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const connector = store.registerConnector(parsed.data);
      return send(res, 201, { ok: true, connector });
    }

    if (req.method === "GET" && url.pathname === "/context/connectors") {
      return send(res, 200, { ok: true, connectors: store.listConnectors() });
    }

    if (req.method === "POST" && url.pathname === "/context/schemas") {
      const parsed = ContextSchemaSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const schema = store.registerSchema(parsed.data);
      return send(res, 201, { ok: true, schema });
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
      const result = runLanguageLearningPlugin({ days: body.days, limit: body.limit, write: body.write, min_count: body.min_count }, store);
      return send(res, 200, result);
    }



    if (req.method === "POST" && url.pathname === "/timeline/observations/compile") {
      const body = await readJson(req);
      const result = compileObservationTimeline({ minutes: body.minutes, limit: body.limit, write: body.write }, store);
      return send(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/runtime/events") {
      return send(res, 200, { ok: true, events: store.listRuntimeEvents({
        limit: Number(url.searchParams.get("limit") ?? 50),
        event_type: url.searchParams.get("type") ?? undefined,
        event_types: url.searchParams.get("types")?.split(",").map(x => x.trim()).filter(Boolean),
        plugin_id: url.searchParams.get("plugin") ?? undefined,
        actor: url.searchParams.get("actor") as any || undefined,
        actor_types: url.searchParams.get("actors")?.split(",").map(x => x.trim()).filter(Boolean) as any,
        timeWindow: url.searchParams.get("minutes") ? { minutes: Number(url.searchParams.get("minutes")) } : undefined,
        subject_type: url.searchParams.get("subject_type") ?? undefined,
        subject_id: url.searchParams.get("subject_id") ?? undefined,
      }) });
    }

    if (req.method === "POST" && url.pathname === "/runtime/events") {
      const parsed = RuntimeEventSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { ok: false, error: parsed.error.flatten() });
      const event = store.appendRuntimeEvent(parsed.data);
      return send(res, 201, { ok: true, event });
    }

    if (req.method === "POST" && url.pathname === "/runtime/tick") {
      const body = await readJson(req);
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
      }, store);
      store.appendRuntimeEvent({ event_type: "runtime_tick_completed", actor: "system", status: "completed", subject_type: "runtime", subject_id: "runtime_tick", related_threads: result.written_threads, related_records: result.evidence.written_records, payload: { active_workspace: result.active_workspace, evidence: result.evidence, candidate_count: result.candidate_threads.length } });
      return send(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/runtime/status") {
      return send(res, 200, runtimeStatus(store));
    }

    if (req.method === "POST" && url.pathname === "/thread/interpret") {
      const body = await readJson(req);
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
      const rawId = url.searchParams.get("thread_id") ?? "active";
      const threadId = rawId === "active" ? activeThreadId(store) : rawId;
      if (!threadId) return send(res, 404, { ok: false, error: "no active thread" });
      const result = persistThreadEvidenceMap(threadId, store);
      return send(res, result.ok ? 200 : 404, result);
    }

    if (req.method === "POST" && url.pathname === "/thread/merge") {
      const body = await readJson(req);
      const result = mergeThreads(String(body.target_id), Array.isArray(body.source_ids) ? body.source_ids.map(String) : [], { title: body.title, write: body.write }, store);
      return send(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/thread/split") {
      const body = await readJson(req);
      const result = splitThread(String(body.thread_id), Array.isArray(body.evidence_ids) ? body.evidence_ids.map(String) : [], { title: body.title, write: body.write }, store);
      return send(res, result.ok ? 200 : 400, result);
    }

    return send(res, 404, { ok: false, error: "not found" });
  } catch (error: any) {
    return send(res, 500, { ok: false, error: error?.message ?? String(error) });
  }
}).listen(port, () => {
  console.log(`[context-layer] standalone HTTP server listening on http://localhost:${port}`);
});

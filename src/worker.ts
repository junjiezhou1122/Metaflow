import { registerWorker } from "iii-sdk";
import { ContextStore } from "./store.js";
import { ContextArtifactSchema, ContextConnectorSchema, ContextPackRequestSchema, ContextQuerySchema, ContextRecordSchema, ContextSchemaSchema, ContextViewSchema } from "./schema.js";
import { enrichWithJinaReader, shouldAutoEnrichBrowserRecord } from "./enrichment.js";
import { fetchScreenpipeRecords } from "./screenpipe.js";
import { aiSessionRefToRecord, locateAiSessions } from "./ai-sessions.js";
import { buildContextPack } from "./context-broker.js";
import { listPluginManifests } from "./plugins.js";
import { runLanguageLearningPlugin } from "./language-learning.js";

const engineUrl = process.env.III_ENGINE_URL ?? "ws://localhost:49134";
const store = new ContextStore();

function api(status_code: number, body: unknown) {
  return {
    status_code,
    headers: { "Content-Type": "application/json" },
    body,
  };
}

function getBody(input: any) {
  return input?.body ?? input;
}

async function main() {
  const iii = await registerWorker(engineUrl, { workerName: "context-layer" });

  await iii.registerFunction("context::ingest", async (input: any) => {
    const parsed = ContextRecordSchema.safeParse(getBody(input));
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
    if (parsed.data.privacy?.retention === "do_not_store") {
      return api(202, { ok: true, stored: false, reason: "retention=do_not_store" });
    }
    const record = store.insertRecord(parsed.data);
    if (shouldAutoEnrichBrowserRecord(parsed.data)) {
      enrichWithJinaReader(store, record).catch((error) => {
        console.error("[reader-enrichment] failed", error);
      });
    }
    return api(201, { ok: true, id: record.id, record, enrichment: shouldAutoEnrichBrowserRecord(parsed.data) ? "scheduled" : "skipped" });
  });

  await iii.registerFunction("context::recent", async (input: any) => {
    const body = getBody(input) ?? {};
    const limit = Number(body.limit ?? input?.query?.limit ?? 50);
    const scope = body.scope ?? {};
    return api(200, { ok: true, records: store.recent(limit, scope) });
  });

  await iii.registerFunction("context::search", async (input: any) => {
    const body = getBody(input) ?? {};
    const query = String(body.query ?? "");
    const limit = Number(body.limit ?? 50);
    return api(200, { ok: true, records: store.search(query, limit, body.scope) });
  });

  await iii.registerFunction("context::pack", async (input: any) => {
    const parsed = ContextPackRequestSchema.safeParse(getBody(input) ?? {});
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
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
    return api(200, { ok: true, pack: store.buildPack(parsed.data, extraRecords, diagnostics) });
  });


  await iii.registerFunction("context::view_upsert", async (input: any) => {
    const parsed = ContextViewSchema.safeParse(getBody(input));
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
    const view = store.upsertView(parsed.data);
    return api(201, { ok: true, id: view.id, view });
  });

  await iii.registerFunction("context::query", async (input: any) => {
    const parsed = ContextQuerySchema.safeParse(getBody(input) ?? {});
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
    return api(200, { ok: true, pack: buildContextPack(parsed.data, store) });
  });

  await iii.registerFunction("context::artifact_create", async (input: any) => {
    const parsed = ContextArtifactSchema.safeParse(getBody(input));
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
    const artifact = store.insertArtifact(parsed.data);
    return api(201, { ok: true, id: artifact.id, artifact });
  });


  await iii.registerFunction("context::connector_register", async (input: any) => {
    const parsed = ContextConnectorSchema.safeParse(getBody(input));
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
    const connector = store.registerConnector(parsed.data);
    return api(201, { ok: true, connector });
  });

  await iii.registerFunction("context::connectors", async () => {
    return api(200, { ok: true, connectors: store.listConnectors() });
  });

  await iii.registerFunction("context::schema_register", async (input: any) => {
    const parsed = ContextSchemaSchema.safeParse(getBody(input));
    if (!parsed.success) return api(400, { ok: false, error: parsed.error.flatten() });
    const schema = store.registerSchema(parsed.data);
    return api(201, { ok: true, schema });
  });


  await iii.registerFunction("plugins::list", async () => {
    return api(200, { ok: true, plugins: listPluginManifests() });
  });

  await iii.registerFunction("plugins::language_learning_run", async (input: any) => {
    const body = getBody(input) ?? {};
    return api(200, runLanguageLearningPlugin({ days: body.days, limit: body.limit, write: body.write, min_count: body.min_count }, store));
  });


  await iii.registerTrigger({
    type: "http",
    function_id: "plugins::list",
    config: { api_path: "/plugins", http_method: "GET" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "plugins::language_learning_run",
    config: { api_path: "/plugins/language-learning/run", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::ingest",
    config: { api_path: "/context/ingest", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::recent",
    config: { api_path: "/context/recent", http_method: "GET" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::search",
    config: { api_path: "/context/search", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::pack",
    config: { api_path: "/context/pack", http_method: "POST" },
  });

  await iii.registerTrigger({
    type: "http",
    function_id: "context::view_upsert",
    config: { api_path: "/context/views", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::query",
    config: { api_path: "/context/query", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::artifact_create",
    config: { api_path: "/context/artifacts", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::schema_register",
    config: { api_path: "/context/schemas", http_method: "POST" },
  });

  await iii.registerTrigger({
    type: "http",
    function_id: "context::connector_register",
    config: { api_path: "/context/connectors", http_method: "POST" },
  });
  await iii.registerTrigger({
    type: "http",
    function_id: "context::connectors",
    config: { api_path: "/context/connectors", http_method: "GET" },
  });

  console.log(`[context-layer] worker connected to ${engineUrl}`);
  console.log(`[context-layer] HTTP routes registered on iii-http, usually http://localhost:3111`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

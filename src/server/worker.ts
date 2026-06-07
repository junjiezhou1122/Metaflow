import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { registerWorker } from "iii-sdk";
import { ContextStore } from "@info/core";
import { createContextHttpHandler } from "./http-server.js";

const engineUrl = process.env.III_ENGINE_URL ?? "ws://localhost:49134";

type IiiWorkerLike = {
  registerFunction(id: string, handler: (input: any) => Promise<any>): unknown | Promise<unknown>;
  registerTrigger(trigger: { type: string; function_id: string; config: Record<string, unknown> }): unknown | Promise<unknown>;
};

type RouteSpec = {
  id: string;
  method: "GET" | "POST";
  path: string;
  getQuery?: (input: any) => Record<string, unknown> | undefined;
};

const functionRoutes: RouteSpec[] = [
  { id: "context::ingest", method: "POST", path: "/context/ingest" },
  { id: "context::recent", method: "GET", path: "/context/recent" },
  { id: "context::search", method: "POST", path: "/context/search" },
  { id: "context::pack", method: "POST", path: "/context/pack" },
  { id: "context::view_catalog", method: "GET", path: "/context/views/catalog" },
  { id: "context::view_upsert", method: "POST", path: "/context/views" },
  { id: "context::query", method: "POST", path: "/context/query" },
  { id: "context::artifact_create", method: "POST", path: "/context/artifacts" },
  { id: "context::connector_register", method: "POST", path: "/context/connectors" },
  { id: "context::connectors", method: "GET", path: "/context/connectors" },
  { id: "context::schema_register", method: "POST", path: "/context/schemas" },
  { id: "timeline::observations_compile", method: "POST", path: "/timeline/observations/compile" },
  { id: "runtime::event_append", method: "POST", path: "/runtime/events" },
  { id: "runtime::events", method: "GET", path: "/runtime/events", getQuery: runtimeEventsQuery },
  { id: "plugins::list", method: "GET", path: "/plugins" },
  { id: "plugins::language_learning_run", method: "POST", path: "/plugins/language-learning/run" },
];

const httpTriggers = [
  { function_id: "timeline::observations_compile", api_path: "/timeline/observations/compile", http_method: "POST" },
  { function_id: "runtime::event_append", api_path: "/runtime/events", http_method: "POST" },
  { function_id: "runtime::events", api_path: "/runtime/events/query", http_method: "POST" },
  { function_id: "plugins::list", api_path: "/plugins", http_method: "GET" },
  { function_id: "plugins::language_learning_run", api_path: "/plugins/language-learning/run", http_method: "POST" },
  { function_id: "context::ingest", api_path: "/context/ingest", http_method: "POST" },
  { function_id: "context::recent", api_path: "/context/recent", http_method: "GET" },
  { function_id: "context::search", api_path: "/context/search", http_method: "POST" },
  { function_id: "context::pack", api_path: "/context/pack", http_method: "POST" },
  { function_id: "context::view_catalog", api_path: "/context/views/catalog", http_method: "GET" },
  { function_id: "context::view_upsert", api_path: "/context/views", http_method: "POST" },
  { function_id: "context::query", api_path: "/context/query", http_method: "POST" },
  { function_id: "context::artifact_create", api_path: "/context/artifacts", http_method: "POST" },
  { function_id: "context::schema_register", api_path: "/context/schemas", http_method: "POST" },
  { function_id: "context::connector_register", api_path: "/context/connectors", http_method: "POST" },
  { function_id: "context::connectors", api_path: "/context/connectors", http_method: "GET" },
];

export async function registerContextWorkerFunctions(iii: IiiWorkerLike, store = new ContextStore()) {
  for (const route of functionRoutes) {
    await iii.registerFunction(route.id, (input: any) => invokeHttpRoute(store, route, input));
  }
  for (const trigger of httpTriggers) {
    await iii.registerTrigger({
      type: "http",
      function_id: trigger.function_id,
      config: { api_path: trigger.api_path, http_method: trigger.http_method },
    });
  }
}

async function invokeHttpRoute(store: ContextStore, route: RouteSpec, input: any) {
  const body = route.method === "GET" ? undefined : requestBody(input);
  const query = route.getQuery?.(input) ?? requestQuery(input, route.method);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  req.method = route.method;
  req.url = withQuery(route.path, query);
  req.headers = { host: "localhost", "content-type": "application/json" };

  let statusCode = 0;
  let raw = "";
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(value: string) {
      raw = value;
    },
  };

  await createContextHttpHandler(store)(req, res);
  return {
    status_code: statusCode,
    headers: { "Content-Type": "application/json" },
    body: raw ? JSON.parse(raw) : undefined,
  };
}

function requestBody(input: any) {
  if (input && typeof input === "object" && "body" in input) return input.body;
  if (input && typeof input === "object" && "query" in input) return {};
  return input ?? {};
}

function requestQuery(input: any, method: "GET" | "POST") {
  if (input && typeof input === "object" && input.query && typeof input.query === "object") return input.query;
  if (method === "GET") return requestBody(input);
  return undefined;
}

function runtimeEventsQuery(input: any) {
  const body = requestBody(input) ?? {};
  const query = requestQuery(input, "GET") ?? {};
  return {
    ...query,
    limit: body.limit,
    type: body.event_type ?? body.type,
    types: Array.isArray(body.event_types) ? body.event_types.join(",") : body.types,
    plugin: body.event_plugin_id ?? body.plugin,
    plugin_id: body.context_plugin_id ?? body.caller_plugin_id ?? body.plugin_id,
    actor: body.actor,
    actors: Array.isArray(body.actor_types) ? body.actor_types.join(",") : body.actors,
    minutes: body.minutes,
    subject_type: body.subject_type,
    subject_id: body.subject_id,
  };
}

function withQuery(path: string, query: Record<string, unknown> | undefined) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function main() {
  const iii = await registerWorker(engineUrl, { workerName: "context-layer" });
  await registerContextWorkerFunctions(iii);
  console.log(`[context-layer] worker connected to ${engineUrl}`);
  console.log(`[context-layer] HTTP routes registered on iii-http, usually http://localhost:3111`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

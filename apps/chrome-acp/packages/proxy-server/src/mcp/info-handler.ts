// Info context tool handler — forwards tool calls to the local info
// context-layer HTTP server (default http://localhost:3111).
//
// Three tools are implemented:
//   - info_search_context   → POST /context/query
//   - info_get_view         → GET  /context/views/:id
//   - info_submit_feedback  → POST /feedback
//
// All requests go through Node's built-in fetch (Node 18+). Failures are
// returned as McpToolCallResult with isError=true so the agent can react.

import { log } from "../logger.js";
import {
  DEFAULT_INFO_CONTEXT_BASE_URL,
  type McpToolCallParams,
  type McpToolCallResult,
} from "./types.js";

function infoBaseUrl(): string {
  return (process.env.INFO_CONTEXT_BASE_URL ?? DEFAULT_INFO_CONTEXT_BASE_URL).replace(/\/+$/, "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && Boolean(v.trim()));
  return items.length ? items : undefined;
}

function textResult(text: string, isError = false): McpToolCallResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function errorResult(message: string): McpToolCallResult {
  return textResult(`info context error: ${message}`, true);
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: T | string = text;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    // leave as raw text
  }
  return { ok: response.ok, status: response.status, data };
}

async function getJson<T>(url: string): Promise<{ ok: boolean; status: number; data: T | string }> {
  const response = await fetch(url);
  const text = await response.text();
  let data: T | string = text;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    // leave as raw text
  }
  return { ok: response.ok, status: response.status, data };
}

function renderPackMarkdown(pack: unknown): string {
  if (!pack || typeof pack !== "object") return JSON.stringify(pack, null, 2);
  const anyPack = pack as Record<string, unknown>;
  if (typeof anyPack.markdown === "string" && anyPack.markdown.trim()) return anyPack.markdown;
  return JSON.stringify(pack, null, 2);
}

async function handleSearchContext(args: Record<string, unknown> | undefined): Promise<McpToolCallResult> {
  const query = asString(args?.query);
  if (!query) return errorResult("query is required");

  const body: Record<string, unknown> = {
    query,
    include_records: true,
    include_views: true,
    include_events: false,
  };
  const viewTypes = asStringArray(args?.view_types);
  if (viewTypes) body.view_types = viewTypes;
  const minutes = asNumber(args?.minutes);
  if (minutes) body.time_window = { minutes };
  const limit = asNumber(args?.limit);
  if (limit) body.limit = limit;

  const url = `${infoBaseUrl()}/context/query`;
  log.info("info_search_context → POST /context/query", { url, query });
  const { ok, status, data } = await postJson<{ ok?: boolean; pack?: unknown; error?: unknown }>(url, body);
  if (!ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    return errorResult(`HTTP ${status}: ${detail.slice(0, 600)}`);
  }
  if (typeof data === "object" && data && data.ok === false) {
    return errorResult(`info returned ok=false: ${JSON.stringify(data.error ?? data).slice(0, 600)}`);
  }
  const pack = (data && typeof data === "object" && "pack" in data) ? (data as { pack?: unknown }).pack : data;
  return textResult(renderPackMarkdown(pack));
}

async function handleGetView(args: Record<string, unknown> | undefined): Promise<McpToolCallResult> {
  const viewId = asString(args?.view_id);
  if (!viewId) return errorResult("view_id is required");

  const url = `${infoBaseUrl()}/context/views/${encodeURIComponent(viewId)}`;
  log.info("info_get_view → GET /context/views/:id", { url });
  const { ok, status, data } = await getJson<{ ok?: boolean; view?: unknown; error?: unknown }>(url);
  if (!ok) {
    if (status === 404) return errorResult(`view not found: ${viewId}`);
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    return errorResult(`HTTP ${status}: ${detail.slice(0, 600)}`);
  }
  if (typeof data === "object" && data && data.ok === false) {
    return errorResult(`info returned ok=false: ${JSON.stringify(data.error ?? data).slice(0, 600)}`);
  }
  const view = (data && typeof data === "object" && "view" in data) ? (data as { view?: unknown }).view : data;
  return textResult(renderPackMarkdown(view));
}

async function handleSubmitFeedback(args: Record<string, unknown> | undefined): Promise<McpToolCallResult> {
  const type = asString(args?.type);
  const applicationId = asString(args?.application_id);
  if (!type) return errorResult("type is required");
  if (!applicationId) return errorResult("application_id is required");

  const viewId = asString(args?.view_id);
  const recordId = asString(args?.record_id);
  if (!viewId && !recordId) return errorResult("view_id or record_id is required");

  const body: Record<string, unknown> = {
    type,
    application_id: applicationId,
  };
  if (viewId) body.view_id = viewId;
  if (recordId) body.record_id = recordId;
  if (args?.value !== undefined) body.value = args.value;
  const reason = asString(args?.reason);
  if (reason) body.reason = reason;
  if (args?.payload && typeof args.payload === "object") body.payload = args.payload;

  const url = `${infoBaseUrl()}/feedback`;
  log.info("info_submit_feedback → POST /feedback", { url, type, viewId, recordId });
  const { ok, status, data } = await postJson<{ ok?: boolean; error?: unknown }>(url, body);
  if (!ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    return errorResult(`HTTP ${status}: ${detail.slice(0, 600)}`);
  }
  if (typeof data === "object" && data && data.ok === false) {
    return errorResult(`info returned ok=false: ${JSON.stringify(data.error ?? data).slice(0, 600)}`);
  }
  return textResult(JSON.stringify(data, null, 2));
}

export async function executeInfoTool(params: McpToolCallParams): Promise<McpToolCallResult> {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (params.name) {
      case "info_search_context":
        return await handleSearchContext(args);
      case "info_get_view":
        return await handleGetView(args);
      case "info_submit_feedback":
        return await handleSubmitFeedback(args);
      default:
        return errorResult(`unknown info tool: ${params.name}`);
    }
  } catch (error) {
    log.error("info tool call failed", { tool: params.name, error: (error as Error).message });
    return errorResult((error as Error).message);
  }
}

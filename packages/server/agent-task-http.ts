import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildContextPack } from "@info/core";
import type { ContextPackRequest, ContextQuery, ContextRecord, ContextStore } from "@info/core";
import type { signalFromObject } from "@info/programs/signals.js";
import type { createDefaultProgramRuntime } from "@info/programs/registry.js";
import { compactScope, errorMessage, isPlainObject, positiveInteger, uniqueStrings } from "./http-util.js";

export type AgentTaskHttpBody = {
  task?: Record<string, unknown>;
  context_limit?: unknown;
  contextLimit?: unknown;
  cascade_depth?: unknown;
  cascadeDepth?: unknown;
};

export type ContextChatHttpBody = {
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

type ProgramRuntimeLike = ReturnType<typeof createDefaultProgramRuntime>;

export const DEFAULT_CASCADE_DEPTH = 2;
export const MAX_CASCADE_DEPTH = 4;

export async function cascadeGeneratedViews(input: {
  runtime: ProgramRuntimeLike;
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

export function cascadeDepth(url: URL, body?: AgentTaskHttpBody): number {
  return Math.min(
    MAX_CASCADE_DEPTH,
    positiveInteger(url.searchParams.get("cascade_depth") ?? body?.cascade_depth ?? body?.cascadeDepth) ?? DEFAULT_CASCADE_DEPTH,
  );
}

export function withDefaultAgentTaskContextPack(taskInput: unknown, signal: ReturnType<typeof signalFromObject>, store: ContextStore, body: AgentTaskHttpBody, pluginId?: string): Record<string, unknown> {
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

export function summarizePackForChat(pack: ReturnType<typeof buildContextPack>) {
  return {
    source_count: pack.sources.length,
    record_count: pack.records.length,
    view_count: pack.views.length,
    diagnostics: pack.diagnostics,
  };
}

export function contextQueryFromPackRequest(req: ContextPackRequest): ContextQuery {
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

export function agentTaskOutputViewType(task: unknown): string | undefined {
  if (!isPlainObject(task)) return undefined;
  const outputContract = task.output_contract;
  if (!isPlainObject(outputContract)) return undefined;
  return typeof outputContract.view_type === "string" ? outputContract.view_type : undefined;
}

export async function runClaudeAcpChat(input: { prompt: string; cwd?: string; timeoutMs?: number }) {
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

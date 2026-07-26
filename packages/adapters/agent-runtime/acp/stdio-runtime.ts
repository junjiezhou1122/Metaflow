import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildAgentConversationPromptBlocks, buildAgentTaskPromptBlocks } from "./content.js";
import { normalizeAgentTaskOutput, stripJsonCodeFence } from "../outputs/view-output.js";
import type {
  AgentAcpStdioRuntimeOptions,
  AgentConversationContext,
  AgentConversationRequest,
  AgentConversationResult,
  AgentConversationRuntimeAdapter,
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentRuntimeEvent,
  AgentTaskRequest,
  AgentTaskResult,
} from "../types.js";

export class AcpStdioAgentRuntimeAdapter implements AgentRuntimeAdapter, AgentConversationRuntimeAdapter {
  readonly id: string;
  readonly kind = "acp_stdio" as const;
  private processByTask = new Map<string, ChildProcess>();
  private connectionByTask = new Map<string, acp.ClientSideConnection>();
  private persistent?: PersistentAcpConnection;
  private persistentStart?: Promise<PersistentAcpConnection>;
  private persistentSessionByTask = new Map<string, string>();
  private persistentSessionByConversation = new Map<string, string>();
  private activeConversations = new Set<string>();
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: AgentAcpStdioRuntimeOptions) {
    this.id = options.id ?? "acp_stdio";
  }

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      modes: ["invoke" as const],
      supportsDryRun: false,
      supportsCancel: true,
      supportsPermissionRequests: true,
      supportsProgress: true,
      supportsMcpServers: true,
    };
  }

  async warmup(): Promise<{ process_id?: number; process_reused: boolean }> {
    if (this.options.lifecycle !== "persistent") {
      throw new Error("ACP warmup requires lifecycle=persistent");
    }
    const processReused = Boolean(this.persistent && !this.persistent.connection.signal.aborted);
    const runtime = await this.ensurePersistent(
      { id: `${this.id}:warmup`, cwd: this.options.cwd },
      { signal: { source: "runtime_warmup" } },
    );
    return { process_id: runtime.child.pid, process_reused: processReused };
  }

  async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    if (task.dryRun) {
      const blocks = buildAgentTaskPromptBlocks({ task, signal: context.signal, contextSources: task.contextPack?.sources ?? [] });
      return {
        ok: true,
        reason: "dry_run previewed ACP stdio agent task",
        diagnostics: {
          runtime: this.id,
          dry_run: true,
          prompt_blocks: blocks,
          mcp_server_count: context.mcpServers?.length ?? 0,
          task_prompt: task.prompt ?? task.goal,
          output_view_type: task.outputContract.viewType,
        },
      };
    }

    if (this.options.lifecycle === "persistent") {
      return this.submitPersistent(task, context);
    }

    let sessionId: string | undefined;
    let child: ChildProcess | undefined;
    let connection: acp.ClientSideConnection | undefined;

    try {
      await emit(context, { type: "runtime.start", runtime: this.id, taskId: task.id, payload: { command: this.options.command, args: this.options.args ?? [] } });
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: task.cwd ?? this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.processByTask.set(task.id, child);

      child.stderr?.on("data", chunk => {
        void emit(context, {
          type: "runtime.prompt_update",
          runtime: this.id,
          taskId: task.id,
          sessionId,
          update: {
            sessionId: sessionId ?? "pending",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: String(chunk) },
            },
          },
        });
      });

      const input = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
      const outputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, outputStream);
      const updates: acp.SessionNotification[] = [];
      const runtimeId = this.id;
      connection = new acp.ClientSideConnection(
        () => ({
          async requestPermission(params) {
            await emit(context, { type: "runtime.permission_requested", runtime: runtimeId, taskId: task.id, sessionId: params.sessionId, request: params });
            return context.permissions?.requestPermission(params) ?? { outcome: { outcome: "cancelled" } };
          },
          async sessionUpdate(params) {
            updates.push(params);
            await emit(context, { type: "runtime.prompt_update", runtime: runtimeId, taskId: task.id, sessionId: params.sessionId, update: params });
          },
          async readTextFile() {
            return { content: "" };
          },
          async writeTextFile() {
            return {};
          },
        }),
        stream,
      );
      this.connectionByTask.set(task.id, connection);

      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: this.options.clientInfo ?? { name: "info", title: "Info", version: "0.0.1" },
        clientCapabilities: {},
      });
      await emit(context, {
        type: "runtime.initialized",
        runtime: this.id,
        taskId: task.id,
        payload: { protocolVersion: initResult.protocolVersion, agentInfo: initResult.agentInfo, agentCapabilities: initResult.agentCapabilities },
      });

      const session = await connection.newSession({
        cwd: task.cwd ?? this.options.cwd ?? process.cwd(),
        mcpServers: context.mcpServers ?? [],
      });
      sessionId = session.sessionId;
      await emit(context, { type: "runtime.session_created", runtime: this.id, taskId: task.id, sessionId, payload: { models: session.models, modes: session.modes } });

      const response = await connection.prompt({
        sessionId,
        prompt: buildAgentTaskPromptBlocks({ task, signal: context.signal, contextSources: task.contextPack?.sources ?? [] }),
      });
      await emit(context, { type: "runtime.prompt_complete", runtime: this.id, taskId: task.id, sessionId, payload: { stopReason: response.stopReason } });

      const agentOutput = outputFromUpdates(updates, response.stopReason);

      await maybeCloseSession(connection, sessionId, initResult.agentCapabilities);
      return {
        ok: true,
        reason: `submitted agent task to ${this.id}`,
        output: agentOutput,
        diagnostics: {
          runtime: this.id,
          stop_reason: response.stopReason,
          session_id: sessionId,
          update_count: updates.length,
          mcp_server_count: context.mcpServers?.length ?? 0,
          agent_capabilities: initResult.agentCapabilities,
        },
      };
    } catch (error) {
      await emit(context, { type: "runtime.failed", runtime: this.id, taskId: task.id, sessionId, error: errorMessage(error) });
      return {
        ok: false,
        reason: `ACP stdio agent task failed: ${errorMessage(error)}`,
        diagnostics: { runtime: this.id, session_id: sessionId, error: errorMessage(error) },
      };
    } finally {
      this.connectionByTask.delete(task.id);
      this.processByTask.delete(task.id);
      if (child && !child.killed) child.kill();
    }
  }

  async converse(request: AgentConversationRequest, conversationContext?: AgentConversationContext): Promise<AgentConversationResult> {
    if (this.options.lifecycle !== "persistent") {
      return { ok: false, reason: "ACP conversation requires lifecycle=persistent" };
    }
    if (this.activeConversations.has(request.conversationId)) {
      return { ok: false, reason: `ACP conversation is busy: ${request.conversationId}` };
    }
    this.activeConversations.add(request.conversationId);
    const context: AgentRuntimeContext = {
      signal: {
        source: "metaflow-notch",
        request_id: request.id,
        conversation_id: request.conversationId,
      },
      events: {
        async emit(event) {
          if (event.type !== "runtime.prompt_update") return;
          const update = event.update.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            await conversationContext?.onEvent?.({ type: "text_delta", delta: update.content.text });
            return;
          }
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            await conversationContext?.onEvent?.({
              type: "diagnostic",
              event: `acp.${update.sessionUpdate}`,
              details: { update: observableToolUpdate(update) },
            });
          }
        },
      },
      permissions: conversationContext?.permissions,
    };
    const processReused = Boolean(this.persistent && !this.persistent.connection.signal.aborted);
    let runtime: PersistentAcpConnection | undefined;
    let sessionId: string | undefined;
    let sessionReused = false;
    try {
      runtime = await this.ensurePersistent({ id: request.id, cwd: request.cwd }, context);
      if (request.screenImage && runtime.initialize.agentCapabilities?.promptCapabilities?.image !== true) {
        throw new Error(`ACP agent ${runtime.initialize.agentInfo?.name ?? this.id} does not advertise image prompt support`);
      }
      sessionId = this.persistentSessionByConversation.get(request.conversationId);
      sessionReused = Boolean(sessionId);
      if (!sessionId) {
        const session = await runtime.connection.newSession({
          cwd: request.cwd ?? this.options.cwd ?? process.cwd(),
          mcpServers: [],
        });
        sessionId = session.sessionId;
        this.persistentSessionByConversation.set(request.conversationId, sessionId);
      }
      const updates: acp.SessionNotification[] = [];
      runtime.sessions.set(sessionId, { requestId: request.id, context, updates });
      const response = await runtime.connection.prompt({
        sessionId,
        prompt: buildAgentConversationPromptBlocks(request),
      });
      return {
        ok: true,
        reason: `continued ACP conversation through ${this.id}`,
        text: conversationTextFromUpdates(updates, response.stopReason),
        diagnostics: {
          runtime: this.id,
          lifecycle: "persistent_conversation",
          process_id: runtime.child.pid,
          process_reused: processReused,
          conversation_id: request.conversationId,
          session_id: sessionId,
          session_reused: sessionReused,
          stop_reason: response.stopReason,
          update_count: updates.length,
          mcp_server_count: 0,
        },
      };
    } catch (error) {
      if (runtime && sessionId) {
        runtime.sessions.delete(sessionId);
        this.persistentSessionByConversation.delete(request.conversationId);
        await maybeCloseSession(runtime.connection, sessionId, runtime.initialize.agentCapabilities).catch(() => undefined);
      }
      return {
        ok: false,
        reason: `persistent ACP conversation failed: ${errorMessage(error)}`,
        diagnostics: {
          runtime: this.id,
          lifecycle: "persistent_conversation",
          conversation_id: request.conversationId,
          session_id: sessionId,
          error: errorMessage(error),
        },
      };
    } finally {
      if (runtime && sessionId) runtime.sessions.delete(sessionId);
      this.activeConversations.delete(request.conversationId);
    }
  }

  async cancel(taskId: string): Promise<void> {
    const persistentSession = this.persistentSessionByTask.get(taskId);
    if (persistentSession && this.persistent) {
      await this.persistent.connection.cancel({ sessionId: persistentSession });
      return;
    }
    const child = this.processByTask.get(taskId);
    if (child && !child.killed) child.kill();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeProcesses();
    return this.closePromise;
  }

  private async submitPersistent(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    let sessionId: string | undefined;
    let runtime: PersistentAcpConnection | undefined;
    let result: AgentTaskResult | undefined;
    const reused = Boolean(this.persistent && !this.persistent.connection.signal.aborted);
    try {
      await emit(context, {
        type: "runtime.start",
        runtime: this.id,
        taskId: task.id,
        payload: {
          command: this.options.command,
          args: this.options.args ?? [],
          lifecycle: "persistent",
          process_reused: reused,
        },
      });
      runtime = await this.ensurePersistent({ id: task.id, cwd: task.cwd }, context);
      await emit(context, {
        type: "runtime.initialized",
        runtime: this.id,
        taskId: task.id,
        payload: {
          protocolVersion: runtime.initialize.protocolVersion,
          agentInfo: runtime.initialize.agentInfo,
          agentCapabilities: runtime.initialize.agentCapabilities,
          lifecycle: "persistent",
          process_id: runtime.child.pid,
        },
      });

      const updates: acp.SessionNotification[] = [];
      const session = await runtime.connection.newSession({
        cwd: task.cwd ?? this.options.cwd ?? process.cwd(),
        mcpServers: context.mcpServers ?? [],
      });
      sessionId = session.sessionId;
      runtime.sessions.set(sessionId, { requestId: task.id, context, updates });
      this.persistentSessionByTask.set(task.id, sessionId);
      await emit(context, {
        type: "runtime.session_created",
        runtime: this.id,
        taskId: task.id,
        sessionId,
        payload: { models: session.models, modes: session.modes, lifecycle: "persistent" },
      });

      const response = await runtime.connection.prompt({
        sessionId,
        prompt: buildAgentTaskPromptBlocks({ task, signal: context.signal, contextSources: task.contextPack?.sources ?? [] }),
      });
      await emit(context, {
        type: "runtime.prompt_complete",
        runtime: this.id,
        taskId: task.id,
        sessionId,
        payload: { stopReason: response.stopReason },
      });
      const output = outputFromUpdates(updates, response.stopReason);
      result = {
        ok: true,
        reason: `submitted agent task to persistent ${this.id}`,
        output,
        diagnostics: {
          runtime: this.id,
          lifecycle: "persistent",
          process_id: runtime.child.pid,
          process_reused: reused,
          stop_reason: response.stopReason,
          session_id: sessionId,
          update_count: updates.length,
          mcp_server_count: context.mcpServers?.length ?? 0,
          agent_capabilities: runtime.initialize.agentCapabilities,
        },
      };
    } catch (error) {
      await emit(context, { type: "runtime.failed", runtime: this.id, taskId: task.id, sessionId, error: errorMessage(error) });
      result = {
        ok: false,
        reason: `persistent ACP stdio agent task failed: ${errorMessage(error)}`,
        diagnostics: { runtime: this.id, lifecycle: "persistent", session_id: sessionId, error: errorMessage(error) },
      };
    } finally {
      if (runtime && sessionId) {
        try {
          await maybeCloseSession(runtime.connection, sessionId, runtime.initialize.agentCapabilities);
        } catch (error) {
          await emit(context, {
            type: "runtime.failed",
            runtime: this.id,
            taskId: task.id,
            sessionId,
            error: `failed to close ACP session: ${errorMessage(error)}`,
          });
          result = {
            ok: false,
            reason: `persistent ACP session cleanup failed: ${errorMessage(error)}`,
            diagnostics: {
              runtime: this.id,
              lifecycle: "persistent",
              session_id: sessionId,
              error: errorMessage(error),
              prior_result: result,
            },
          };
        }
        runtime.sessions.delete(sessionId);
      }
      this.persistentSessionByTask.delete(task.id);
    }
    if (!result) throw new Error(`persistent ACP task ${task.id} completed without a result`);
    return result;
  }

  private async ensurePersistent(startup: PersistentStartup, context: AgentRuntimeContext): Promise<PersistentAcpConnection> {
    if (this.closed) throw new Error(`ACP runtime ${this.id} is closed`);
    if (this.persistent && !this.persistent.connection.signal.aborted && !this.persistent.child.killed) {
      return this.persistent;
    }
    if (this.persistentStart) return this.persistentStart;
    this.persistentStart = this.startPersistent(startup, context);
    try {
      const runtime = await this.persistentStart;
      this.persistent = runtime;
      return runtime;
    } finally {
      this.persistentStart = undefined;
    }
  }

  private async startPersistent(startup: PersistentStartup, startupContext: AgentRuntimeContext): Promise<PersistentAcpConnection> {
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd ?? startup.cwd ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const sessions = new Map<string, PersistentTaskSession>();
    child.stderr?.on("data", chunk => {
      console.error(JSON.stringify({
        component: "agent-runtime-acp",
        event: "acp.stderr",
        runtime: this.id,
        lifecycle: "persistent",
        process_id: child.pid,
        message: String(chunk),
      }));
    });
    const input = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const runtimeId = this.id;
    const connection = new acp.ClientSideConnection(
      () => ({
        async requestPermission(params) {
          const active = sessions.get(params.sessionId);
          if (!active) return { outcome: { outcome: "cancelled" } };
          await emit(active.context, {
            type: "runtime.permission_requested",
            runtime: runtimeId,
            taskId: active.requestId,
            sessionId: params.sessionId,
            request: params,
          });
          return active.context.permissions?.requestPermission(params) ?? { outcome: { outcome: "cancelled" } };
        },
        async sessionUpdate(params) {
          const active = sessions.get(params.sessionId);
          if (!active) {
            console.error(JSON.stringify({
              component: "agent-runtime-acp",
              event: "acp.orphan_session_update",
              runtime: runtimeId,
              session_id: params.sessionId,
            }));
            return;
          }
          active.updates.push(params);
          await emit(active.context, {
            type: "runtime.prompt_update",
            runtime: runtimeId,
            taskId: active.requestId,
            sessionId: params.sessionId,
            update: params,
          });
        },
        async readTextFile() {
          return { content: "" };
        },
        async writeTextFile() {
          return {};
        },
      }),
      stream,
    );
    let initialize: acp.InitializeResponse;
    try {
      initialize = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: this.options.clientInfo ?? { name: "metaflow", title: "Metaflow", version: "0.1.0" },
        clientCapabilities: {},
      });
    } catch (error) {
      await terminateChild(child);
      throw new Error(`failed to initialize persistent ACP process: ${errorMessage(error)}`);
    }
    const runtime = { child, connection, initialize, sessions };
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      if (this.persistent?.child === child) this.persistent = undefined;
      for (const active of sessions.values()) {
        void emit(active.context, {
          type: "runtime.failed",
          runtime: this.id,
          taskId: active.requestId,
          error: `persistent ACP process exited (pid ${child.pid ?? "unknown"})`,
        });
      }
      sessions.clear();
    };
    child.once("exit", clear);
    child.once("error", clear);
    connection.signal.addEventListener("abort", clear, { once: true });
    await emit(startupContext, {
      type: "runtime.initialized",
      runtime: this.id,
      taskId: startup.id,
      payload: { lifecycle: "persistent", process_id: child.pid, process_started: true },
    });
    return runtime;
  }

  private async closeProcesses(): Promise<void> {
    let runtime = this.persistent;
    if (!runtime && this.persistentStart) {
      runtime = await this.persistentStart.catch(error => {
        console.error(JSON.stringify({
          component: "agent-runtime-acp",
          event: "acp.close_startup_failed",
          runtime: this.id,
          error: errorMessage(error),
        }));
        return undefined;
      });
    }
    this.persistent = undefined;
    this.persistentStart = undefined;
    this.persistentSessionByTask.clear();
    this.persistentSessionByConversation.clear();
    this.activeConversations.clear();

    const children = new Set<ChildProcess>(this.processByTask.values());
    if (runtime) children.add(runtime.child);
    this.connectionByTask.clear();
    this.processByTask.clear();
    await Promise.all([...children].map(child => terminateChild(child)));
  }
}

type PersistentTaskSession = {
  requestId: string;
  context: AgentRuntimeContext;
  updates: acp.SessionNotification[];
};

type PersistentStartup = {
  id: string;
  cwd?: string;
};

type PersistentAcpConnection = {
  child: ChildProcess;
  connection: acp.ClientSideConnection;
  initialize: acp.InitializeResponse;
  sessions: Map<string, PersistentTaskSession>;
};

function outputFromUpdates(updates: acp.SessionNotification[], stopReason: string) {
  const runs: string[] = [];
  const chunks: string[] = [];
  let current = "";
  for (const notification of updates) {
    const item = notification.update;
    if (item.sessionUpdate === "agent_message_chunk" && item.content.type === "text") {
      current += item.content.text;
      chunks.push(item.content.text);
      continue;
    }
    if (current) runs.push(current);
    current = "";
  }
  if (current) runs.push(current);

  const candidates = [...runs].reverse().concat([...chunks].reverse());
  let lastError: unknown;
  for (const text of candidates) {
    if (!text.trim()) continue;
    try {
      return normalizeAgentTaskOutput(JSON.parse(stripJsonCodeFence(text)));
    } catch (error) {
      lastError = error;
    }
  }
  if (chunks.length === 0) {
    throw new Error(`ACP prompt completed with ${stopReason} but emitted no text agent_message_chunk`);
  }
  const characters = chunks.reduce((total, chunk) => total + chunk.length, 0);
  throw new Error(
    `ACP prompt completed with ${stopReason} and emitted ${chunks.length} text chunks (${characters} characters), but no valid AgentTaskOutput was found: ${errorMessage(lastError)}`,
  );
}

function conversationTextFromUpdates(updates: acp.SessionNotification[], stopReason: string): string {
  const text = updates.flatMap(notification => {
    const update = notification.update;
    return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [];
  }).join("").trim();
  if (!text) throw new Error(`ACP conversation completed with ${stopReason} but emitted no assistant text`);
  return text;
}

async function maybeCloseSession(connection: acp.ClientSideConnection, sessionId: string, capabilities: acp.AgentCapabilities | undefined): Promise<void> {
  if (!capabilities?.sessionCapabilities?.close) return;
  await connection.closeSession({ sessionId });
}

async function emit(context: AgentRuntimeContext, event: AgentRuntimeEvent): Promise<void> {
  await context.events?.emit(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observableToolUpdate(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const update = value as Record<string, unknown>;
  const observable: Record<string, unknown> = {};
  for (const key of ["sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput"]) {
    if (update[key] !== undefined) observable[key] = update[key];
  }
  const meta = update._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const claudeCode = (meta as Record<string, unknown>).claudeCode;
    if (claudeCode && typeof claudeCode === "object" && !Array.isArray(claudeCode)) {
      const toolName = (claudeCode as Record<string, unknown>).toolName;
      if (typeof toolName === "string") observable.toolName = toolName;
    }
  }
  return observable;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let forceTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      forceTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`ACP process ${child.pid ?? "unknown"} did not exit after SIGTERM and SIGKILL`));
      }, 2_000);
      child.kill("SIGKILL");
    }, 2_000);
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      cleanup();
      reject(new Error(`failed to signal ACP process ${child.pid ?? "unknown"}`));
    }
  });
}

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildAgentConversationPromptBlocks, buildAgentTaskPromptBlocks } from "./content.js";
import { normalizeAgentSchemaValue, normalizeAgentTaskOutput, stripJsonCodeFence } from "../outputs/view-output.js";
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
  AgentSchemaValue,
  AgentTaskOutput,
  AgentTaskOutputMode,
} from "../types.js";

export class AcpStdioAgentRuntimeAdapter implements AgentRuntimeAdapter, AgentConversationRuntimeAdapter {
  readonly id: string;
  readonly kind = "acp_stdio" as const;
  private processByTask = new Map<string, ChildProcess>();
  private connectionByTask = new Map<string, acp.ClientSideConnection>();
  private persistent?: PersistentAcpConnection;
  private persistentStart?: Promise<PersistentAcpConnection>;
  private persistentSessionByTask = new Map<string, string>();
  private persistentSessionByConversation = new Map<string, PersistentConversationSession>();
  private activeConversations = new Set<string>();
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: AgentAcpStdioRuntimeOptions) {
    this.id = options.id ?? "acp_stdio";
    const capacity = options.maxPersistentConversations ?? 4;
    const idleMs = options.persistentConversationIdleMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("maxPersistentConversations must be a positive safe integer");
    }
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) {
      throw new Error("persistentConversationIdleMs must be a positive safe integer");
    }
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

      const outputMode = task.outputContract.mode ?? "agent_task_output";
      const agentOutput = outputMode === "schema_value"
        ? { schemaValue: outputFromUpdates(updates, response.stopReason, "schema_value") }
        : { output: outputFromUpdates(updates, response.stopReason, "agent_task_output") };

      await maybeCloseSession(connection, sessionId, initResult.agentCapabilities);
      return {
        ok: true,
        reason: `submitted agent task to ${this.id}`,
        ...agentOutput,
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
    let sessionResumed = false;
    try {
      throwIfAborted(conversationContext?.signal, request.id);
      runtime = await this.ensurePersistent({ id: request.id, cwd: request.cwd }, context);
      if (request.screenImage && runtime.initialize.agentCapabilities?.promptCapabilities?.image !== true) {
        throw new Error(`ACP agent ${runtime.initialize.agentInfo?.name ?? this.id} does not advertise image prompt support`);
      }
      const acquired = await this.acquireConversationSession(runtime, request);
      sessionId = acquired.record.sessionId;
      sessionReused = acquired.reused;
      sessionResumed = acquired.resumed;
      const updates: acp.SessionNotification[] = [];
      runtime.sessions.set(sessionId, { requestId: request.id, context, updates });
      const response = await promptWithAbort(
        runtime.connection,
        {
          sessionId,
          prompt: buildAgentConversationPromptBlocks(request),
        },
        conversationContext?.signal,
        () => this.logConversationLifecycle("acp.conversation_cancel_requested", request, {
          session_id: sessionId,
          reason: abortReason(conversationContext?.signal),
        }),
      );
      acquired.record.lastUsedAt = Date.now();
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
          session_resumed: sessionResumed,
          stop_reason: response.stopReason,
          update_count: updates.length,
          mcp_server_count: 0,
        },
      };
    } catch (error) {
      if (runtime && sessionId) {
        runtime.sessions.delete(sessionId);
        const record = this.persistentSessionByConversation.get(request.conversationId);
        if (record?.sessionId === sessionId && !isAbortError(error, conversationContext?.signal)) {
          try {
            await this.closeConversationSession(runtime, request.conversationId, record, "prompt_failure");
          } catch (closeError) {
            this.logConversationLifecycle("acp.conversation_close_failed", request, {
              session_id: sessionId,
              reason: "prompt_failure",
              error: errorMessage(closeError),
            });
          }
        }
      }
      this.logConversationLifecycle(
        isAbortError(error, conversationContext?.signal) ? "acp.conversation_cancelled" : "acp.conversation_failed",
        request,
        { session_id: sessionId, error: errorMessage(error) },
      );
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
      const record = this.persistentSessionByConversation.get(request.conversationId);
      if (runtime && record && record.sessionId === sessionId && record.isOpen) {
        this.scheduleConversationIdleClose(runtime, request.conversationId, record);
      }
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

  private async acquireConversationSession(
    runtime: PersistentAcpConnection,
    request: AgentConversationRequest,
  ): Promise<{ record: PersistentConversationSession; reused: boolean; resumed: boolean }> {
    const cwd = request.cwd ?? this.options.cwd ?? process.cwd();
    const existing = this.persistentSessionByConversation.get(request.conversationId);
    if (existing) {
      this.clearConversationIdleTimer(existing);
      if (existing.cwd !== cwd) {
        throw new Error(
          `ACP conversation ${request.conversationId} was created in ${existing.cwd} and cannot move to ${cwd}`,
        );
      }
      if (!existing.isOpen) {
        await this.ensureConversationCapacity(runtime, request.conversationId);
        if (runtime.initialize.agentCapabilities?.loadSession !== true) {
          throw new Error(
            `ACP agent ${runtime.initialize.agentInfo?.name ?? this.id} cannot resume exact session ${existing.sessionId}: session/load is unsupported`,
          );
        }
        await runtime.connection.loadSession({
          sessionId: existing.sessionId,
          cwd: existing.cwd,
          mcpServers: [],
        });
        existing.isOpen = true;
        existing.lastUsedAt = Date.now();
        this.logConversationLifecycle("acp.conversation_resumed", request, {
          session_id: existing.sessionId,
          open_conversations: this.openConversationCount(),
        });
        return { record: existing, reused: true, resumed: true };
      }
      existing.lastUsedAt = Date.now();
      return { record: existing, reused: true, resumed: false };
    }

    await this.ensureConversationCapacity(runtime, request.conversationId);
    const session = await runtime.connection.newSession({ cwd, mcpServers: [] });
    const record: PersistentConversationSession = {
      sessionId: session.sessionId,
      cwd,
      isOpen: true,
      lastUsedAt: Date.now(),
    };
    this.persistentSessionByConversation.set(request.conversationId, record);
    this.logConversationLifecycle("acp.conversation_created", request, {
      session_id: record.sessionId,
      open_conversations: this.openConversationCount(),
    });
    return { record, reused: false, resumed: false };
  }

  private async ensureConversationCapacity(
    runtime: PersistentAcpConnection,
    requestedConversationId: string,
  ): Promise<void> {
    const capacity = this.options.maxPersistentConversations ?? 4;
    while (this.openConversationCount() >= capacity) {
      const candidate = [...this.persistentSessionByConversation.entries()]
        .filter(([conversationId, record]) => (
          conversationId !== requestedConversationId
          && record.isOpen
          && !this.activeConversations.has(conversationId)
        ))
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!candidate) {
        throw new Error(
          `ACP persistent conversation capacity ${capacity} is exhausted by active sessions`,
        );
      }
      const [conversationId, record] = candidate;
      await this.closeConversationSession(runtime, conversationId, record, "capacity");
    }
  }

  private scheduleConversationIdleClose(
    runtime: PersistentAcpConnection,
    conversationId: string,
    record: PersistentConversationSession,
  ): void {
    this.clearConversationIdleTimer(record);
    const idleMs = this.options.persistentConversationIdleMs ?? 10 * 60_000;
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (this.closed || !record.isOpen || this.activeConversations.has(conversationId)) return;
      void this.closeConversationSession(runtime, conversationId, record, "idle").catch(error => {
        this.logConversationLifecycle("acp.conversation_close_failed", {
          id: "idle-session-close",
          conversationId,
        }, {
          session_id: record.sessionId,
          reason: "idle",
          error: errorMessage(error),
        });
      });
    }, idleMs);
    record.idleTimer.unref?.();
  }

  private async closeConversationSession(
    runtime: PersistentAcpConnection,
    conversationId: string,
    record: PersistentConversationSession,
    reason: "capacity" | "idle" | "prompt_failure",
  ): Promise<void> {
    this.clearConversationIdleTimer(record);
    if (!record.isOpen) return;
    if (!runtime.initialize.agentCapabilities?.sessionCapabilities?.close) {
      throw new Error(
        `ACP agent ${runtime.initialize.agentInfo?.name ?? this.id} cannot close resident session ${record.sessionId}`,
      );
    }
    await runtime.connection.closeSession({ sessionId: record.sessionId });
    record.isOpen = false;
    record.lastUsedAt = Date.now();
    this.logConversationLifecycle("acp.conversation_closed", {
      id: `${reason}-session-close`,
      conversationId,
    }, {
      session_id: record.sessionId,
      reason,
      open_conversations: this.openConversationCount(),
    });
  }

  private clearConversationIdleTimer(record: PersistentConversationSession): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private openConversationCount(): number {
    return [...this.persistentSessionByConversation.values()].filter(record => record.isOpen).length;
  }

  private persistentConversationIdForSession(sessionId: string): string | undefined {
    for (const [conversationId, record] of this.persistentSessionByConversation) {
      if (record.sessionId === sessionId) return conversationId;
    }
    return undefined;
  }

  private logConversationLifecycle(
    event: string,
    request: Pick<AgentConversationRequest, "id" | "conversationId">,
    details: Record<string, unknown>,
  ): void {
    console.log(JSON.stringify({
      component: "agent-runtime-acp",
      event,
      runtime: this.id,
      request_id: request.id,
      conversation_id: request.conversationId,
      ...details,
    }));
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
      const outputMode = task.outputContract.mode ?? "agent_task_output";
      const output = outputMode === "schema_value"
        ? { schemaValue: outputFromUpdates(updates, response.stopReason, "schema_value") }
        : { output: outputFromUpdates(updates, response.stopReason, "agent_task_output") };
      result = {
        ok: true,
        reason: `submitted agent task to persistent ${this.id}`,
        ...output,
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
    const adapter = this;
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
            const knownConversation = adapter.persistentConversationIdForSession(params.sessionId);
            console[knownConversation ? "log" : "error"](JSON.stringify({
              component: "agent-runtime-acp",
              event: knownConversation ? "acp.inactive_conversation_update" : "acp.orphan_session_update",
              runtime: runtimeId,
              session_id: params.sessionId,
              conversation_id: knownConversation,
              update_type: params.update.sessionUpdate,
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
      for (const record of this.persistentSessionByConversation.values()) {
        this.clearConversationIdleTimer(record);
        record.isOpen = false;
      }
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
    for (const record of this.persistentSessionByConversation.values()) {
      this.clearConversationIdleTimer(record);
    }
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

type PersistentConversationSession = {
  sessionId: string;
  cwd: string;
  isOpen: boolean;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
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

function outputFromUpdates(
  updates: acp.SessionNotification[],
  stopReason: string,
  mode: "schema_value",
): AgentSchemaValue;
function outputFromUpdates(
  updates: acp.SessionNotification[],
  stopReason: string,
  mode: "agent_task_output",
): AgentTaskOutput;
function outputFromUpdates(
  updates: acp.SessionNotification[],
  stopReason: string,
  mode: AgentTaskOutputMode,
): AgentSchemaValue | AgentTaskOutput {
  const chunks: string[] = [];
  const messages = new Map<string, string>();
  const messageOrder: string[] = [];
  const legacyMessageKey = "__acp_message_without_id__";
  let identifiedStream: boolean | undefined;
  let currentMessageKey: string | undefined;
  const completedMessageKeys = new Set<string>();
  for (const notification of updates) {
    const item = notification.update;
    if (item.sessionUpdate !== "agent_message_chunk") continue;
    if (item.content.type !== "text") {
      throw new Error(`ACP structured output contains unsupported ${item.content.type} agent message content`);
    }
    const identified = item.messageId !== undefined && item.messageId !== null;
    identifiedStream ??= identified;
    if (identifiedStream !== identified) {
      throw new Error("ACP structured output mixes identified and unidentified message chunks");
    }
    chunks.push(item.content.text);
    const key = item.messageId ?? legacyMessageKey;
    if (currentMessageKey !== undefined && currentMessageKey !== key) {
      completedMessageKeys.add(currentMessageKey);
      if (completedMessageKeys.has(key)) {
        throw new Error("ACP structured output resumed a completed agent message identity");
      }
    }
    currentMessageKey = key;
    if (!messages.has(key)) messageOrder.push(key);
    messages.set(key, `${messages.get(key) ?? ""}${item.content.text}`);
  }

  let lastError: unknown;
  const finalMessage = messageOrder.at(-1);
  if (finalMessage) {
    const text = messages.get(finalMessage)!;
    try {
      const parsed = JSON.parse(stripJsonCodeFence(text)) as unknown;
      return mode === "schema_value"
        ? normalizeAgentSchemaValue(parsed)
        : normalizeAgentTaskOutput(parsed);
    } catch (error) {
      lastError = error;
    }
  }
  if (chunks.length === 0) {
    throw new Error(`ACP prompt completed with ${stopReason} but emitted no text agent_message_chunk`);
  }
  const characters = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const expected = mode === "schema_value" ? "schema_value" : "AgentTaskOutput";
  throw new Error(
    `ACP prompt completed with ${stopReason} and emitted ${chunks.length} text chunks across ${messageOrder.length} messages (${characters} characters), but no valid ${expected} was found: ${errorMessage(lastError)}`,
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

async function promptWithAbort(
  connection: acp.ClientSideConnection,
  params: Parameters<acp.ClientSideConnection["prompt"]>[0],
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Promise<Awaited<ReturnType<acp.ClientSideConnection["prompt"]>>> {
  throwIfAborted(signal, params.sessionId);
  if (!signal) return await connection.prompt(params);

  let removeAbortListener: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    let cancellationStarted = false;
    const abort = () => {
      if (cancellationStarted) return;
      cancellationStarted = true;
      onCancel();
      void connection.cancel({ sessionId: params.sessionId }).then(
        () => reject(new ConversationAbortedError(abortReason(signal))),
        error => reject(new Error(`failed to cancel ACP session ${params.sessionId}: ${errorMessage(error)}`)),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([connection.prompt(params), cancelled]);
  } finally {
    removeAbortListener();
  }
}

class ConversationAbortedError extends Error {
  constructor(reason: string) {
    super(`ACP conversation aborted: ${reason}`);
    this.name = "ConversationAbortedError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined, requestId: string): void {
  if (signal?.aborted) throw new ConversationAbortedError(`${requestId}: ${abortReason(signal)}`);
}

function abortReason(signal: AbortSignal | undefined): string {
  if (!signal?.aborted) return "client disconnected";
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "client disconnected");
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return error instanceof ConversationAbortedError || signal?.aborted === true;
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
  for (const key of ["sessionUpdate", "toolCallId", "title", "kind", "status"]) {
    if (update[key] !== undefined) observable[key] = update[key];
  }
  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    observable.inputKeys = Object.keys(rawInput as Record<string, unknown>).slice(0, 20);
    if ((rawInput as Record<string, unknown>).run_in_background === true) observable.background = true;
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

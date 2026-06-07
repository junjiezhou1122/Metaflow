import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildAgentTaskPromptBlocks } from "./content.js";
import { normalizeAgentTaskOutput, stripJsonCodeFence } from "../outputs/view-output.js";
import type {
  AgentAcpStdioRuntimeOptions,
  AgentRuntimeAdapter,
  AgentRuntimeContext,
  AgentRuntimeEvent,
  AgentTaskRequest,
  AgentTaskResult,
} from "../types.js";

export class AcpStdioAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id: string;
  readonly kind = "acp_stdio" as const;
  private processByTask = new Map<string, ChildProcess>();
  private connectionByTask = new Map<string, acp.ClientSideConnection>();

  constructor(private readonly options: AgentAcpStdioRuntimeOptions) {
    this.id = options.id ?? "acp_stdio";
  }

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      supportsDryRun: false,
      supportsCancel: true,
      supportsMcpServers: true,
    };
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
          task_goal: task.goal,
          output_view_type: task.outputContract.viewType,
        },
      };
    }

    let sessionId: string | undefined;
    let child: ChildProcess | undefined;
    let connection: acp.ClientSideConnection | undefined;

    try {
      await emit(context, { type: "runtime.start", runtime: this.id, taskId: task.id, payload: { command: this.options.command, args: this.options.args ?? [] } });
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: task.cwd ?? this.options.cwd ?? process.cwd(),
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

      const agentOutput = outputFromUpdates(updates);
      if (!agentOutput) throw new Error(`ACP prompt completed with ${response.stopReason} but no structured agent output was found`);

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

  async cancel(taskId: string): Promise<void> {
    const child = this.processByTask.get(taskId);
    if (child && !child.killed) child.kill();
  }
}

function outputFromUpdates(updates: acp.SessionNotification[]) {
  for (const update of [...updates].reverse()) {
    const item = update.update;
    if (item.sessionUpdate !== "agent_message_chunk") continue;
    if (item.content.type !== "text") continue;
    const text = item.content.text.trim();
    if (!text) continue;
    try {
      return normalizeAgentTaskOutput(JSON.parse(stripJsonCodeFence(text)));
    } catch {
      continue;
    }
  }
  return undefined;
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

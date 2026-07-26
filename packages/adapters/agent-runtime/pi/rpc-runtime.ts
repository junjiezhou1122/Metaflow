import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildAgentConversationPromptBlocks } from "../acp/content.js";
import type {
  AgentConversationContext,
  AgentConversationRequest,
  AgentConversationResult,
  AgentConversationRuntimeAdapter,
} from "../types.js";

export type PiRpcConversationRuntimeOptions = {
  id?: string;
  command?: string;
  provider: string;
  model: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxConversations?: number;
  tools?: string[];
};

type PendingCommand = {
  resolve(value: PiRpcResponse): void;
  reject(error: Error): void;
};

type ActiveTurn = {
  request: AgentConversationRequest;
  context?: AgentConversationContext;
  resolve(value: AgentConversationResult): void;
  startedAt: number;
  firstDeltaAt?: number;
  text: string;
  error?: string;
  timeout: NodeJS.Timeout;
  processReused: boolean;
};

type PiRpcResponse = {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

type PiModelState = {
  id?: string;
  provider?: string;
  input?: string[];
};

export class PiRpcConversationRuntimeAdapter implements AgentConversationRuntimeAdapter {
  readonly id: string;
  private readonly conversations = new Map<string, PiRpcConversation>();

  constructor(private readonly options: PiRpcConversationRuntimeOptions) {
    this.id = options.id ?? "pi_rpc";
    if (!options.provider.trim()) throw new Error("Pi provider is required");
    if (!options.model.trim()) throw new Error("Pi model is required");
  }

  async warmup(conversationId = "metaflow-notch"): Promise<Record<string, unknown>> {
    const conversation = await this.conversation(conversationId);
    return conversation.diagnostics(false);
  }

  async converse(
    request: AgentConversationRequest,
    context?: AgentConversationContext,
  ): Promise<AgentConversationResult> {
    try {
      const existing = this.conversations.has(request.conversationId);
      const conversation = await this.conversation(request.conversationId);
      return await conversation.prompt(request, context, existing);
    } catch (error) {
      return {
        ok: false,
        reason: `Pi RPC conversation failed: ${errorMessage(error)}`,
        diagnostics: {
          runtime: this.id,
          provider: this.options.provider,
          model: this.options.model,
          conversation_id: request.conversationId,
          error: errorMessage(error),
        },
      };
    }
  }

  async close(): Promise<void> {
    const conversations = [...this.conversations.values()];
    this.conversations.clear();
    await Promise.all(conversations.map(conversation => conversation.close()));
  }

  private async conversation(conversationId: string): Promise<PiRpcConversation> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const limit = this.options.maxConversations ?? 4;
    if (this.conversations.size >= limit) {
      throw new Error(`Pi conversation limit reached (${limit}); close an existing conversation before opening ${conversationId}`);
    }
    const conversation = new PiRpcConversation(this.id, conversationId, this.options, () => {
      if (this.conversations.get(conversationId) === conversation) this.conversations.delete(conversationId);
    });
    this.conversations.set(conversationId, conversation);
    try {
      await conversation.start();
      return conversation;
    } catch (error) {
      this.conversations.delete(conversationId);
      await conversation.close();
      throw error;
    }
  }
}

class PiRpcConversation {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingCommand>();
  private active?: ActiveTurn;
  private model?: PiModelState;
  private commandCounter = 0;
  private stderr = "";
  private startedAt = 0;
  private closing = false;

  constructor(
    private readonly runtimeId: string,
    private readonly conversationId: string,
    private readonly options: PiRpcConversationRuntimeOptions,
    private readonly onExit: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.startedAt = Date.now();
    const args = [
      "--mode", "rpc",
      "--provider", this.options.provider,
      "--model", this.options.model,
      "--thinking", this.options.thinking ?? "off",
      "--name", `Metaflow ${this.conversationId}`,
    ];
    const tools = this.options.tools;
    if (tools?.length === 0) args.push("--no-tools");
    else if (tools) args.push("--tools", tools.join(","));
    const child = spawn(this.options.command ?? "pi", args, {
      cwd: this.options.cwd ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", chunk => this.consumeStdout(chunk));
    child.stderr.on("data", chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_000);
    });
    child.once("error", error => this.failProcess(`Pi process error: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.failProcess(`Pi process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    });
    const state = await this.command("get_state");
    this.model = isRecord(state.data?.model) ? state.data?.model as PiModelState : undefined;
    if (!this.model) throw new Error("Pi RPC get_state returned no active model");
  }

  diagnostics(processReused: boolean): Record<string, unknown> {
    return {
      runtime: this.runtimeId,
      lifecycle: "persistent_conversation",
      backend: "pi_rpc",
      provider: this.model?.provider ?? this.options.provider,
      model: this.model?.id ?? this.options.model,
      process_id: this.child?.pid,
      process_reused: processReused,
      conversation_id: this.conversationId,
      mcp_server_count: 0,
      tools: this.options.tools ?? "pi_default",
      skills_enabled: true,
      extensions_enabled: true,
      context_files_enabled: true,
      session_persistence: true,
    };
  }

  async prompt(
    request: AgentConversationRequest,
    context: AgentConversationContext | undefined,
    processReused: boolean,
  ): Promise<AgentConversationResult> {
    if (!this.child || this.child.killed) throw new Error("Pi RPC process is not running");
    if (this.active) throw new Error(`Pi conversation is busy: ${this.conversationId}`);
    if (request.screenImage && !this.model?.input?.includes("image")) {
      throw new Error(
        `Pi model ${this.model?.provider ?? this.options.provider}/${this.model?.id ?? this.options.model} does not declare image input support`,
      );
    }
    const blocks = buildAgentConversationPromptBlocks(request);
    const message = blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    const images = blocks.flatMap(block => block.type === "image" ? [{
      type: "image" as const,
      data: block.data,
      mimeType: block.mimeType,
    }] : []);
    const id = this.nextId("prompt");
    return await new Promise<AgentConversationResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.finishTurn({ ok: false, reason: `Pi prompt timed out after ${this.options.timeoutMs ?? 120_000} ms` });
        void this.close();
      }, this.options.timeoutMs ?? 120_000);
      this.active = {
        request,
        context,
        resolve,
        startedAt: Date.now(),
        text: "",
        timeout,
        processReused,
      };
      this.pending.set(id, {
        resolve: response => {
          if (!response.success) {
            this.finishTurn({ ok: false, reason: response.error ?? "Pi rejected the prompt" });
          }
        },
        reject: error => this.finishTurn({ ok: false, reason: error.message }),
      });
      this.write({ id, type: "prompt", message, images });
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    if (this.active) this.finishTurn({ ok: false, reason: "Pi conversation closed" });
    for (const pending of this.pending.values()) pending.reject(new Error("Pi conversation closed"));
    this.pending.clear();
    if (child && !child.killed) child.kill("SIGTERM");
  }

  private command(type: string): Promise<PiRpcResponse> {
    const id = this.nextId(type);
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: response => {
          clearTimeout(timer);
          if (response.success) resolve(response);
          else reject(new Error(response.error ?? `Pi RPC ${type} failed`));
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, type });
    });
  }

  private write(value: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) throw new Error("Pi RPC stdin is unavailable");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        this.failProcess(`Pi emitted invalid JSONL: ${errorMessage(error)}; line=${line.slice(0, 500)}`);
        return;
      }
    }
  }

  private handle(event: Record<string, unknown>): void {
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        pending.resolve(event as PiRpcResponse);
      }
      return;
    }
    if (!this.active) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const toolCallId = event.toolCallId;
      const toolName = event.toolName;
      if (typeof toolCallId !== "string" || !toolCallId.trim() || typeof toolName !== "string" || !toolName.trim()) {
        this.failProcess(`Pi emitted malformed ${event.type}: toolCallId and toolName are required`);
        return;
      }
      const status = event.type === "tool_execution_end"
        ? event.isError === true ? "failed" : "completed"
        : "running";
      void this.active.context?.onEvent?.({
        type: "diagnostic",
        event: `pi.${event.type}`,
        details: {
          update: {
            toolCallId,
            title: toolName,
            kind: "tool",
            status,
            toolName,
          },
        },
      });
      return;
    }
    if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        if (this.active.firstDeltaAt === undefined) this.active.firstDeltaAt = Date.now();
        this.active.text += update.delta;
        void this.active.context?.onEvent?.({ type: "text_delta", delta: update.delta });
      } else if (update.type === "error") {
        this.active.error = typeof update.reason === "string" ? update.reason : "Pi model stream failed";
      }
      return;
    }
    if (event.type === "message_end" && isRecord(event.message)) {
      const stopReason = event.message.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        this.active.error = `Pi message ended with ${stopReason}`;
      }
      return;
    }
    if (event.type === "agent_end") {
      const active = this.active;
      if (active.error) {
        this.finishTurn({ ok: false, reason: active.error });
      } else if (!active.text.trim()) {
        this.finishTurn({ ok: false, reason: "Pi completed without assistant text" });
      } else {
        const completedAt = Date.now();
        this.finishTurn({
          ok: true,
          reason: `continued Pi conversation through ${this.runtimeId}`,
          text: active.text,
          diagnostics: {
            ...this.diagnostics(active.processReused),
            first_token_ms: active.firstDeltaAt ? active.firstDeltaAt - active.startedAt : undefined,
            elapsed_ms: completedAt - active.startedAt,
          },
        });
      }
    }
  }

  private finishTurn(result: AgentConversationResult): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timeout);
    this.active = undefined;
    active.resolve({
      ...result,
      diagnostics: result.diagnostics ?? {
        ...this.diagnostics(active.processReused),
        stderr: this.stderr || undefined,
      },
    });
  }

  private failProcess(reason: string): void {
    if (this.closing) return;
    const details = this.stderr ? `${reason}; stderr=${this.stderr}` : reason;
    if (this.active) this.finishTurn({ ok: false, reason: details });
    for (const pending of this.pending.values()) pending.reject(new Error(details));
    this.pending.clear();
    this.child = undefined;
    this.onExit();
  }

  private nextId(prefix: string): string {
    this.commandCounter += 1;
    return `${prefix}:${this.commandCounter}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

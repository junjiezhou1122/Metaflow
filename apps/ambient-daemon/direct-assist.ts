import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AgentConversationContext,
  AgentConversationEvent,
  AgentConversationRuntimeAdapter,
} from "@info/agent-runtime-adapter";
import { z } from "zod";

const OptionalText = z.string().trim().min(1).max(100_000).optional();
const MAX_SCREEN_IMAGE_BYTES = 3_000_000;
const ToolActivitySchema = z.object({
  tool_call_id: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500).optional(),
  kind: z.string().trim().min(1).max(200).optional(),
  status: z.string().trim().min(1).max(100).optional(),
  tool_name: z.string().trim().min(1).max(300).optional(),
  background: z.boolean().optional(),
}).strict();
const Base64Image = z.string()
  .min(4)
  .max(Math.ceil(MAX_SCREEN_IMAGE_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "screen image must be valid base64")
  .refine(value => Buffer.from(value, "base64").byteLength <= MAX_SCREEN_IMAGE_BYTES, "screen image exceeds 3 MB");

export const AmbientAssistRequestSchema = z.object({
  request_id: z.string().trim().min(1).max(200),
  conversation_id: z.string().trim().min(1).max(200).default("metaflow-notch"),
  prompt: z.string().trim().min(1).max(20_000),
  source: z.enum(["typed", "voice"]),
  current_context: z.object({
    voice: z.object({
      transcript: OptionalText,
      language: OptionalText,
    }).strict().optional(),
    screen: z.object({
      title: OptionalText,
      app: OptionalText,
      url: OptionalText,
      text: OptionalText,
      selected_text: OptionalText,
    }).strict().optional(),
    app: z.object({
      name: OptionalText,
      bundle_id: OptionalText,
      window_title: OptionalText,
      project_path: OptionalText,
    }).strict().optional(),
    summary: OptionalText,
  }).strict(),
  screen_image: z.object({
    mime_type: z.enum(["image/jpeg", "image/png"]),
    data: Base64Image,
  }).strict().optional(),
  agent: z.object({
    harness: z.enum(["pi", "claude_code_acp"]),
    provider: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(300).optional(),
  }).strict().optional(),
  cwd: z.string().trim().min(1).max(4_096).optional(),
}).strict();

export type AmbientAssistRequest = z.infer<typeof AmbientAssistRequestSchema>;

export class DirectAssistService {
  constructor(
    private readonly runtime: AgentConversationRuntimeAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async assist(raw: unknown, context?: AgentConversationContext): Promise<{
    request_id: string;
    conversation_id: string;
    message_id: string;
    text: string;
    diagnostics?: Record<string, unknown>;
  }> {
    const input = AmbientAssistRequestSchema.parse(raw);
    const startedAt = this.now().toISOString();
    this.log("assist.started", input.request_id, { source: input.source });
    const result = await this.runtime.converse({
      id: input.request_id,
      conversationId: input.conversation_id,
      message: input.prompt,
      cwd: input.cwd,
      currentContext: input.current_context,
      screenImage: input.screen_image
        ? { mimeType: input.screen_image.mime_type, data: input.screen_image.data }
        : undefined,
      backend: input.agent,
    }, context);
    if (!result.ok || !result.text) {
      this.log("assist.failed", input.request_id, {
        started_at: startedAt,
        reason: result.reason,
        diagnostics: result.diagnostics,
      });
      throw new DirectAssistError("agent_failed", result.reason, 502, result.diagnostics);
    }
    this.log("assist.succeeded", input.request_id, {
      started_at: startedAt,
      diagnostics: result.diagnostics,
    });
    return {
      request_id: input.request_id,
      conversation_id: input.conversation_id,
      message_id: input.request_id,
      text: result.text,
      diagnostics: result.diagnostics,
    };
  }

  private log(event: string, requestId: string, details: Record<string, unknown>): void {
    console.log(JSON.stringify({
      component: "ambient-direct-assist",
      event,
      request_id: requestId,
      occurred_at: this.now().toISOString(),
      details,
    }));
  }
}

export class DirectAssistError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function createDirectAssistHttpHandler(service: DirectAssistService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const abortController = new AbortController();
    let requestId: string | undefined;
    const abort = (source: "request_aborted" | "response_closed") => {
      if (abortController.signal.aborted) return;
      const reason = new Error(`Ambient assist client disconnected (${source})`);
      abortController.abort(reason);
      console.log(JSON.stringify({
        component: "ambient-direct-assist",
        event: "assist.client_disconnected",
        request_id: requestId,
        source,
      }));
    };
    const onRequestAborted = () => abort("request_aborted");
    const onResponseClosed = () => {
      if (!response.writableEnded) abort("response_closed");
    };
    request.once("aborted", onRequestAborted);
    response.once?.("close", onResponseClosed);
    try {
      const input = await readJson(request);
      requestId = AmbientAssistRequestSchema.parse(input).request_id;
      if (acceptsNdjson(request)) {
        await streamAssist(service, input, response, abortController.signal);
        return;
      }
      const result = await service.assist(input, { signal: abortController.signal });
      if (!canWrite(response)) return;
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      if (!canWrite(response)) return;
      if (error instanceof z.ZodError) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid_assist_request",
          error: "invalid Ambient assist request",
          details: { issues: error.issues },
        });
        return;
      }
      if (error instanceof DirectAssistError) {
        sendJson(response, error.status, {
          ok: false,
          code: error.code,
          error: error.message,
          details: error.details,
        });
        return;
      }
      sendJson(response, 500, {
        ok: false,
        code: "assist_internal_error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      request.off("aborted", onRequestAborted);
      response.off?.("close", onResponseClosed);
    }
  };
}

async function streamAssist(
  service: DirectAssistService,
  input: unknown,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const parsed = AmbientAssistRequestSchema.parse(input);
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeNdjson(response, {
    type: "assistant_message_start",
    request_id: parsed.request_id,
    conversation_id: parsed.conversation_id,
    message_id: parsed.request_id,
  });
  try {
    const result = await service.assist(parsed, {
      signal,
      onEvent(event) {
        if (!canWrite(response)) return;
        if (event.type === "text_delta") {
          writeNdjson(response, {
            type: "assistant_message_delta",
            request_id: parsed.request_id,
            message_id: parsed.request_id,
            delta: event.delta,
          });
          return;
        }
        const toolActivity = parseToolActivity(event);
        if (!toolActivity) return;
        console.log(JSON.stringify({
          component: "ambient-direct-assist",
          event: "assist.tool_activity",
          request_id: parsed.request_id,
          conversation_id: parsed.conversation_id,
          tool_call_id: toolActivity.tool_call_id,
          tool_name: toolActivity.tool_name,
          kind: toolActivity.kind,
          status: toolActivity.status,
        }));
        writeNdjson(response, {
          type: "tool_activity",
          request_id: parsed.request_id,
          message_id: parsed.request_id,
          tool: toolActivity,
        });
      },
    });
    writeNdjson(response, { type: "assistant_message_done", result });
  } catch (error) {
    const envelope = directAssistErrorEnvelope(error);
    if (canWrite(response)) writeNdjson(response, { type: "assistant_message_error", ...envelope });
  } finally {
    if (canWrite(response)) response.end();
  }
}

function parseToolActivity(
  event: Extract<AgentConversationEvent, { type: "diagnostic" }>,
): z.infer<typeof ToolActivitySchema> | undefined {
  const toolEvents = new Set([
    "acp.tool_call",
    "acp.tool_call_update",
    "pi.tool_execution_start",
    "pi.tool_execution_update",
    "pi.tool_execution_end",
  ]);
  if (!toolEvents.has(event.event)) return undefined;
  const update = event.details?.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new DirectAssistError("invalid_tool_activity", `${event.event} omitted its update object`, 502);
  }
  const value = update as Record<string, unknown>;
  const parsed = ToolActivitySchema.safeParse({
    tool_call_id: value.toolCallId,
    title: value.title,
    kind: value.kind,
    status: value.status,
    tool_name: value.toolName,
    background: value.background,
  });
  if (!parsed.success) {
    throw new DirectAssistError(
      "invalid_tool_activity",
      `${event.event} contained an invalid tool update`,
      502,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += Buffer.byteLength(chunk);
    if (byteLength > 5_000_000) throw new DirectAssistError("request_too_large", "Ambient assist request exceeds 5 MB", 413);
    body += String(chunk);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new DirectAssistError("invalid_json", "Ambient assist request must be valid JSON", 400);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function acceptsNdjson(request: IncomingMessage): boolean {
  const value = request.headers.accept;
  return typeof value === "string" && value.split(",").some(item => item.trim().startsWith("application/x-ndjson"));
}

function writeNdjson(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}

function canWrite(response: ServerResponse): boolean {
  return response.destroyed !== true && response.writableEnded !== true;
}

function directAssistErrorEnvelope(error: unknown): {
  code: string;
  error: string;
  details?: unknown;
} {
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_assist_request",
      error: "invalid Ambient assist request",
      details: { issues: error.issues },
    };
  }
  if (error instanceof DirectAssistError) {
    return { code: error.code, error: error.message, details: error.details };
  }
  return {
    code: "assist_internal_error",
    error: error instanceof Error ? error.message : String(error),
  };
}

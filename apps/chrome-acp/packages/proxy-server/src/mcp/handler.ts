import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import {
  type McpRequest,
  type McpResponse,
  type McpInitializeResult,
  type McpToolsListResult,
  type McpToolCallParams,
  type McpToolCallResult,
  type BrowserToolParams,
  type BrowserToolResult,
  type BrowserTabsResult,
  type BrowserReadResult,
  type BrowserExecuteResult,
  type BrowserObserveResult,
  type BrowserActionResult,
  type BrowserDebuggerResult,
  type BrowserLanguageRecentResult,
  MCP_METHODS,
  INFO_TOOLS,
  getBrowserTools,
} from "./types.js";
import { log } from "../logger.js";
import { executeInfoTool } from "./info-handler.js";
import { executeMidsceneVisionAct } from "./midscene-handler.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

// Pending browser tool calls waiting for extension response
const pendingBrowserCalls = new Map<
  string,
  {
    resolve: (result: BrowserToolResult) => void;
    reject: (error: Error) => void;
  }
>();

// Reference to connected WebSocket clients (set by server.ts)
let extensionWs: WSContext | null = null;

export function setExtensionWebSocket(ws: WSContext | null): void {
  extensionWs = ws;
}

export function handleBrowserToolResponse(
  callId: string,
  result: BrowserToolResult | { error: string },
): void {
  log.debug("Browser tool response received", { callId });

  const pending = pendingBrowserCalls.get(callId);
  if (!pending) {
    log.warn("No pending call found", { callId });
    return;
  }

  pendingBrowserCalls.delete(callId);

  if ("error" in result && !("action" in result)) {
    log.error("Browser tool error", { error: result.error });
    pending.reject(new Error(result.error));
  } else {
    const browserResult = result as BrowserToolResult;
    log.debug("Browser tool result", {
      action: browserResult.action,
    });
    pending.resolve(browserResult);
  }
}

async function executeBrowserTool(
  params: BrowserToolParams,
): Promise<BrowserToolResult> {
  log.debug("Browser tool called", { params });

  if (!extensionWs) {
    log.error("No browser extension connected");
    throw new Error("No browser extension connected");
  }

  const callId = crypto.randomUUID();
  log.debug("Browser tool call", { callId });

  // Send request to extension
  extensionWs.send(
    JSON.stringify({
      type: "browser_tool_call",
      callId,
      params,
    }),
  );

  // Wait for response
  return new Promise((resolve, reject) => {
    pendingBrowserCalls.set(callId, { resolve, reject });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingBrowserCalls.has(callId)) {
        pendingBrowserCalls.delete(callId);
        log.error("Browser tool call timed out", { callId });
        reject(new Error("Browser tool call timed out"));
      }
    }, 30000);
  });
}

function handleInitialize(id: string | number): McpResponse {
  const result: McpInitializeResult = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "chrome-acp-browser",
      version: "1.0.0",
    },
  };

  return { jsonrpc: "2.0", id, result };
}

function handleToolsList(id: string | number): McpResponse {
  const result: McpToolsListResult = {
    tools: [...getBrowserTools(), ...INFO_TOOLS],
  };

  return { jsonrpc: "2.0", id, result };
}

function formatTabsResult(result: BrowserTabsResult): McpToolCallResult {
  const lines: Array<string | undefined> = [
    `# Browser Tabs`,
    ``,
    `Found ${result.tabs.length} open tab(s):`,
    ``,
    ...result.tabs.map(
      (tab) =>
        `- **Tab ${tab.id}**${tab.active ? " (active)" : ""}: ${tab.title}\n  URL: ${tab.url}`,
    ),
  ];

  log.debug("Tabs result", {
    count: result.tabs.length,
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

function formatReadResult(result: BrowserReadResult): McpToolCallResult {
  const textContent = [
    `# Browser Read Result`,
    ``,
    `## Page Info`,
    `- Tab ID: ${result.tabId}`,
    `- URL: ${result.url}`,
    `- Title: ${result.title}`,
    `- Viewport: ${result.viewport.width}x${result.viewport.height}`,
    `- Scroll Position: (${result.viewport.scrollX}, ${result.viewport.scrollY})`,
    result.selection ? `- Selected Text: "${result.selection}"` : null,
    ``,
    `## Page Content`,
    ``,
    result.dom,
  ]
    .filter(Boolean)
    .join("\n");

  log.debug("Read result", {
    tabId: result.tabId,
    url: result.url,
    title: result.title,
    viewport: result.viewport,
    selection: result.selection,
    domLength: result.dom?.length || 0,
    totalChars: textContent.length,
  });

  return {
    content: [{ type: "text", text: textContent }],
  };
}

function formatExecuteResult(result: BrowserExecuteResult): McpToolCallResult {
  const textContent = [
    `# Browser Execute Result`,
    ``,
    `- Tab ID: ${result.tabId}`,
    `- URL: ${result.url}`,
    result.result !== undefined
      ? `\n## Script Result\n\`\`\`\n${JSON.stringify(result.result, null, 2)}\n\`\`\``
      : null,
    result.error ? `\n## Script Error\n${result.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  log.debug("Execute result", {
    tabId: result.tabId,
    url: result.url,
    result: result.result,
    error: result.error,
    isError: !!result.error,
    totalChars: textContent.length,
  });

  return {
    content: [{ type: "text", text: textContent }],
    isError: !!result.error,
  };
}

function formatActionResult(result: BrowserActionResult): McpToolCallResult {
  const textContent = [
    `# Browser Action Result`,
    ``,
    `- action: ${result.action}`,
    result.tabId !== undefined ? `- tab_id: ${result.tabId}` : null,
    result.url ? `- url: ${result.url}` : null,
    result.title ? `- title: ${result.title}` : null,
    `- ok: ${result.ok}`,
    result.result !== undefined
      ? `\n## Result\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\``
      : null,
    result.error ? `\n## Error\n${result.error}` : null,
  ].filter(Boolean).join("\n");

  return {
    content: [{ type: "text", text: textContent }],
    isError: !result.ok,
  };
}

function formatObserveResult(result: BrowserObserveResult): McpToolCallResult {
  const lines = [
    "# Browser Observe",
    "",
    `- tab_id: ${result.tabId}`,
    `- url: ${result.url}`,
    `- title: ${result.title}`,
    `- elements: ${result.elements.length}/${result.elementCount}`,
    "",
    "## Interactive Elements",
    ...result.elements.map((element) => {
      const rect = element.rect ? ` @ ${Math.round(element.rect.x)},${Math.round(element.rect.y)} ${Math.round(element.rect.width)}x${Math.round(element.rect.height)}` : "";
      const flags = [
        element.editable ? "editable" : undefined,
        element.disabled ? "disabled" : undefined,
      ].filter(Boolean).join(", ");
      return `- ${element.ref} [${element.role}/${element.tag}] "${element.label || element.text || element.placeholder || "(unlabeled)"}"${flags ? ` (${flags})` : ""}${rect}`;
    }),
  ].join("\n");
  return { content: [{ type: "text", text: lines }] };
}

function formatSeconds(seconds: number | undefined): string {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return "0:00";
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function compactLine(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact || undefined;
}

function captionTimeline(gap: { caption_samples?: Array<{ text?: string; start_seconds?: number; end_seconds?: number }> }): string[] {
  if (!Array.isArray(gap.caption_samples)) return [];
  return gap.caption_samples
    .map((sample) => {
      const text = compactLine(sample.text);
      if (!text) return undefined;
      return `${formatSeconds(sample.start_seconds)}-${formatSeconds(sample.end_seconds)} ${text}`;
    })
    .filter((line): line is string => Boolean(line));
}

function formatLanguageRecentResult(result: BrowserLanguageRecentResult): McpToolCallResult {
  const lines: Array<string | undefined> = [
    "# Recent Language Caption Segments",
    "",
    `Storage key: \`${result.key}\``,
    `Returned ${result.count} segment(s).`,
    `Saved key: \`${result.saved_key}\``,
    `Saved ${result.total_saved ?? 0} segment(s) across ${result.saved_videos?.length ?? 0} video(s).`,
    "",
  ];

  if (result.saved_videos?.length) {
    lines.push("## Saved By Video", "");
  }
  for (const [videoIndex, video] of (result.saved_videos ?? []).entries()) {
    lines.push(
      `### ${videoIndex + 1}. ${video.video_title || "YouTube video"}`,
      `- video_id: ${video.video_id}`,
      video.video_url ? `- video_url: ${video.video_url}` : undefined,
      `- updated_at: ${video.updated_at}`,
      `- saved_segments: ${Array.isArray(video.segments) ? video.segments.length : 0}`,
    );
    for (const [segmentIndex, gap] of (video.segments ?? []).slice(0, 6).entries()) {
      const samples = [
        compactLine(gap.current_caption),
        compactLine(gap.subtitle_text),
        ...(Array.isArray(gap.transcript_samples) ? gap.transcript_samples.map(compactLine) : []),
      ].filter((line, lineIndex, all): line is string => Boolean(line) && all.indexOf(line) === lineIndex);
      const timeline = captionTimeline(gap);
      lines.push(
        `  - ${segmentIndex + 1}. ${formatSeconds(gap.start_seconds)} - ${formatSeconds(gap.end_seconds)}; ${Math.round((gap.caption_on_ms ?? 0) / 1000)}s; toggles ${gap.toggles ?? 0}`,
        gap.fragment_url ? `    fragment_url: ${gap.fragment_url}` : undefined,
        samples.length ? `    captions: ${samples.slice(0, 3).join(" | ")}` : undefined,
        timeline.length ? `    timeline: ${timeline.slice(0, 3).join(" | ")}` : undefined,
      );
    }
    lines.push("");
  }

  if (result.gaps.length) {
    lines.push("## Recent Session Segments", "");
  }
  for (const [index, gap] of result.gaps.entries()) {
    const samples = [
      compactLine(gap.current_caption),
      compactLine(gap.subtitle_text),
      ...(Array.isArray(gap.transcript_samples) ? gap.transcript_samples.map(compactLine) : []),
    ].filter((line, lineIndex, all): line is string => Boolean(line) && all.indexOf(line) === lineIndex);
    const timeline = captionTimeline(gap);
    lines.push(
      `## ${index + 1}. ${gap.video_title || "YouTube caption segment"}`,
      `- status: ${gap.status || "unknown"}`,
      `- range: ${formatSeconds(gap.start_seconds)} - ${formatSeconds(gap.end_seconds)}`,
      `- caption_seconds: ${Math.round((gap.caption_on_ms ?? 0) / 1000)}`,
      `- toggles: ${gap.toggles ?? 0}`,
      gap.video_url ? `- video_url: ${gap.video_url}` : undefined,
      gap.fragment_url ? `- fragment_url: ${gap.fragment_url}` : undefined,
      samples.length ? `- captions: ${samples.slice(0, 4).join(" | ")}` : undefined,
      timeline.length ? `- timeline: ${timeline.slice(0, 5).join(" | ")}` : undefined,
      "",
    );
  }

  return {
    content: [{ type: "text", text: lines.filter((line): line is string => Boolean(line)).join("\n") }],
  };
}

function formatDebuggerResult(result: BrowserDebuggerResult): McpToolCallResult {
  const lines = [
    "# Browser Debugger Result",
    "",
    `- command: ${result.command}`,
    `- tab_id: ${result.tabId}`,
    `- url: ${result.url}`,
    result.domain ? `- domain: ${result.domain}` : undefined,
    `- allowed: ${result.allowed}`,
    `- attached: ${result.attached}`,
    result.policy ? `- policy: ${JSON.stringify(result.policy)}` : undefined,
    result.error ? `\n## Error\n${result.error}` : undefined,
    result.result !== undefined ? `\n## Result\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : undefined,
    result.artifact ? `\n## Artifact\n- mimeType: ${result.artifact.mimeType ?? "unknown"}\n- sizeBytes: ${result.artifact.sizeBytes ?? 0}\n- data: ${result.artifact.data ? `${result.artifact.data.slice(0, 120)}...` : "(omitted)"}` : undefined,
  ].filter(Boolean).join("\n");

  if (result.artifact?.data && result.artifact.mimeType?.startsWith("image/")) {
    return {
      content: [
        { type: "text", text: lines },
        { type: "image", data: result.artifact.data, mimeType: result.artifact.mimeType },
      ],
      isError: Boolean(result.error || !result.allowed),
    };
  }

  return {
    content: [{ type: "text", text: lines }],
    isError: Boolean(result.error || !result.allowed),
  };
}

function formatBrowserToolResult(result: BrowserToolResult): McpToolCallResult {
  switch (result.action) {
    case "tabs":
      return formatTabsResult(result);
    case "read":
      return formatReadResult(result);
    case "execute":
      return formatExecuteResult(result);
    case "observe":
      return formatObserveResult(result);
    case "open_tab":
    case "activate_tab":
    case "close_tab":
    case "reload_tab":
    case "click":
    case "type":
    case "act":
      return formatActionResult(result);
    case "language_recent":
      return formatLanguageRecentResult(result);
    case "debugger":
      return formatDebuggerResult(result);
    default:
      throw new Error(`Unknown action: ${(result as BrowserToolResult).action}`);
  }
}

async function activeTabId(): Promise<number> {
  const tabsResult = await executeBrowserTool({ action: "tabs" });
  if (tabsResult.action !== "tabs") throw new Error("Failed to list browser tabs");
  const active = tabsResult.tabs.find(tab => tab.active);
  if (!active) throw new Error("No active Chrome tab found");
  return active.id;
}

async function executeCurrentBrowserTool(
  name: string,
  args: {
    intent?: string;
    target?: string;
    selector?: string;
    text?: string;
    submit?: boolean;
    mode?: BrowserToolParams["mode"] | "tap";
    maxElements?: number;
    command?: BrowserToolParams["command"];
    args?: Record<string, unknown>;
  },
): Promise<McpToolCallResult> {
  if (name === "browser_current_vision_act") {
    return executeMidsceneVisionAct({
      intent: args.intent,
      target: args.target,
      text: args.text,
      submit: args.submit,
      mode: typeof args.mode === "string" ? args.mode : undefined,
    });
  }

  const tabId = await activeTabId();
  const actionByTool: Record<string, BrowserToolParams["action"]> = {
    browser_current_read: "read",
    browser_current_observe: "observe",
    browser_current_act: "act",
    browser_current_debugger: "debugger",
  };
  const action = actionByTool[name];
  if (!action) throw new Error(`Unknown current browser tool: ${name}`);

  const params: BrowserToolParams = {
    action,
    tabId,
    intent: args.intent,
    target: args.target,
    selector: args.selector,
    text: args.text,
    submit: args.submit,
    mode: args.mode === "tap" ? "click" : args.mode,
    maxElements: args.maxElements,
    command: args.command,
    args: args.args,
  };
  return formatBrowserToolResult(await executeBrowserTool(params));
}

async function handleToolCall(
  id: string | number,
  params: McpToolCallParams,
): Promise<McpResponse> {
  log.info("Tool call started", {
    id,
    tool: params.name,
    arguments: params.arguments,
  });

  // Info context tools (info_search_context / info_get_view / info_submit_feedback)
  // run locally against the info context-layer HTTP server, no extension required.
  if (params.name.startsWith("info_")) {
    try {
      const result = await executeInfoTool(params);
      log.info("Info tool call completed", { id, tool: params.name });
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      log.error("Info tool call failed", {
        id,
        tool: params.name,
        error: (error as Error).message,
      });
      const result: McpToolCallResult = {
        content: [{ type: "text", text: (error as Error).message }],
        isError: true,
      };
      return { jsonrpc: "2.0", id, result };
    }
  }

  if (params.name.startsWith("browser_current_")) {
    try {
      const result = await executeCurrentBrowserTool(params.name, (params.arguments ?? {}) as {
        intent?: string;
        target?: string;
        selector?: string;
        text?: string;
        submit?: boolean;
        mode?: BrowserToolParams["mode"] | "tap";
        maxElements?: number;
        command?: BrowserToolParams["command"];
        args?: Record<string, unknown>;
      });
      log.info("Current browser tool call completed", { id, tool: params.name });
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      log.error("Current browser tool call failed", {
        id,
        tool: params.name,
        error: (error as Error).message,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        },
      };
    }
  }

  if (params.name === "browser_vision_act") {
    const exposed =
      process.env.CHROME_ACP_EXPOSE_MIDSCENE === "1" ||
      process.env.CHROME_ACP_EXPOSE_MIDSCENE === "true";
    if (!exposed) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{
            type: "text",
            text:
              "browser_vision_act is hidden by default. Use browser_tabs, browser_observe, and browser_act for normal page automation. " +
              "Restart the proxy with CHROME_ACP_EXPOSE_MIDSCENE=1 only if visual automation is explicitly needed.",
          }],
          isError: true,
        },
      };
    }
    try {
      const result = await executeMidsceneVisionAct((params.arguments ?? {}) as {
        intent?: string;
        target?: string;
        text?: string;
        mode?: string;
        submit?: boolean;
      });
      log.info("Midscene vision tool call completed", { id, tool: params.name });
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      log.error("Midscene vision tool call failed", {
        id,
        tool: params.name,
        error: (error as Error).message,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        },
      };
    }
  }

  // Map tool name to action
  const toolToAction: Record<string, BrowserToolParams["action"]> = {
    browser_tabs: "tabs",
    browser_read: "read",
    browser_execute: "execute",
    browser_language_recent_captions: "language_recent",
    browser_open_tab: "open_tab",
    browser_activate_tab: "activate_tab",
    browser_close_tab: "close_tab",
    browser_reload_tab: "reload_tab",
    browser_click: "click",
    browser_type: "type",
    browser_observe: "observe",
    browser_act: "act",
    browser_debugger: "debugger",
  };

  const action = toolToAction[params.name];
  if (!action) {
    log.warn("Unknown tool requested", { tool: params.name });
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: `Unknown tool: ${params.name}`,
      },
    };
  }

  try {
    const args = params.arguments as {
      tabId?: number;
      script?: string;
      limit?: number;
      command?: BrowserToolParams["command"];
      args?: Record<string, unknown>;
      url?: string;
      selector?: string;
      text?: string;
      active?: boolean;
      intent?: string;
      target?: string;
      submit?: boolean;
      mode?: BrowserToolParams["mode"];
      maxElements?: number;
    };
    const browserParams: BrowserToolParams = {
      action,
      tabId: args?.tabId,
      script: args?.script,
      limit: typeof args?.limit === "number" ? args.limit : undefined,
      command: args?.command,
      args: args?.args,
      url: args?.url,
      selector: args?.selector,
      text: args?.text,
      active: args?.active,
      intent: args?.intent,
      target: args?.target,
      submit: args?.submit,
      mode: args?.mode,
      maxElements: args?.maxElements,
    };

    const startTime = Date.now();
    const browserResult = await executeBrowserTool(browserParams);
    const duration = Date.now() - startTime;

    log.info("Tool call completed", {
      id,
      tool: params.name,
      action,
      durationMs: duration,
    });

    const result = formatBrowserToolResult(browserResult);

    const response: McpResponse = { jsonrpc: "2.0", id, result };
    log.trace("MCP tool call response", { response });
    return response;
  } catch (error) {
    log.error("Tool call failed", {
      id,
      tool: params.name,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    const result: McpToolCallResult = {
      content: [{ type: "text", text: (error as Error).message }],
      isError: true,
    };

    return { jsonrpc: "2.0", id, result };
  }
}

export async function handleMcpRequest(c: Context): Promise<Response> {
  const request = (await c.req.json()) as McpRequest;
  log.debug("MCP request received", { method: request.method });

  let response: McpResponse;

  switch (request.method) {
    case MCP_METHODS.INITIALIZE:
      response = handleInitialize(request.id);
      break;

    case MCP_METHODS.TOOLS_LIST:
      response = handleToolsList(request.id);
      break;

    case MCP_METHODS.TOOLS_CALL:
      response = await handleToolCall(
        request.id,
        request.params as unknown as McpToolCallParams,
      );
      break;

    default:
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
  }

  return c.json(response);
}

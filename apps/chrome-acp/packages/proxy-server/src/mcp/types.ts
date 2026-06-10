// MCP (Model Context Protocol) Types for Streamable HTTP Transport

// ============================================================================
// Browser Tool Types
// ============================================================================
// IMPORTANT: These types MUST stay in sync with @chrome-acp/shared/src/acp/types.ts
// They define the protocol between proxy-server and browser extension.
//
// Why duplicated? proxy-server uses NodeNext module resolution which requires
// .js extensions, while shared package is designed for bundlers (Bun/Vite).
// Until we have a proper @chrome-acp/protocol package, keep these in sync manually.
// ============================================================================

export interface BrowserToolParams {
  action: "tabs" | "read" | "execute";
  tabId?: number;   // Required for read/execute
  script?: string;  // Required for execute
}

export interface BrowserTabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserTabsResult {
  action: "tabs";
  tabs: BrowserTabInfo[];
}

export interface BrowserReadResult {
  action: "read";
  tabId: number;
  url: string;
  title: string;
  dom: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  selection: string | null;
}

export interface BrowserExecuteResult {
  action: "execute";
  tabId: number;
  url: string;
  result?: unknown;
  error?: string;
}

export type BrowserToolResult =
  | BrowserTabsResult
  | BrowserReadResult
  | BrowserExecuteResult;

export interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: McpError;
}

export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

// MCP Protocol Methods
export const MCP_METHODS = {
  INITIALIZE: "initialize",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

// MCP Initialize
export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: {
    roots?: { listChanged?: boolean };
    sampling?: Record<string, never>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// MCP Tools
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolsListResult {
  tools: McpTool[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpToolContent[];
  isError?: boolean;
}

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// Browser Tabs Tool
export const BROWSER_TABS_TOOL: McpTool = {
  name: "browser_tabs",
  description:
    "List all open tabs in the browser. " +
    "Returns an array of tabs with their id, url, title, and whether it's the active tab. " +
    "Use this tool first to get the tabId before calling browser_read or browser_execute.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// Browser Read Tool
export const BROWSER_READ_TOOL: McpTool = {
  name: "browser_read",
  description:
    "Read the content of a specific browser tab. " +
    "Returns page URL, title, simplified DOM content, viewport size, and selected text. " +
    "IMPORTANT: You must call browser_tabs first to get the tabId.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: {
        type: "number",
        description:
          "The tab ID to read from. Get this from browser_tabs tool.",
      },
    },
    required: ["tabId"],
  },
};

// Browser Execute Tool
export const BROWSER_EXECUTE_TOOL: McpTool = {
  name: "browser_execute",
  description:
    "Execute JavaScript code in a specific browser tab. " +
    "The script is executed via `new Function(script)()`, so the LAST EXPRESSION or explicit `return` statement becomes the tool result. " +
    "IMPORTANT: You must call browser_tabs first to get the tabId.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: {
        type: "number",
        description:
          "The tab ID to execute the script in. Get this from browser_tabs tool.",
      },
      script: {
        type: "string",
        description:
          "JavaScript code to execute in the page context.\n\n" +
          "EXECUTION MODEL:\n" +
          "Your script runs as: `(new Function(script))()`. The return value becomes the tool result.\n" +
          "- Use `return { success: true, ... }` to report success with details\n" +
          "- Use `return { success: false, reason: '...' }` to report failure\n" +
          "- If no return, result will be undefined\n\n" +
          "EXAMPLE - Good script with clear return value:\n" +
          "```\n" +
          "const btn = document.querySelector('button.submit');\n" +
          "if (!btn) return { success: false, reason: 'Button not found' };\n" +
          "btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));\n" +
          "return { success: true, clicked: btn.textContent };\n" +
          "```\n\n" +
          "EVENT HANDLING for React/Vue/Angular:\n\n" +
          "1. CLICKING - Do NOT use element.click():\n" +
          "   element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));\n\n" +
          "2. INPUT FIELDS - Setting .value alone won't work:\n" +
          "   input.value = 'text';\n" +
          "   input.dispatchEvent(new Event('input', { bubbles: true }));\n" +
          "   input.dispatchEvent(new Event('change', { bubbles: true }));\n\n" +
          "3. FORM SUBMIT - Do NOT use form.submit() (bypasses validation):\n" +
          "   form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));\n\n" +
          "4. HOVER: element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));\n\n" +
          "5. KEYBOARD: element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));\n\n" +
          "Always use dispatchEvent with { bubbles: true } for framework compatibility.",
      },
    },
    required: ["tabId", "script"],
  },
};

// All browser tools
export const BROWSER_TOOLS = [
  BROWSER_TABS_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_EXECUTE_TOOL,
];

// ============================================================================
// Info Context Tool Types (custom tools pointing at the local info context layer)
// ============================================================================
// These tools forward calls to the local info context-layer HTTP server
// (default http://localhost:3111) so the ACP agent can search / fetch /
// feedback on views and records the user has already captured.

// Default base URL of the info context layer. Overridable via the
// INFO_CONTEXT_BASE_URL env var so deployments can re-point at a different host.
export const DEFAULT_INFO_CONTEXT_BASE_URL = "http://localhost:3111";

// Info Search Context Tool — wraps POST /context/query and returns markdown
export const INFO_SEARCH_CONTEXT_TOOL: McpTool = {
  name: "info_search_context",
  description:
    "Search the user's local Info context layer for relevant views, records, and events. " +
    "Returns a markdown context pack (most-recent first) that the agent should cite when answering. " +
    "Use this BEFORE answering any question that depends on the user's past reading, projects, threads, or browser/window activity. " +
    "If you only have a view id, use info_get_view instead.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language goal or question. Keep it short and concrete, e.g. 'what was I reading about ACP last week'.",
      },
      view_types: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of view_type filters, e.g. ['thread.active_work', 'project.current_context'].",
      },
      minutes: {
        type: "number",
        description: "Optional time window in minutes. Defaults to no time filter.",
      },
      limit: {
        type: "number",
        description: "Max number of items per source (records / views / events). Defaults to 8.",
      },
    },
    required: ["query"],
  },
};

// Info Get View Tool — wraps GET /context/views/:id
export const INFO_GET_VIEW_TOOL: McpTool = {
  name: "info_get_view",
  description:
    "Fetch a single Info view by id and return its full content as markdown. " +
    "Use this when info_search_context returns a view id you want to read in full.",
  inputSchema: {
    type: "object",
    properties: {
      view_id: {
        type: "string",
        description: "The Info view id, e.g. 'view:thread:active:abc123' or 'analysis.browser_agent_task:xyz'.",
      },
    },
    required: ["view_id"],
  },
};

// Info Submit Feedback Tool — wraps POST /feedback
export const INFO_SUBMIT_FEEDBACK_TOOL: McpTool = {
  name: "info_submit_feedback",
  description:
    "Submit feedback for an Info view or record. Use to mark a view as useful, dismissed, or edited. " +
    "Returns the processed view/record. The `type` field is the feedback category (e.g. 'analysis.useful', 'analysis.dismissed', 'output.edited').",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Feedback type, e.g. 'analysis.useful', 'analysis.dismissed', 'output.edited'.",
      },
      application_id: {
        type: "string",
        description: "Which surface is sending the feedback. Use 'acp.agent' when the agent is sending it.",
      },
      view_id: {
        type: "string",
        description: "Target view id (set exactly one of view_id / record_id).",
      },
      record_id: {
        type: "string",
        description: "Target record id (set exactly one of view_id / record_id).",
      },
      value: {
        description: "Optional structured value (string / number / object) attached to the feedback.",
      },
      reason: {
        type: "string",
        description: "Short human-readable reason, e.g. 'aligned with user goal'.",
      },
      payload: {
        type: "object",
        description: "Optional extra metadata merged into the feedback payload.",
      },
    },
    required: ["type", "application_id"],
  },
};

// All info context tools
export const INFO_TOOLS = [
  INFO_SEARCH_CONTEXT_TOOL,
  INFO_GET_VIEW_TOOL,
  INFO_SUBMIT_FEEDBACK_TOOL,
];


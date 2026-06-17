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

export type BrowserDebuggerCommand =
  | "capture_full_page"
  | "get_layout_tree"
  | "get_network_log"
  | "evaluate_js"
  | "dispatch_input"
  | "print_pdf";

export interface BrowserToolParams {
  action:
    | "tabs"
    | "read"
    | "execute"
    | "language_recent"
    | "debugger"
    | "open_tab"
    | "activate_tab"
    | "close_tab"
    | "reload_tab"
    | "click"
    | "type"
    | "observe"
    | "act";
  tabId?: number;   // Required for read/execute
  script?: string;  // Required for execute
  limit?: number;   // Optional for language_recent
  command?: BrowserDebuggerCommand; // Required for debugger
  args?: Record<string, unknown>;   // Optional debugger command args
  url?: string;      // Required for open_tab
  selector?: string; // Required for click/type, optional direct selector for act
  text?: string;     // Required for type
  active?: boolean;  // Optional for open_tab
  intent?: string;   // Required for act
  target?: string;   // Optional natural-language target for act
  submit?: boolean;  // Optional for act
  mode?: "click" | "type" | "submit" | "auto"; // Optional for act
  maxElements?: number; // Optional for observe
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

export interface BrowserActionResult {
  action: "open_tab" | "activate_tab" | "close_tab" | "reload_tab" | "click" | "type" | "act";
  tabId?: number;
  url?: string;
  title?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserObservedElement {
  ref: string;
  role: string;
  tag: string;
  label: string;
  selector: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  href?: string;
  editable?: boolean;
  disabled?: boolean;
  visible?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface BrowserObserveResult {
  action: "observe";
  tabId: number;
  url: string;
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  elements: BrowserObservedElement[];
  elementCount: number;
}

export interface RecentCaptionGap {
  id?: string;
  fragment_id?: string;
  video_id?: string;
  video_title?: string;
  video_url?: string;
  fragment_url?: string;
  start_seconds?: number;
  end_seconds?: number;
  duration_seconds?: number;
  video_current_seconds?: number;
  video_duration_seconds?: number;
  caption_on_ms?: number;
  toggles?: number;
  transcript_samples?: string[];
  subtitle_text?: string;
  caption_samples?: Array<{
    text: string;
    start_seconds?: number;
    end_seconds?: number;
    captured_at?: string;
  }>;
  current_caption?: string | null;
  trigger_reason?: string;
  ended_reason?: string;
  caption_state?: "on" | "off";
  playback_state?: "playing" | "paused" | "ended";
  fragment_started_at?: string;
  fragment_ended_at?: string;
  observed_at?: string;
  captured_at?: string;
  status?: string;
}

export interface SavedCaptionVideo {
  video_id: string;
  video_title: string;
  video_url?: string;
  updated_at: string;
  segments: RecentCaptionGap[];
}

export interface BrowserLanguageRecentResult {
  action: "language_recent";
  key: string;
  count: number;
  gaps: RecentCaptionGap[];
  saved_key: string;
  total_saved: number;
  saved_videos: SavedCaptionVideo[];
}

export interface BrowserDebuggerResult {
  action: "debugger";
  command: BrowserDebuggerCommand;
  tabId: number;
  url: string;
  domain?: string;
  allowed: boolean;
  attached: boolean;
  result?: unknown;
  artifact?: {
    mimeType?: string;
    data?: string;
    sizeBytes?: number;
  };
  error?: string;
  policy?: {
    enabled: boolean;
    domain_allowed: boolean;
    sensitive_domain: boolean;
    requires_confirm?: boolean;
  };
}

export type BrowserToolResult =
  | BrowserTabsResult
  | BrowserReadResult
  | BrowserExecuteResult
  | BrowserObserveResult
  | BrowserActionResult
  | BrowserLanguageRecentResult
  | BrowserDebuggerResult;

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
    "Use this tool first to get the active tabId before calling browser_read, browser_observe, browser_act, or browser_execute. " +
    "For user requests about the page they are looking at, choose the tab where active=true. Do not open or navigate a new tab unless the user explicitly asks.",
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
    "IMPORTANT: Call browser_tabs first and use the active tabId for the user's current page.",
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

export const BROWSER_LANGUAGE_RECENT_TOOL: McpTool = {
  name: "browser_language_recent_captions",
  description:
    "Read Metaflow/Info Learn tab recent YouTube caption segments from the Chrome extension session store. " +
    "Use this when the user asks about language-learning caption segments, recent comprehension gaps, or the Learn tab content. " +
    "This reads chrome.storage.session['language.recent_caption_gaps']; it does not scrape the side panel DOM.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Maximum caption segments to return. Defaults to 12, capped at 50.",
      },
    },
  },
};

export const BROWSER_OPEN_TAB_TOOL: McpTool = {
  name: "browser_open_tab",
  description:
    "Open a URL in a new Chrome tab. Use only when the user explicitly asks to open a new page/tab or when no existing relevant tab is open. " +
    "For tasks like 'ask Gemini in the page I am viewing', do NOT use this; use browser_tabs to find the active tab, then browser_act.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open. Include http:// or https:// unless opening a chrome:// page." },
      active: { type: "boolean", description: "Whether to activate the new tab. Defaults to true." },
    },
    required: ["url"],
  },
};

export const BROWSER_ACTIVATE_TAB_TOOL: McpTool = {
  name: "browser_activate_tab",
  description: "Activate an existing Chrome tab by tabId. Use browser_tabs first to find the tabId.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID to activate." },
    },
    required: ["tabId"],
  },
};

export const BROWSER_CLOSE_TAB_TOOL: McpTool = {
  name: "browser_close_tab",
  description: "Close an existing Chrome tab by tabId. Use only when the user clearly asks to close a tab.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID to close." },
    },
    required: ["tabId"],
  },
};

export const BROWSER_RELOAD_TAB_TOOL: McpTool = {
  name: "browser_reload_tab",
  description: "Reload an existing Chrome tab by tabId.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID to reload." },
    },
    required: ["tabId"],
  },
};

export const BROWSER_CLICK_TOOL: McpTool = {
  name: "browser_click",
  description:
    "Click an element in a tab using a CSS selector. Uses DOM events for framework compatibility. Use browser_read first when unsure which selector to use.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID containing the element." },
      selector: { type: "string", description: "CSS selector for the element to click." },
    },
    required: ["tabId", "selector"],
  },
};

export const BROWSER_TYPE_TOOL: McpTool = {
  name: "browser_type",
  description:
    "Type text into an input, textarea, or contenteditable element in a tab using a CSS selector. Dispatches input/change events.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID containing the editable element." },
      selector: { type: "string", description: "CSS selector for input, textarea, or contenteditable target." },
      text: { type: "string", description: "Text to insert into the editable element." },
    },
    required: ["tabId", "selector", "text"],
  },
};

export const BROWSER_OBSERVE_TOOL: McpTool = {
  name: "browser_observe",
  description:
    "Observe a Chrome tab and return a compact list of visible interactive elements with stable refs, labels, roles, selectors, and viewport coordinates. " +
    "Use this before acting on complex pages instead of guessing CSS selectors.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID to observe. Use browser_tabs first." },
      maxElements: { type: "number", description: "Maximum elements to return. Defaults to 60, capped at 200." },
    },
    required: ["tabId"],
  },
};

export const BROWSER_ACT_TOOL: McpTool = {
  name: "browser_act",
  description:
    "Perform a high-level browser action from natural language. Internally observes the page, locates the best matching element, uses real CDP mouse/text input when needed, then verifies. " +
    "Prefer this over browser_click/browser_type on complex SPAs such as ChatGPT, Gemini, Xianyu, Notion, Google Docs, and other React/contenteditable sites. " +
    "For current-page tasks, first call browser_tabs and pass the active tabId. Do not navigate away from the user's current tab unless they explicitly ask.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "number", description: "Tab ID to act in. Use browser_tabs first." },
      intent: { type: "string", description: "Natural-language action, e.g. 'click chat button', 'type message into main input', 'send message'." },
      target: { type: "string", description: "Optional target hint, e.g. '聊一聊 button', 'main chat input', 'search box'." },
      selector: { type: "string", description: "Optional CSS selector to act on directly when already known from browser_observe." },
      text: { type: "string", description: "Text to enter when the action types/fills an editable element." },
      submit: { type: "boolean", description: "Whether to submit after typing, usually by Enter or a send button." },
      mode: { type: "string", enum: ["click", "type", "submit", "auto"], description: "Optional action mode. Defaults to auto." },
    },
    required: ["tabId", "intent"],
  },
};

export const BROWSER_VISION_ACT_TOOL: McpTool = {
  name: "browser_vision_act",
  description:
    "Use Midscene visual browser automation on the user's current Chrome tab. " +
    "Last-resort fallback only after browser_tabs + browser_observe + browser_act fail. " +
    "Do not use this for normal Gemini/ChatGPT/search input tasks. " +
    "Requires the proxy to be started with CHROME_ACP_MIDSCENE=1, CHROME_ACP_EXPOSE_MIDSCENE=1, and MIDSCENE_MODEL_* environment variables.",
  inputSchema: {
    type: "object",
    properties: {
      intent: { type: "string", description: "Natural-language action, e.g. 'click the 聊一聊 button'." },
      target: { type: "string", description: "Optional visual target prompt, e.g. 'yellow 聊一聊 button near bottom center'." },
      text: { type: "string", description: "Text to input when using mode='type'." },
      submit: { type: "boolean", description: "Whether to press Enter after typing." },
      mode: { type: "string", enum: ["auto", "click", "tap", "type"], description: "Action mode. Defaults to auto." },
    },
    required: ["intent"],
  },
};

export const BROWSER_CURRENT_READ_TOOL: McpTool = {
  name: "browser_current_read",
  description:
    "Read the user's currently active Chrome tab. This is a current-page facade over browser_tabs + browser_read. " +
    "Use this instead of browser_read when the user asks about the page they are looking at. Never opens a new browser or tab.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const BROWSER_CURRENT_OBSERVE_TOOL: McpTool = {
  name: "browser_current_observe",
  description:
    "Observe visible interactive elements in the user's currently active Chrome tab. " +
    "This is a current-page facade over browser_tabs + browser_observe and should be used before acting when targets are ambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      maxElements: { type: "number", description: "Maximum elements to return. Defaults to 60, capped at 200." },
    },
  },
};

export const BROWSER_CURRENT_ACT_TOOL: McpTool = {
  name: "browser_current_act",
  description:
    "Perform a natural-language action in the user's currently active Chrome tab. " +
    "This is the preferred tool for operating the page the user is looking at. " +
    "It resolves the active tab internally, uses Chrome ACP DOM/CDP automation, and does not open a separate browser. " +
    "If this fails because the page is visually complex, use browser_current_vision_act as fallback.",
  inputSchema: {
    type: "object",
    properties: {
      intent: { type: "string", description: "Natural-language action, e.g. 'click the send button', 'type message into the main input'." },
      target: { type: "string", description: "Optional target hint, e.g. 'bottom ChatGPT input'." },
      selector: { type: "string", description: "Optional CSS selector to act on directly when already known from browser_current_observe." },
      text: { type: "string", description: "Text to enter when the action types/fills an editable element." },
      submit: { type: "boolean", description: "Whether to submit after typing, usually by Enter or a send button." },
      mode: { type: "string", enum: ["click", "type", "submit", "auto"], description: "Optional action mode. Defaults to auto." },
    },
    required: ["intent"],
  },
};

export const BROWSER_CURRENT_VISION_ACT_TOOL: McpTool = {
  name: "browser_current_vision_act",
  description:
    "Use Midscene visual automation on the user's currently active Chrome tab. " +
    "Use this only when browser_current_act/browser_observe cannot locate the target or the page is visually complex. " +
    "This uses Midscene Chrome Bridge Mode and does not use external chrome_devtools.",
  inputSchema: {
    type: "object",
    properties: {
      intent: { type: "string", description: "Natural-language visual action, e.g. 'click the blue Save button'." },
      target: { type: "string", description: "Optional visual target prompt." },
      text: { type: "string", description: "Text to input when using mode='type'." },
      submit: { type: "boolean", description: "Whether to press Enter after typing." },
      mode: { type: "string", enum: ["auto", "click", "tap", "type"], description: "Action mode. Defaults to auto." },
    },
    required: ["intent"],
  },
};

export const BROWSER_CURRENT_DEBUGGER_TOOL: McpTool = {
  name: "browser_current_debugger",
  description:
    "Run an advanced Chrome Debugger/CDP command against the user's currently active Chrome tab. " +
    "This is a current-page facade over browser_tabs + browser_debugger. Use for screenshots, layout snapshots, PDF export, or controlled CDP diagnostics.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["capture_full_page", "get_layout_tree", "get_network_log", "evaluate_js", "dispatch_input", "print_pdf"],
        description: "Debugger command to run on the active tab.",
      },
      args: {
        type: "object",
        description:
          "Optional command args. capture_full_page accepts {format:'jpeg'|'png', quality}. " +
          "evaluate_js accepts {expression}. dispatch_input accepts {type:'mouse'|'text'|'key', x, y, text, key}. print_pdf accepts {landscape, printBackground}.",
      },
    },
    required: ["command"],
  },
};

export const BROWSER_DEBUGGER_TOOL: McpTool = {
  name: "browser_debugger",
  description:
    "Advanced optional Chrome Debugger/CDP tool for approved domains only. " +
    "Default extension settings deny this tool until Advanced Browser Control is enabled and the tab domain is allowlisted. " +
    "Use for full-page screenshots, layout/accessibility snapshots, PDF export, or controlled CDP input. " +
    "High-risk commands such as evaluate_js, dispatch_input, and get_network_log are denied unless the user explicitly disables high-risk confirmation in settings.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: {
        type: "number",
        description: "The tab ID to attach Chrome debugger to. Get this from browser_tabs.",
      },
      command: {
        type: "string",
        enum: ["capture_full_page", "get_layout_tree", "get_network_log", "evaluate_js", "dispatch_input", "print_pdf"],
        description: "Debugger command to run.",
      },
      args: {
        type: "object",
        description:
          "Optional command args. capture_full_page accepts {format:'jpeg'|'png', quality}. " +
          "evaluate_js accepts {expression}. dispatch_input accepts {type:'mouse'|'text'|'key', x, y, text, key}. print_pdf accepts {landscape, printBackground}.",
      },
    },
    required: ["tabId", "command"],
  },
};

// All browser tools.
const BASE_BROWSER_TOOLS = [
  BROWSER_CURRENT_READ_TOOL,
  BROWSER_CURRENT_OBSERVE_TOOL,
  BROWSER_CURRENT_ACT_TOOL,
  BROWSER_CURRENT_DEBUGGER_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_EXECUTE_TOOL,
  BROWSER_LANGUAGE_RECENT_TOOL,
  BROWSER_OPEN_TAB_TOOL,
  BROWSER_ACTIVATE_TAB_TOOL,
  BROWSER_CLOSE_TAB_TOOL,
  BROWSER_RELOAD_TAB_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_OBSERVE_TOOL,
  BROWSER_ACT_TOOL,
  BROWSER_DEBUGGER_TOOL,
];

export function getBrowserTools(): McpTool[] {
  const exposeVision =
    process.env.CHROME_ACP_EXPOSE_MIDSCENE === "1" ||
    process.env.CHROME_ACP_EXPOSE_MIDSCENE === "true";
  return exposeVision
    ? [...BASE_BROWSER_TOOLS, BROWSER_CURRENT_VISION_ACT_TOOL, BROWSER_VISION_ACT_TOOL]
    : BASE_BROWSER_TOOLS;
}

export const BROWSER_TOOLS = getBrowserTools();

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

// Info List Views Tool — wraps GET /context/views and returns active view context
export const INFO_LIST_VIEWS_TOOL: McpTool = {
  name: "info_list_views",
  description:
    "List recent active Info Views directly from the user's local view inbox. " +
    "Use this to inspect auto analysis, proactive tasks, writing suggestions, language-learning views, tool opportunities, and project context before answering. " +
    "This is better than browser_read when the question is about what Info/Metaflow already observed, analyzed, or recommended. " +
    "Use family='related' for a broad working context, or family='analyze' / 'task' / 'language' / 'writing' / 'tool' for focused context.",
  inputSchema: {
    type: "object",
    properties: {
      family: {
        type: "string",
        enum: ["related", "analyze", "task", "language", "writing", "tool", "project", "all"],
        description:
          "Optional view family shortcut. 'related' includes current work, browser analysis, writing, research, tool, and language-learning views. 'all' applies no view_type filter.",
      },
      view_types: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional exact Info view_type filters. Overrides or narrows by concrete types such as ['analysis.browser_agent_task', 'app.language.review_queue'].",
      },
      view_type_prefix: {
        type: "string",
        description:
          "Optional prefix filter, e.g. 'app.language.' or 'memory.language.'. Used only when view_types/family do not fully express the request.",
      },
      query: {
        type: "string",
        description:
          "Optional text query to rank/filter views against the user's current question, tab title, URL, selected text, or task.",
      },
      active_only: {
        type: "boolean",
        description: "Whether to exclude archived/rejected views. Defaults to true.",
      },
      limit: {
        type: "number",
        description: "Maximum number of views to return. Defaults to 12, capped at 50.",
      },
      updated_after: {
        type: "string",
        description: "Optional ISO timestamp cursor. Only return views updated after this time.",
      },
    },
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

export const INFO_AGENT_TASKS_TOOL: McpTool = {
  name: "info_agent_tasks",
  description:
    "Inspect or run Info's unified agent task list. Use mode='list' to read the current agent.task_list view, mode='queue' to queue background tasks, mode='process' to run queued tasks, and mode='cancel'/'retry' to update one task.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["list", "queue", "process", "cancel", "retry"],
        description: "Which agent task operation to perform.",
      },
      task_id: {
        type: "string",
        description: "Task View id required for mode='cancel' or mode='retry'.",
      },
      limit: {
        type: "number",
        description: "Maximum task count to inspect or queue/process. Defaults to 8.",
      },
      runtime: {
        type: "string",
        description: "Runtime to use when processing tasks, e.g. 'local_mock', 'claude_code', or 'acp_stdio'.",
      },
      refresh: {
        type: "boolean",
        description: "Refresh the task list before returning it when mode='list'. Defaults to true.",
      },
      dry_run: {
        type: "boolean",
        description: "Queue/process without writing when supported.",
      },
      autonomy: {
        type: "string",
        description: "Optional autonomy override for processing, such as 'suggest' or 'draft'.",
      },
      reason: {
        type: "string",
        description: "Optional reason recorded on cancel/retry lifecycle events.",
      },
    },
  },
};

// All info context tools
export const INFO_TOOLS = [
  INFO_SEARCH_CONTEXT_TOOL,
  INFO_LIST_VIEWS_TOOL,
  INFO_GET_VIEW_TOOL,
  INFO_SUBMIT_FEEDBACK_TOOL,
  INFO_AGENT_TASKS_TOOL,
];

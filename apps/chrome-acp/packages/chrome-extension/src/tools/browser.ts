// Browser tool handler - executes in the extension context
// Communicates with content scripts to access page DOM

import type {
  BrowserDebuggerCommand,
  BrowserDebuggerResult,
  BrowserToolParams,
  BrowserToolResult,
  BrowserTabsResult,
  BrowserReadResult,
  BrowserExecuteResult,
  BrowserActionResult,
  BrowserObserveResult,
  BrowserLanguageRecentResult,
} from "@chrome-acp/shared/acp";

const RECENT_CAPTION_GAPS_KEY = "language.recent_caption_gaps";
const SAVED_CAPTION_GAPS_BY_VIDEO_KEY = "language.caption_gaps.by_video";
const DEBUGGER_SETTINGS_KEY = "advanced_browser_control";
const CDP_VERSION = "1.3";
const DEFAULT_OBSERVE_LIMIT = 60;
const ACT_OBSERVE_CACHE_TTL_MS = 1500;
const MAX_READ_DOM_CHARS = 12000;
const SENSITIVE_DOMAIN_PATTERNS = [
  "mail.google.com",
  "gmail.com",
  "icloud.com",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
  "paypal.com",
  "stripe.com",
  "bank",
  "chase.com",
  "capitalone.com",
  "americanexpress.com",
  "admin.google.com",
  "aws.amazon.com",
  "console.cloud.google.com",
  "portal.azure.com",
];

type DebuggerSettings = {
  enabled?: boolean;
  allowedDomains?: string[];
  deniedDomains?: string[];
  requireConfirmForHighRisk?: boolean;
};

type ObserveCacheEntry = {
  at: number;
  result: BrowserObserveResult;
};

const observeCache = new Map<string, ObserveCacheEntry>();

// Execute browser_tabs: List all open tabs
async function executeBrowserTabs(): Promise<BrowserTabsResult> {
  console.log("[BrowserTool] Listing tabs...");
  const allTabs = await chrome.tabs.query({});

  const tabs = allTabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => ({
      id: tab.id!,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active || false,
    }));

  console.log(`[BrowserTool] Found ${tabs.length} tabs`);
  return { action: "tabs", tabs };
}

// Execute browser_read: Get DOM info from specific tab
async function executeBrowserRead(tabId: number): Promise<BrowserReadResult> {
  console.log(`[BrowserTool] Reading tab ${tabId}...`);

  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error(`Tab ${tabId} not found`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageInfo,
  });

  const pageInfo = results[0]?.result;
  if (!pageInfo) {
    throw new Error("Failed to collect page info");
  }

  const dom = truncateText(pageInfo.dom, MAX_READ_DOM_CHARS);
  console.log(`[BrowserTool] Read complete: ${dom.length} chars`);
  return { action: "read", tabId, ...pageInfo, dom };
}

// Execute browser_execute: Run script in specific tab
async function executeBrowserExecute(
  tabId: number,
  script: string,
): Promise<BrowserExecuteResult> {
  console.log(`[BrowserTool] Executing script in tab ${tabId}...`);

  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error(`Tab ${tabId} not found`);
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN", // Execute in page's main world
      func: executeScriptInMainWorld,
      args: [script],
    });

    const scriptResult = results[0]?.result;
    console.log("[BrowserTool] Script executed");

    return {
      action: "execute",
      tabId,
      url: tab.url || "",
      result: scriptResult?.result,
      error: scriptResult?.error,
    };
  } catch (error) {
    console.error("[BrowserTool] Script execution failed:", error);
    return {
      action: "execute",
      tabId,
      url: tab.url || "",
      error: (error as Error).message,
    };
  }
}

async function executeLanguageRecent(limit = 12): Promise<BrowserLanguageRecentResult> {
  console.log("[BrowserTool] Reading recent language caption gaps...");
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const [sessionStored, localStored] = await Promise.all([
    chrome.storage?.session?.get?.(RECENT_CAPTION_GAPS_KEY),
    chrome.storage?.local?.get?.(SAVED_CAPTION_GAPS_BY_VIDEO_KEY),
  ]);
  const gaps = Array.isArray(sessionStored?.[RECENT_CAPTION_GAPS_KEY])
    ? sessionStored[RECENT_CAPTION_GAPS_KEY].slice(0, safeLimit)
    : [];
  const savedByVideo = localStored?.[SAVED_CAPTION_GAPS_BY_VIDEO_KEY];
  const savedVideos = savedByVideo && typeof savedByVideo === "object" && !Array.isArray(savedByVideo)
    ? Object.values(savedByVideo as Record<string, any>)
        .sort((a: any, b: any) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, safeLimit)
    : [];
  return {
    action: "language_recent",
    key: RECENT_CAPTION_GAPS_KEY,
    count: gaps.length,
    gaps,
    saved_key: SAVED_CAPTION_GAPS_BY_VIDEO_KEY,
    total_saved: savedVideos.reduce((sum: number, video: any) => sum + (Array.isArray(video?.segments) ? video.segments.length : 0), 0),
    saved_videos: savedVideos,
  };
}

async function executeBrowserOpenTab(url: string, active = true): Promise<BrowserActionResult> {
  const tab = await chrome.tabs.create({ url, active });
  return {
    action: "open_tab",
    ok: true,
    tabId: tab.id,
    url: tab.url || url,
    title: tab.title || "",
  };
}

async function executeBrowserActivateTab(tabId: number): Promise<BrowserActionResult> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  return {
    action: "activate_tab",
    ok: true,
    tabId,
    url: tab.url || "",
    title: tab.title || "",
  };
}

async function executeBrowserCloseTab(tabId: number): Promise<BrowserActionResult> {
  await chrome.tabs.remove(tabId);
  return { action: "close_tab", ok: true, tabId };
}

async function executeBrowserReloadTab(tabId: number): Promise<BrowserActionResult> {
  await chrome.tabs.reload(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return {
    action: "reload_tab",
    ok: true,
    tabId,
    url: tab?.url || "",
    title: tab?.title || "",
  };
}

async function executeBrowserClick(tabId: number, selector: string): Promise<BrowserActionResult> {
  let result = (await chrome.scripting.executeScript({
    target: { tabId },
    func: clickElementBySelector,
    args: [selector],
  }))[0]?.result;
  if (!result?.ok) {
    result = await cdpClickSelector(tabId, selector);
  }
  return {
    action: "click",
    ok: Boolean(result?.ok),
    tabId,
    result,
    error: result?.ok ? undefined : result?.error || "Click failed",
  };
}

async function executeBrowserType(tabId: number, selector: string, text: string): Promise<BrowserActionResult> {
  const result = await cdpTypeIntoSelector(tabId, selector, text);
  return {
    action: "type",
    ok: Boolean(result?.ok),
    tabId,
    result,
    error: result?.ok ? undefined : result?.error || "Type failed",
  };
}

async function executeBrowserObserve(
  tabId: number,
  maxElements = DEFAULT_OBSERVE_LIMIT,
  options: { useCache?: boolean } = {},
): Promise<BrowserObserveResult> {
  const tab = await chrome.tabs.get(tabId);
  const safeLimit = Math.max(1, Math.min(200, Math.floor(maxElements || DEFAULT_OBSERVE_LIMIT)));
  const cacheKey = `${tabId}:${tab.url || ""}:${safeLimit}:${tab.windowId ?? ""}`;
  const now = Date.now();
  if (options.useCache !== false) {
    const cached = observeCache.get(cacheKey);
    if (cached && now - cached.at <= ACT_OBSERVE_CACHE_TTL_MS) {
      return cached.result;
    }
  }
  const result = (await chrome.scripting.executeScript({
    target: { tabId },
    func: observeInteractiveElements,
    args: [safeLimit],
  }))[0]?.result;
  const observed: BrowserObserveResult = {
    action: "observe",
    tabId,
    url: tab.url || result?.url || "",
    title: tab.title || result?.title || "",
    viewport: result?.viewport ?? { width: 0, height: 0, scrollX: 0, scrollY: 0 },
    elements: result?.elements ?? [],
    elementCount: result?.elementCount ?? 0,
  };
  if (options.useCache !== false) {
    observeCache.set(cacheKey, { at: now, result: observed });
  }
  return observed;
}

async function executeBrowserAct(params: BrowserToolParams): Promise<BrowserActionResult> {
  const tabId = params.tabId;
  if (tabId === undefined) throw new Error("tabId is required for act action");
  const intent = String(params.intent || "").trim();
  if (!intent) throw new Error("intent is required for act action");
  const mode = params.mode || "auto";
  const text = params.text;
  const target = params.target;
  const queryText = `${intent} ${target ?? ""}`.toLowerCase();
  const wantsSubmit = params.submit === true || mode === "submit" || /submit|send|发送|提交|enter|回车/.test(`${intent} ${target ?? ""}`.toLowerCase());
  let actionResult: any;
  let verification: Awaited<ReturnType<typeof verifyAct>> = { ok: false };
  let observe: BrowserObserveResult | undefined;
  let ranked: ReturnType<typeof rankObservedElements> = [];
  let best: ReturnType<typeof rankObservedElements>[number] | undefined;
  let selector = params.selector;
  let wantsType = mode === "type" || Boolean(text && mode !== "click" && /type|fill|输入|填写|搜索|search|message|消息|聊天/.test(queryText));

  if (!selector) {
    observe = await executeBrowserObserve(tabId, params.maxElements ?? DEFAULT_OBSERVE_LIMIT);
    ranked = rankObservedElements(observe.elements, { intent, target, text, mode });
    best = ranked[0];
    if (!best) {
      return {
        action: "act",
        ok: false,
        tabId,
        url: observe.url,
        title: observe.title,
        result: { intent, target, mode, candidates: [] },
        error: "No interactive element candidates found",
      };
    }
    selector = best.element.selector;
    wantsType = mode === "type" || Boolean(text && mode !== "click" && (best.element.editable || /type|fill|输入|填写|搜索|search|message|消息|聊天/.test(queryText)));
  }

  if (!selector) {
    return {
      action: "act",
      ok: false,
      tabId,
      url: observe?.url || "",
      title: observe?.title || "",
      result: { intent, target, mode, candidates: ranked.slice(0, 8) },
      error: "No selector resolved for action",
    };
  }

  if (wantsType && text !== undefined) {
    actionResult = await cdpTypeIntoSelector(tabId, selector, text);
    if (wantsSubmit && actionResult?.ok) {
      await cdpPressKey(tabId, "Enter");
    }
    verification = await verifyAct(tabId, {
      selector,
      text,
      expectNavigation: false,
      waitMs: wantsSubmit ? 220 : 120,
    });
  } else {
    actionResult = await cdpClickSelector(tabId, selector);
    verification = wantsSubmit
      ? await verifyAct(tabId, {
          selector,
          expectNavigation: true,
          waitMs: 180,
        })
      : { ok: Boolean(actionResult?.ok), ...(await currentTabSnapshot(tabId)) };
  }

  const ok = Boolean(actionResult?.ok) && verification.ok !== false;
  return {
    action: "act",
    ok,
    tabId,
    url: observe?.url || verification.url || "",
    title: observe?.title || verification.title || "",
    result: {
      intent,
      target,
      mode,
      selected: best,
      action: actionResult,
      verification,
      candidates: ranked.slice(0, 8),
    },
    error: ok ? undefined : actionResult?.error || verification.error || "Action could not be verified",
  };
}

async function cdpClickSelector(tabId: number, selector: string) {
  const target = { tabId };
  let attached = false;
  try {
    const rect = await selectorCenter(tabId, selector);
    if (!rect.ok) return rect;
    await chrome.debugger.attach(target, CDP_VERSION);
    attached = true;
    await sendCdp(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x,
      y: rect.y,
      button: "none",
    });
    await sendCdp(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    await sendCdp(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true, selector, method: "cdp", x: rect.x, y: rect.y, tag: rect.tag, text: rect.text };
  } catch (error) {
    return { ok: false, selector, method: "cdp", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function cdpPressKey(tabId: number, key: string) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, CDP_VERSION);
    attached = true;
    await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyDown", key });
    await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", key });
    return { ok: true, key };
  } catch (error) {
    return { ok: false, key, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function cdpTypeIntoSelector(tabId: number, selector: string, text: string) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, CDP_VERSION);
    attached = true;
    const rect = await selectorCenter(tabId, selector);
    if (!rect.ok) return rect;
    await dispatchCdpClick(target, rect.x, rect.y);
    await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
    await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
    await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
    await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
    await sendCdp(target, "Input.insertText", { text });
    const verification = (await chrome.scripting.executeScript({
      target: { tabId },
      func: editableTextForSelector,
      args: [selector],
    }))[0]?.result;
    const textPresent = typeof verification?.text === "string"
      ? verification.text.includes(text)
      : verification?.textPresent;
    return {
      ok: textPresent !== false,
      selector,
      method: "cdp",
      textLength: text.length,
      textPresent,
      tag: verification?.tag,
      error: textPresent === false ? "Text was inserted via CDP but could not be verified in the target element" : undefined,
    };
  } catch (error) {
    return { ok: false, selector, method: "cdp", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function dispatchCdpClick(target: chrome.debugger.Debuggee, x: number, y: number): Promise<void> {
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function selectorCenter(tabId: number, selector: string) {
  const result = (await chrome.scripting.executeScript({
    target: { tabId },
    func: rectForSelector,
    args: [selector],
  }))[0]?.result;
  return result ?? { ok: false, selector, error: "No selector rect result" };
}

async function executeBrowserDebugger(
  tabId: number,
  command: BrowserDebuggerCommand,
  args: Record<string, unknown> = {},
): Promise<BrowserDebuggerResult> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab) throw new Error(`Tab ${tabId} not found`);
  const url = tab.url || "";
  const domain = domainFromUrl(url);
  const settings = await debuggerSettings();
  const policy = debuggerPolicy(command, domain, settings);
  if (!policy.allowed) {
    return {
      action: "debugger",
      command,
      tabId,
      url,
      domain,
      allowed: false,
      attached: false,
      error: policy.reason,
      policy: policy.detail,
    };
  }

  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, CDP_VERSION);
    attached = true;
    await sendCdp(target, "Page.enable");
    if (command === "get_network_log") await sendCdp(target, "Network.enable");
    const result = await runDebuggerCommand(target, command, args);
    return {
      action: "debugger",
      command,
      tabId,
      url,
      domain,
      allowed: true,
      attached,
      ...result,
      policy: policy.detail,
    };
  } catch (error) {
    return {
      action: "debugger",
      command,
      tabId,
      url,
      domain,
      allowed: true,
      attached,
      error: error instanceof Error ? error.message : String(error),
      policy: policy.detail,
    };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function runDebuggerCommand(
  target: chrome.debugger.Debuggee,
  command: BrowserDebuggerCommand,
  args: Record<string, unknown>,
): Promise<Pick<BrowserDebuggerResult, "result" | "artifact">> {
  switch (command) {
    case "capture_full_page": {
      const metrics = await sendCdp<any>(target, "Page.getLayoutMetrics");
      const contentSize = metrics?.contentSize ?? {};
      const width = Math.ceil(Number(contentSize.width) || 0);
      const height = Math.ceil(Number(contentSize.height) || 0);
      const screenshot = await sendCdp<{ data: string }>(target, "Page.captureScreenshot", {
        format: args.format === "png" ? "png" : "jpeg",
        quality: typeof args.quality === "number" ? Math.max(1, Math.min(100, Math.floor(args.quality))) : 80,
        captureBeyondViewport: true,
        fromSurface: true,
      });
      const data = screenshot?.data ?? "";
      return {
        result: { width, height, format: args.format === "png" ? "png" : "jpeg" },
        artifact: {
          mimeType: args.format === "png" ? "image/png" : "image/jpeg",
          data,
          sizeBytes: Math.ceil(data.length * 0.75),
        },
      };
    }
    case "get_layout_tree": {
      const [metrics, domSnapshot, axTree] = await Promise.all([
        sendCdp(target, "Page.getLayoutMetrics"),
        sendCdp(target, "DOMSnapshot.captureSnapshot", {
          computedStyles: ["display", "visibility", "font-size"],
          includeDOMRects: true,
          includePaintOrder: true,
        }),
        sendCdp(target, "Accessibility.getFullAXTree").catch(error => ({ error: error instanceof Error ? error.message : String(error) })),
      ]);
      return { result: { metrics, domSnapshot: compactForTransport(domSnapshot, 160000), accessibilityTree: compactForTransport(axTree, 80000) } };
    }
    case "get_network_log": {
      return {
        result: {
          enabled: true,
          note: "Network domain enabled for this debugger session. Persistent event streaming is not implemented in this request/response tool yet.",
        },
      };
    }
    case "evaluate_js": {
      const expression = typeof args.expression === "string" ? args.expression : typeof args.script === "string" ? args.script : "";
      if (!expression.trim()) throw new Error("expression or script is required for evaluate_js");
      const result = await sendCdp(target, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: Boolean(args.userGesture),
      });
      return { result };
    }
    case "dispatch_input": {
      const inputType = typeof args.type === "string" ? args.type : "key";
      if (inputType === "mouse") {
        await sendCdp(target, "Input.dispatchMouseEvent", {
          type: args.eventType ?? "mousePressed",
          x: Number(args.x ?? 0),
          y: Number(args.y ?? 0),
          button: args.button ?? "left",
          clickCount: Number(args.clickCount ?? 1),
        });
        if (args.eventType === undefined || args.eventType === "mousePressed") {
          await sendCdp(target, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: Number(args.x ?? 0),
            y: Number(args.y ?? 0),
            button: args.button ?? "left",
            clickCount: Number(args.clickCount ?? 1),
          });
        }
        return { result: { dispatched: "mouse", x: args.x, y: args.y } };
      }
      if (inputType === "text") {
        const text = typeof args.text === "string" ? args.text : "";
        if (!text) throw new Error("text is required for dispatch_input type=text");
        await sendCdp(target, "Input.insertText", { text });
        return { result: { dispatched: "text", text_length: text.length } };
      }
      const key = typeof args.key === "string" ? args.key : "Enter";
      await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyDown", key });
      await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", key });
      return { result: { dispatched: "key", key } };
    }
    case "print_pdf": {
      const pdf = await sendCdp<{ data: string }>(target, "Page.printToPDF", {
        printBackground: args.printBackground !== false,
        landscape: Boolean(args.landscape),
      });
      const data = pdf?.data ?? "";
      return {
        result: { format: "pdf" },
        artifact: { mimeType: "application/pdf", data, sizeBytes: Math.ceil(data.length * 0.75) },
      };
    }
  }
}

function sendCdp<T = unknown>(target: chrome.debugger.Debuggee, method: string, commandParams?: object): Promise<T> {
  return chrome.debugger.sendCommand(target, method, commandParams) as Promise<T>;
}

async function debuggerSettings(): Promise<DebuggerSettings> {
  const stored = await chrome.storage.local.get(DEBUGGER_SETTINGS_KEY).catch(() => ({}));
  const settings = stored?.[DEBUGGER_SETTINGS_KEY];
  return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
}

function debuggerPolicy(command: BrowserDebuggerCommand, domain: string | undefined, settings: DebuggerSettings) {
  const enabled = settings.enabled === true;
  const allowedDomains = Array.isArray(settings.allowedDomains) ? settings.allowedDomains : [];
  const deniedDomains = [...SENSITIVE_DOMAIN_PATTERNS, ...(Array.isArray(settings.deniedDomains) ? settings.deniedDomains : [])];
  const sensitive = domain ? deniedDomains.some(pattern => domainMatches(domain, pattern)) : true;
  const domainAllowed = domain ? allowedDomains.some(pattern => domainMatches(domain, pattern)) : false;
  const requiresConfirm = ["evaluate_js", "dispatch_input", "get_network_log"].includes(command)
    ? settings.requireConfirmForHighRisk !== false
    : false;
  const detail = {
    enabled,
    domain_allowed: domainAllowed,
    sensitive_domain: sensitive,
    requires_confirm: requiresConfirm,
  };
  if (!enabled) return { allowed: false, reason: "Advanced Browser Control is disabled in extension settings.", detail };
  if (sensitive) return { allowed: false, reason: `Debugger tools are blocked on sensitive domain: ${domain ?? "unknown"}`, detail };
  if (!domainAllowed) return { allowed: false, reason: `Domain is not allowlisted for debugger tools: ${domain ?? "unknown"}`, detail };
  if (requiresConfirm) return { allowed: false, reason: `High-risk debugger command requires explicit user confirmation: ${command}`, detail };
  return { allowed: true, detail };
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function domainMatches(domain: string, pattern: string): boolean {
  const cleanDomain = domain.toLowerCase();
  const cleanPattern = pattern.toLowerCase().replace(/^\*\./, "");
  return cleanDomain === cleanPattern || cleanDomain.endsWith(`.${cleanPattern}`) || cleanDomain.includes(cleanPattern);
}

function compactForTransport(value: unknown, maxChars: number): unknown {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return {
    truncated: true,
    original_chars: text.length,
    json_preview: text.slice(0, maxChars),
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

type ObservedElement = BrowserObserveResult["elements"][number];

function rankObservedElements(
  elements: ObservedElement[],
  options: { intent: string; target?: string; text?: string; mode?: string },
): Array<{ score: number; reasons: string[]; element: ObservedElement }> {
  const query = normalizeSearch(`${options.intent} ${options.target ?? ""}`);
  const wantsEditable = Boolean(options.text) || /type|fill|input|write|search|message|输入|填写|搜索|消息|聊天|发/.test(query);
  const wantsButton = /click|press|open|submit|send|buy|chat|点击|打开|提交|发送|购买|聊|联系|收藏/.test(query);
  return elements
    .map((element) => {
      let score = 0;
      const reasons: string[] = [];
      const haystack = normalizeSearch([
        element.label,
        element.text,
        element.placeholder,
        element.ariaLabel,
        element.title,
        element.role,
        element.tag,
        element.selector,
      ].filter(Boolean).join(" "));
      const tokens = query.split(/\s+/).filter(token => token.length > 1);
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += token.length >= 3 ? 8 : 4;
          reasons.push(`matches "${token}"`);
        }
      }
      if (options.target && haystack.includes(normalizeSearch(options.target))) {
        score += 30;
        reasons.push("target phrase");
      }
      if (wantsEditable && element.editable) {
        score += 25;
        reasons.push("editable");
      }
      if (wantsButton && ["button", "link", "menuitem"].includes(element.role)) {
        score += 15;
        reasons.push(`role ${element.role}`);
      }
      if (element.disabled) {
        score -= 80;
        reasons.push("disabled");
      }
      if (element.rect) {
        const area = element.rect.width * element.rect.height;
        if (area > 20) score += 2;
        const centerY = element.rect.y + element.rect.height / 2;
        if (centerY >= 0 && centerY <= 900) score += 2;
      }
      const label = normalizeSearch(element.label);
      if (label === "聊一聊" || label.includes("聊一聊") || label.includes("chat")) {
        score += query.includes("聊") || query.includes("chat") ? 35 : 0;
      }
      return { score, reasons, element };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

async function verifyAct(
  tabId: number,
  options: { selector: string; text?: string; expectNavigation?: boolean; waitMs?: number },
): Promise<{ ok?: boolean; textPresent?: boolean; url?: string; title?: string; error?: string }> {
  try {
    const waitMs = Math.max(0, Math.min(500, Math.floor(options.waitMs ?? 120)));
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const result = (await chrome.scripting.executeScript({
      target: { tabId },
      func: editableTextForSelector,
      args: [options.selector],
    }).catch(() => []))[0]?.result;
    if (options.text !== undefined) {
      const textPresent = typeof result?.text === "string" && result.text.includes(options.text);
      return {
        ok: textPresent || result?.textPresent === true,
        textPresent,
        url: tab?.url,
        title: tab?.title,
        error: textPresent || result?.textPresent === true ? undefined : "Typed text was not visible in the target element",
      };
    }
    return { ok: true, url: tab?.url, title: tab?.title };
  } catch (error) {
    return { ok: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

async function currentTabSnapshot(tabId: number): Promise<{ url?: string; title?: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return {
    url: tab?.url,
    title: tab?.title,
  };
}

// Main entry point - routes to appropriate action
export async function executeBrowserTool(
  params: BrowserToolParams,
): Promise<BrowserToolResult> {
  console.log("[BrowserTool] Action:", params.action);

  switch (params.action) {
    case "tabs":
      return executeBrowserTabs();
    case "read":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for read action");
      }
      return executeBrowserRead(params.tabId);
    case "execute":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for execute action");
      }
      if (!params.script) {
        throw new Error("script is required for execute action");
      }
      return executeBrowserExecute(params.tabId, params.script);
    case "language_recent":
      return executeLanguageRecent(params.limit);
    case "open_tab":
      if (!params.url) {
        throw new Error("url is required for open_tab action");
      }
      return executeBrowserOpenTab(params.url, params.active !== false);
    case "activate_tab":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for activate_tab action");
      }
      return executeBrowserActivateTab(params.tabId);
    case "close_tab":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for close_tab action");
      }
      return executeBrowserCloseTab(params.tabId);
    case "reload_tab":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for reload_tab action");
      }
      return executeBrowserReloadTab(params.tabId);
    case "click":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for click action");
      }
      if (!params.selector) {
        throw new Error("selector is required for click action");
      }
      return executeBrowserClick(params.tabId, params.selector);
    case "type":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for type action");
      }
      if (!params.selector) {
        throw new Error("selector is required for type action");
      }
      if (params.text === undefined) {
        throw new Error("text is required for type action");
      }
      return executeBrowserType(params.tabId, params.selector, params.text);
    case "observe":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for observe action");
      }
      return executeBrowserObserve(params.tabId, params.maxElements);
    case "act":
      return executeBrowserAct(params);
    case "debugger":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for debugger action");
      }
      if (!params.command) {
        throw new Error("command is required for debugger action");
      }
      return executeBrowserDebugger(params.tabId, params.command, params.args);
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}

// Page info type for collectPageInfo return
interface PageInfo {
  url: string;
  title: string;
  dom: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  selection: string | null;
}

// This function is serialized and executed in the page context (ISOLATED world)
// It only collects DOM info, does NOT execute user scripts
function collectPageInfo(): PageInfo {
  // Serialize DOM to a simplified text representation
  function serializeDOM(): string {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            const tagName = el.tagName.toLowerCase();
            if (
              ["script", "style", "noscript", "svg", "path"].includes(tagName)
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    const parts: string[] = [];
    let currentNode: Node | null;

    while ((currentNode = walker.nextNode())) {
      if (currentNode.nodeType === Node.TEXT_NODE) {
        const text = currentNode.textContent?.trim();
        if (text) {
          parts.push(text);
        }
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
        const el = currentNode as Element;
        const tagName = el.tagName.toLowerCase();

        if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tagName)) {
          parts.push(`\n\n## `);
        } else if (tagName === "p" || tagName === "div") {
          parts.push("\n");
        } else if (tagName === "li") {
          parts.push("\n- ");
        } else if (tagName === "button") {
          parts.push(`[Button: `);
        } else if (tagName === "input") {
          const type = el.getAttribute("type") || "text";
          const name = el.getAttribute("name") || el.getAttribute("id") || "";
          const value = (el as HTMLInputElement).value || "";
          parts.push(`[Input ${type} "${name}": "${value}"]`);
        } else if (tagName === "img") {
          const alt = el.getAttribute("alt") || "";
          parts.push(`[Image: ${alt}]`);
        }
      }
    }

    return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  return {
    url: window.location.href,
    title: document.title,
    dom: serializeDOM(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    selection: window.getSelection()?.toString() || null,
  };
}

// This function executes user script in the MAIN world (page context)
// When called with world: "MAIN", it runs directly in the page's JavaScript context
// which means it uses the PAGE's CSP, not the extension's CSP
function executeScriptInMainWorld(script: string): { result?: unknown; error?: string } {
  try {
    // Use Function constructor to execute the script
    // This works because we're in the MAIN world with the page's CSP
    // Most pages allow eval/Function (unlike our extension which is MV3)
    const fn = new Function(script);
    const result = fn();
    return { result };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function clickElementBySelector(selector: string): { ok: boolean; selector: string; tag?: string; text?: string; error?: string } {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { ok: false, selector, error: "Element not found" };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return {
    ok: true,
    selector,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

function typeIntoElementBySelector(selector: string, text: string): { ok: boolean; selector: string; tag?: string; textLength?: number; textPresent?: boolean; error?: string } {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { ok: false, selector, error: "Element not found" };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element.isContentEditable) {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  } else {
    return { ok: false, selector, tag: element.tagName.toLowerCase(), error: "Element is not editable" };
  }

  return {
    ok: true,
    selector,
    tag: element.tagName.toLowerCase(),
    textLength: text.length,
    textPresent: editableText(element).includes(text),
  };
}

function rectForSelector(selector: string): { ok: boolean; selector: string; x?: number; y?: number; tag?: string; text?: string; error?: string } {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { ok: false, selector, error: "Element not found" };
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return { ok: false, selector, tag: element.tagName.toLowerCase(), error: "Element has no visible rect" };
  return {
    ok: true,
    selector,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

function observeInteractiveElements(maxElements: number): {
  url: string;
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  elements: Array<{
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
  }>;
  elementCount: number;
} {
  const selector = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='searchbox']",
    "[role='menuitem']",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
    ".btn",
    "[class*='button']",
  ].join(",");
  const seen = new Set<Element>();
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
    });
  const elements = candidates.slice(0, Math.max(1, maxElements)).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const placeholder = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : undefined;
    const ariaLabel = element.getAttribute("aria-label") || undefined;
    const title = element.getAttribute("title") || undefined;
    const role = inferElementRole(element);
    const label = [ariaLabel, placeholder, text, title, element.getAttribute("name") || undefined, element.id || undefined]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260);
    return {
      ref: `@e${index + 1}`,
      role,
      tag: element.tagName.toLowerCase(),
      label,
      selector: cssPath(element),
      text,
      placeholder,
      ariaLabel,
      title,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      editable: isEditableElement(element),
      disabled: isDisabledElement(element),
      visible: true,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  });
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    elements,
    elementCount: candidates.length,
  };
}

function inferElementRole(element: HTMLElement): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (element as HTMLInputElement).type;
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (["checkbox"].includes(type)) return "checkbox";
    if (["radio"].includes(type)) return "radio";
    if (["search"].includes(type)) return "searchbox";
    return "textbox";
  }
  if (element.isContentEditable) return "textbox";
  return element.onclick ? "button" : "generic";
}

function isEditableElement(element: HTMLElement): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable || element.getAttribute("role") === "textbox" || element.getAttribute("role") === "searchbox";
}

function isDisabledElement(element: HTMLElement): boolean {
  return Boolean((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true");
}

function cssPath(element: Element): string {
  if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(child => child.tagName === current!.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = parent;
  }
  return parts.join(" > ");
}

function editableTextForSelector(selector: string): { ok: boolean; selector: string; tag?: string; text?: string; textPresent?: boolean; error?: string } {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { ok: false, selector, error: "Element not found" };
  const text = editableText(element);
  return {
    ok: true,
    selector,
    tag: element.tagName.toLowerCase(),
    text,
    textPresent: text.length > 0,
  };
}

function editableText(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

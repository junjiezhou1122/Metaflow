const contentGlobal = window as any;
if (contentGlobal.__metaflowContentScriptLoaded) {
  throw new Error("metaflow content script already loaded");
}
contentGlobal.__metaflowContentScriptLoaded = true;

let maxScrollDepth = 0;
let scrollEvents = 0;
let selectionCount = 0;
let lastSelectedText = "";
let selectionTimer: number | undefined;
let selectionToolbar: HTMLDivElement | null = null;
let activeSelectionPayload: any = null;
let writingTimer: number | undefined;
let lastWritingText = "";
let assistBubble: HTMLDivElement | null = null;
let assistElement: Element | null = null;
let pendingInsertedDraftEdit: {
  element: Element;
  view: any;
  draft: string;
  beforeText: string;
  insertedText: string;
  lastText: string;
  createdAt: number;
  sent: boolean;
} | null = null;
let insertedDraftEditTimer: number | undefined;
let writingRequestSeq = 0;
const startedAt = Date.now();
const WRITING_VIEW_TYPES = ["draft.writing_continuation", "advice.writing_assist"];
const WRITING_ASSIST_POLL_ATTEMPTS = 45;
const WRITING_ASSIST_POLL_INTERVAL_MS = 2000;

function visibleText() {
  const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
  if (!clone) return "";
  clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,footer").forEach((el) => el.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120_000);
}

function textQuality(text: string) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  const words = compact.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const cjk = compact.match(/[\u4e00-\u9fff]/g) || [];
  const letters = compact.match(/[A-Za-z]/g) || [];
  const totalSignal = Math.max(1, letters.length + cjk.length);
  const englishRatio = letters.length / totalSignal;
  const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
  const repeatedRatio = words.length ? 1 - uniqueWords / words.length : 0;
  const sentenceCount = (compact.match(/[.!?。！？]/g) || []).length;
  return {
    detected_language: document.documentElement.lang || (englishRatio > 0.65 ? "en" : cjk.length > letters.length ? "zh" : undefined),
    english_ratio: Number(englishRatio.toFixed(3)),
    word_count: words.length,
    char_count: compact.length,
    sentence_count: sentenceCount,
    repeated_ratio: Number(repeatedRatio.toFixed(3)),
    quality_score: Number(Math.min(1, Math.max(0, englishRatio * 0.45 + Math.min(1, words.length / 500) * 0.35 + Math.min(1, sentenceCount / 20) * 0.2 - repeatedRatio * 0.2)).toFixed(3)),
  };
}

function searchQueryInfo() {
  const host = location.hostname.replace(/^www\./, "");
  const params = new URLSearchParams(location.search);
  const path = location.pathname;
  const engines = [
    { test: /(^|\.)google\./, name: "google", param: "q" },
    { test: /(^|\.)bing\.com$/, name: "bing", param: "q" },
    { test: /(^|\.)duckduckgo\.com$/, name: "duckduckgo", param: "q" },
    { test: /(^|\.)baidu\.com$/, name: "baidu", param: "wd" },
    { test: /(^|\.)perplexity\.ai$/, name: "perplexity", param: "q" },
    { test: /(^|\.)github\.com$/, name: "github", param: "q", path: /^\/search/ },
    { test: /(^|\.)youtube\.com$/, name: "youtube", param: "search_query", path: /^\/results/ },
  ];
  for (const engine of engines) {
    if (!engine.test.test(host)) continue;
    if (engine.path && !engine.path.test(path)) continue;
    const query = params.get(engine.param)?.trim();
    if (!query) continue;
    return { engine: engine.name, query, param: engine.param, url: location.href, title: document.title, searched_at: new Date().toISOString() };
  }
  return undefined;
}

function metadata() {
  const pick = (selector: string, attr = "content") => document.querySelector(selector)?.getAttribute(attr) || undefined;
  return {
    description: pick('meta[name="description"]'),
    og_title: pick('meta[property="og:title"]'),
    og_description: pick('meta[property="og:description"]'),
    canonical_url: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || undefined,
    lang: document.documentElement.lang || undefined,
  };
}

function automationDomContext() {
  const path = location.pathname.split("/").filter(Boolean);
  const githubRepository = location.hostname === "github.com"
    && path.length >= 2
    && Boolean(document.querySelector("#repository-container-header, [data-testid='repository-container-header'], [itemtype='http://schema.org/SoftwareSourceCode']"));
  return {
    github_repository: githubRepository,
    repository_owner: githubRepository ? path[0] : undefined,
    repository_name: githubRepository ? path[1] : undefined,
    markers: {
      repository_header: Boolean(document.querySelector("#repository-container-header, [data-testid='repository-container-header']")),
      repository_content: Boolean(document.querySelector("#repo-content-pjax-container, [data-turbo-frame='repo-content-turbo-frame']")),
      readme: Boolean(document.querySelector("#readme, article.markdown-body")),
    },
  };
}

function scrollDepth() {
  const doc = document.documentElement;
  const max = Math.max(1, doc.scrollHeight - window.innerHeight);
  return Math.min(1, Math.max(0, (window.scrollY + window.innerHeight) / Math.max(doc.scrollHeight, window.innerHeight), window.scrollY / max));
}

function selectionContext(kind = "selected") {
  const selection = window.getSelection?.();
  const selectedText = String(selection ?? "").trim();
  if (!selection || !selectedText) return undefined;
  const range = selection.rangeCount ? selection.getRangeAt(0) : undefined;
  const node = range?.commonAncestorContainer;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
  const rect = range?.getBoundingClientRect?.();
  const surroundingText = (element as HTMLElement | undefined)?.innerText?.replace(/\s+/g, " ").trim().slice(0, 2000);
  return {
    kind,
    selected_text: selectedText,
    surrounding_text: surroundingText,
    selection_length: selectedText.length,
    tag: element?.tagName,
    url: location.href,
    title: document.title,
    domain: location.hostname,
    canonical_url: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || location.href,
    page_language: document.documentElement.lang || undefined,
    scroll_depth: Math.max(maxScrollDepth, scrollDepth()),
    viewport: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined,
    selected_at: new Date().toISOString(),
    metadata: metadata(),
    text_quality: textQuality(selectedText),
  };
}

function collectPageContext() {
  const selected = String(getSelection?.() ?? "").trim();
  if (selected && selected !== lastSelectedText) {
    selectionCount += 1;
    lastSelectedText = selected;
  }
  maxScrollDepth = Math.max(maxScrollDepth, scrollDepth());
  const text = visibleText();
  return {
    title: document.title,
    url: location.href,
    domain: location.hostname,
    text,
    selected_text: selected,
    scroll_depth: maxScrollDepth,
    scroll_events: scrollEvents,
    selection_count: selectionCount,
    page_active_seconds: Math.round((Date.now() - startedAt) / 1000),
    observed_at: new Date().toISOString(),
    metadata: metadata(),
    text_quality: textQuality(text),
    search: searchQueryInfo(),
    dom: automationDomContext(),
  };
}

function sendAttention(kind: "selected" | "copied") {
  const payload = selectionContext(kind);
  if (!payload || payload.selected_text.length < 3) return;
  chrome.runtime.sendMessage({ type: "context.capture.browser_attention", kind, payload }).catch(error => {
    reportBrowserCaptureMessageFailure("attention", error, { kind, url: payload.url });
  });
}

function handleStableSelection() {
  const payload = selectionContext("selected");
  if (!payload || payload.selected_text.length < 3) {
    removeSelectionToolbar();
    return;
  }
  showSelectionToolbar(payload);
  chrome.runtime.sendMessage({ type: "context.capture.browser_attention", kind: "selected", payload }).catch(error => {
    reportBrowserCaptureMessageFailure("selection", error, { url: payload.url });
  });
}

function reportBrowserCaptureMessageFailure(stage: string, error: unknown, details: Record<string, unknown>): void {
  console.error(JSON.stringify({
    component: "browser-capture-content",
    event: "browser_capture.message_failed",
    stage,
    error: error instanceof Error ? error.message : String(error),
    ...details,
  }));
}

function queueSelectionCheck(delayMs = 180) {
  clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => handleStableSelection(), delayMs);
}

window.addEventListener("scroll", () => {
  scrollEvents += 1;
  maxScrollDepth = Math.max(maxScrollDepth, scrollDepth());
}, { passive: true });

document.addEventListener("selectionchange", () => {
  const selected = String(getSelection?.() ?? "").trim();
  if (selected && selected !== lastSelectedText) {
    selectionCount += 1;
    lastSelectedText = selected;
  }
  queueSelectionCheck(650);
});

document.addEventListener("mouseup", () => queueSelectionCheck(), true);
document.addEventListener("pointerup", () => queueSelectionCheck(), true);
document.addEventListener("keyup", () => queueSelectionCheck(), true);

document.addEventListener("copy", () => {
  window.setTimeout(() => sendAttention("copied"), 0);
});

document.addEventListener("mousedown", (event) => {
  if (selectionToolbar?.contains(event.target as Node)) return;
  const selected = String(getSelection?.() ?? "").trim();
  if (!selected) removeSelectionToolbar();
}, true);

document.addEventListener("focusin", (event) => {
  const target = editableElement(event.target);
  if (!target) return;
  attachWritingWidget(target);
}, true);

document.addEventListener("click", (event) => {
  const target = editableElement(event.target);
  if (!target) return;
  attachWritingWidget(target);
}, true);

document.addEventListener("keyup", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = editableElement(event.target);
  if (!target) return;
  queueWritingInput(target);
}, true);

document.addEventListener("compositionend", (event) => {
  const target = editableElement(event.target);
  if (!target) return;
  queueWritingInput(target);
}, true);

document.addEventListener("input", (event) => {
  const target = editableElement(event.target);
  if (!target) return;
  queueWritingInput(target);
}, true);

function queueWritingInput(target: Element) {
  attachWritingWidget(target);
  const fullText = editableText(target);
  const text = focusedWritingText(target, fullText);
  observeInsertedDraftEdit(target, text);
  if (!shouldSendWritingText(text, target)) return;
  clearTimeout(writingTimer);
  writingTimer = window.setTimeout(() => sendWritingInput(target, text, fullText), 900);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect-page-context") {
    sendResponse(collectPageContext());
    return true;
  }
});

function editableElement(target: EventTarget | null) {
  const element = target instanceof Element ? target : undefined;
  if (!element) return undefined;
  const editable = element.closest("textarea,input,[contenteditable='true'],[contenteditable='plaintext-only']");
  if (!editable) return undefined;
  if (editable instanceof HTMLInputElement) {
    const type = (editable.type || "text").toLowerCase();
    if (!["text", "search", "url", "email", "tel"].includes(type)) return undefined;
  }
  return editable;
}

function attachWritingWidget(element: Element) {
  if (sensitiveEditable(element)) return;
  if (assistBubble && assistElement === element) positionAssistBubble(element);
}

function editableText(element: Element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  return element.textContent || "";
}

function focusedWritingText(element: Element, fullText: string) {
  const selected = String(window.getSelection?.() ?? "").replace(/\s+/g, " ").trim();
  if (selected.length >= 12) return selected.slice(0, 2000);
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const caret = element.selectionStart ?? fullText.length;
    return textAroundOffset(fullText, caret, 1800);
  }
  const selection = window.getSelection?.();
  const anchor = selection?.anchorNode;
  const block = anchor ? editableBlockText(anchor, element) : "";
  return (block || fullText).replace(/\s+/g, " ").trim().slice(0, 2000);
}

function editableBlockText(node: Node, root: Element) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const block = element?.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,[data-block-id],[data-page-id],[role='textbox'],div");
  if (block && root.contains(block)) return block.textContent || "";
  return element && root.contains(element) ? element.textContent || "" : "";
}

function textAroundOffset(text: string, offset: number, max: number) {
  const half = Math.floor(max / 2);
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, offset + half);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function shouldSendWritingText(text: string, element: Element) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 24 || normalized.length > 5000) return false;
  if (normalized === lastWritingText) return false;
  if (element instanceof HTMLInputElement && normalized.length < 40) return false;
  if (sensitiveEditable(element)) return false;
  lastWritingText = normalized;
  return true;
}

function sensitiveEditable(element: Element) {
  return /password|token|secret|api[_-]?key|credit card|验证码|密码/i.test(`${element.id || ""} ${element.getAttribute("name") || ""} ${element.getAttribute("autocomplete") || ""}`);
}

function sendWritingInput(element: Element, text: string, fullText = text) {
  const rect = element.getBoundingClientRect();
  const requestSeq = ++writingRequestSeq;
  chrome.runtime.sendMessage({
    type: "context.capture.writing_input",
    payload: {
      title: document.title,
      url: location.href,
      domain: location.hostname,
      text,
      full_text: fullText,
      field_tag: element.tagName,
      field_id: element.id || undefined,
      field_name: element.getAttribute("name") || undefined,
      field_role: element.getAttribute("role") || undefined,
      field_placeholder: element.getAttribute("placeholder") || undefined,
      viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      page_context: pageWritingContext(),
      changed_at: new Date().toISOString(),
      metadata: metadata(),
      text_quality: textQuality(text),
    },
  }).then(async (result) => {
    if (showWritingAssist(result, element)) return;
    await pollWritingAssist(element, text, result, requestSeq);
  }).catch(() => {
    // Writing ambient is advisory; backend failures should not interrupt the editor.
  });
}

function showWritingAssist(result: any, element: Element) {
  const view = writingViewFromResult(result);
  const draft = draftTextFromView(view);
  let suggestions: string[] = suggestionsFromView(view);
  if (!view || (!draft && !suggestions.length)) return false;
  // Normalize suggestions to a single "draft" for the insert flow if no draft.
  if (!draft && suggestions.length) suggestions = [suggestions[0]];
  removeAssistBubble();
  assistElement = element;
  assistBubble = document.createElement("div");
  assistBubble.id = "info-writing-assist";
  const title = document.createElement("div");
  title.className = "info-writing-title";
  title.textContent = view.view_type === "draft.writing_continuation" ? "Draft" : "Suggestion";
  const panel = document.createElement("div");
  panel.className = "info-writing-panel";
  const body = document.createElement("div");
  body.className = "info-writing-body";
  body.textContent = draft || suggestions[0];
  const actions = document.createElement("div");
  actions.className = "info-writing-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dismiss";
  close.addEventListener("click", () => {
    submitWritingFeedback(view, {
      feedbackType: "analysis.dismissed",
      value: "dismissed",
      reason: "Dismissed inline writing assist.",
      payload: { action: "dismiss", surface: "writing_inline", draft_text: draft || undefined, suggestion_count: suggestions.length },
    });
    removeAssistBubble();
  });
  actions.append(close);
  if (draft) {
    const insert = document.createElement("button");
    insert.type = "button";
    insert.textContent = "Insert";
    insert.addEventListener("click", () => {
      const beforeText = editableText(element);
      insertDraft(element, draft);
      const afterText = editableText(element);
      rememberInsertedDraftForEdit(element, view, draft, beforeText, afterText);
      submitWritingFeedback(view, {
        feedbackType: "analysis.useful",
        value: "inserted",
        reason: "Inserted inline writing draft.",
        payload: { action: "insert", surface: "writing_inline", draft_text: draft, original_text: beforeText, edited_text: afterText },
      });
      removeAssistBubble();
    });
    actions.append(insert);
  } else if (suggestions.length) {
    // "Insert" for suggestion text treats the first suggestion as a draft.
    const insert = document.createElement("button");
    insert.type = "button";
    insert.textContent = "Insert";
    insert.addEventListener("click", () => {
      const beforeText = editableText(element);
      const suggestionText = suggestions[0];
      insertDraft(element, suggestionText);
      const afterText = editableText(element);
      rememberInsertedDraftForEdit(element, view, suggestionText, beforeText, afterText);
      submitWritingFeedback(view, {
        feedbackType: "analysis.useful",
        value: "inserted",
        reason: "Inserted inline writing suggestion.",
        payload: { action: "insert", surface: "writing_inline", draft_text: suggestionText, original_text: beforeText, edited_text: afterText },
      });
      removeAssistBubble();
    });
    actions.append(insert);
  }
  // Route-to-inbox when a view exists but has no draft or suggestion.
  if (!draft && !suggestions.length && view?.id) {
    const inbox = document.createElement("button");
    inbox.type = "button";
    inbox.textContent = "Inbox";
    inbox.addEventListener("click", () => {
      submitWritingFeedback(view, {
        feedbackType: "analysis.useful",
        value: "routed_to_inbox",
        reason: "Routed writing output to inbox.",
        payload: { action: "route_inbox", surface: "writing_inline", view_id: view.id, view_type: view.view_type },
      });
      removeAssistBubble();
    });
    actions.append(inbox);
  }
  panel.append(title, body, actions);
  assistBubble.append(panel);
  document.documentElement.append(assistBubble);
  positionAssistBubble(element);
  return true;
}

async function pollWritingAssist(element: Element, text: string, result: any, requestSeq: number) {
  const sourceRecordId = result?.record_id;
  if (!sourceRecordId) {
    return;
  }
  for (let attempt = 0; attempt < WRITING_ASSIST_POLL_ATTEMPTS; attempt += 1) {
    await delay(attempt === 0 ? 900 : WRITING_ASSIST_POLL_INTERVAL_MS);
    const currentText = focusedWritingText(element, editableText(element));
    if (requestSeq !== writingRequestSeq || !element.isConnected || normalizeWriting(currentText) !== normalizeWriting(text)) {
      return;
    }
    const polled = await chrome.runtime.sendMessage({
      type: "poll-context-views",
      viewTypes: WRITING_VIEW_TYPES,
      sourceRecordId,
      limit: 4,
      activeOnly: true,
    }).catch(() => undefined);
    if (showWritingAssist(polled, element)) return;
  }
}

function writingViewFromResult(result: any) {
  const views = Array.isArray(result?.views) ? result.views.map((item: any) => item?.view ?? item).filter(Boolean) : [];
  return views.find((view: any) => view.view_type === "draft.writing_continuation")
    || views.find((view: any) => view.view_type === "advice.writing_assist");
}

function delay(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function draftTextFromView(view: any) {
  const value = view?.content?.draft_text || view?.summary;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function suggestionsFromView(view: any) {
  const value = view?.content?.suggestions;
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()) : [];
}

function pageWritingContext() {
  const pageText = visibleText();
  return {
    title: document.title,
    url: location.href,
    domain: location.hostname,
    selected_text: String(window.getSelection?.() ?? "").trim().slice(0, 2000) || undefined,
    excerpt: pageText.slice(0, 6000),
    text_quality: textQuality(pageText),
  };
}

function submitWritingFeedback(view: any, input: any) {
  if (!view?.id || !input?.feedbackType) return;
  chrome.runtime.sendMessage({
    type: "feedback-view",
    viewId: view.id,
    viewType: view.view_type,
    feedbackType: input.feedbackType,
    value: input.value,
    reason: input.reason,
    applicationId: "editor.inline_assist",
    payload: {
      target_view_id: view.id,
      target_view_type: view.view_type,
      ...(input.payload ?? {}),
    },
  }).catch(error => {
    console.error("[metaflow-writing] feedback delivery failed", error, { view_id: view.id });
  });
}

function rememberInsertedDraftForEdit(element: Element, view: any, draft: string, beforeText: string, afterText: string) {
  if (!view?.id || !draft || sensitiveEditable(element)) return;
  clearTimeout(insertedDraftEditTimer);
  pendingInsertedDraftEdit = { element, view, draft, beforeText, insertedText: afterText, lastText: afterText, createdAt: Date.now(), sent: false };
}

function observeInsertedDraftEdit(element: Element, text: string) {
  const pending = pendingInsertedDraftEdit;
  if (!pending || pending.sent || pending.element !== element) return;
  if (Date.now() - pending.createdAt > 120_000 || sensitiveEditable(element)) {
    clearPendingInsertedDraftEdit();
    return;
  }
  if (normalizeWriting(text) === normalizeWriting(pending.insertedText)) return;
  pending.lastText = text;
  clearTimeout(insertedDraftEditTimer);
  insertedDraftEditTimer = window.setTimeout(() => flushInsertedDraftEditFeedback(), 1800);
}

function flushInsertedDraftEditFeedback() {
  const pending = pendingInsertedDraftEdit;
  if (!pending || pending.sent) return;
  const editedText = String(pending.lastText || "").trim();
  if (editedText.length < 12 || normalizeWriting(editedText) === normalizeWriting(pending.insertedText)) return;
  pending.sent = true;
  submitWritingFeedback(pending.view, {
    feedbackType: "output.edited",
    value: "edited",
    reason: "Edited inline writing draft after insertion.",
    payload: {
      action: "edit_after_insert",
      surface: "writing_inline",
      original_text: pending.draft,
      edited_text: editedText,
      inserted_context_text: pending.insertedText,
      pre_insert_text: pending.beforeText,
    },
  });
  clearPendingInsertedDraftEdit();
}

function clearPendingInsertedDraftEdit() {
  clearTimeout(insertedDraftEditTimer);
  insertedDraftEditTimer = undefined;
  pendingInsertedDraftEdit = null;
}

function normalizeWriting(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function insertDraft(element: Element, draft: string) {
  if (!draft) return;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const prefix = element.value.slice(0, start);
    const suffix = element.value.slice(end);
    const insertion = `${prefix && !/\s$/.test(prefix) ? " " : ""}${draft}`;
    element.value = `${prefix}${insertion}${suffix}`;
    element.selectionStart = element.selectionEnd = start + insertion.length;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: draft }));
    return;
  }
  (element as HTMLElement).focus();
  document.execCommand("insertText", false, `${editableText(element).trim() ? " " : ""}${draft}`);
}

function positionAssistBubble(element: Element) {
  if (!assistBubble) return;
  const rect = editablePositionRect(element);
  const bubbleRect = assistBubble.getBoundingClientRect();
  const width = Math.max(318, bubbleRect.width || 318);
  const height = Math.max(128, bubbleRect.height || 128);
  const panelLeft = Math.min(rect.left, rect.right - width);
  const top = Math.max(12, Math.min(window.innerHeight - height - 12, rect.bottom + 8));
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, panelLeft));
  assistBubble.style.top = `${top + window.scrollY}px`;
  assistBubble.style.left = `${left + window.scrollX}px`;
}

function removeAssistBubble() {
  assistBubble?.remove();
  assistBubble = null;
  assistElement = null;
}

function editablePositionRect(element: Element) {
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement)) {
    const selection = window.getSelection?.();
    const anchor = selection?.anchorNode;
    if (selection?.rangeCount && anchor && element.contains(anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)) {
      const range = selection.getRangeAt(0).cloneRange();
      const rects = Array.from(range.getClientRects());
      const rect = rects[rects.length - 1] || range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    }
  }
  return element.getBoundingClientRect();
}

function showSelectionToolbar(payload: any) {
  removeSelectionToolbar();
  activeSelectionPayload = payload;
  const rect = selectionRect();
  if (!rect) return;
  selectionToolbar = document.createElement("div");
  selectionToolbar.id = "info-selection-toolbar";
  selectionToolbar.className = "is-ready";
  selectionToolbar.setAttribute("role", "toolbar");
  selectionToolbar.setAttribute("aria-label", "Info selection toolbar");
  document.documentElement.append(selectionToolbar);
  renderSelectionSaveButton(payload);
  positionSelectionToolbar(rect);
}

function renderSelectionSaveButton(payload: any) {
  if (!selectionToolbar || activeSelectionPayload !== payload) return;
  selectionToolbar.textContent = "";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.setAttribute("role", "button");
  save.setAttribute("aria-label", "Save selected text to Info");
  save.addEventListener("click", () => saveSelection(payload));
  selectionToolbar.append(save);
  const rect = selectionRect();
  if (rect) positionSelectionToolbar(rect);
}

function saveSelection(payload = activeSelectionPayload) {
  if (!payload?.selected_text) return;
  chrome.runtime.sendMessage({
    type: "context.capture.browser_attention",
    kind: "selected",
    payload: {
      ...payload,
      manual_save: true,
      saved_at: new Date().toISOString(),
    },
  }).then((result) => {
    showSelectionStatus(result?.ok === false ? "Save failed" : "Saved");
  }).catch(() => showSelectionStatus("Save failed"));
}

function showSelectionStatus(text: string) {
  if (!selectionToolbar) return;
  selectionToolbar.className = "is-status";
  selectionToolbar.textContent = text;
  const rect = selectionRect();
  if (rect) positionSelectionToolbar(rect);
}

function showSelectionAnswer(answer: string) {
  if (!selectionToolbar) return;
  selectionToolbar.className = "is-answer";
  selectionToolbar.textContent = "";
  selectionToolbar.setAttribute("role", "dialog");
  selectionToolbar.setAttribute("aria-modal", "true");
  selectionToolbar.setAttribute("aria-label", "Info explanation");
  const title = document.createElement("div");
  title.className = "info-selection-title";
  title.textContent = "Info explain";
  const body = document.createElement("div");
  body.className = "info-selection-body";
  body.textContent = answer;
  const actions = document.createElement("div");
  actions.className = "info-selection-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dismiss";
  close.setAttribute("aria-label", "Dismiss explanation");
  close.addEventListener("click", () => removeSelectionToolbar());
  actions.append(close);
  selectionToolbar.append(title, body, actions);
  const rect = selectionRect();
  if (rect) positionSelectionToolbar(rect);
}

function selectionRect() {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount || !String(selection).trim()) return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width || rect.height);
  return rects[rects.length - 1] || range.getBoundingClientRect();
}

function positionSelectionToolbar(rect: DOMRect) {
  if (!selectionToolbar) return;
  const toolbarRect = selectionToolbar.getBoundingClientRect();
  const width = Math.max(144, toolbarRect.width || 144);
  const height = Math.max(34, toolbarRect.height || 34);
  const top = Math.max(12, Math.min(window.innerHeight - height - 12, rect.bottom + 8));
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
  selectionToolbar.style.top = `${top + window.scrollY}px`;
  selectionToolbar.style.left = `${left + window.scrollX}px`;
}

function removeSelectionToolbar() {
  selectionToolbar?.remove();
  selectionToolbar = null;
  activeSelectionPayload = null;
}

const TOOLBAR_STYLE = `
  #info-selection-toolbar {
    position: absolute;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: min(360px, calc(100vw - 24px));
    border: 1px solid rgba(47, 47, 47, 0.16);
    border-radius: 8px;
    background: #fffffc;
    color: #2f2f2f;
    box-shadow: 0 12px 32px rgba(20, 20, 20, 0.14);
    padding: 6px;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #info-selection-toolbar.is-status {
    padding: 7px 10px;
    color: #6f6f6f;
    font-size: 12px;
  }
  #info-selection-toolbar.is-answer {
    display: block;
    width: 318px;
    padding: 10px;
  }
  #info-selection-toolbar button {
    height: 28px;
    border: 1px solid #d8d0c2;
    border-radius: 6px;
    background: #fffdfa;
    color: #2f2f2f;
    padding: 0 9px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #info-selection-toolbar button:focus {
    outline: 2px solid rgba(47, 47, 47, 0.35);
    outline-offset: 1px;
  }
  #info-selection-toolbar button:first-child {
    background: #2f2f2f;
    color: #fff;
    border-color: #2f2f2f;
  }
  #info-selection-toolbar button:first-child:focus {
    outline-color: rgba(255,255,255,0.5);
  }
  #info-selection-toolbar .info-selection-title {
    color: #6f6f6f;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0;
    margin-bottom: 5px;
  }
  #info-selection-toolbar .info-selection-body {
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    hyphens: auto;
  }
  #info-selection-toolbar .info-selection-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 9px;
  }
  #info-writing-assist {
    position: absolute;
    z-index: 2147483647;
    width: 318px;
    max-width: calc(100vw - 24px);
    color: #2f2f2f;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #info-writing-assist .info-writing-panel {
    border: 1px solid rgba(47, 47, 47, 0.16);
    border-radius: 8px;
    background: #fffffc;
    color: #2f2f2f;
    box-shadow: 0 12px 32px rgba(20, 20, 20, 0.14);
    padding: 10px;
    width: 318px;
    max-width: calc(100vw - 24px);
  }
  #info-writing-assist .info-writing-title {
    color: #6f6f6f;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0;
    margin-bottom: 5px;
  }
  #info-writing-assist .info-writing-body {
    max-height: 96px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    hyphens: auto;
    min-width: 0;
  }
  #info-writing-assist .info-writing-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 9px;
  }
  #info-writing-assist button {
    height: 28px;
    border: 1px solid #d8d0c2;
    border-radius: 6px;
    background: #fffdfa;
    color: #2f2f2f;
    padding: 0 9px;
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  #info-writing-assist button:focus {
    outline: 2px solid rgba(47, 47, 47, 0.35);
    outline-offset: 1px;
  }
  #info-writing-assist button:last-child {
    background: #2f2f2f;
    color: #fff;
    border-color: #2f2f2f;
  }
  #info-writing-assist button:last-child:focus {
    outline-color: rgba(255,255,255,0.5);
  }
`;
const style = document.createElement("style");
style.textContent = TOOLBAR_STYLE;
document.documentElement.append(style);

// ---------------------------------------------------------------------------
// Ambient: declarative Browser trigger signal
// ---------------------------------------------------------------------------
// The user's request: while they are reading or interacting with a page, we
// Cheap DOM/dwell signals stay in the content script. Once a local condition
// is reached, the background submits one strict event to the v1 Automation
// endpoint. Durable dedupe and Agent selection remain backend responsibilities.

const AMBIENT_DWELL_MS = 30_000;          // 30s dwell
const AMBIENT_SCROLL_THRESHOLD = 0.5;     // 50% scroll depth
const AMBIENT_SELECTION_MIN = 20;         // any 20+ char selection
const ambientNavigationId = crypto.randomUUID();
let ambientDwellTimer: number | undefined;
let ambientDwellFired = false;
let ambientSelectionFired = false;

function ambientShouldFireFromDwell(): boolean {
  return !ambientDwellFired
    && Date.now() - startedAt >= AMBIENT_DWELL_MS
    && maxScrollDepth >= AMBIENT_SCROLL_THRESHOLD
    && scrollEvents >= 3;
}

function ambientMaybeFireFromDwell(): void {
  if (ambientDwellFired) return;
  if (!ambientShouldFireFromDwell()) return;
  ambientDwellFired = true;
  void ambientFire("dwell", "Dwelled on page and scrolled past 50%");
}

function ambientMaybeFireFromSelection(text: string): void {
  if (ambientSelectionFired) return;
  if (ambientDwellFired) return; // dwell already won
  if (text.length < AMBIENT_SELECTION_MIN) return;
  ambientSelectionFired = true;
  void ambientFire("selection", `Significant selection (${text.length} chars)`);
}

async function ambientFire(reasonKind: "dwell" | "selection", reason: string): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "automation.browser.signal",
      event_id: crypto.randomUUID(),
      navigation_id: ambientNavigationId,
      reason_kind: reasonKind,
      reason,
      dwell_ms: Date.now() - startedAt,
      scroll_depth: Math.max(maxScrollDepth, scrollDepth()),
      scroll_events: scrollEvents,
      selection_count: selectionCount,
      dom: automationDomContext(),
    });
    if (!response?.ok) {
      console.error("[metaflow-ambient] Browser Automation rejected", response);
    }
  } catch (error) {
    console.error("[metaflow-ambient] Browser Automation submission failed", error);
  }
}

function ambientScheduleDwellCheck(): void {
  if (ambientDwellTimer) window.clearTimeout(ambientDwellTimer);
  // Poll every 5s once past the dwell threshold; cheap and predictable.
  ambientDwellTimer = window.setInterval(() => {
    if (ambientDwellFired) {
      if (ambientDwellTimer) window.clearInterval(ambientDwellTimer);
      return;
    }
    ambientMaybeFireFromDwell();
  }, 5_000);
}

// Wire the silent ambient trigger to existing page signals. The scroll and
// selectionchange listeners above already update the module-level counters
// (maxScrollDepth / scrollEvents / selectionCount); we just add a dedicated
// listener that turns those counters into a fire-and-forget ambient request.
document.addEventListener("selectionchange", () => {
  const text = String(window.getSelection?.() ?? "").trim();
  if (text.length >= AMBIENT_SELECTION_MIN) ambientMaybeFireFromSelection(text);
}, true);

window.addEventListener("scroll", () => {
  ambientMaybeFireFromDwell();
}, { passive: true });

ambientScheduleDwellCheck();

// ---------------------------------------------------------------------------
// YouTube comprehension gap capture (Stage 5)
// ---------------------------------------------------------------------------
// On youtube.com/watch we let the user press Shift+C to toggle the player's
// closed captions. We track how long captions stay on within a given window
// of the video; if a window accumulates above a threshold of caption-time
// while the user keeps pressing Shift+C, we emit a single
// observation.youtube.comprehension_gap record summarising the start/end
// timecodes and approximate transcript snippets. The language_learning
// program (Stage 7) picks those up and turns them into review queue items.

const YT_WATCH_PATH = "/watch";
const YT_GAP_KEY = "C";
const YT_GAP_FLUSH_AFTER_MS = 12_000;          // emit the gap after 12s of idle
const YT_GAP_MIN_TOTAL_MS = 5_000;              // ignore micro-gaps < 5s
const YT_SEND_DEBOUNCE_MS = 1_500;
const YT_RECENT_GAPS_KEY = "language.recent_caption_gaps";
const YT_RECENT_ACTIVE_WRITE_MS = 1_000;

type YtGap = {
  fragmentId: string;
  videoId: string;
  videoTitle: string;
  startTime: number;        // video seconds
  endTime: number;          // video seconds
  durationSeconds: number;
  videoDurationSeconds: number;
  captionOnMs: number;      // accumulated caption-on milliseconds
  toggles: number;          // how many times the user pressed Shift+C
  transcriptSamples: string[];
  captionSamples: Array<{
    text: string;
    start_seconds: number;
    end_seconds?: number;
    captured_at: string;
  }>;
  triggerReason: string;
  endedReason?: string;
  startedAt: string;        // ISO
  endedAt?: string;
};

let ytActive = false;
let ytPlayer: HTMLVideoElement | null = null;
let ytVideoId: string | null = null;
let ytVideoTitle: string | null = null;
let ytCurrentGap: YtGap | null = null;
let ytCaptionOn: boolean = false;
let ytVideoPaused: boolean = true;
let ytCaptionOnSince: number | null = null;
let ytFlushTimer: number | undefined;
let ytSendTimer: number | undefined;
let ytLastRecentWriteAt = 0;
let ytLastPlayedSentAt = 0;
let ytLastPausedSentAt = 0;

function ytIsWatchPage(): boolean {
  return (location.hostname === "youtube.com" || location.hostname.endsWith(".youtube.com"))
    && location.pathname === YT_WATCH_PATH;
}

function ytExtractVideoId(): string | null {
  try {
    return new URLSearchParams(location.search).get("v");
  } catch {
    return null;
  }
}

function ytExtractVideoTitle(): string {
  const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
    ?? document.querySelector("h1.title yt-formatted-string")
    ?? document.querySelector("meta[name=\"title\"]");
  if (titleEl instanceof HTMLMetaElement) return titleEl.content;
  if (titleEl) return (titleEl.textContent ?? "").trim();
  return document.title.replace(/ - YouTube$/, "");
}

function ytFindPlayer(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
}

function ytGetPlayerTime(): number {
  return ytPlayer?.currentTime ?? 0;
}

function ytGetVideoDuration(): number {
  const duration = ytPlayer?.duration;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : 0;
}

function ytIsPlayerPaused(): boolean {
  return !ytPlayer || ytPlayer.paused || ytPlayer.ended;
}

function ytIsCaptionsOn(): boolean {
  // The captions button carries aria-pressed when captions are active.
  const btn = document.querySelector<HTMLElement>(".ytp-subtitles-button");
  if (ytReadCaptionText()) return true;
  if (!btn) return false;
  const pressed = btn.getAttribute("aria-pressed");
  if (pressed === "true") return true;
  // Fall back to URL parameter; YouTube persists the user's choice in the cc lang prefs.
  const track = document.querySelector("video > track[kind=\"captions\"][default], video > track[kind=\"subtitles\"][default]");
  return Boolean(track);
}

function ytCleanCaptionText(text: string): string {
  return text
    .replace(/\b[A-Za-z-]+\s+\(auto-generated\)\s*Click for settings\b/gi, " ")
    .replace(/\b[A-Za-z-]+\s+\(auto-generated\)\b/gi, " ")
    .replace(/\bClick for settings\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ytCollapseIncrementalCaptionLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  for (const line of lines) {
    const text = ytCleanCaptionText(line);
    if (!text) continue;
    const existingLonger = collapsed.some(existing => ytIsCaptionPrefix(text, existing));
    if (existingLonger) continue;
    for (let index = collapsed.length - 1; index >= 0; index -= 1) {
      if (ytIsCaptionPrefix(collapsed[index], text)) collapsed.splice(index, 1);
    }
    collapsed.push(text);
  }
  return collapsed;
}

function ytIsCaptionPrefix(shorter: string, longer: string): boolean {
  return longer === shorter || (longer.startsWith(shorter) && /^[\s,.;:!?]/.test(longer.slice(shorter.length, shorter.length + 1)));
}

function ytReadCaptionText(): string | null {
  // YouTube often renders the visible caption as multiple segment nodes.
  // Prefer those leaf nodes; the broader fallback can include settings UI text.
  const leafSegments = Array.from(document.querySelectorAll<HTMLElement>(
    ".ytp-caption-window-container .ytp-caption-segment",
  ));
  const fallbackSegments = leafSegments.length
    ? []
    : Array.from(document.querySelectorAll<HTMLElement>(".caption-window .captions-text"));
  const segments = [...leafSegments, ...fallbackSegments]
    .map(slot => ytCleanCaptionText(slot.textContent ?? ""))
    .filter(Boolean);
  const joined = segments.join(" ").replace(/\s+/g, " ").trim();
  return joined || null;
}

function ytVideoUrlAt(seconds: number): string {
  const url = new URL(location.href);
  url.searchParams.set("t", `${Math.max(0, Math.floor(seconds))}s`);
  return url.toString();
}

function ytSubtitleText(gap: YtGap): string {
  const lines = gap.captionSamples
    .map(sample => sample.text)
    .filter(Boolean);
  return ytCollapseIncrementalCaptionLines(lines).join("\n");
}

function ytSendCanonicalObservation(schemaName: string, payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage({
    type: "youtube-observation",
    schemaName,
    payload: {
      video_id: ytVideoId,
      video_title: ytVideoTitle ?? ytExtractVideoTitle(),
      video_url: location.href,
      video_current_seconds: ytGetPlayerTime(),
      video_duration_seconds: ytGetVideoDuration(),
      observed_at: new Date().toISOString(),
      ...payload,
    },
  }).catch(error => {
    reportBrowserCaptureMessageFailure("youtube_observation", error, { schema_name: schemaName, video_id: ytVideoId });
  });
}

function ytStartFreshGap(): void {
  if (!ytVideoId) return;
  const startTime = ytGetPlayerTime();
  const startedAt = new Date().toISOString();
  ytCurrentGap = {
    fragmentId: `${ytVideoId}:${Math.round(startTime * 1000)}:${Date.now()}`,
    videoId: ytVideoId,
    videoTitle: ytVideoTitle ?? "",
    startTime,
    endTime: startTime,
    durationSeconds: 0,
    videoDurationSeconds: ytGetVideoDuration(),
    captionOnMs: 0,
    toggles: 0,
    transcriptSamples: [],
    captionSamples: [],
    triggerReason: "unknown",
    startedAt,
  };
}

function ytExtendGap(): void {
  if (!ytCurrentGap) return;
  const now = ytGetPlayerTime();
  if (now > ytCurrentGap.endTime) ytCurrentGap.endTime = now;
  ytCurrentGap.durationSeconds = Math.max(0, ytCurrentGap.endTime - ytCurrentGap.startTime);
  ytCurrentGap.videoDurationSeconds = ytGetVideoDuration();
  const sample = ytReadCaptionText();
  if (sample && !ytCurrentGap.transcriptSamples.includes(sample)) {
    ytCurrentGap.transcriptSamples.push(sample);
    if (ytCurrentGap.transcriptSamples.length > 6) ytCurrentGap.transcriptSamples.shift();
  }
  if (sample) {
    const last = ytCurrentGap.captionSamples[ytCurrentGap.captionSamples.length - 1];
    if (!last || last.text !== sample) {
      if (last && last.end_seconds === undefined) last.end_seconds = now;
      ytCurrentGap.captionSamples.push({
        text: sample,
        start_seconds: now,
        captured_at: new Date().toISOString(),
      });
      if (ytCurrentGap.captionSamples.length > 20) ytCurrentGap.captionSamples.shift();
    } else {
      last.end_seconds = now;
    }
  }
  if (ytCaptionOn && Date.now() - ytLastRecentWriteAt > YT_RECENT_ACTIVE_WRITE_MS) {
    ytLastRecentWriteAt = Date.now();
    void rememberCurrentCaptionGap("active");
  }
}

function ytStartCaptionFragment(reason: "keyboard" | "button" | "poll" | "play"): void {
  if (!ytVideoId) return;
  ytStartFreshGap();
  ytCaptionOnSince = Date.now();
  if (ytCurrentGap) ytCurrentGap.triggerReason = reason;
  if (ytCurrentGap) ytCurrentGap.toggles += reason === "poll" || reason === "play" ? 0 : 1;
  ytLastRecentWriteAt = 0;
  void rememberCurrentCaptionGap("active");
}

function ytScheduleFlush(): void {
  if (ytFlushTimer) window.clearTimeout(ytFlushTimer);
  ytFlushTimer = window.setTimeout(() => {
    if (ytCurrentGap && ytCurrentGap.captionOnMs >= YT_GAP_MIN_TOTAL_MS) {
      ytFlushGap();
    } else {
      ytCurrentGap = null;
    }
  }, YT_GAP_FLUSH_AFTER_MS);
}

function ytFlushGap(): void {
  const gap = ytCurrentGap;
  ytCurrentGap = null;
  ytSendGap(gap);
}

function ytSendGap(gap: YtGap | null): void {
  if (!gap || gap.captionOnMs < YT_GAP_MIN_TOTAL_MS) return;
  // Debounce the actual send so a flurry of toggles coalesces into one record.
  if (ytSendTimer) window.clearTimeout(ytSendTimer);
  ytSendTimer = window.setTimeout(() => {
    const payload = {
      fragment_id: gap.fragmentId,
      video_id: gap.videoId,
      video_title: gap.videoTitle,
      video_url: location.href,
      fragment_url: ytVideoUrlAt(gap.startTime),
      start_seconds: gap.startTime,
      end_seconds: gap.endTime,
      duration_seconds: Math.max(0, gap.endTime - gap.startTime),
      video_current_seconds: ytGetPlayerTime(),
      video_duration_seconds: gap.videoDurationSeconds || ytGetVideoDuration(),
      caption_on_ms: gap.captionOnMs,
      toggles: gap.toggles,
      transcript_samples: gap.transcriptSamples,
      caption_samples: gap.captionSamples,
      subtitle_text: ytSubtitleText(gap),
      trigger_reason: gap.triggerReason,
      ended_reason: gap.endedReason,
      caption_state: ytCaptionOn ? "on" : "off",
      playback_state: ytIsPlayerPaused() ? "paused" : "playing",
      fragment_started_at: gap.startedAt,
      fragment_ended_at: gap.endedAt,
      observed_at: gap.startedAt,
    };
    ytSendCanonicalObservation("observation.youtube.caption_fragment", {
      ...payload,
      caption_text: payload.subtitle_text,
      caption_lang: document.documentElement.lang || undefined,
      observed_at: payload.fragment_ended_at || payload.observed_at,
    });
    void rememberRecentCaptionGap(payload, "sent");
    void chrome.runtime.sendMessage({
      type: "youtube-comprehension-gap",
      gap: payload,
    }).catch(error => {
      reportBrowserCaptureMessageFailure("youtube_comprehension_gap", error, { video_id: ytVideoId });
    });
  }, YT_SEND_DEBOUNCE_MS);
}

function ytFinishCaptionFragment(reason: "caption_off" | "pause" | "navigation" | "idle" = "caption_off"): void {
  if (!ytCurrentGap) {
    ytCaptionOnSince = null;
    return;
  }
  if (ytCaptionOnSince) {
    ytCurrentGap.captionOnMs += Date.now() - ytCaptionOnSince;
    ytCaptionOnSince = null;
  }
  const sample = ytReadCaptionText();
  if (sample && !ytCurrentGap.transcriptSamples.includes(sample)) {
    ytCurrentGap.transcriptSamples.push(sample);
    if (ytCurrentGap.transcriptSamples.length > 6) ytCurrentGap.transcriptSamples.shift();
  }
  ytCurrentGap.endTime = Math.max(ytCurrentGap.endTime, ytGetPlayerTime());
  ytCurrentGap.durationSeconds = Math.max(0, ytCurrentGap.endTime - ytCurrentGap.startTime);
  ytCurrentGap.videoDurationSeconds = ytGetVideoDuration();
  ytCurrentGap.endedReason = reason;
  ytCurrentGap.endedAt = new Date().toISOString();
  if (sample) {
    const last = ytCurrentGap.captionSamples[ytCurrentGap.captionSamples.length - 1];
    if (!last || last.text !== sample) {
      if (last && last.end_seconds === undefined) last.end_seconds = ytGetPlayerTime();
      ytCurrentGap.captionSamples.push({
        text: sample,
        start_seconds: ytGetPlayerTime(),
        captured_at: ytCurrentGap.endedAt,
      });
    } else {
      last.end_seconds = ytGetPlayerTime();
    }
  }
  void rememberCurrentCaptionGap("sent");
  const gap = ytCurrentGap;
  ytCurrentGap = null;
  ytSendGap(gap);
}

async function rememberCurrentCaptionGap(status: "active" | "sent"): Promise<void> {
  if (!ytCurrentGap) return;
  const activeDelta = ytCaptionOnSince ? Date.now() - ytCaptionOnSince : 0;
  await rememberRecentCaptionGap({
    fragment_id: ytCurrentGap.fragmentId,
    video_id: ytCurrentGap.videoId,
    video_title: ytCurrentGap.videoTitle,
    video_url: location.href,
    fragment_url: ytVideoUrlAt(ytCurrentGap.startTime),
    start_seconds: ytCurrentGap.startTime,
    end_seconds: ytCurrentGap.endTime,
    duration_seconds: Math.max(0, ytCurrentGap.endTime - ytCurrentGap.startTime),
    video_current_seconds: ytGetPlayerTime(),
    video_duration_seconds: ytCurrentGap.videoDurationSeconds || ytGetVideoDuration(),
    caption_on_ms: ytCurrentGap.captionOnMs + activeDelta,
    toggles: ytCurrentGap.toggles,
    transcript_samples: ytCurrentGap.transcriptSamples,
    caption_samples: ytCurrentGap.captionSamples,
    subtitle_text: ytSubtitleText(ytCurrentGap),
    current_caption: ytReadCaptionText(),
    trigger_reason: ytCurrentGap.triggerReason,
    ended_reason: ytCurrentGap.endedReason,
    caption_state: ytCaptionOn ? "on" : "off",
    playback_state: ytIsPlayerPaused() ? "paused" : "playing",
    fragment_started_at: ytCurrentGap.startedAt,
    fragment_ended_at: ytCurrentGap.endedAt,
    observed_at: ytCurrentGap.startedAt,
  }, status);
}

async function rememberRecentCaptionGap(gap: any, status: "active" | "sent"): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: "language.caption_gap.recent",
      storage_key: YT_RECENT_GAPS_KEY,
      gap,
      status,
    });
  } catch {
    // Recent segments are best-effort UI state; the server observation remains the source of truth.
  }
}

function ytApplyCaptionState(nextOn: boolean, reason: "keyboard" | "button" | "poll"): void {
  if (nextOn === ytCaptionOn) return;
  ytCaptionOn = nextOn;
  ytSendCanonicalObservation("observation.youtube.caption_state", {
    enabled: ytCaptionOn,
    captions_enabled: ytCaptionOn,
    current_time: ytGetPlayerTime(),
    trigger_reason: reason,
    caption_text: ytReadCaptionText(),
  });
  if (ytCaptionOn) {
    if (!ytIsPlayerPaused()) ytStartCaptionFragment(reason);
  } else {
    ytFinishCaptionFragment("caption_off");
  }
}

function ytApplyPlaybackState(): void {
  const paused = ytIsPlayerPaused();
  if (paused === ytVideoPaused) return;
  ytVideoPaused = paused;
  const now = Date.now();
  if (paused && now - ytLastPausedSentAt > 500) {
    ytLastPausedSentAt = now;
    ytSendCanonicalObservation("observation.youtube.paused", {
      current_time: ytGetPlayerTime(),
      caption_text: ytReadCaptionText(),
      captions_enabled: ytCaptionOn,
      is_difficult: ytCaptionOn,
      difficulty_reason: ytCaptionOn ? "paused while captions were enabled" : undefined,
    });
  } else if (!paused && now - ytLastPlayedSentAt > 500) {
    ytLastPlayedSentAt = now;
    ytSendCanonicalObservation("observation.youtube.played", {
      current_time: ytGetPlayerTime(),
      caption_text: ytReadCaptionText(),
      captions_enabled: ytCaptionOn,
    });
  }
  if (!ytCaptionOn) return;
  if (paused) {
    ytFinishCaptionFragment("pause");
  } else {
    ytStartCaptionFragment("play");
  }
}

function ytIsEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input,textarea,[contenteditable='true'],[contenteditable='plaintext-only']"));
}

function ytBind(): void {
  if (!ytIsWatchPage()) return;
  if (ytActive) return;
  ytActive = true;
  ytPlayer = ytFindPlayer();
  ytVideoId = ytExtractVideoId();
  ytVideoTitle = ytExtractVideoTitle();
  ytVideoPaused = ytIsPlayerPaused();

  // Periodically extend the current gap and read captions.
  window.setInterval(() => {
    if (!ytActive) return;
    if (!ytPlayer) ytPlayer = ytFindPlayer();
    if (!ytVideoId) ytVideoId = ytExtractVideoId();
    if (!ytVideoTitle) ytVideoTitle = ytExtractVideoTitle();
    ytApplyCaptionState(ytIsCaptionsOn(), "poll");
    ytApplyPlaybackState();
    if (ytCaptionOn && !ytIsPlayerPaused()) {
      ytExtendGap();
    }
  }, 750);

  document.addEventListener("keydown", (event) => {
    if (!ytActive) return;
    if ((event.key === "C" || event.key === "c") && !event.altKey && !event.metaKey && !event.ctrlKey && !ytIsEditableTarget(event.target)) {
      // Plain C is YouTube's native subtitle shortcut. Shift+C is our
      // explicit alternate shortcut, so synthesize the same CC button click.
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        document.querySelector<HTMLElement>(".ytp-subtitles-button")?.click();
      }
      window.setTimeout(() => ytApplyCaptionState(ytIsCaptionsOn(), "keyboard"), 120);
    }
  }, true);

  document.addEventListener("click", (event) => {
    if (!ytActive) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".ytp-subtitles-button")) return;
    window.setTimeout(() => ytApplyCaptionState(ytIsCaptionsOn(), "button"), 120);
  }, true);

  window.addEventListener("pagehide", () => {
    if (ytCurrentGap) ytFinishCaptionFragment("navigation");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && ytCurrentGap) {
      ytFinishCaptionFragment("idle");
    }
  });

  // SPA navigation: re-bind when the URL changes to a new /watch?v=...
  let lastHref = location.href;
  window.setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (ytCurrentGap) ytFinishCaptionFragment("navigation");
    if (ytIsWatchPage()) {
      ytFlushGap();
      ytVideoId = ytExtractVideoId();
      ytVideoTitle = ytExtractVideoTitle();
      ytCurrentGap = null;
      ytCaptionOn = false;
      ytVideoPaused = ytIsPlayerPaused();
      ytCaptionOnSince = null;
    } else {
      ytActive = false;
      ytPlayer = null;
      ytVideoId = null;
      ytVideoTitle = null;
      ytCurrentGap = null;
      ytCaptionOn = false;
      ytCaptionOnSince = null;
    }
  }, 1_000);
}

ytBind();
window.setInterval(() => {
  if (!ytActive && ytIsWatchPage()) ytBind();
}, 1_000);

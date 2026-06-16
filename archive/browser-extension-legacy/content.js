let maxScrollDepth = 0;
let scrollEvents = 0;
let selectionCount = 0;
let lastSelectedText = "";
let selectionTimer = null;
let selectionToolbar = null;
let activeSelectionPayload = null;
let selectionRequestSeq = 0;
let writingTimer = null;
let lastWritingText = "";
let activeWritingElement = null;
let assistBubble = null;
let assistElement = null;
let pendingInsertedDraftEdit = null;
let insertedDraftEditTimer = null;
let writingRequestSeq = 0;
const startedAt = Date.now();
const WRITING_VIEW_TYPES = ["draft.writing_continuation", "advice.writing_assist"];
const WRITING_ASSIST_POLL_ATTEMPTS = 45;
const WRITING_ASSIST_POLL_INTERVAL_MS = 2000;
const DEFAULT_SELECTION_ACTIONS = [
  {
    id: "explain",
    label: "Explain",
    prompt: "Explain this selected text in plain language. Keep it concise, and mention the page context if it matters.",
  },
  {
    id: "translate_zh",
    label: "Translate",
    prompt: "Translate this selected text into natural Simplified Chinese. Preserve names, technical terms, and the original meaning.",
  },
];

function visibleText() {
  const clone = document.body?.cloneNode(true);
  if (!clone) return "";
  clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,footer").forEach((el) => el.remove());
  return clone.textContent.replace(/\s+/g, " ").trim().slice(0, 120_000);
}


function textQuality(text) {
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
  const pick = (selector, attr = "content") => document.querySelector(selector)?.getAttribute(attr) || undefined;
  return {
    description: pick('meta[name="description"]'),
    og_title: pick('meta[property="og:title"]'),
    og_description: pick('meta[property="og:description"]'),
    canonical_url: document.querySelector('link[rel="canonical"]')?.href || undefined,
    lang: document.documentElement.lang || undefined,
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
  if (!selectedText) return undefined;
  const range = selection.rangeCount ? selection.getRangeAt(0) : undefined;
  const node = range?.commonAncestorContainer;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const rect = range?.getBoundingClientRect?.();
  const surroundingText = element?.innerText?.replace(/\s+/g, " ").trim().slice(0, 2000);
  return {
    kind,
    selected_text: selectedText,
    surrounding_text: surroundingText,
    selection_length: selectedText.length,
    tag: element?.tagName,
    url: location.href,
    title: document.title,
    domain: location.hostname,
    canonical_url: document.querySelector('link[rel="canonical"]')?.href || location.href,
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
  return {
    title: document.title,
    url: location.href,
    domain: location.hostname,
    text: visibleText(),
    selected_text: selected,
    scroll_depth: maxScrollDepth,
    scroll_events: scrollEvents,
    selection_count: selectionCount,
    page_active_seconds: Math.round((Date.now() - startedAt) / 1000),
    observed_at: new Date().toISOString(),
    metadata: metadata(),
    text_quality: textQuality(visibleText()),
    search: searchQueryInfo(),
  };
}

function sendAttention(kind) {
  const payload = selectionContext(kind);
  if (!payload || payload.selected_text.length < 3) return;
  chrome.runtime.sendMessage({ type: "context.capture.browser_attention", kind, payload }).catch(() => undefined);
}

function handleStableSelection() {
  const payload = selectionContext("selected");
  if (!payload || payload.selected_text.length < 3) {
    removeSelectionToolbar();
    return;
  }
  activeSelectionPayload = payload;
  showSelectionToolbar(payload);
  chrome.runtime.sendMessage({ type: "context.capture.browser_attention", kind: "selected", payload }).catch(() => undefined);
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
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => handleStableSelection(), 650);
});

document.addEventListener("copy", () => {
  setTimeout(() => sendAttention("copied"), 0);
});

document.addEventListener("mousedown", (event) => {
  if (selectionToolbar?.contains(event.target)) return;
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

function queueWritingInput(target) {
  attachWritingWidget(target);
  const fullText = editableText(target);
  const text = focusedWritingText(target, fullText);
  observeInsertedDraftEdit(target, text);
  if (!shouldSendWritingText(text, target)) return;
  clearTimeout(writingTimer);
  writingTimer = setTimeout(() => sendWritingInput(target, text, fullText), 900);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect-page-context") {
    sendResponse(collectPageContext());
    return true;
  }
});

function editableElement(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  if (!element) return undefined;
  const editable = element.closest("textarea,input,[contenteditable='true'],[contenteditable='plaintext-only']");
  if (!editable) return undefined;
  if (editable instanceof HTMLInputElement) {
    const type = (editable.type || "text").toLowerCase();
    if (!["text", "search", "url", "email", "tel"].includes(type)) return undefined;
  }
  return editable;
}

function attachWritingWidget(element) {
  if (sensitiveEditable(element)) return;
  activeWritingElement = element;
  if (!assistBubble || assistElement !== element) {
    showWritingIdle(element);
    return;
  }
  positionAssistBubble(element);
}

function editableText(element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  return element.textContent || "";
}

function focusedWritingText(element, fullText) {
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

function editableBlockText(node, root) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const block = element?.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,[data-block-id],[data-page-id],[role='textbox'],div");
  if (block && root.contains(block)) return block.textContent || "";
  return element && root.contains(element) ? element.textContent || "" : "";
}

function textAroundOffset(text, offset, max) {
  const half = Math.floor(max / 2);
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, offset + half);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function shouldSendWritingText(text, element) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 24 || normalized.length > 5000) return false;
  if (normalized === lastWritingText) return false;
  if (element instanceof HTMLInputElement && normalized.length < 40) return false;
  if (sensitiveEditable(element)) return false;
  lastWritingText = normalized;
  return true;
}

function sensitiveEditable(element) {
  return /password|token|secret|api[_-]?key|credit card|验证码|密码/i.test(`${element.id || ""} ${element.getAttribute("name") || ""} ${element.getAttribute("autocomplete") || ""}`);
}

function sendWritingInput(element, text, fullText = text) {
  const rect = element.getBoundingClientRect();
  const requestSeq = ++writingRequestSeq;
  showWritingPending(element, requestSeq);
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
      changed_at: new Date().toISOString(),
      metadata: metadata(),
      text_quality: textQuality(text),
    },
  }).then(async (result) => {
    if (showWritingAssist(result, element)) return;
    await pollWritingAssist(element, text, result, requestSeq);
  }).catch(() => {
    showWritingError(element, requestSeq, "Could not reach writing assist.");
  });
}

function showWritingPending(element, requestSeq) {
  removeAssistBubble();
  assistElement = element;
  assistBubble = document.createElement("div");
  assistBubble.id = "info-writing-assist";
  assistBubble.className = "is-collapsed is-pending";
  assistBubble.dataset.requestSeq = String(requestSeq);
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "info-writing-trigger";
  trigger.title = "Writing suggestion is generating";
  trigger.textContent = "Info...";
  assistBubble.append(trigger);
  document.documentElement.append(assistBubble);
  positionAssistBubble(element);
}

function showWritingIdle(element) {
  removeAssistBubble();
  assistElement = element;
  assistBubble = document.createElement("div");
  assistBubble.id = "info-writing-assist";
  assistBubble.className = "is-collapsed is-idle";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "info-writing-trigger";
  trigger.title = "Writing assist is ready";
  trigger.textContent = "Info";
  assistBubble.append(trigger);
  document.documentElement.append(assistBubble);
  positionAssistBubble(element);
}

function showWritingError(element, requestSeq, message) {
  if (assistBubble?.dataset.requestSeq && assistBubble.dataset.requestSeq !== String(requestSeq)) return;
  removeAssistBubble();
  assistElement = element;
  assistBubble = document.createElement("div");
  assistBubble.id = "info-writing-assist";
  assistBubble.className = "is-collapsed is-error";
  assistBubble.dataset.requestSeq = String(requestSeq);
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "info-writing-trigger";
  trigger.title = "Writing suggestion failed";
  trigger.textContent = "Info!";
  const panel = document.createElement("div");
  panel.className = "info-writing-panel";
  const title = document.createElement("div");
  title.className = "info-writing-title";
  title.textContent = "Info writing";
  const body = document.createElement("div");
  body.className = "info-writing-body";
  body.textContent = message;
  const actions = document.createElement("div");
  actions.className = "info-writing-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dismiss";
  close.addEventListener("click", () => removeAssistBubble());
  actions.append(close);
  panel.append(title, body, actions);
  assistBubble.append(trigger, panel);
  document.documentElement.append(assistBubble);
  trigger.addEventListener("click", () => {
    assistBubble?.classList.toggle("is-collapsed");
    positionAssistBubble(element);
  });
  positionAssistBubble(element);
}

function removePendingAssist(requestSeq) {
  if (assistBubble?.classList.contains("is-pending") && assistBubble.dataset.requestSeq === String(requestSeq)) {
    if (activeWritingElement?.isConnected) showWritingIdle(activeWritingElement);
    else removeAssistBubble();
  }
}

function showWritingAssist(result, element) {
  const view = writingViewFromResult(result);
  const draft = draftTextFromView(view);
  const suggestions = suggestionsFromView(view);
  if (!view || (!draft && !suggestions.length)) return false;
  removeAssistBubble();
  assistElement = element;
  assistBubble = document.createElement("div");
  assistBubble.id = "info-writing-assist";
  assistBubble.className = "is-collapsed";
  assistBubble.innerHTML = "";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "info-writing-trigger";
  trigger.title = "Show writing suggestion";
  trigger.textContent = view.view_type === "draft.writing_continuation" ? "Info draft" : "Info";
  const title = document.createElement("div");
  title.className = "info-writing-title";
  title.textContent = view.view_type === "draft.writing_continuation" ? "Info draft" : "Info writing";
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
      payload: {
        action: "dismiss",
        surface: "writing_inline",
        draft_text: draft || undefined,
        suggestion_count: suggestions.length,
      },
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
        payload: {
          action: "insert",
          surface: "writing_inline",
          draft_text: draft,
          original_text: beforeText,
          edited_text: afterText,
        },
      });
      removeAssistBubble();
    });
    actions.append(insert);
  }
  panel.append(title, body, actions);
  assistBubble.append(trigger, panel);
  document.documentElement.append(assistBubble);
  trigger.addEventListener("click", () => {
    assistBubble?.classList.toggle("is-collapsed");
    positionAssistBubble(element);
  });
  assistBubble.addEventListener("mouseenter", () => {
    assistBubble?.classList.remove("is-collapsed");
    positionAssistBubble(element);
  });
  positionAssistBubble(element);
  return true;
}

async function pollWritingAssist(element, text, result, requestSeq) {
  const sourceRecordId = result?.record_id;
  if (!sourceRecordId) {
    showWritingError(element, requestSeq, result?.error || result?.posted?.body?.error || "Writing assist did not return a request id.");
    return;
  }
  for (let attempt = 0; attempt < WRITING_ASSIST_POLL_ATTEMPTS; attempt += 1) {
    await delay(attempt === 0 ? 900 : WRITING_ASSIST_POLL_INTERVAL_MS);
    const currentText = focusedWritingText(element, editableText(element));
    if (requestSeq !== writingRequestSeq || !element.isConnected || normalizeWriting(currentText) !== normalizeWriting(text)) {
      removePendingAssist(requestSeq);
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
  showWritingError(element, requestSeq, "Writing assist timed out.");
}

function writingViewFromResult(result) {
  const views = Array.isArray(result?.views) ? result.views.map(item => item?.view ?? item).filter(Boolean) : [];
  return views.find(view => view.view_type === "draft.writing_continuation")
    || views.find(view => view.view_type === "advice.writing_assist");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function draftTextFromView(view) {
  const value = view?.content?.draft_text || view?.summary;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function suggestionsFromView(view) {
  const value = view?.content?.suggestions;
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()) : [];
}

function submitWritingFeedback(view, input) {
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
  }).catch(() => undefined);
}

function rememberInsertedDraftForEdit(element, view, draft, beforeText, afterText) {
  if (!view?.id || !draft || sensitiveEditable(element)) return;
  clearTimeout(insertedDraftEditTimer);
  pendingInsertedDraftEdit = {
    element,
    view,
    draft,
    beforeText,
    insertedText: afterText,
    lastText: afterText,
    createdAt: Date.now(),
    sent: false,
  };
}

function observeInsertedDraftEdit(element, text) {
  const pending = pendingInsertedDraftEdit;
  if (!pending || pending.sent || pending.element !== element) return;
  if (Date.now() - pending.createdAt > 120_000 || sensitiveEditable(element)) {
    clearPendingInsertedDraftEdit();
    return;
  }
  if (normalizeWriting(text) === normalizeWriting(pending.insertedText)) return;
  pending.lastText = text;
  clearTimeout(insertedDraftEditTimer);
  insertedDraftEditTimer = setTimeout(() => flushInsertedDraftEditFeedback(), 1800);
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
  insertedDraftEditTimer = null;
  pendingInsertedDraftEdit = null;
}

function normalizeWriting(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function insertDraft(element, draft) {
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
  element.focus();
  document.execCommand("insertText", false, `${editableText(element).trim() ? " " : ""}${draft}`);
}

function positionAssistBubble(element) {
  if (!assistBubble) return;
  const rect = editablePositionRect(element);
  const bubbleRect = assistBubble.getBoundingClientRect();
  const collapsed = assistBubble.classList.contains("is-collapsed");
  const width = collapsed ? Math.max(92, bubbleRect.width || 92) : Math.max(318, bubbleRect.width || 318);
  const height = collapsed ? Math.max(32, bubbleRect.height || 32) : Math.max(128, bubbleRect.height || 128);
  const collapsedLeft = rect.right + 8;
  const panelLeft = Math.min(rect.left, rect.right - width);
  const top = Math.max(12, Math.min(window.innerHeight - height - 12, rect.bottom + 8));
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, collapsed ? collapsedLeft : panelLeft));
  assistBubble.style.top = `${top + window.scrollY}px`;
  assistBubble.style.left = `${left + window.scrollX}px`;
}

function removeAssistBubble() {
  assistBubble?.remove();
  assistBubble = null;
  assistElement = null;
}

function editablePositionRect(element) {
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement)) {
    const selection = window.getSelection?.();
    const anchor = selection?.anchorNode;
    const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    if (selection?.rangeCount && anchorElement && element.contains(anchorElement)) {
      const range = selection.getRangeAt(0).cloneRange();
      const rects = Array.from(range.getClientRects());
      const rect = rects[rects.length - 1] || range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    }
  }
  return element.getBoundingClientRect();
}

async function selectionActions() {
  try {
    const stored = await chrome.storage?.local?.get?.("selectionActions");
    const custom = Array.isArray(stored?.selectionActions) ? stored.selectionActions : [];
    const normalized = custom
      .filter((action) => action && action.enabled !== false && action.id && action.label && action.prompt)
      .map((action) => ({
        id: String(action.id),
        label: String(action.label).slice(0, 24),
        prompt: String(action.prompt),
      }));
    return normalized.length ? normalized : DEFAULT_SELECTION_ACTIONS;
  } catch {
    return DEFAULT_SELECTION_ACTIONS;
  }
}

function showSelectionToolbar(payload) {
  removeSelectionToolbar();
  const rect = selectionRect();
  if (!rect) return;
  selectionToolbar = document.createElement("div");
  selectionToolbar.id = "info-selection-toolbar";
  selectionToolbar.className = "is-ready";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.addEventListener("click", () => saveSelection(payload));
  document.documentElement.append(selectionToolbar);
  selectionActions().then((actions) => {
    if (!selectionToolbar || activeSelectionPayload !== payload) return;
    selectionToolbar.textContent = "";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => runSelectionAction(action, payload));
      selectionToolbar.append(button);
    }
    selectionToolbar.append(save);
    positionSelectionToolbar(rect);
  });
  positionSelectionToolbar(rect);
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

function runSelectionAction(action, payload = activeSelectionPayload) {
  if (!payload?.selected_text) return;
  const requestSeq = ++selectionRequestSeq;
  showSelectionStatus("Opening Chat...");
  chrome.runtime.sendMessage({
    type: "sidepanel.run.selection_action",
    action,
    payload,
  }).then((result) => {
    if (requestSeq !== selectionRequestSeq) return;
    if (!result?.ok) {
      showSelectionStatus(result?.error || "Explain failed");
      return;
    }
    showSelectionStatus("Sent to Chat");
    setTimeout(() => {
      if (requestSeq === selectionRequestSeq) removeSelectionToolbar();
    }, 1200);
  }).catch(() => {
    if (requestSeq === selectionRequestSeq) showSelectionStatus("Explain failed");
  });
}

function showSelectionStatus(text) {
  if (!selectionToolbar) return;
  selectionToolbar.className = "is-status";
  selectionToolbar.textContent = text;
  const rect = selectionRect();
  if (rect) positionSelectionToolbar(rect);
}

function showSelectionAnswer(answer) {
  if (!selectionToolbar) return;
  selectionToolbar.className = "is-answer";
  selectionToolbar.textContent = "";
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

function positionSelectionToolbar(rect) {
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

const style = document.createElement("style");
style.textContent = `
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
  }
  #info-selection-toolbar button:first-child {
    background: #2f2f2f;
    color: #fff;
    border-color: #2f2f2f;
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
  #info-writing-assist.is-collapsed {
    width: auto;
  }
  #info-writing-assist .info-writing-trigger {
    display: none;
    height: 30px;
    border: 1px solid rgba(47, 47, 47, 0.2);
    border-radius: 999px;
    background: #2f2f2f;
    color: #fff;
    box-shadow: 0 8px 24px rgba(20, 20, 20, 0.14);
    padding: 0 10px;
    font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
    user-select: none;
  }
  #info-writing-assist.is-idle .info-writing-trigger {
    background: #ffffff;
    color: #2f2f2f;
  }
  #info-writing-assist.is-pending .info-writing-trigger {
    opacity: .74;
  }
  #info-writing-assist.is-error .info-writing-trigger {
    background: #ffffff;
    color: #8a1f17;
    border-color: rgba(138, 31, 23, .34);
  }
  #info-writing-assist.is-collapsed .info-writing-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  #info-writing-assist .info-writing-panel {
    border: 1px solid rgba(47, 47, 47, 0.16);
    border-radius: 8px;
    background: #fffffc;
    color: #2f2f2f;
    box-shadow: 0 12px 32px rgba(20, 20, 20, 0.14);
    padding: 10px;
  }
  #info-writing-assist.is-collapsed .info-writing-panel {
    display: none;
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
  }
  #info-writing-assist button:last-child {
    background: #2f2f2f;
    color: #fff;
    border-color: #2f2f2f;
  }
`;
document.documentElement.append(style);

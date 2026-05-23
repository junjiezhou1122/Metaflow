let maxScrollDepth = 0;
let scrollEvents = 0;
let selectionCount = 0;
let lastSelectedText = "";
let selectionTimer = null;
const startedAt = Date.now();

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
  selectionTimer = setTimeout(() => sendAttention("selected"), 650);
});

document.addEventListener("copy", () => {
  setTimeout(() => sendAttention("copied"), 0);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect-page-context") {
    sendResponse(collectPageContext());
    return true;
  }
});

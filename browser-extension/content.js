let maxScrollDepth = 0;
let scrollEvents = 0;
let selectionCount = 0;
let lastSelectedText = "";
const startedAt = Date.now();

function visibleText() {
  const clone = document.body?.cloneNode(true);
  if (!clone) return "";
  clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,footer").forEach((el) => el.remove());
  return clone.textContent.replace(/\s+/g, " ").trim().slice(0, 120_000);
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
  };
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
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect-page-context") {
    sendResponse(collectPageContext());
    return true;
  }
});

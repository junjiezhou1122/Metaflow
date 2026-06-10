// Build a short text block describing the active tab so the agent can
// answer "what is on this page" without first calling browser_tabs.
//
// Strategy:
//   1. chrome.tabs.query for the active tab in the current window.
//   2. Try to extract a short text excerpt by injecting a content script
//      that returns the visible text. Fall back to just url+title if the
//      content script is unavailable (e.g. chrome:// pages, the extension
//      store, PDFs).
//
// The returned string is plain text formatted like:
//
//   Current browser tab:
//   URL: https://example.com/post/123
//   Title: ...
//   Excerpt: <first ~2000 chars of visible text>
//
// It is intended to be prepended to the user's prompt before being sent
// to the ACP agent. Always returns a non-empty string when there is an
// active tab; returns null if the call cannot find a tab.

const MAX_EXCERPT_CHARS = 2000;
const MAX_TITLE_CHARS = 240;
const MAX_URL_CHARS = 2000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ?? null;
  } catch (error) {
    console.warn("[active-tab-context] chrome.tabs.query failed:", error);
    return null;
  }
}

async function readTabText(tabId: number): Promise<string | null> {
  if (!chrome.scripting?.executeScript) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Mirror the extraction that the existing content script does.
        const clone = document.body?.cloneNode(true);
        if (!clone) return "";
        clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,footer").forEach((el) => el.remove());
        return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      },
    });
    const first = results?.[0]?.result;
    return typeof first === "string" ? first : null;
  } catch (error) {
    // Restricted pages (chrome://, the web store, file://) throw.
    console.debug("[active-tab-context] executeScript skipped:", (error as Error).message);
    return null;
  }
}

export async function buildActiveTabContext(): Promise<string | null> {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !tab.url) return null;

  const url = truncate(tab.url, MAX_URL_CHARS);
  const title = tab.title ? truncate(tab.title, MAX_TITLE_CHARS) : "(untitled)";
  const excerptRaw = await readTabText(tab.id);
  const excerpt = excerptRaw ? truncate(excerptRaw, MAX_EXCERPT_CHARS) : null;

  const lines = [
    "Current browser tab (auto-injected by the chrome-acp side panel):",
    `URL: ${url}`,
    `Title: ${title}`,
  ];
  if (excerpt) lines.push(`Excerpt: ${excerpt}`);
  return lines.join("\n");
}

import type { ContextRecord, StoredContextRecord } from "./types.js";
import type { ContextStore } from "./store.js";

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_READER_TEXT = 250_000;

const BLOCKED_PROTOCOLS = new Set(["chrome:", "chrome-extension:", "edge:", "about:", "file:", "data:", "blob:"]);
const PRIVATE_HOST_RE = /(gmail|mail|icloud|bank|paypal|stripe|checkout|1password|bitwarden|lastpass|login|account)/i;
const PRIVATE_PATH_RE = /(login|signin|account|checkout|payment|password|token|secret|oauth|auth)/i;

export function shouldReaderEnrich(record: ContextRecord): { ok: boolean; reason?: string } {
  const url = record.content?.url;
  if (!url) return { ok: false, reason: "missing url" };
  if (record.privacy?.retention === "do_not_store") return { ok: false, reason: "do_not_store" };
  if (record.privacy?.level === "secret") return { ok: false, reason: "secret privacy" };
  if (record.payload?.reader_enrichment === false) return { ok: false, reason: "reader_enrichment disabled" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) return { ok: false, reason: `blocked protocol ${parsed.protocol}` };
  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  if (PRIVATE_HOST_RE.test(parsed.hostname) || PRIVATE_PATH_RE.test(parsed.pathname)) return { ok: false, reason: "privacy url pattern" };
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname.endsWith(".local")) {
    return { ok: false, reason: "local/private host" };
  }
  return { ok: true };
}

export async function enrichWithJinaReader(store: ContextStore, parent: StoredContextRecord): Promise<StoredContextRecord | undefined> {
  const gate = shouldReaderEnrich(parent);
  if (!gate.ok) return undefined;

  const targetUrl = parent.content?.url;
  if (!targetUrl) return undefined;
  const readerUrl = `https://r.jina.ai/${targetUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(readerUrl, {
      signal: controller.signal,
      headers: {
        "Accept": "text/plain, text/markdown;q=0.9, */*;q=0.1",
        "User-Agent": "personal-context-layer/0.0.1",
      },
    });
    const text = await response.text();
    const ok = response.ok && text.trim().length > 0;
    const record = store.insertRecord({
      schema: { name: "derived.reader_snapshot", version: 1 },
      source: { type: "reader", connector: "jina" },
      scope: parent.scope,
      content: {
        title: parent.content?.title ?? `Reader snapshot: ${targetUrl}`,
        url: targetUrl,
        text: ok ? text.slice(0, MAX_READER_TEXT) : `Reader enrichment failed: HTTP ${response.status}\n${text.slice(0, 2000)}`,
      },
      acquisition: {
        mode: "derived",
        actor: "system",
        reason: `reader enrichment for ${parent.schema.name}`,
      },
      signal: {
        importance: Math.min(1, (parent.signal?.importance ?? 0.5) + 0.05),
        confidence: ok ? 0.85 : 0.2,
        status: ok ? parent.signal?.status ?? "accepted" : "candidate",
      },
      privacy: parent.privacy,
      payload: {
        parent_record_id: parent.id,
        provider: "jina",
        reader_url: readerUrl,
        http_status: response.status,
        ok,
        fetched_at: new Date().toISOString(),
        source_schema: parent.schema,
      },
    });
    return record;
  } catch (error: any) {
    return store.insertRecord({
      schema: { name: "derived.reader_snapshot", version: 1 },
      source: { type: "reader", connector: "jina" },
      scope: parent.scope,
      content: {
        title: parent.content?.title ?? `Reader snapshot failed: ${targetUrl}`,
        url: targetUrl,
        text: `Reader enrichment failed: ${error?.message ?? String(error)}`,
      },
      acquisition: { mode: "derived", actor: "system", reason: `reader enrichment failed for ${parent.schema.name}` },
      signal: { importance: 0.1, confidence: 0.1, status: "candidate" },
      privacy: parent.privacy,
      payload: {
        parent_record_id: parent.id,
        provider: "jina",
        reader_url: readerUrl,
        ok: false,
        error: error?.message ?? String(error),
        fetched_at: new Date().toISOString(),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function shouldAutoEnrichBrowserRecord(record: ContextRecord): boolean {
  return record.schema.name === "observation.browser_page_saved" || record.schema.name === "observation.browser_page_snapshot";
}

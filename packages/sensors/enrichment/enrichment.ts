import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ContextStore } from "@info/core";

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_READER_TEXT = 250_000;

const BLOCKED_PROTOCOLS = new Set(["chrome:", "chrome-extension:", "edge:", "about:", "file:", "data:", "blob:"]);
const PRIVATE_HOST_RE = /(gmail|mail|icloud|bank|paypal|stripe|checkout|1password|bitwarden|lastpass|login|account)/i;
const PRIVATE_PATH_RE = /(login|signin|account|checkout|payment|password|token|secret|oauth|auth)/i;

type ReaderGateRecord = {
  schema: { name: string };
  content?: { url?: string };
  payload?: Record<string, unknown>;
  privacy?: {
    level?: "public" | "workspace" | "private" | "secret";
    retention?: "ephemeral" | "normal" | "archive" | "do_not_store";
  };
};

type ReaderSnapshot = {
  url: string;
  text: string;
  provider: "jina";
  reader_url: string;
  http_status?: number;
  ok: boolean;
  error?: string;
  fetched_at: string;
};

export function shouldReaderEnrich(record: ReaderGateRecord): { ok: boolean; reason?: string } {
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

export function shouldAutoEnrichBrowserRecord(record: ReaderGateRecord): boolean {
  return record.schema.name === "observation.browser_page_saved" || record.schema.name === "observation.browser_page_snapshot";
}

export async function enrichWithJinaReader(store: ContextStore, parent: StoredContextRecord): Promise<StoredContextView | undefined> {
  const gate = shouldReaderEnrich(parent);
  if (!gate.ok) return undefined;

  const targetUrl = parent.content?.url;
  if (!targetUrl) return undefined;
  const snapshot = await fetchJinaReaderSnapshot(targetUrl);

  if (snapshot.ok) {
    return store.upsertView({
      id: `extraction:reader-snapshot:${parent.id}`,
      view_type: "extraction.reader_snapshot",
      title: parent.content?.title ?? `Reader snapshot: ${targetUrl}`,
      summary: `Reader snapshot for ${targetUrl}`,
      status: parent.signal?.status !== "inbox" ? parent.signal?.status ?? "candidate" : "candidate",
      source_records: [parent.id],
      compiler: { id: "reader.jina", version: "0.1.0", mode: "deterministic" },
      purpose: "Extract readable page text from a browser Observation for downstream Programs.",
      scope: parent.scope,
      content: {
        ...snapshot,
        source_schema: parent.schema,
      },
      confidence: 0.85,
      stability: "session",
      lossiness: "low",
      privacy: parent.privacy,
      metadata: {
        parent_record_id: parent.id,
      },
    });
  }

  return store.upsertView({
    id: `extraction:reader-snapshot:${parent.id}`,
    view_type: "extraction.reader_snapshot",
    title: parent.content?.title ?? `Reader snapshot failed: ${targetUrl}`,
    summary: snapshot.error ? `Reader enrichment failed: ${snapshot.error}` : `Reader enrichment failed: HTTP ${snapshot.http_status}`,
    status: "candidate",
    source_records: [parent.id],
    compiler: { id: "reader.jina", version: "0.1.0", mode: "deterministic" },
    purpose: "Extract readable page text from a browser Observation for downstream Programs.",
    scope: parent.scope,
    content: snapshot,
    confidence: snapshot.http_status ? 0.2 : 0.1,
    stability: "session",
    lossiness: "high",
    privacy: parent.privacy,
    metadata: { parent_record_id: parent.id },
  });
}

async function fetchJinaReaderSnapshot(targetUrl: string): Promise<ReaderSnapshot> {
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
    return {
      url: targetUrl,
      text: ok ? text.slice(0, MAX_READER_TEXT) : `Reader enrichment failed: HTTP ${response.status}\n${text.slice(0, 2000)}`,
      provider: "jina",
      reader_url: readerUrl,
      http_status: response.status,
      ok,
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      url: targetUrl,
      text: `Reader enrichment failed: ${message}`,
      provider: "jina",
      reader_url: readerUrl,
      ok: false,
      error: message,
      fetched_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

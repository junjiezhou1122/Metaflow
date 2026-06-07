import type { ContextSignal } from "./types.js";
import type { StoredContextRecord, StoredContextView } from "@info/core";

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "into", "your", "you", "are", "was", "were", "will", "would", "could", "should", "have", "has", "had", "not", "but", "about", "what", "when", "where", "which", "there", "their", "then", "than", "them", "they", "our", "out", "all", "can", "just", "more", "some", "like", "use", "used", "using", "how", "why", "http", "https", "localhost", "function", "const", "return", "import", "export", "type", "interface", "true", "false", "null", "undefined",
  "一个", "这个", "我们", "现在", "然后", "可以", "就是", "什么", "因为", "如果", "不是", "需要", "进行", "那个",
]);

export function signalFromRecord(record: StoredContextRecord): ContextSignal {
  const text = [record.content?.title, record.content?.text, record.content?.url, record.content?.path].filter(Boolean).join("\n");
  const payload = record.payload ?? {};
  return {
    object_id: record.id,
    object_kind: "observation",
    object_type: record.schema.name,
    source: record.source.type,
    connector: record.source.connector,
    title: record.content?.title,
    text_preview: preview(record.content?.text ?? JSON.stringify(payload)),
    url: record.content?.url,
    path: record.content?.path,
    domain: record.scope?.domain ?? domainFromUrl(record.content?.url),
    app: record.scope?.app,
    project: record.scope?.project,
    project_path: record.scope?.project_path,
    repo: record.scope?.repo,
    language: languageFromText(text, payload),
    keywords: keywords(text),
    topics: arrayOfStrings(payload.topics),
    observed_at: record.time?.observed_at,
    created_at: record.created_at,
    privacy_level: record.privacy?.level,
    confidence: record.signal?.confidence,
    importance: record.signal?.importance,
  };
}

export function signalFromView(view: StoredContextView): ContextSignal {
  const text = [view.title, view.summary, JSON.stringify(view.content ?? {})].filter(Boolean).join("\n");
  return {
    object_id: view.id,
    object_kind: "view",
    object_type: view.view_type,
    source: "view",
    title: view.title,
    text_preview: preview(view.summary ?? JSON.stringify(view.content ?? {})),
    domain: view.scope?.domain,
    app: view.scope?.app,
    project: view.scope?.project,
    project_path: view.scope?.project_path,
    repo: view.scope?.repo,
    language: languageFromText(text, view.content ?? {}),
    keywords: keywords(text),
    topics: arrayOfStrings(view.content?.topics ?? view.metadata?.topics),
    produced_by: view.compiler?.id,
    source_records: view.source_records,
    source_views: view.source_views,
    created_at: view.created_at,
    privacy_level: view.privacy?.level,
    confidence: view.confidence,
  };
}

export function signalFromObject(object: StoredContextRecord | StoredContextView): ContextSignal {
  return "schema" in object ? signalFromRecord(object) : signalFromView(object);
}

function preview(value: unknown, max = 600): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function keywords(text: string, max = 16): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]{2,}/gu) ?? []) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[0].localeCompare(b[0])).slice(0, max).map(([word]) => word);
}

function languageFromText(text: string, payload: Record<string, unknown>): string | undefined {
  const explicit = typeof payload.language === "string" ? payload.language : typeof (payload.text_quality as any)?.detected_language === "string" ? (payload.text_quality as any).detected_language : undefined;
  if (explicit) return explicit;
  const compact = text.replace(/\s+/g, "");
  if (!compact) return undefined;
  const latin = compact.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = compact.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  if (latin >= 20 && latin > cjk * 2) return "en";
  if (cjk >= 10 && cjk > latin) return "zh";
  return undefined;
}

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map(x => x.trim());
  return out.length ? out : undefined;
}

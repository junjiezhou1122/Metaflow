import { createHash, randomUUID } from "node:crypto";
import type { ContextView, StoredContextRecord } from "@info/core";

export const CONTENT_CLASSIFIER_ID = "builtin.content-classifier";
export const CONTENT_CLASSIFIER_VERSION = "0.1.0";

type Classification = {
  content_kind: "code_repo" | "code_review" | "docs" | "local_app" | "dashboard" | "terminal_or_ops" | "article" | "social_post" | "pdf" | "unknown";
  domain_area: "coding" | "research" | "learning" | "ops" | "general";
  confidence: number;
  recommended_next: string[];
  reasons: string[];
  features: Record<string, unknown>;
};

export function classifyCodingContext(record: StoredContextRecord): ContextView | undefined {
  if (!isClassifiable(record)) return undefined;
  const classification = classify(record);
  const inputHash = hashRecordInput(record);
  const generatedAt = new Date().toISOString();
  return {
    id: `analysis:content-classification:${record.id}:${inputHash.slice(0, 16)}`,
    view_type: "analysis.content_classification",
    title: `Classification: ${record.content?.title ?? record.content?.url ?? record.id}`,
    summary: `${classification.content_kind} (${classification.domain_area}) confidence=${classification.confidence}`,
    status: "candidate",
    source_records: [record.id],
    compiler: { id: CONTENT_CLASSIFIER_ID, version: CONTENT_CLASSIFIER_VERSION, mode: "deterministic" },
    purpose: "Classify raw context so Programs can attend without mutating the raw Observation.",
    scope: record.scope,
    confidence: classification.confidence,
    stability: "session",
    lossiness: "low",
    privacy: record.privacy,
    content: {
      plugin_id: CONTENT_CLASSIFIER_ID,
      plugin_version: CONTENT_CLASSIFIER_VERSION,
      run_id: randomUUID(),
      input_hash: inputHash,
      generated_at: generatedAt,
      source_record_id: record.id,
      source_schema: record.schema,
      source_url: record.content?.url,
      observed_at: record.time?.observed_at ?? record.created_at,
      ...classification,
    },
    metadata: { input_hash: inputHash, generated_at: generatedAt },
  };
}

function isClassifiable(record: StoredContextRecord): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (record.privacy?.retention === "do_not_store") return false;
  if (record.privacy?.level === "secret") return false;
  return [
    "observation.browser_page_snapshot",
    "observation.browser_page_saved",
    "observation.browser_text_selected",
    "observation.browser_text_copied",
    "observation.local_project",
    "observation.ai_session_locator_result",
    "observation.screenpipe_activity",
    "observation.screenpipe_activity_summary",
    "observation.screenpipe_workspace_signal",
  ].includes(record.schema.name);
}

function classify(record: StoredContextRecord): Classification {
  const url = record.content?.url ?? "";
  const host = safeHost(url) ?? record.scope?.domain ?? "";
  const path = safePath(url);
  const title = record.content?.title ?? "";
  const text = record.content?.text ?? "";
  const hay = `${host}\n${path}\n${title}\n${text}\n${JSON.stringify(record.payload ?? {})}`.toLowerCase();
  const reasons: string[] = [];
  const recommended = new Set<string>();
  let content_kind: Classification["content_kind"] = "unknown";
  let domain_area: Classification["domain_area"] = "general";
  let confidence = 0.35;

  if (record.schema.name === "observation.local_project") {
    content_kind = "code_repo";
    domain_area = "coding";
    confidence = 0.92;
    reasons.push("local project snapshot");
    recommended.add("work_thread_builder");
  } else if (host === "github.com" && looksLikeRepoPath(path)) {
    content_kind = path.includes("/pull/") ? "code_review" : "code_repo";
    domain_area = "coding";
    confidence = 0.88;
    reasons.push("github repository-like URL");
    recommended.add("repo_analyzer");
  } else if (host === "github.com" && /issues|pull|commit|blob|tree/.test(path)) {
    content_kind = "code_review";
    domain_area = "coding";
    confidence = 0.78;
    reasons.push("github coding workflow URL");
    recommended.add("repo_context");
  } else if (isLocalHost(host)) {
    content_kind = "local_app";
    domain_area = "coding";
    confidence = 0.82;
    reasons.push("local development host");
    recommended.add("local_app_snapshot");
  } else if (/langsmith|localhost:2024|studio|dashboard|console/.test(hay)) {
    content_kind = "dashboard";
    domain_area = "coding";
    confidence = 0.72;
    reasons.push("developer dashboard/studio indicators");
    recommended.add("screenpipe_context");
  } else if (/docs\.|\/docs\b|documentation|quickstart|api reference|getting started/.test(hay)) {
    content_kind = "docs";
    domain_area = /api|sdk|cli|install|quickstart|github|code|developer/.test(hay) ? "coding" : "learning";
    confidence = 0.7;
    reasons.push("documentation indicators");
    recommended.add("reader_snapshot");
  } else if (/terminal|pm2|docker|pnpm|npm|node|sqlite|permission|error|stack trace/.test(hay)) {
    content_kind = "terminal_or_ops";
    domain_area = "ops";
    confidence = 0.64;
    reasons.push("ops/debugging terms");
    recommended.add("debugging_timeline");
  } else if (/\.pdf($|\?)/.test(url) || host === "arxiv.org" && path.startsWith("/pdf")) {
    content_kind = "pdf";
    domain_area = "research";
    confidence = 0.86;
    reasons.push("pdf URL");
    recommended.add("pdf_parser");
  } else if (/x\.com|twitter\.com/.test(host) && /\/status\//.test(path)) {
    content_kind = "social_post";
    domain_area = /codex|agent|github|repo|code|developer|cli/.test(hay) ? "coding" : "general";
    confidence = 0.72;
    reasons.push("social post URL");
  } else if (text.length > 1000) {
    content_kind = "article";
    confidence = 0.55;
    reasons.push("long readable text");
  }

  const features = {
    schema: record.schema.name,
    host,
    path,
    title_length: title.length,
    text_length: text.length,
    has_url: Boolean(url),
    source_type: record.source.type,
    app: record.scope?.app,
  };

  return {
    content_kind,
    domain_area,
    confidence,
    recommended_next: [...recommended],
    reasons,
    features,
  };
}

export function hashRecordInput(record: StoredContextRecord): string {
  const payload = {
    schema: record.schema,
    url: record.content?.url,
    title: record.content?.title,
    text: normalize(record.content?.text).slice(0, 20_000),
    source: record.source,
    scope: record.scope,
    observed_at: record.time?.observed_at,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalize(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeHost(rawUrl: string): string | undefined {
  try { return new URL(rawUrl).hostname.replace(/^www\./, ""); } catch { return undefined; }
}

function safePath(rawUrl: string): string {
  try { return new URL(rawUrl).pathname; } catch { return ""; }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
}

function looksLikeRepoPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return false;
  const excluded = new Set(["search", "settings", "notifications", "pulls", "issues", "marketplace", "explore", "topics", "trending"]);
  return !excluded.has(parts[0]);
}

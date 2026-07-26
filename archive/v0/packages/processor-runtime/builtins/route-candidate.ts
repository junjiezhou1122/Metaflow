import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ContextRecord, StoredContextRecord } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler } from "../types.js";

export const ROUTE_CANDIDATE_PROCESSOR_ID = "processor.route_candidate";
export const ROUTE_CANDIDATE_SCHEMA = "observation.route_candidate";

export type RouteCandidateOptions = {
  now?: Date;
};

type RouteFeatureSet = {
  source_type: string;
  schema_name: string;
  app?: string;
  domain?: string;
  url?: string;
  url_class?: string;
  title_tokens: string[];
  text_tokens: string[];
  project_path?: string;
  project?: string;
  repo?: string;
  session_id?: string;
  file_paths: string[];
  command_tokens: string[];
  timestamp?: string;
};

type CandidateRoute = {
  route_key: string;
  lane_kind: "project" | "topic" | "communication" | "browser" | "app";
  score: number;
  rule_hits: string[];
  evidence_fields: Record<string, unknown>;
};

export function createRouteCandidateProcessor(options: RouteCandidateOptions = {}): ProcessorDefinition {
  return {
    id: ROUTE_CANDIDATE_PROCESSOR_ID,
    title: "Route Candidate",
    version: "0.0.1",
    description: "Extracts cheap deterministic routing candidates from raw observations.",
    consumes: {
      observations: [
        "observation.ai_session_locator_result",
        "observation.local_project",
        "observation.git*",
        "observation.browser_*",
        "observation.screenpipe_*",
        "observation.editor.*",
        "observation.youtube.*",
        "observation.message.*",
        "observation.communication.*",
      ],
    },
    produces: { observations: [ROUTE_CANDIDATE_SCHEMA] },
    runtime: { kind: "local" },
    policy: { speed: "reflex", autonomy: "draft", privacy: "inherit" },
    handler: routeCandidateHandler(options),
  };
}

export function routeCandidateHandler(options: RouteCandidateOptions = {}): ProcessorHandler {
  return ({ observation }, context) => {
    if (!observation || observation.schema.name === ROUTE_CANDIDATE_SCHEMA) return { observations: [] };
    if (observation.privacy?.retention === "do_not_store" || observation.privacy?.level === "secret") return { observations: [] };

    const recentCandidates = context.store.recent(40, undefined, { minutes: 180 })
      .filter(record => record.schema.name === ROUTE_CANDIDATE_SCHEMA);
    const features = extractRouteFeatures(observation);
    const candidateRoutes = buildCandidateRoutes(features, recentCandidates);
    if (!candidateRoutes.length) return { observations: [], diagnostics: { candidate_routes: 0 } };

    const now = options.now ?? new Date();
    const routeRecord = buildRouteCandidateRecord(observation, features, candidateRoutes, now);
    return {
      observations: [routeRecord],
      diagnostics: {
        candidate_routes: candidateRoutes.length,
        route_keys: candidateRoutes.map(route => route.route_key),
      },
    };
  };
}

export function buildRouteCandidateRecord(
  source: StoredContextRecord,
  features: RouteFeatureSet,
  candidateRoutes: CandidateRoute[],
  now = new Date(),
): ContextRecord {
  const observedAt = source.time?.observed_at ?? source.created_at ?? now.toISOString();
  return {
    id: `route-candidate:${source.id}:${shortHash(JSON.stringify({ features, candidateRoutes }))}`,
    schema: { name: ROUTE_CANDIDATE_SCHEMA, version: 1 },
    source: { type: "runtime", connector: ROUTE_CANDIDATE_PROCESSOR_ID },
    scope: {
      project: features.project,
      project_path: features.project_path,
      repo: features.repo,
      app: features.app,
      session: features.session_id,
      domain: features.domain,
    },
    time: { observed_at: observedAt, captured_at: now.toISOString() },
    content: {
      title: `Route candidates for ${source.schema.name}`,
      text: candidateRoutes.map(route => `${route.route_key} ${route.score}`).join("\n"),
      url: features.url,
      path: features.project_path ?? source.content?.path,
    },
    acquisition: {
      mode: "derived",
      actor: "system",
      reason: "deterministic route candidate extraction",
    },
    signal: {
      confidence: Math.max(...candidateRoutes.map(route => route.score)),
      importance: Math.max(...candidateRoutes.map(route => route.score)),
      status: "candidate",
    },
    privacy: {
      ...source.privacy,
      level: source.privacy?.level ?? "private",
      retention: source.privacy?.retention ?? "normal",
      allow_llm_summary: source.privacy?.allow_llm_summary ?? false,
      allow_external_llm: false,
      allow_external_reader: false,
    },
    relations: { derived_from: [source.id] },
    memory: { kind: "observation", stability: "session" },
    payload: {
      source_observation_id: source.id,
      features,
      candidate_routes: candidateRoutes,
      generated_by: ROUTE_CANDIDATE_PROCESSOR_ID,
      generated_at: now.toISOString(),
    },
  };
}

export function extractRouteFeatures(record: StoredContextRecord): RouteFeatureSet {
  const payload = record.payload ?? {};
  const url = firstString(record.content?.url, stringValue(payload.url), stringValue(payload.browser_url));
  const domain = record.scope?.domain ?? domainFromUrl(url);
  const title = firstString(record.content?.title, stringValue(payload.title), stringValue(payload.window_title), stringValue(payload.window_name));
  const text = [
    record.content?.text,
    title,
    url,
    record.content?.path,
    safeJson(payload),
  ].filter(Boolean).join("\n");
  const projectPath = firstString(
    record.scope?.project_path,
    stringValue(payload.project_path),
    stringValue(payload.cwd),
    stringValue(payload.root),
    stringValue(payload.projectPath),
    stringValue(payload.source_path),
  );
  const files = unique([
    ...arrayStrings(payload.files_touched),
    ...arrayStrings(payload.changed_files),
    ...arrayStrings(payload.file_paths),
    ...extractFilePaths(text),
  ]).slice(0, 40);
  const project = record.scope?.project ?? stringValue(payload.project) ?? (projectPath ? basename(projectPath) : undefined);
  const app = normalizeApp(firstString(record.scope?.app, stringValue(payload.app), stringValue(payload.app_name), stringValue(payload.window_app)));
  return {
    source_type: record.source.type,
    schema_name: record.schema.name,
    app,
    domain,
    url,
    url_class: classifyUrl(url, domain),
    title_tokens: tokenize(title).slice(0, 12),
    text_tokens: tokenize(text).slice(0, 24),
    project_path: projectPath,
    project,
    repo: firstString(record.scope?.repo, stringValue(payload.repo), stringValue(payload.repoRemote)),
    session_id: firstString(record.scope?.session, stringValue(payload.session_id), stringValue(payload.sessionId), stringValue(payload.id)),
    file_paths: files,
    command_tokens: arrayStrings(payload.commands_run).flatMap(tokenize).slice(0, 20),
    timestamp: record.time?.observed_at ?? record.created_at,
  };
}

export function buildCandidateRoutes(features: RouteFeatureSet, recentCandidates: StoredContextRecord[] = []): CandidateRoute[] {
  const byKey = new Map<string, CandidateRoute>();
  const add = (
    route_key: string | undefined,
    lane_kind: CandidateRoute["lane_kind"],
    score: number,
    rule_hit: string,
    evidence: Record<string, unknown>,
  ) => {
    if (!route_key) return;
    const current = byKey.get(route_key) ?? { route_key, lane_kind, score: 0, rule_hits: [], evidence_fields: {} };
    current.score = Math.min(1, Number((current.score + score).toFixed(3)));
    current.rule_hits = unique([...current.rule_hits, rule_hit]);
    current.evidence_fields = { ...current.evidence_fields, ...compactRecord(evidence) };
    byKey.set(route_key, current);
  };

  if (features.project_path) {
    add(`project:${features.project_path}`, "project", 0.55, "project_path.present", { project_path: features.project_path });
  }
  if (features.schema_name === "observation.ai_session_locator_result" && features.project_path) {
    add(`project:${features.project_path}`, "project", 0.35, "ai_session.project_path", { session_id: features.session_id });
  }
  if (features.schema_name === "observation.local_project" && features.project_path) {
    add(`project:${features.project_path}`, "project", 0.3, "local_project.root", { project: features.project });
  }
  if (features.file_paths.length && features.project_path) {
    add(`project:${features.project_path}`, "project", 0.2, "file_paths.inside_project", { file_paths: features.file_paths.slice(0, 8) });
  }
  if (features.repo) {
    add(`repo:${features.repo}`, "project", 0.45, "repo.present", { repo: features.repo });
  }
  if (features.domain) {
    const topic = topicFromDomain(features.domain);
    if (topic) add(`topic:${topic}`, "topic", features.url_class === "docs" ? 0.5 : 0.32, `domain.${features.url_class ?? "site"}`, { domain: features.domain, url_class: features.url_class });
    add(`domain:${features.domain}`, "browser", 0.22, "browser.domain", { domain: features.domain });
  }
  for (const token of [...features.title_tokens, ...features.text_tokens].filter(isUsefulTopicToken).slice(0, 4)) {
    add(`topic:${token}`, "topic", 0.12, "token.topic", { title_tokens: features.title_tokens.slice(0, 8) });
  }
  if (features.app && isCommunicationApp(features.app)) {
    add("communication:messages", "communication", 0.5, "app.communication", { app: features.app });
  } else if (features.app) {
    add(`app:${features.app}`, "app", 0.12, "app.active", { app: features.app });
  }

  const activeProject = recentActiveProject(recentCandidates);
  if (activeProject && !byKey.has(activeProject.route_key)) {
    const overlap = intersection(features.title_tokens.concat(features.text_tokens), activeProject.tokens);
    if (overlap.length) {
      add(activeProject.route_key, "project", 0.18, "recent_active_project.topic_overlap", { overlap_tokens: overlap.slice(0, 6) });
    }
  }

  return [...byKey.values()]
    .map(route => ({ ...route, score: Math.min(1, Number(route.score.toFixed(3))) }))
    .filter(route => route.score >= 0.12)
    .sort((a, b) => b.score - a.score || a.route_key.localeCompare(b.route_key))
    .slice(0, 8);
}

function recentActiveProject(records: StoredContextRecord[]): { route_key: string; tokens: string[] } | undefined {
  for (const record of records) {
    const routes = arrayRecords(record.payload?.candidate_routes);
    const project = routes.find(route => Boolean(stringValue(route.route_key)?.startsWith("project:")) && (numberValue(route.score) ?? 0) >= 0.55);
    if (!project) continue;
    const features = recordValue(record.payload?.features);
    return {
      route_key: stringValue(project.route_key) ?? "",
      tokens: arrayStrings(features?.title_tokens).concat(arrayStrings(features?.text_tokens)),
    };
  }
  return undefined;
}

function classifyUrl(url?: string, domain?: string): string | undefined {
  const hay = `${domain ?? ""} ${url ?? ""}`.toLowerCase();
  if (!hay.trim()) return undefined;
  if (/(docs|developer|dev|api|github|gitlab|npmjs|midscenejs|readme|reference)/.test(hay)) return "docs";
  if (/(mail|messages|slack|discord|wechat|wx|telegram)/.test(hay)) return "communication";
  if (/(weather|news|shopping|video|music)/.test(hay)) return "general";
  return "site";
}

function topicFromDomain(domain: string): string | undefined {
  const parts = domain.toLowerCase().replace(/^www\./, "").split(".");
  const stem = parts[0];
  if (!stem || ["google", "bing", "duckduckgo", "weather", "news"].includes(stem)) return undefined;
  return stem.replace(/js$/, "");
}

function isCommunicationApp(app: string): boolean {
  return /(message|wechat|weixin|slack|discord|telegram|mail|teams)/i.test(app);
}

function isUsefulTopicToken(token: string): boolean {
  return token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "what", "when", "where", "how", "why",
  "http", "https", "www", "com", "org", "net", "file", "path", "users", "junjie", "node", "npm", "pnpm", "git",
  "import", "export", "const", "function", "return", "true", "false", "undefined", "null",
  "这个", "我们", "现在", "就是", "可以", "什么", "然后", "因为", "需要",
]);

function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|\/Users\/[^\s"'`]+/g) ?? [];
  return unique(matches.map(value => value.replace(/[),.;\]]+$/, ""))).slice(0, 80);
}

function tokenize(value?: string): string[] {
  return unique(String(value ?? "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,40}|[\u4e00-\u9fff]{2,}/g) ?? [])
    .filter(token => !STOPWORDS.has(token));
}

function normalizeApp(value?: string): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (v.includes("chrome")) return "chrome";
  if (v.includes("code")) return "code";
  if (v.includes("wechat") || v.includes("微信")) return "wechat";
  return v;
}

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(recordValue) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function intersection(a: string[], b: string[]): string[] {
  const bset = new Set(b);
  return unique(a.filter(value => bset.has(value)));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return ""; }
}

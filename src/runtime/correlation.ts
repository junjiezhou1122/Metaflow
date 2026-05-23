import type { ContextRecord, StoredContextRecord } from "../core/types.js";

export type RecordFeatures = {
  id: string;
  observed_at?: string;
  schema_name: string;
  source_type: string;
  connector?: string;
  app?: string;
  domain?: string;
  url?: string;
  path?: string;
  repo?: string;
  project?: string;
  session?: string;
  title?: string;
  text?: string;
  keywords: string[];
  file_paths: string[];
};

export type PairEvidence = {
  score: number;
  reasons: string[];
};

export type CandidateThreadRecord = {
  id: string;
  score: number;
  reasons: string[];
  schema: string;
  source: string;
  title?: string;
  observed_at?: string;
};

export type CandidateThread = {
  thread_id: string;
  title: string;
  confidence: number;
  status: "candidate";
  records: CandidateThreadRecord[];
  keywords: string[];
  domains: string[];
  apps: string[];
  projects: string[];
  repos: string[];
  reasons: string[];
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "what", "when", "where", "how", "why",
  "http", "https", "localhost", "com", "www", "file", "files", "true", "false", "null", "undefined",
  "users", "user", "junjie", "node", "npm", "pnpm", "yarn", "bun", "git", "src", "docs", "path", "run",
  "import", "export", "const", "let", "var", "function", "return", "type", "interface",
  "一个", "这个", "我们", "现在", "然后", "可以", "就是", "什么", "因为", "如果", "不是", "需要", "进行", "这个", "那个",
]);

const ANCHOR_SCHEMAS = [
  "observation.local_project",
  "observation.git_change",
  "observation.ai_chat",
  "observation.codex_session",
  "observation.browser_page_saved",
  "observation.ai_session_locator_result",
  "episode.candidate_thread",
];

export function extractFeatures(record: StoredContextRecord): RecordFeatures {
  const payload = record.payload ?? {};
  const rawText = [
    record.content?.title,
    record.content?.text,
    record.content?.url,
    record.content?.path,
    JSON.stringify(payload),
  ].filter(Boolean).join("\n");
  const url = record.content?.url ?? stringValue(payload.browser_url) ?? stringValue(payload.url);
  const domain = record.scope?.domain ?? domainFromUrl(url) ?? domainFromUrl(stringValue(payload.browser_url));
  const path = record.content?.path ?? stringValue(payload.path) ?? stringValue(payload.root) ?? stringValue(payload.cwd);
  const repo = record.scope?.repo ?? stringValue(payload.repoRemote) ?? stringValue(payload.repo);
  const cwd = stringValue(payload.cwd);
  const projectPath = record.scope?.project_path ?? stringValue(payload.project_path) ?? (cwd && cwd.startsWith("/") ? cwd : undefined);
  const project = record.scope?.project ?? stringValue(payload.project) ?? basename(projectPath) ?? basename(path);

  return {
    id: record.id,
    observed_at: record.time?.observed_at ?? record.created_at,
    schema_name: record.schema.name,
    source_type: record.source.type,
    connector: record.source.connector,
    app: record.scope?.app ?? stringValue(payload.app_name),
    domain,
    url,
    path: projectPath ?? path,
    repo,
    project,
    session: record.scope?.session ?? stringValue(payload.session_id),
    title: record.content?.title,
    text: record.content?.text,
    keywords: extractKeywords(rawText),
    file_paths: extractFilePaths(rawText),
  };
}

const EXPLICIT_RELATIONS = new Map<string, Set<string>>();

function areExplicitlyRelated(a: string, b: string): boolean {
  return EXPLICIT_RELATIONS.get(a)?.has(b) || EXPLICIT_RELATIONS.get(b)?.has(a) || false;
}

function indexExplicitRelations(records: StoredContextRecord[]) {
  EXPLICIT_RELATIONS.clear();
  for (const record of records) {
    const related = [
      ...(record.relations?.related_to ?? []),
      ...(record.relations?.derived_from ?? []),
      ...(record.relations?.supersedes ?? []),
    ];
    if (!related.length) continue;
    const set = EXPLICIT_RELATIONS.get(record.id) ?? new Set<string>();
    for (const id of related) set.add(id);
    EXPLICIT_RELATIONS.set(record.id, set);
  }
}

export function scorePair(a: RecordFeatures, b: RecordFeatures): PairEvidence {
  const reasons: string[] = [];
  let score = 0;

  if (a.repo && b.repo && a.repo === b.repo) {
    score += 0.4;
    reasons.push(`same repo: ${a.repo}`);
  }
  if (a.project && b.project && normalizeToken(a.project) === normalizeToken(b.project)) {
    score += 0.35;
    reasons.push(`same project: ${a.project}`);
  }
  if (a.path && b.path && (a.path === b.path || a.path.includes(b.path) || b.path.includes(a.path))) {
    score += 0.35;
    reasons.push("same/overlapping path");
  }

  const fileOverlap = intersection(a.file_paths, b.file_paths);
  if (fileOverlap.length > 0) {
    score += Math.min(0.4, 0.2 + fileOverlap.length * 0.05);
    reasons.push(`file path overlap: ${fileOverlap.slice(0, 3).join(", ")}`);
  }

  if (a.url && b.url && normalizeUrl(a.url) === normalizeUrl(b.url)) {
    score += 0.3;
    reasons.push("same url");
  } else if (a.domain && b.domain && a.domain === b.domain) {
    score += 0.15;
    reasons.push(`same domain: ${a.domain}`);
  }

  if (a.session && b.session && a.session === b.session) {
    score += 0.3;
    reasons.push(`same session: ${a.session}`);
  }

  if (areExplicitlyRelated(a.id, b.id)) {
    score += 0.45;
    reasons.push("explicit relation");
  }

  if ((a.schema_name === "observation.ai_session_locator_result" || b.schema_name === "observation.ai_session_locator_result") && a.project && b.project && normalizeToken(a.project) === normalizeToken(b.project)) {
    score += 0.15;
    reasons.push("ai session anchor matches project");
  }

  const keywordOverlap = intersection(a.keywords, b.keywords);
  if (keywordOverlap.length > 0) {
    score += Math.min(0.25, keywordOverlap.length * 0.05);
    reasons.push(`keyword overlap: ${keywordOverlap.slice(0, 6).join(", ")}`);
  }

  const minutes = minutesBetween(a.observed_at, b.observed_at);
  if (minutes !== undefined) {
    if (minutes <= 10) {
      score += 0.15;
      reasons.push(`near timestamp: ${Math.round(minutes)}m`);
    } else if (minutes <= 30) {
      score += 0.1;
      reasons.push(`near timestamp: ${Math.round(minutes)}m`);
    } else if (minutes <= 120) {
      score += 0.05;
      reasons.push(`same work block: ${Math.round(minutes)}m`);
    }
  }

  if (a.app && b.app && a.app === b.app) {
    score += 0.05;
    reasons.push(`same app: ${a.app}`);
  }

  return { score: Math.min(1, Number(score.toFixed(3))), reasons };
}

export function buildCandidateThreads(records: StoredContextRecord[], options: { minScore?: number; maxThreads?: number } = {}): CandidateThread[] {
  const minScore = options.minScore ?? 0.4;
  const dedupedRecords = dedupeRecords(records);
  indexExplicitRelations(dedupedRecords);
  const features = dedupedRecords.map(extractFeatures);
  const anchors = chooseAnchors(dedupedRecords, features);
  const candidates: CandidateThread[] = [];

  for (const anchor of anchors) {
    const membersById = new Map<string, CandidateThreadRecord>();
    const reasonCounts = new Map<string, number>();
    for (const f of features) {
      const evidence = f.id === anchor.id ? { score: 1, reasons: ["anchor record"] } : scorePair(anchor, f);
      if (evidence.score >= minScore || f.id === anchor.id) {
        const member = {
          id: f.id,
          score: evidence.score,
          reasons: evidence.reasons,
          schema: f.schema_name,
          source: `${f.source_type}${f.connector ? `/${f.connector}` : ""}`,
          title: f.title,
          observed_at: f.observed_at,
        };
        const prev = membersById.get(f.id);
        if (!prev || member.score > prev.score) membersById.set(f.id, member);
        for (const reason of evidence.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    const members = [...membersById.values()];
    if (members.length < 2) continue;
    const keywordList = topValues(members.flatMap(m => features.find(f => f.id === m.id)?.keywords ?? []), 8);
    const domains = topValues(members.map(m => features.find(f => f.id === m.id)?.domain).filter(Boolean) as string[], 6);
    const apps = topValues(members.map(m => features.find(f => f.id === m.id)?.app).filter(Boolean) as string[], 6);
    const projects = topValues(members.map(m => features.find(f => f.id === m.id)?.project).filter(Boolean) as string[], 4);
    const repos = topValues(members.map(m => features.find(f => f.id === m.id)?.repo).filter(Boolean) as string[], 4);
    const confidence = Number((members.reduce((sum, m) => sum + m.score, 0) / members.length).toFixed(3));
    const title = inferTitle(anchor, keywordList, projects, domains);
    candidates.push({
      thread_id: `candidate:${slug(title)}`,
      title,
      confidence,
      status: "candidate",
      records: members.sort((a, b) => b.score - a.score),
      keywords: keywordList,
      domains,
      apps,
      projects,
      repos,
      reasons: [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason]) => reason).slice(0, 10),
    });
  }

  return dedupeThreads(candidates)
    .sort((a, b) => b.confidence - a.confidence || b.records.length - a.records.length)
    .slice(0, options.maxThreads ?? 8);
}

function chooseAnchors(records: StoredContextRecord[], features: RecordFeatures[]): RecordFeatures[] {
  const anchors = features.filter(f => ANCHOR_SCHEMAS.includes(f.schema_name) || f.project || f.repo || f.path);
  return anchors.length ? anchors : features.slice(0, Math.min(5, records.length));
}

function inferTitle(anchor: RecordFeatures, keywords: string[], projects: string[], domains: string[]): string {
  if (projects[0] && keywords.length) return `${titleCase(projects[0])}: ${keywords.slice(0, 3).join(" / ")}`;
  if (projects[0]) return titleCase(projects[0]);
  if (anchor.title) return anchor.title.slice(0, 80);
  if (domains[0] && keywords.length) return `${domains[0]}: ${keywords.slice(0, 3).join(" / ")}`;
  return keywords.slice(0, 4).join(" / ") || "Untitled WorkThread";
}

function dedupeThreads(candidates: CandidateThread[]): CandidateThread[] {
  const byKey = new Map<string, CandidateThread>();
  for (const c of candidates) {
    const key = c.thread_id;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    const mergedRecords = [...prev.records, ...c.records]
      .sort((a, b) => b.score - a.score)
      .reduce((acc, record) => acc.some(r => r.id === record.id) ? acc : [...acc, record], [] as CandidateThreadRecord[]);
    const mergedConfidence = Number((mergedRecords.reduce((sum, r) => sum + r.score, 0) / mergedRecords.length).toFixed(3));
    byKey.set(key, {
      ...prev,
      confidence: Math.max(prev.confidence, c.confidence, mergedConfidence),
      records: mergedRecords,
      keywords: topValues([...prev.keywords, ...c.keywords], 8),
      domains: topValues([...prev.domains, ...c.domains], 6),
      apps: topValues([...prev.apps, ...c.apps], 6),
      projects: topValues([...prev.projects, ...c.projects], 4),
      repos: topValues([...prev.repos, ...c.repos], 4),
      reasons: [...new Set([...prev.reasons, ...c.reasons])].slice(0, 10),
    });
  }
  return [...byKey.values()];
}

function dedupeRecords(records: StoredContextRecord[]): StoredContextRecord[] {
  const byId = new Map<string, StoredContextRecord>();
  for (const record of records) {
    const prev = byId.get(record.id);
    if (!prev || Date.parse(record.updated_at) >= Date.parse(prev.updated_at)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function extractKeywords(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const raw of matches) {
    const word = normalizeToken(raw);
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 30);
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+(?:[\w.-]+)(?:\.[a-zA-Z0-9]+)?|[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)/g) ?? [];
  return [...new Set(matches
    .map(m => m.replace(/^['"`]|['"`]$/g, ""))
    .filter(m => !isGenericFilePathToken(m))
  )].slice(0, 50);
}

function isGenericFilePathToken(value: string): boolean {
  const normalized = value.toLowerCase();
  if (["readme.md", "package.json", "tsconfig.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "agents.md"].includes(normalized)) return true;
  if (!value.includes("/") && normalized.match(/^(index|main|app|page|route|layout)\.(ts|tsx|js|jsx|py|md|json)$/)) return true;
  return false;
}

function topValues(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, limit);
}

function intersection(a: string[], b: string[]): string[] {
  const set = new Set(a);
  return [...new Set(b.filter(x => set.has(x)))];
}

function minutesBetween(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
  return Math.abs(ta - tb) / 60_000;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function basename(path?: string): string | undefined {
  if (!path) return undefined;
  return path.split(/[\\/]/).filter(Boolean).at(-1);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "").trim();
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function slug(value: string): string {
  return normalizeToken(value).replace(/[_\s]+/g, "-").slice(0, 80) || "thread";
}

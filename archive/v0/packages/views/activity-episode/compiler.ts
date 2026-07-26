import { createHash } from "node:crypto";
import { ContextStore, chatCompletion, parseJsonObject, type ContextView, type LlmOptions, type StoredContextRecord, type StoredContextView } from "@info/core";

export const ACTIVITY_EPISODE_VIEW_TYPE = "activity.episode";
export const ACTIVITY_EPISODE_COMPILER_ID = "builtin.activity-episode";

export type ActivityEpisodeSummaryInput = {
  episode: ActivityEpisodeDraft;
  contextViews: StoredContextView[];
};

export type ActivityEpisodeSummaryResult = {
  ok: boolean;
  content?: Record<string, unknown>;
  raw?: string;
  model?: string;
  base_url?: string;
  error?: string;
};

export type ActivityEpisodeSummarizer = (input: ActivityEpisodeSummaryInput) => Promise<ActivityEpisodeSummaryResult>;

export type CompileActivityEpisodesOptions = {
  minutes?: number;
  startTime?: string;
  endTime?: string;
  limit?: number;
  write?: boolean;
  records?: StoredContextRecord[];
  llm?: LlmOptions;
  summarizer?: ActivityEpisodeSummarizer;
  summarizeWithLlm?: boolean;
  llmEpisodeLimit?: number;
  gapMinutes?: number;
};

export type CompileActivityEpisodesResult = {
  ok: true;
  compiler_id: string;
  generated_at: string;
  views: Array<ContextView | StoredContextView>;
  records_used: number;
  episodes: ActivityEpisodeDraft[];
  diagnostics: Record<string, unknown>;
};

export type ActivityEpisodeDraft = {
  id: string;
  episode_key: string;
  identity_kind: "browser_url" | "application";
  start_time: string;
  end_time: string;
  duration_minutes: number;
  records: StoredContextRecord[];
  app?: string;
  title?: string;
  summary: string;
  urls: string[];
  domains: string[];
  window_titles: string[];
  projects: string[];
  frame_ids: Array<string | number>;
  visual_frames: Array<{ id: string; frame_id: string | number; title?: string }>;
  keywords: string[];
};

type EpisodeAccumulator = {
  episode_key: string;
  identity_kind: ActivityEpisodeDraft["identity_kind"];
  records: StoredContextRecord[];
};

export async function compileActivityEpisodes(options: CompileActivityEpisodesOptions = {}, store = new ContextStore()): Promise<CompileActivityEpisodesResult> {
  const generatedAt = new Date().toISOString();
  const minutes = options.minutes ?? 24 * 60;
  const endTime = options.endTime ?? generatedAt;
  const startTime = options.startTime ?? new Date(Date.parse(endTime) - minutes * 60_000).toISOString();
  const limit = options.limit ?? 500;
  const candidates = options.records ?? store.recent(Math.max(limit * 3, limit + 50), undefined, { start_time: startTime, end_time: endTime, minutes });
  const records = candidates
    .filter(isEpisodeRecord)
    .sort((a, b) => Date.parse(recordTime(a)) - Date.parse(recordTime(b)))
    .slice(0, limit);
  const contextViews = episodeContextViews(store);
  const visualFrameViews = episodeVisualFrameViews(store, { startTime, endTime });
  const episodes = segmentRecords(records, { gapMinutes: options.gapMinutes ?? 20, visualFrameViews });
  const summarize = options.summarizer ?? (options.summarizeWithLlm ? defaultLlmSummarizer(options.llm) : undefined);

  if (options.write ?? true) archiveStaleEpisodeViews(store, episodes, startTime, endTime, generatedAt);
  const summarized = await summarizeEpisodes(episodes, contextViews, summarize, options.llmEpisodeLimit ?? 8, generatedAt);
  const stored = (options.write ?? true) ? summarized.map(view => store.upsertView(view)) : summarized;
  if (options.write ?? true) appendCompileEvent(store, stored, records.length, generatedAt);
  return {
    ok: true,
    compiler_id: ACTIVITY_EPISODE_COMPILER_ID,
    generated_at: generatedAt,
    views: stored,
    records_used: records.length,
    episodes,
    diagnostics: {
      records_scanned: candidates.length,
      records_used: records.length,
      episodes: episodes.length,
      context_views_used: contextViews.length,
      visual_frame_views_used: visualFrameViews.length,
      llm_attempted: Boolean(summarize),
    },
  };
}

export function segmentRecords(records: StoredContextRecord[], options: { gapMinutes?: number; visualFrameViews?: StoredContextView[] } = {}): ActivityEpisodeDraft[] {
  const gapMinutes = options.gapMinutes ?? 5;
  const frameRecords = records.filter(record => frameIdsOfRecord(record).length > 0);
  const accs: EpisodeAccumulator[] = [];
  for (const record of records) {
    const identity = episodeIdentity(record);
    if (!identity) continue;
    const existing = findContinuableAccumulator(accs, record, identity, gapMinutes);
    if (existing) {
      existing.records.push(record);
    } else {
      accs.push({ episode_key: identity.key, identity_kind: identity.kind, records: [record] });
    }
  }
  return accs.map(acc => accumulatorToDraft(acc, frameRecords, options.visualFrameViews ?? []));
}

function findContinuableAccumulator(accs: EpisodeAccumulator[], next: StoredContextRecord, identity: { key: string; kind: ActivityEpisodeDraft["identity_kind"] }, gapMinutes: number): EpisodeAccumulator | undefined {
  for (let index = accs.length - 1; index >= 0; index -= 1) {
    const acc = accs[index]!;
    if (canContinue(acc, next, identity, gapMinutes)) return acc;
  }
  return undefined;
}

function canContinue(current: EpisodeAccumulator, next: StoredContextRecord, identity: { key: string; kind: ActivityEpisodeDraft["identity_kind"] }, gapMinutes: number): boolean {
  if (current.episode_key !== identity.key) return false;
  const last = current.records.at(-1);
  if (!last) return false;
  const gap = Date.parse(recordTime(next)) - Date.parse(recordTime(last));
  return Number.isFinite(gap) && gap >= 0 && gap <= gapMinutes * 60_000;
}

function episodeIdentity(record: StoredContextRecord): { key: string; kind: ActivityEpisodeDraft["identity_kind"] } | undefined {
  const url = urlOf(record);
  if (isBrowserRecord(record) && url) return { key: `browser:${normalizeEpisodeUrl(url)}`, kind: "browser_url" };
  const app = normalizeApp(appOf(record) ?? (isBrowserRecord(record) ? "browser" : undefined));
  if (!app) return undefined;
  return { key: `app:${app}`, kind: "application" };
}

function accumulatorToDraft(acc: EpisodeAccumulator, frameRecords: StoredContextRecord[] = [], visualFrameViews: StoredContextView[] = []): ActivityEpisodeDraft {
  const sorted = [...acc.records].sort((a, b) => Date.parse(recordTime(a)) - Date.parse(recordTime(b)));
  const first = sorted[0]!;
  const last = sorted.at(-1) ?? first;
  const start = recordTime(first);
  const end = recordTime(last);
  const duration = Math.max(0, (Date.parse(end) - Date.parse(start)) / 60_000);
  const urls = unique(sorted.map(urlOf).filter(isString));
  const domains = unique(sorted.map(record => domainOf(record, acc.identity_kind === "browser_url")).filter(isString));
  const windowTitles = unique(sorted.map(windowTitleOf).filter(isString)).slice(0, 12);
  const projects = unique(sorted.flatMap(record => [record.scope?.project, record.scope?.project_path, stringValue(record.payload?.cwd)]).filter(isString)).slice(0, 8);
  const app = commonString(sorted.map(appOf).filter(isString)) ?? appOf(last);
  const title = titleForEpisode(acc.identity_kind, app, urls, windowTitles, sorted);
  const keywords = keywordCandidates(sorted, { app, domains, projects, windowTitles });
  const relatedFrames = relatedFrameRecords(sorted, frameRecords, acc.identity_kind);
  const relatedVisualFrames = relatedVisualFrameViews(sorted, visualFrameViews, acc.identity_kind);
  const id = `activity:episode:${stableKey(`${acc.episode_key}|${first.id}`)}`;
  return {
    id,
    episode_key: acc.episode_key,
    identity_kind: acc.identity_kind,
    start_time: start,
    end_time: end,
    duration_minutes: Number(duration.toFixed(3)),
    records: sorted,
    app,
    title,
    summary: deterministicSummary(title, sorted, duration),
    urls,
    domains,
    window_titles: windowTitles,
    projects,
    frame_ids: unique([...uniqueFrameIds([...sorted, ...relatedFrames]), ...relatedVisualFrames.map(frame => frame.frame_id)]),
    visual_frames: relatedVisualFrames,
    keywords,
  };
}

async function summarizeEpisodes(
  episodes: ActivityEpisodeDraft[],
  contextViews: StoredContextView[],
  summarizer: ActivityEpisodeSummarizer | undefined,
  llmLimit: number,
  generatedAt: string,
): Promise<ContextView[]> {
  const views: ContextView[] = [];
  for (let index = 0; index < episodes.length; index += 1) {
    const episode = episodes[index]!;
    const llm = summarizer && index < llmLimit ? await summarizer({ episode, contextViews }) : undefined;
    views.push(episodeView(episode, contextViews, llm, generatedAt));
  }
  return views;
}

function episodeView(episode: ActivityEpisodeDraft, contextViews: StoredContextView[], llm: ActivityEpisodeSummaryResult | undefined, generatedAt: string): ContextView {
  const content = llm?.ok && llm.content ? llm.content : {};
  const title = stringValue(content.title) ?? episode.title ?? "Activity episode";
  const summary = stringValue(content.summary) ?? episode.summary;
  const keywords = unique([...stringArray(content.keywords), ...episode.keywords]).slice(0, 12);
  const ambientHelp = recordValue(content.ambient_help);
  const sourceRecords = episode.records.map(record => record.id);
  const sourceViews = contextViews.map(view => view.id).filter(isString);
  return {
    id: episode.id,
    view_type: ACTIVITY_EPISODE_VIEW_TYPE,
    title,
    summary,
    status: "candidate",
    source_records: sourceRecords,
    source_views: sourceViews,
    compiler: { id: ACTIVITY_EPISODE_COMPILER_ID, version: "0.1.0", mode: llm?.ok ? "hybrid" : "deterministic" },
    purpose: "User-understandable activity segment compiled from continuous observations in one stable app or page context.",
    scope: {
      app: episode.app,
      domain: episode.domains[0],
      project: episode.projects[0],
      time_range: { start: episode.start_time, end: episode.end_time },
      plugin_id: ACTIVITY_EPISODE_COMPILER_ID,
    },
    content: {
      kind: "activity_episode",
      episode_key: episode.episode_key,
      identity_kind: episode.identity_kind,
      start_time: episode.start_time,
      end_time: episode.end_time,
      duration_minutes: episode.duration_minutes,
      record_count: episode.records.length,
      app: episode.app,
      urls: episode.urls,
      domains: episode.domains,
      window_titles: episode.window_titles,
      projects: episode.projects,
      frame_ids: episode.frame_ids,
      visual_frames: episode.visual_frames,
      keywords,
      details: stringArray(content.details),
      next_steps: stringArray(content.next_steps),
      memory_signals: stringArray(content.memory_signals),
      ambient_help: ambientHelp ?? deterministicAmbientHelp(episode, contextViews),
      evidence: episode.records.slice(0, 12).map(record => ({
        id: record.id,
        schema: record.schema.name,
        title: record.content?.title,
        url: urlOf(record),
        app: appOf(record),
        window_title: windowTitleOf(record),
        observed_at: recordTime(record),
        text: textOf(record)?.slice(0, 300),
      })),
      llm_summary: llm?.ok ? { model: llm.model, base_url: llm.base_url } : undefined,
    },
    confidence: llm?.ok ? 0.82 : 0.68,
    stability: "session",
    lossiness: llm?.ok ? "medium" : "low",
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    metadata: {
      generated_at: generatedAt,
      algorithm: "activity-episode-v1",
      llm: llm ? { ok: llm.ok, model: llm.model, base_url: llm.base_url, error: llm.error } : undefined,
      visual_frame_ids: episode.visual_frames.map(frame => frame.id),
    },
  };
}

function defaultLlmSummarizer(llm?: LlmOptions): ActivityEpisodeSummarizer {
  return async ({ episode, contextViews }) => {
    const result = await chatCompletion([
      {
        role: "system",
        content: [
          "You are Info's Activity Episode compiler.",
          "Summarize only the provided episode evidence and context Views.",
          "Return strict JSON only.",
          "Prefer the user's language when obvious.",
          "If memory/profile/project context suggests a useful proactive action, set ambient_help.should_help=true.",
        ].join("\n"),
      },
      { role: "user", content: episodePrompt(episode, contextViews) },
    ], { ...llm, max_tokens: llm?.max_tokens ?? 900 });
    if (!result.ok || !result.content) return { ok: false, model: result.model, base_url: result.base_url, error: result.error ?? "llm failed" };
    const parsed = parseJsonObject(result.content);
    if (!parsed) return { ok: false, raw: result.content, model: result.model, base_url: result.base_url, error: "LLM did not return JSON object" };
    return { ok: true, content: parsed, raw: result.content, model: result.model, base_url: result.base_url };
  };
}

function episodePrompt(episode: ActivityEpisodeDraft, contextViews: StoredContextView[]): string {
  return [
    "Compile one Activity Episode.",
    "Return JSON with keys: title, summary, details, keywords, next_steps, memory_signals, ambient_help.",
    "ambient_help must be an object: { should_help: boolean, kind: string, rationale: string, suggested_action: string, confidence: number }.",
    "Use ambient_help for useful proactive help, such as background research, writing assistance, project recap, or memory update.",
    "",
    "Episode:",
    JSON.stringify({
      identity_kind: episode.identity_kind,
      app: episode.app,
      urls: episode.urls,
      domains: episode.domains,
      window_titles: episode.window_titles,
      projects: episode.projects,
      start_time: episode.start_time,
      end_time: episode.end_time,
      duration_minutes: episode.duration_minutes,
      deterministic_summary: episode.summary,
      evidence: episode.records.slice(0, 20).map(record => ({
        id: record.id,
        schema: record.schema.name,
        title: record.content?.title,
        url: urlOf(record),
        app: appOf(record),
        window_title: windowTitleOf(record),
        text: textOf(record)?.slice(0, 500),
      })),
    }, null, 2),
    "",
    "Relevant context Views:",
    JSON.stringify(contextViews.map(view => ({
      id: view.id,
      view_type: view.view_type,
      title: view.title,
      summary: view.summary,
      content: compactContent(view.content),
    })), null, 2),
  ].join("\n");
}

function deterministicAmbientHelp(episode: ActivityEpisodeDraft, contextViews: StoredContextView[]): Record<string, unknown> {
  const hay = `${episode.summary} ${episode.keywords.join(" ")} ${episode.records.map(record => `${record.content?.title ?? ""} ${record.content?.text ?? ""}`).join(" ")}`.toLowerCase();
  const context = contextViews.map(view => `${view.title ?? ""} ${view.summary ?? ""} ${JSON.stringify(view.content ?? {})}`).join(" ").toLowerCase();
  const meaningfulKeywords = episode.keywords.map(keyword => keyword.toLowerCase()).filter(isMeaningfulHelpKeyword);
  const shouldHelp = Boolean(context && meaningfulKeywords.some(keyword => context.includes(keyword)))
    || /research|auto research|agent|ambient|memory|写作|研究|自动/.test(hay);
  return {
    should_help: shouldHelp,
    kind: shouldHelp ? "episode_analysis" : "none",
    rationale: shouldHelp ? "Episode overlaps with recent memory/project context or contains research/agent work signals." : "No strong proactive help signal.",
    suggested_action: shouldHelp ? "Prepare a concise activity brief and consider background research or memory update." : "",
    confidence: shouldHelp ? 0.62 : 0.25,
  };
}

function episodeContextViews(store: ContextStore): StoredContextView[] {
  const types = ["memory.daily", "memory.profile", "project.current", "work.focus_set"];
  return store.listViews({ view_types: types, active_only: true, limit: 12 });
}

function episodeVisualFrameViews(store: ContextStore, options: { startTime: string; endTime: string }): StoredContextView[] {
  const startMs = Date.parse(options.startTime);
  const endMs = Date.parse(options.endTime);
  const marginMs = 12 * 60_000;
  return store.listViews({ view_types: ["visual_frame"], active_only: true, limit: 300 }).filter(view => {
    const range = viewTimeRange(view);
    if (!range || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;
    return range.end >= startMs - marginMs && range.start <= endMs + marginMs;
  });
}

function isEpisodeRecord(record: StoredContextRecord): boolean {
  if (record.schema.name.startsWith("derived.")) return false;
  if (record.schema.name.startsWith("episode.")) return false;
  if (record.schema.name === "observation.route_candidate") return false;
  if (record.privacy?.retention === "do_not_store" || record.privacy?.level === "secret") return false;
  if (isNoisyBrowserUrl(urlOf(record))) return false;
  if (isScreenpipeRecorderRecord(record)) return false;
  return Boolean(episodeIdentity(record));
}

function isBrowserRecord(record: StoredContextRecord): boolean {
  const app = (appOf(record) ?? "").toLowerCase();
  return record.source.type === "browser" || record.schema.name.includes("browser") || ["chrome", "arc", "safari", "firefox", "edge"].some(name => app.includes(name));
}

function normalizeEpisodeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (shouldStripQueryParam(parsed.hostname, parsed.pathname, key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/[#?].*$/, "").replace(/\/$/, "");
  }
}

function shouldStripQueryParam(hostname: string, pathname: string, key: string): boolean {
  const lower = key.toLowerCase();
  if (/^utm_/i.test(key) || ["ref", "fbclid", "gclid", "sourceid", "ie", "oq", "gs_lcrp"].includes(lower)) return true;
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtube.com" && pathname === "/watch") return lower !== "v";
  if (host === "google.com" && pathname === "/search") return lower !== "q";
  return false;
}

function titleForEpisode(kind: ActivityEpisodeDraft["identity_kind"], app: string | undefined, urls: string[], windowTitles: string[], records: StoredContextRecord[]): string {
  if (kind === "browser_url" && urls[0]) return `Browsing: ${readableUrl(urls[0])}`;
  const strongTitle = windowTitles.find(title => title.length > 2 && !/^screen ocr$/i.test(title));
  return [app, strongTitle].filter(Boolean).join(": ") || records.at(-1)?.content?.title || "Activity episode";
}

function deterministicSummary(title: string | undefined, records: StoredContextRecord[], duration: number): string {
  const count = records.length;
  const minutes = duration < 1 ? "<1m" : `${Math.round(duration)}m`;
  return `${title ?? "Activity"} across ${count} observation${count === 1 ? "" : "s"} over ${minutes}.`;
}

function keywordCandidates(records: StoredContextRecord[], context: { app?: string; domains: string[]; projects: string[]; windowTitles: string[] }): string[] {
  const values = [
    context.app,
    ...context.domains.map(domain => domain.replace(/^www\./, "")),
    ...context.projects.map(project => project.split(/[\\/]/).filter(Boolean).at(-1) ?? project),
    ...context.windowTitles.flatMap(title => title.split(/[\s·:|/-]+/).filter(part => part.length >= 3)),
    ...records.flatMap(record => [record.scope?.project, record.scope?.domain]),
  ].filter(isString);
  return unique(values.map(value => value.trim()).filter(value => value.length >= 2)).slice(0, 10);
}

function appendCompileEvent(store: ContextStore, views: Array<ContextView | StoredContextView>, recordsUsed: number, generatedAt: string): void {
  store.appendRuntimeEvent({
    event_type: "view_compiled",
    actor: "system",
    status: "completed",
    subject_type: "view",
    subject_id: views[0]?.id ?? "activity:episode:batch",
    plugin_id: ACTIVITY_EPISODE_COMPILER_ID,
    related_records: unique(views.flatMap(view => view.source_records ?? [])),
    related_views: views.map(view => view.id).filter(isString),
    payload: { view_type: ACTIVITY_EPISODE_VIEW_TYPE, records_used: recordsUsed, view_count: views.length, generated_at: generatedAt },
  });
}

function archiveStaleEpisodeViews(store: ContextStore, episodes: ActivityEpisodeDraft[], startTime: string, endTime: string, generatedAt: string): void {
  const activeIds = new Set(episodes.map(episode => episode.id));
  const stale = store.listViews({
    view_types: [ACTIVITY_EPISODE_VIEW_TYPE],
    active_only: true,
    limit: 0,
    timeWindow: { start_time: startTime, end_time: endTime },
  }).filter(view => !activeIds.has(view.id));
  for (const view of stale) {
    store.upsertView({
      ...view,
      status: "archived",
      metadata: { ...(view.metadata ?? {}), archived_reason: "activity_episode_recompiled", archived_at: generatedAt },
    });
  }
}

function recordTime(record: StoredContextRecord): string {
  return record.time?.observed_at ?? record.created_at;
}

function appOf(record: StoredContextRecord): string | undefined {
  return record.scope?.app ?? stringValue(record.payload?.app_name) ?? stringValue(record.payload?.app) ?? (record.source.type === "browser" ? "Browser" : undefined);
}

function urlOf(record: StoredContextRecord): string | undefined {
  return record.content?.url ?? stringValue(record.payload?.browser_url) ?? stringValue(record.payload?.reported_url);
}

function domainOf(record: StoredContextRecord, preferUrl = false): string | undefined {
  const url = urlOf(record);
  if (preferUrl && url) {
    try { return new URL(url).hostname; } catch { /* fall through */ }
  }
  if (record.scope?.domain) return record.scope.domain;
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

function windowTitleOf(record: StoredContextRecord): string | undefined {
  const title = stringValue(record.payload?.window_name) ?? stringValue(record.payload?.window_title) ?? record.content?.title;
  return title?.replace(/\s+/g, " ").trim();
}

function textOf(record: StoredContextRecord): string | undefined {
  const text = record.content?.text ?? stringValue(record.payload?.text);
  return text?.replace(/\s+/g, " ").trim();
}

function isNoisyBrowserUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host.endsWith("googlesyndication.com")) return true;
    if (host.endsWith("doubleclick.net")) return true;
    if (host.endsWith("googleadservices.com")) return true;
    if (host === "ogs.google.com" && parsed.pathname.includes("/widget/")) return true;
    if (parsed.protocol === "chrome:" || parsed.protocol === "chrome-untrusted:") return true;
    return false;
  } catch {
    return false;
  }
}

function isScreenpipeRecorderRecord(record: StoredContextRecord): boolean {
  if (record.source.type !== "screenpipe") return false;
  const app = (appOf(record) ?? "").toLowerCase();
  if (!["terminal", "warp", "iterm", "iterm2"].some(termApp => app.includes(termApp))) return false;
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${windowTitleOf(record) ?? ""}`.toLowerCase();
  return text.includes("screenpipe") && (text.includes("screenpipe record") || text.includes("screenpipe@") || text.includes("cli-darwin"));
}

function isInfoTimelineSelfObservation(record: StoredContextRecord): boolean {
  const url = urlOf(record);
  if (url) {
    try {
      const parsed = new URL(url);
      if (["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "5177") return true;
    } catch {
      // Fall through to text-based detection.
    }
  }
  const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}\n${stringValue(record.payload?.text) ?? ""}`.toLowerCase();
  return text.includes("info runtime") || (text.includes("timeline") && text.includes("live sync"));
}

function relatedFrameRecords(episodeRecords: StoredContextRecord[], frameRecords: StoredContextRecord[], identityKind: ActivityEpisodeDraft["identity_kind"]): StoredContextRecord[] {
  if (!episodeRecords.length) return [];
  const directIds = new Set(episodeRecords.map(record => record.id));
  const startMs = Math.min(...episodeRecords.map(record => Date.parse(recordTime(record))).filter(Number.isFinite));
  const endMs = Math.max(...episodeRecords.map(record => Date.parse(recordTime(record))).filter(Number.isFinite));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const apps = new Set(episodeRecords.map(record => normalizeApp(appOf(record))).filter(isString));
  const urls = new Set(episodeRecords.map(urlOf).filter(isString).map(normalizeEpisodeUrl));
  const domains = new Set(episodeRecords.map(record => domainOf(record, identityKind === "browser_url")).filter(isString).map(domain => domain.replace(/^www\./, "").toLowerCase()));
  const marginMs = 90_000;
  return frameRecords.filter(record => {
    if (directIds.has(record.id)) return false;
    const time = Date.parse(recordTime(record));
    if (!Number.isFinite(time) || time < startMs - marginMs || time > endMs + marginMs) return false;
    if (identityKind === "browser_url") {
      const url = urlOf(record);
      if (url && urls.has(normalizeEpisodeUrl(url))) return true;
      const domain = domainOf(record, true)?.replace(/^www\./, "").toLowerCase();
      return Boolean(domain && domains.has(domain));
    }
    const app = normalizeApp(appOf(record));
    return Boolean(app && apps.has(app));
  });
}

function relatedVisualFrameViews(episodeRecords: StoredContextRecord[], visualFrameViews: StoredContextView[], identityKind: ActivityEpisodeDraft["identity_kind"]): Array<{ id: string; frame_id: string | number; title?: string }> {
  if (!episodeRecords.length || !visualFrameViews.length) return [];
  const episodeRange = recordRange(episodeRecords);
  if (!episodeRange) return [];
  const apps = new Set(episodeRecords.map(record => normalizeApp(appOf(record))).filter(isString));
  const domains = new Set(episodeRecords.map(record => domainOf(record, identityKind === "browser_url")).filter(isString).map(domain => domain.replace(/^www\./, "").toLowerCase()));
  const projects = new Set(episodeRecords.flatMap(record => [record.scope?.project, record.scope?.project_path, stringValue(record.payload?.cwd)]).filter(isString).map(value => value.toLowerCase()));
  const marginMs = 6 * 60_000;
  const matched = visualFrameViews.flatMap(view => {
    const frameId = visualFrameIdOf(view);
    const range = viewTimeRange(view);
    if (frameId === undefined || !range) return [];
    if (range.end < episodeRange.start - marginMs || range.start > episodeRange.end + marginMs) return [];
    if (!visualFrameMatchesEpisode(view, { apps, domains, projects, identityKind })) return [];
    return [{ id: view.id, frame_id: frameId, title: view.title }];
  });
  if (matched.length) return matched.slice(0, 8);
  return nearestVisualFrameViews(visualFrameViews, episodeRange).slice(0, 1).flatMap(view => {
    const frameId = visualFrameIdOf(view);
    return frameId === undefined ? [] : [{ id: view.id, frame_id: frameId, title: view.title }];
  });
}

function visualFrameMatchesEpisode(view: StoredContextView, context: { apps: Set<string>; domains: Set<string>; projects: Set<string>; identityKind: ActivityEpisodeDraft["identity_kind"] }): boolean {
  const content = view.content ?? {};
  const subject = recordValue(content.subject);
  const app = normalizeApp(stringValue(content.app) ?? stringValue(subject?.app));
  if (app && context.apps.has(app)) return true;
  const hay = `${view.title ?? ""} ${view.summary ?? ""} ${stringValue(content.topic) ?? ""} ${stringValue(content.project) ?? ""} ${stringArray(content.visible_files).join(" ")} ${stringArray(content.visible_text_lines).join(" ")}`.toLowerCase();
  if (context.identityKind === "browser_url" && [...context.domains].some(domain => hay.includes(domain) || (domain === "localhost" && hay.includes("localhost")))) return true;
  if ([...context.projects].some(project => project && hay.includes(project))) return true;
  return true;
}

function recordRange(records: StoredContextRecord[]): { start: number; end: number } | undefined {
  const times = records.map(record => Date.parse(recordTime(record))).filter(Number.isFinite);
  if (!times.length) return undefined;
  return { start: Math.min(...times), end: Math.max(...times) };
}

function viewTimeRange(view: StoredContextView): { start: number; end: number } | undefined {
  const scope = view.scope?.time_range as Record<string, unknown> | undefined;
  const start = Date.parse(stringValue(scope?.start) ?? view.created_at ?? view.updated_at ?? "");
  const end = Date.parse(stringValue(scope?.end) ?? view.updated_at ?? view.created_at ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function nearestVisualFrameViews(views: StoredContextView[], range: { start: number; end: number }): StoredContextView[] {
  const center = (range.start + range.end) / 2;
  return views
    .map(view => ({ view, range: viewTimeRange(view) }))
    .filter((item): item is { view: StoredContextView; range: { start: number; end: number } } => Boolean(item.range))
    .sort((a, b) => distanceToRange(center, a.range) - distanceToRange(center, b.range))
    .map(item => item.view);
}

function distanceToRange(point: number, range: { start: number; end: number }) {
  if (point >= range.start && point <= range.end) return 0;
  return Math.min(Math.abs(point - range.start), Math.abs(point - range.end));
}

function visualFrameIdOf(view: StoredContextView): string | number | undefined {
  const content = view.content ?? {};
  const direct = content.frame_id ?? content.frameId;
  if (typeof direct === "string" || typeof direct === "number") return direct;
  const signals = recordValue(content.signals);
  const ids = signals?.frame_ids;
  if (Array.isArray(ids)) return ids.find((id): id is string | number => typeof id === "string" || typeof id === "number");
  return undefined;
}

function uniqueFrameIds(records: StoredContextRecord[]): Array<string | number> {
  const out: Array<string | number> = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const raw of frameIdsOfRecord(record)) {
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      const key = String(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
  }
  return out;
}

function frameIdsOfRecord(record: StoredContextRecord): Array<string | number> {
  const out: Array<string | number> = [];
  const payload = record.payload ?? {};
  const content = record.content as Record<string, unknown> | undefined ?? {};
  for (const source of [payload.frame_ids, payload.frameIds, content.frame_ids, content.frameIds]) {
    if (!Array.isArray(source)) continue;
    for (const value of source) if (typeof value === "string" || typeof value === "number") out.push(value);
  }
  for (const value of [payload.frame_id, payload.frameId, content.frame_id, content.frameId]) {
    if (typeof value === "string" || typeof value === "number") out.push(value);
  }
  return out;
}

function readableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/\/$/, "");
    return `${parsed.hostname}${path && path !== "/" ? path.slice(0, 80) : ""}`;
  } catch {
    return url.slice(0, 120);
  }
}

function normalizeApp(app?: string): string | undefined {
  return app?.toLowerCase().replace(/\s+/g, " ").trim() || undefined;
}

function commonString(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function compactContent(content?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!content) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["summary", "active_lanes", "project", "current_status", "preferences", "workflow_patterns", "markdown"] as const) {
    if (content[key] !== undefined) out[key] = typeof content[key] === "string" ? String(content[key]).slice(0, 1200) : content[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function stableKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function unique<T>(values: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString).map(item => item.trim()).filter(Boolean) : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isMeaningfulHelpKeyword(keyword: string): boolean {
  if (keyword.length < 5) return false;
  return !new Set([
    "chrome",
    "browser",
    "terminal",
    "screenpipe",
    "localhost",
    "local",
    "project",
  ]).has(keyword);
}

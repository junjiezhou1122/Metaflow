import type { AttentionDecision, Capability, ContextSignal, Program, ProgramRunResult } from "../types.js";
import type { ContextStore } from "@info/core";
import type { ContextBrokerPack, ContextQuery, ContextView, StoredContextRecord, StoredContextView } from "@info/core";
import { activeContextView } from "@info/core";
import { filterRecordsForPlugin } from "@info/core";
import { readPluginManifest } from "@info/core";

const BROWSER_SCHEMAS = new Set([
  "observation.browser_page_saved",
  "observation.browser_page_snapshot",
  "observation.browser_search_query",
  "observation.browser_text_selected",
  "observation.browser_text_copied",
  "observation.browser_ambient_requested",
]);

const BROWSER_AMBIENT_CAPABILITIES = ["capability.agent_task.submit", "capability.browser_ambient.explore"];

type BrowserAmbientAgentOutput = {
  summary: string;
  analysis?: string;
  key_points?: string[];
  tags?: string[];
  confidence: number;
};

export const browserAmbientProgram: Program = {
  id: "program.browser_ambient",
  title: "Browser Ambient",
  purpose: "Delegate browser page analysis through AgentTask and write a reusable View; deterministic browser_page analysis is only a fallback.",
  version: "0.1.0",
  default_speed: "glance",
  default_autonomy: "suggest",
  capabilities: BROWSER_AMBIENT_CAPABILITIES,
  applications: ["browser.popup", "browser.sidebar"],
  produces: ["analysis.browser_agent_task", "analysis.browser_page"],
  learns_from: ["feedback.analysis.opened", "feedback.analysis.dismissed", "behavior.browser.opened_source"],

  attention(signal: ContextSignal, store: ContextStore): AttentionDecision {
    if (signal.object_kind !== "observation") return { action: "ignore", reason: "browser ambient starts from observations", confidence: 0.9 };
    if (!BROWSER_SCHEMAS.has(signal.object_type) && signal.source !== "browser") return { action: "ignore", reason: "not browser context", confidence: 0.9 };
    if (!signal.url) return { action: "ignore", reason: "browser object has no URL", confidence: 0.8 };
    if (signal.object_type === "observation.browser_ambient_requested") {
      return { action: "run", reason: "user explicitly requested browser ambient exploration", confidence: 1, speed: "glance", capability_ids: BROWSER_AMBIENT_CAPABILITIES };
    }

    const kind = classifyUrl(signal.url, signal.title ?? "", signal.text_preview ?? "");
    const showLessMemory = surfacingMemoryForBrowserAnalysis(signal, store, "show_less");
    if (showLessMemory) {
      return {
        action: "defer",
        reason: `surfacing memory prefers less automatic browser analysis (${showLessMemory.id})`,
        confidence: showLessMemory.confidence ?? 0.6,
        attention_influences: [surfacingMemoryInfluence(showLessMemory)],
      };
    }
    const showMoreMemory = surfacingMemoryForBrowserAnalysis(signal, store, "show_more");
    if (kind.kind === "other" && signal.object_type !== "observation.browser_page_saved") {
      if (showMoreMemory) {
        return {
          action: "run",
          reason: `surfacing memory prefers more browser analysis (${showMoreMemory.id})`,
          confidence: Math.max(0.6, showMoreMemory.confidence ?? 0.6),
          speed: "glance",
          capability_ids: BROWSER_AMBIENT_CAPABILITIES,
          attention_influences: [surfacingMemoryInfluence(showMoreMemory)],
        };
      }
      return { action: "defer", reason: "browser page is not an obvious ambient exploration target", confidence: 0.35 };
    }
    return { action: "run", reason: `browser ambient target: ${kind.kind}`, confidence: kind.confidence, speed: "glance", capability_ids: BROWSER_AMBIENT_CAPABILITIES };
  },

  async run({ signal, store, runCapability, buildContextPack }): Promise<ProgramRunResult> {
    const agentTaskResult = await runCapability("capability.agent_task.submit", {
      payload: {
        task: buildBrowserAgentTask(signal, buildContextPack),
      },
    });
    const agentTaskViews = (agentTaskResult.written_views ?? [])
      .map(id => store.getView(id))
      .filter((view): view is StoredContextView => Boolean(view));
    if (agentTaskResult.ok && agentTaskViews.length) {
      return {
        ok: true,
        reason: "delegated browser ambient analysis to capability.agent_task.submit",
        views: agentTaskViews,
        diagnostics: {
          agent_task: { ok: true, reason: agentTaskResult.reason, written_views: agentTaskResult.written_views, diagnostics: agentTaskResult.diagnostics },
          fallback_used: false,
        },
      };
    }

    const capabilityResult = await runCapability("capability.browser_ambient.explore");
    if (!capabilityResult.ok) return { ok: false, reason: capabilityResult.reason, diagnostics: capabilityResult.diagnostics };
    const diagnostics = readBrowserAmbientDiagnostics(capabilityResult.diagnostics);
    if (!diagnostics) return { ok: false, reason: "browser ambient capability returned invalid diagnostics", diagnostics: capabilityResult.diagnostics };

    const record = store.getRecord(signal.object_id);
    if (!record) return { ok: false, reason: `source record not found: ${signal.object_id}` };
    const nearby = diagnostics.nearby_record_ids
      .map(id => store.getRecord(id))
      .filter((item): item is StoredContextRecord => Boolean(item));
    const agent = diagnostics.agent;
    const classification = diagnostics.classification;
    const analysis = buildBrowserAmbientView(record, classification, nearby, agent.output, agent.mode);
    return {
      ok: true,
      reason: `created fallback browser page analysis for ${classification.kind}${agent.used ? ` with ${agent.mode ?? "local-agent"}` : ""}`,
      views: [analysis],
      diagnostics: {
        classification,
        nearby_records: nearby.length,
        agent_task: { ok: agentTaskResult.ok, reason: agentTaskResult.reason, written_views: agentTaskResult.written_views, diagnostics: agentTaskResult.diagnostics },
        fallback_used: true,
        local_agent: { used: agent.used, mode: agent.mode, error: agent.error, events: agent.events },
      },
    };
  },
};

export const browserAmbientExploreCapability: Capability = {
  id: "capability.browser_ambient.explore",
  title: "Browser Ambient Explore",
  purpose: "Classify and analyze a browser observation for the Browser Ambient Program.",
  version: "0.1.0",
  mode: "agent",
  default_speed: "glance",
  default_autonomy: "suggest",
  produces: ["browser_ambient.analysis_payload"],

  async run({ signal, store, context_plugin_id }) {
    const record = store.getRecord(signal.object_id);
    if (!record) return { ok: false, reason: `source record not found: ${signal.object_id}` };
    const plugin = context_plugin_id ? readPluginManifest(context_plugin_id) : undefined;
    if (context_plugin_id && !filterRecordsForPlugin([record], plugin).length) return { ok: false, reason: `plugin cannot access browser ambient source: ${context_plugin_id}` };
    const classification = classifyUrl(record.content?.url ?? "", record.content?.title ?? "", record.content?.text ?? "");
    const nearby = filterRecordsForPlugin(relatedBrowserRecords(record, store), plugin);
    return {
      ok: true,
      reason: `analyzed browser page as ${classification.kind}`,
      diagnostics: {
        classification,
        nearby_record_ids: nearby.map(item => item.id),
        agent: { used: false, mode: "deterministic" },
      },
    };
  },
};

type BrowserAmbientDiagnostics = {
  classification: BrowserPageClass;
  nearby_record_ids: string[];
  agent: {
    used: boolean;
    mode?: string;
    output?: BrowserAmbientAgentOutput;
    error?: string;
    events?: unknown[];
  };
};

type BrowserPageClass = {
  kind: "github_repo" | "github_issue" | "github_pr" | "pdf" | "search" | "docs" | "article" | "other";
  confidence: number;
  reasons: string[];
};

function classifyUrl(url: string, title: string, text: string): BrowserPageClass {
  const reasons: string[] = [];
  let u: URL | undefined;
  try { u = new URL(url); } catch {}
  const host = u?.hostname.replace(/^www\./, "") ?? "";
  const path = u?.pathname ?? "";
  const hay = `${title}\n${url}\n${text.slice(0, 2000)}`.toLowerCase();

  if (host === "github.com") {
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "issues") return { kind: "github_issue", confidence: 0.96, reasons: ["github issue URL"] };
    if (parts.length >= 4 && parts[2] === "pull") return { kind: "github_pr", confidence: 0.96, reasons: ["github pull request URL"] };
    if (parts.length >= 2) return { kind: "github_repo", confidence: 0.92, reasons: ["github repository URL"] };
  }
  if (/\.pdf($|[?#])/i.test(url) || /pdf/i.test(u?.pathname ?? "")) return { kind: "pdf", confidence: 0.9, reasons: ["PDF URL"] };
  if (isSearchUrl(host, path, u?.search ?? "")) return { kind: "search", confidence: 0.86, reasons: ["search result URL"] };
  if (/docs|documentation|developer|api|reference|guide/.test(host + path + title.toLowerCase())) {
    reasons.push("docs-like URL/title");
    return { kind: "docs", confidence: 0.74, reasons };
  }
  if (/paper|blog|article|post|essay|arxiv|research|whitepaper/.test(host + path + title.toLowerCase())) {
    reasons.push("article/research-like URL/title");
    return { kind: "article", confidence: 0.68, reasons };
  }
  if (/github|repository|readme|install|api|sdk|architecture|runtime|agent|model|paper|abstract/.test(hay)) {
    reasons.push("technical content keywords");
    return { kind: "article", confidence: 0.58, reasons };
  }
  return { kind: "other", confidence: 0.25, reasons: ["no strong browser ambient signal"] };
}

function isSearchUrl(host: string, path: string, search: string): boolean {
  if (!search) return false;
  if (/(^|\.)google\./.test(host) && search.includes("q=")) return true;
  if (host === "bing.com" && search.includes("q=")) return true;
  if (host === "duckduckgo.com" && search.includes("q=")) return true;
  if (host === "baidu.com" && (search.includes("wd=") || search.includes("word="))) return true;
  if (host === "github.com" && path === "/search" && search.includes("q=")) return true;
  return false;
}


type BuildContextPack = (query?: ContextQuery) => ContextBrokerPack;

function buildBrowserAgentTask(signal: ContextSignal, buildContextPack: BuildContextPack) {
  const goal = [
    "Analyze this browser observation through Info's generic AgentTask boundary.",
    "Focus on concise reusable analysis for the user's current work.",
    "If the page is public and the captured text is thin, you may use your own local runtime tools/skills to fetch read-only public context.",
    "For YouTube pages, prefer read-only metadata/transcript retrieval when available, for example `opencli youtube video <url> -f json` and `opencli youtube transcript <url> --mode raw -f json`; raw transcript mode is preferred because grouped/default caption fetch can fail on auto-caption URLs.",
    "Do not perform account-changing actions such as like, subscribe, comment, post, or reply.",
    "Do not modify files. Do not return next_actions, tasks, tool plans, or file diffs.",
  ].join("\n");
  const pack = buildContextPack({
    goal,
    include_records: true,
    include_views: true,
    include_events: false,
    allow_external_llm: true,
    limit: 8,
  });
  return {
    runtime: process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME || "claude_code",
    goal,
    context_pack: {
      markdown: pack.markdown,
      sources: pack.sources,
      diagnostics: pack.diagnostics,
    },
    constraints: {
      write_policy: "views_only",
      no_file_edits: true,
    },
    output_contract: {
      view_type: "analysis.browser_agent_task",
      title: `Browser agent analysis: ${signal.title ?? signal.url ?? signal.object_id}`,
      purpose: "Generic agent runtime output for browser ambient exploration.",
    },
  };
}

function surfacingMemoryForBrowserAnalysis(signal: ContextSignal, store: ContextStore, preference: "show_less" | "show_more") {
  return store.listViews({ view_types: ["memory.surfacing_preference"], active_only: true, limit: 20 })
    .filter(activeContextView)
    .find(view => {
      if (view.content?.preference !== preference) return false;
      if (!browserAmbientTargetViewTypes().has(String(view.content?.target_view_type))) return false;
      if (view.scope?.domain && view.scope.domain !== signal.domain) return false;
      return (view.confidence ?? 0) >= 0.6;
    });
}

function surfacingMemoryInfluence(memory: ContextView) {
  return {
    kind: "memory.surfacing_preference",
    view_id: memory.id,
    preference: String(memory.content?.preference ?? ""),
    target_view_type: String(memory.content?.target_view_type ?? ""),
  };
}

function browserAmbientTargetViewTypes() {
  return new Set(["analysis.browser_page", "analysis.browser_agent_task"]);
}

function relatedBrowserRecords(record: StoredContextRecord, store: ContextStore): StoredContextRecord[] {
  const domain = record.scope?.domain;
  const now = Date.parse(record.time?.observed_at ?? record.created_at);
  return store.recent(40)
    .filter(item => item.id !== record.id)
    .filter(item => item.source.type === "browser" || item.source.connector === "chrome-extension")
    .filter(item => scopeCompatible(record.scope, item.scope))
    .filter(item => {
      if (domain && item.scope?.domain === domain) return true;
      const t = Date.parse(item.time?.observed_at ?? item.created_at);
      return Number.isFinite(now) && Number.isFinite(t) && Math.abs(now - t) <= 30 * 60_000;
    })
    .slice(0, 8);
}

function scopeCompatible(target?: StoredContextRecord["scope"], source?: StoredContextRecord["scope"]): boolean {
  if (!target || !source) return true;
  for (const key of ["project", "project_path", "repo", "domain", "app", "session"] as const) {
    if (target[key] && source[key] && target[key] !== source[key]) return false;
  }
  return true;
}

function buildBrowserAmbientView(record: StoredContextRecord, classification: BrowserPageClass, nearby: StoredContextRecord[], agentOutput?: BrowserAmbientAgentOutput, agentMode?: string): ContextView {
  const now = new Date().toISOString();
  const url = record.content?.url ?? "";
  const title = record.content?.title ?? (url || "Browser page");
  const pageText = (record.content?.text ?? "").replace(/\s+/g, " ").trim();
  const pageSummary = agentOutput?.summary || summarizeText(pageText);
  const keyPoints = agentOutput?.key_points?.length ? agentOutput.key_points : deterministicKeyPoints(classification, record, nearby);
  const id = `analysis:browser-page:${stableKey(url || record.id)}`;
  return {
    id,
    view_type: "analysis.browser_page",
    title: `Browser analysis: ${title}`.slice(0, 180),
    summary: pageSummary || keyPoints[0] || `Browser page analysis candidate: ${classification.kind}`,
    status: "candidate",
    source_records: [record.id, ...nearby.map(r => r.id)],
    compiler: { id: "program.browser_ambient", version: "0.1.0", mode: agentOutput ? "llm" : "deterministic" },
    purpose: "Reusable browser page analysis generated when the user asks Info to explore the current page.",
    scope: { domain: record.scope?.domain, app: record.scope?.app, project: record.scope?.project, project_path: record.scope?.project_path, time_range: { start: record.time?.observed_at, end: now }, plugin_id: "program.browser_ambient" },
    content: {
      page: { title, url, domain: record.scope?.domain, kind: classification.kind },
      classification,
      page_summary: pageSummary,
      analysis: agentOutput?.analysis,
      key_points: keyPoints,
      tags: agentOutput?.tags,
      agent_summary: agentOutput?.summary,
      related_recent_pages: nearby.map(item => ({ id: item.id, title: item.content?.title, url: item.content?.url, observed_at: item.time?.observed_at })),
      generated_for: "manual_browser_ambient_button",
    },
    confidence: Math.max(classification.confidence, agentOutput?.confidence ?? 0),
    stability: "session",
    lossiness: "medium",
    privacy: { level: record.privacy?.level ?? "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    metadata: { source_url: url, source_schema: record.schema.name, browser_ambient_version: "0.1.0", local_agent: agentOutput ? (agentMode ?? "claude-code") : "deterministic" },
  };
}

function summarizeText(text: string): string {
  if (!text) return "No page text captured yet.";
  const first = text.split(/(?<=[.!?。！？])\s+/).find(s => s.length >= 80) ?? text;
  return first.slice(0, 700);
}

function deterministicKeyPoints(classification: BrowserPageClass, record: StoredContextRecord, nearby: StoredContextRecord[]): string[] {
  const title = record.content?.title ?? record.content?.url ?? "this page";
  const points = [`Captured browser page: ${title}`, `Classified as ${classification.kind} (${classification.confidence})`];
  if (classification.reasons.length) points.push(`Classification evidence: ${classification.reasons.join(", ")}`);
  if (nearby.length) points.push(`Related recent browser observations: ${nearby.length}`);
  return points;
}

function readBrowserAmbientDiagnostics(value: Record<string, unknown> | undefined): BrowserAmbientDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const classification = value.classification;
  const nearbyRecordIds = value.nearby_record_ids;
  const agent = value.agent;
  if (!isBrowserPageClass(classification)) return undefined;
  if (!Array.isArray(nearbyRecordIds) || !nearbyRecordIds.every(item => typeof item === "string")) return undefined;
  if (!agent || typeof agent !== "object" || typeof (agent as { used?: unknown }).used !== "boolean") return undefined;
  return {
    classification,
    nearby_record_ids: nearbyRecordIds,
    agent: agent as BrowserAmbientDiagnostics["agent"],
  };
}

function isBrowserPageClass(value: unknown): value is BrowserPageClass {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BrowserPageClass>;
  return (
    typeof item.kind === "string" &&
    ["github_repo", "github_issue", "github_pr", "pdf", "search", "docs", "article", "other"].includes(item.kind) &&
    typeof item.confidence === "number" &&
    Array.isArray(item.reasons) &&
    item.reasons.every(reason => typeof reason === "string")
  );
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

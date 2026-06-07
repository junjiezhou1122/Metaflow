import type { ContextView, StoredContextView } from "@info/core";
import { activeContextView } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";
import { analysisTextFromView, isGenericAgentAnalysisView, keyPointsFromView } from "@info/core";

const INPUT_VIEWS = new Set(["analysis.browser_page", "analysis.repo", "extraction.pdf_text"]);

export const researchShadowProgram: Program = {
  id: "program.research_shadow",
  title: "Research Shadow",
  purpose: "Follow research-like context and compile reusable research briefs.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "suggest",
  capabilities: ["context.research.summarize"],
  applications: ["research.inbox", "agent.context_pack"],
  produces: ["brief.research"],
  learns_from: ["feedback.research_brief.useful", "feedback.research_brief.dismissed"],

  attention(signal: ContextSignal, store): AttentionDecision {
    if (signal.object_kind !== "view") return { action: "ignore", reason: "research shadow consumes derived Views", confidence: 0.9 };
    const view = store.getView(signal.object_id);
    if (!view || !activeContextView(view)) return { action: "ignore", reason: "inactive source View", confidence: 0.95 };
    if (!INPUT_VIEWS.has(signal.object_type) && !isGenericAgentAnalysisView(view)) return { action: "ignore", reason: "not a research shadow input View", confidence: 0.8 };

    const score = researchSignalScore(signal);
    if (score >= 0.5) return { action: "run", reason: `research-like View (${score})`, confidence: score, speed: "background" };
    return { action: "defer", reason: `weak research relevance (${score})`, confidence: score };
  },

  run({ signal, store }): ProgramRunResult {
    const view = store.getView(signal.object_id);
    if (!view) return { ok: false, reason: `source view not found: ${signal.object_id}` };
    const brief = buildResearchBrief(view);
    return {
      ok: true,
      reason: `compiled research brief from ${view.view_type}`,
      views: [brief],
      diagnostics: {
        input_view_type: view.view_type,
        source_records: view.source_records?.length ?? 0,
        source_view_id: view.id,
      },
    };
  },
};

function buildResearchBrief(source: StoredContextView): ContextView {
  const title = source.title?.replace(/^Browser analysis:\s*/i, "") || source.summary || source.id;
  const keyPoints = keyPointsFromView(source, 8);
  const tags = arrayOfStrings(source.content?.tags).slice(0, 12);
  const analysis = analysisTextFromView(source);
  const id = `brief:research:${stableKey([source.scope?.domain, source.scope?.repo, source.id].filter(Boolean).join(":"))}`;

  return {
    id,
    view_type: "brief.research",
    title: `Research brief: ${title}`.slice(0, 180),
    summary: `Research synthesis from ${title}`.slice(0, 300),
    status: "candidate",
    source_records: source.source_records,
    source_views: [source.id],
    compiler: { id: "program.research_shadow", version: "0.1.0", mode: "deterministic" },
    purpose: "Reusable research brief compiled from circulating analysis Views.",
    scope: {
      domain: source.scope?.domain,
      repo: source.scope?.repo,
      project: source.scope?.project,
      project_path: source.scope?.project_path,
      app: source.scope?.app,
      plugin_id: "program.research_shadow",
    },
    content: {
      source_view_type: source.view_type,
      source_view_id: source.id,
      analysis,
      key_points: keyPoints,
      tags,
      evidence: (source.source_records ?? []).map(id => ({ id, kind: "source_record" })),
    },
    confidence: Math.max(0.42, Math.min(0.88, source.confidence ?? 0.6)),
    stability: "session",
    lossiness: "medium",
    privacy: source.privacy,
    metadata: { source_view_id: source.id, source_compiler: source.compiler?.id },
  };
}

function researchSignalScore(signal: ContextSignal): number {
  let score = 0;
  const hay = [signal.title, signal.text_preview, signal.url, ...(signal.keywords ?? []), ...(signal.topics ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/research|paper|pdf|arxiv|article|architecture|runtime|context|agent/.test(hay)) score += 0.45;
  if (signal.url?.endsWith(".pdf") || /pdf|paper|arxiv/.test(hay)) score += 0.25;
  if (signal.object_type === "analysis.browser_page") score += 0.15;
  if (signal.object_type === "extraction.pdf_text") score += 0.2;
  if (signal.confidence !== undefined) score += Math.min(0.15, Math.max(0, signal.confidence) * 0.15);
  return Number(Math.min(1, score).toFixed(3));
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

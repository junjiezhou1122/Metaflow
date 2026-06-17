import { ContextStore } from "@info/core";
import type { ContextSourceReference, WorkActivity, Interruption } from "./types.js";
import type { ContextWindowSnapshot } from "./context-window.js";

export type ClassifyResult = {
  mainActivities: WorkActivity[];
  interruptions: Interruption[];
  diagnostics: {
    totalActivities: number;
    totalInterruptions: number;
    classificationReasons: string[];
  };
};

/**
 * Classify work vs interruptions from a context window.
 * Deterministic: no LLM required.
 * Heuristic: work is longer duration, productive source types, or known coding signals;
 * interruptions are short duration, communication, browsing, or explicitly tagged.
 */
export function classifyWorkAndInterruptions(
  window: ContextWindowSnapshot
): ClassifyResult {
  const mainActivities: WorkActivity[] = [];
  const interruptions: Interruption[] = [];
  const classificationReasons: string[] = [];

  for (const record of window.records) {
    const schema = record.schema.name;
    const isCommunication =
      schema.includes("message") ||
      schema.includes("slack") ||
      schema.includes("wechat") ||
      schema.includes("email") ||
      record.scope?.app?.toLowerCase().includes("wechat");

    const browserUrl = String(record.content?.url ?? "");
    const browserDomain = String(record.scope?.domain ?? "");
    const isKnownWorkBrowser =
      browserUrl.includes("github.com") ||
      browserDomain.includes("github.com") ||
      browserDomain.includes("docs.") ||
      browserDomain.includes("localhost");
    const isBrowsing =
      schema.includes("browser_page") && !isKnownWorkBrowser;

    const isExplicitInterruption = record.payload?.interruption === true || record.payload?.distraction === true;

    if (isExplicitInterruption) {
      interruptions.push(recordToInterruption(record));
      classificationReasons.push(`${record.id}: explicit interruption flag`);
      continue;
    }

    if (isCommunication || isBrowsing) {
      if (isCommunication) {
        classificationReasons.push(`${record.id}: communication schema treated as interruption`);
      }
      if (isBrowsing) {
        classificationReasons.push(`${record.id}: non-github browsing treated as interruption`);
      }
      interruptions.push(recordToInterruption(record));
      continue;
    }

    mainActivities.push(recordToWorkActivity(record));
  }

  // If no main activity found but there are views, treat those as main activities
  for (const view of window.views.filter((v) => !window.records.some((r) => r.id === v.id))) {
    if (view.view_type === "work.focus_set" || view.view_type.startsWith("work.")) {
      mainActivities.push(viewToWorkActivity(view));
    }
  }

  return {
    mainActivities,
    interruptions,
    diagnostics: {
      totalActivities: mainActivities.length,
      totalInterruptions: interruptions.length,
      classificationReasons,
    },
  };
}

function recordToInterruption(record: { id: string; schema: { name: string }; source: { type: string }; content?: { title?: string; text?: string } }): Interruption {
  return {
    id: record.id,
    type: record.schema.name,
    sourceType: record.source.type,
    title: record.content?.title,
    description: record.content?.text,
    durationMinutes: undefined,
    severity: "normal",
  };
}

function recordToWorkActivity(record: { id: string; schema: { name: string }; source: { type: string }; content?: { title?: string; text?: string } }): WorkActivity {
  return {
    id: record.id,
    type: record.schema.name,
    sourceType: record.source.type,
    title: record.content?.title,
    description: record.content?.text,
    durationMinutes: undefined,
    interruptionRisk: "low",
  };
}

function viewToWorkActivity(view: { id: string; view_type: string; title?: string; summary?: string }): WorkActivity {
  return {
    id: view.id,
    type: view.view_type,
    sourceType: "view",
    title: view.title,
    description: view.summary,
    durationMinutes: undefined,
    interruptionRisk: "low",
  };
}

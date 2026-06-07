import { runLanguageLearningPlugin } from "@info/core";
import type { AttentionDecision, ContextSignal, Program, ProgramRunResult } from "../types.js";
import type { ContextStore } from "@info/core";

const LANGUAGE_SCHEMAS = new Set([
  "observation.browser_page_snapshot",
  "observation.browser_page_saved",
  "observation.browser_text_selected",
  "observation.browser_text_copied",
  "observation.browser_search_query",
  "observation.screenpipe_activity",
  "observation.screenpipe_input_event",
  "observation.ai_chat",
  "extraction.reader_snapshot",
]);

export const languageLearningProgram: Program = {
  id: "program.language_learning",
  title: "Language Learning",
  purpose: "Turn the user's real English exposure into personalized learning views.",
  version: "0.1.0",
  default_speed: "background",
  default_autonomy: "draft",
  capabilities: ["language.detect", "vocabulary.extract", "review.schedule"],
  applications: ["app.language_dashboard", "browser.tooltip"],
  produces: ["memory.language.vocabulary_exposure", "app.language.learning_pack"],
  learns_from: ["feedback.language.word_known", "feedback.language.review_completed", "behavior.language.card_skipped"],

  attention(signal: ContextSignal, _store: ContextStore): AttentionDecision {
    if (signal.object_kind === "view" && signal.object_type.startsWith("memory.language.")) {
      return { action: "ignore", reason: "own language memory view", confidence: 0.95 };
    }

    if (signal.object_type.startsWith("feedback.language.")) {
      return { action: "run", reason: "language feedback should update learning views", confidence: 0.9, speed: "background" };
    }

    const languageScore = signal.language === "en" ? 0.35 : englishish(signal) ? 0.22 : 0;
    const sourceScore = LANGUAGE_SCHEMAS.has(signal.object_type) || signal.source === "browser" || signal.source === "screenpipe" || signal.source === "reader" ? 0.28 : 0;
    const attentionScore = signal.object_type.includes("selected") || signal.object_type.includes("copied") || signal.object_type.includes("search_query") ? 0.22 : 0;
    const textScore = (signal.text_preview?.length ?? 0) >= 40 ? 0.15 : 0;
    const score = Number(Math.min(1, languageScore + sourceScore + attentionScore + textScore).toFixed(3));

    if (score >= 0.55) {
      return { action: "run", reason: `English exposure candidate (${score})`, confidence: score, speed: attentionScore ? "glance" : "background" };
    }
    if (score >= 0.35) {
      return { action: "defer", reason: `Possible English exposure but weak signal (${score})`, confidence: score };
    }
    return { action: "ignore", reason: `Not language-learning relevant (${score})`, confidence: score };
  },

  run({ store }): ProgramRunResult {
    const result = runLanguageLearningPlugin({ days: 7, limit: 120, write: false }, store);
    return {
      ok: result.ok,
      reason: `compiled ${result.views.length} language learning views from ${result.records_used} records`,
      views: result.views,
      diagnostics: {
        records_used: result.records_used,
        vocabulary_count: result.vocabulary.length,
        examples_count: result.examples.length,
        source: "program.language_learning",
      },
    };
  },
};

function englishish(signal: ContextSignal): boolean {
  const text = [signal.title, signal.text_preview, signal.url].filter(Boolean).join(" ");
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return letters >= 30 && letters > cjk * 2;
}

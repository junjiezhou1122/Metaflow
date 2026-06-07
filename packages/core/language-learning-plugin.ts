import { ContextStore } from "./store.js";
import { buildContextPack } from "./broker.js";
import type { ContextQuery, ContextView, StoredContextRecord, StoredContextView } from "./types.js";

export type LanguageLearningRunOptions = {
  days?: number;
  limit?: number;
  write?: boolean;
  min_count?: number;
};

export type LanguageLearningRunResult = {
  ok: boolean;
  generated_at: string;
  records_used: number;
  vocabulary: VocabularyCandidate[];
  examples: Array<{ word: string; sentence: string; record_id: string }>;
  views: StoredContextView[] | ContextView[];
  diagnostics: Record<string, unknown>;
};

type VocabularyCandidate = {
  word: string;
  count: number;
  score: number;
  examples: string[];
  source_records: string[];
};

type TextExposure = {
  id: string;
  kind: "record" | "view";
  source_type: string;
  schema_name?: string;
  view_type?: string;
  title?: string;
  text?: string;
  url?: string;
  payload?: Record<string, unknown>;
  source_records: string[];
};

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "into", "your", "you", "are", "was", "were", "will", "would", "could", "should", "have", "has", "had", "not", "but", "about", "what", "when", "where", "which", "there", "their", "then", "than", "them", "they", "our", "out", "all", "can", "just", "more", "some", "like", "use", "used", "using", "how", "why", "http", "https", "localhost", "function", "const", "return", "import", "export", "type", "interface", "true", "false", "null", "undefined",
  "example", "domain", "page", "browser", "observation", "snapshot", "published", "warning", "cached", "caching", "retry", "source", "title", "visible", "text",
]);

export function runLanguageLearningPlugin(options: LanguageLearningRunOptions = {}, store = new ContextStore()): LanguageLearningRunResult {
  const generatedAt = new Date().toISOString();
  store.appendRuntimeEvent({ event_type: "plugin_run_started", actor: "plugin", status: "started", subject_type: "plugin", subject_id: "language-learning", plugin_id: "language-learning", payload: { options } });
  const days = options.days ?? 7;
  const minCount = options.min_count ?? 2;
  const query: ContextQuery = {
    plugin_id: "language-learning",
    mode: "source",
    time_window: { minutes: days * 24 * 60 },
    limit: options.limit ?? 100,
    include_records: true,
    include_views: true,
    view_types: ["extraction.reader_snapshot"],
  };
  const pack = buildContextPack(query, store);
  const textExposures = [
    ...pack.records.map(recordTextExposure),
    ...pack.views.filter(view => view.view_type === "extraction.reader_snapshot").map(viewTextExposure),
  ].filter(item => extractText(item).length >= 20);
  const vocabulary = extractVocabulary(textExposures, minCount).slice(0, 30);
  const examples = vocabulary.slice(0, 12).flatMap(candidate => candidate.examples.slice(0, 1).map(sentence => ({
    word: candidate.word,
    sentence,
    record_id: candidate.source_records[0],
  })));
  const styleGuidance = outputEditStyleGuidance(store);

  const baseView = {
    compiler: { id: "language-learning-v0", version: "0.1.0", mode: "deterministic" as const },
    scope: { plugin_id: "language-learning", time_range: packTimeRange(days) },
    privacy: { level: "private" as const, retention: "normal" as const, allow_embedding: false, allow_llm_summary: false, allow_external_llm: false, allow_external_reader: false },
    status: "candidate" as const,
  };

  const vocabularyView: ContextView = {
    ...baseView,
    id: `memory:language:vocabulary-exposure:${dateKey(generatedAt)}`,
    view_type: "memory.language.vocabulary_exposure",
    title: `Language vocabulary exposure (${days}d)`,
    summary: vocabulary.slice(0, 10).map(v => `${v.word}×${v.count}`).join(", ") || "No vocabulary candidates found.",
    purpose: "Durable language-learning memory view compiled from recent text exposure.",
    source_records: [...new Set(vocabulary.flatMap(v => v.source_records))],
    content: { vocabulary, days, min_count: minCount },
    confidence: vocabulary.length ? 0.72 : 0.25,
    stability: "long_term",
    lossiness: "high",
  };

  const learningPackView: ContextView = {
    ...baseView,
    id: `app:language:learning-pack:${dateKey(generatedAt)}`,
    view_type: "app.language.learning_pack",
    title: `Adaptive language learning pack (${days}d)`,
    summary: renderLearningPackSummary(vocabulary),
    purpose: "User-facing learning material generated from personal context exposure without requiring WorkThread.",
    source_records: vocabularyView.source_records,
    source_views: [vocabularyView.id!, ...styleGuidance.map(item => item.memory_view_id)],
    content: { examples, story_prompt: buildStoryPrompt(vocabulary), focus_words: vocabulary.slice(0, 12).map(v => v.word), ...(styleGuidance.length ? { style_guidance: styleGuidance } : {}) },
    confidence: vocabulary.length ? 0.68 : 0.2,
    stability: "session",
    lossiness: "high",
  };

  const views = options.write ?? true
    ? [store.upsertView(vocabularyView), store.upsertView(learningPackView)]
    : [vocabularyView, learningPackView];

  const result: LanguageLearningRunResult = {
    ok: true,
    generated_at: generatedAt,
    records_used: textExposures.length,
    vocabulary,
    examples,
    views,
    diagnostics: {
      pack: pack.diagnostics,
      source_count: pack.records.length + pack.views.length,
      text_record_count: textExposures.length,
      reader_extraction_view_count: pack.views.filter(view => view.view_type === "extraction.reader_snapshot").length,
      style_guidance_count: styleGuidance.length,
      thread_required: false,
      external_llm_used: false,
    },
  };
  store.appendRuntimeEvent({
    event_type: "plugin_run_completed",
    actor: "plugin",
    status: "completed",
    subject_type: "plugin",
    subject_id: "language-learning",
    plugin_id: "language-learning",
    related_records: [...new Set(vocabulary.flatMap(v => v.source_records))],
    related_views: result.views.map(view => view.id!).filter(Boolean),
    payload: { records_used: result.records_used, vocabulary_count: result.vocabulary.length, views_written: result.views.length, external_llm_used: false },
  });
  return result;
}

function outputEditStyleGuidance(store: ContextStore): Array<{ memory_view_id: string; original_text?: string; edited_text?: string; reason?: string }> {
  const pack = buildContextPack({
    plugin_id: "language-learning",
    mode: "source",
    include_records: false,
    include_views: true,
    view_types: ["memory.output_edit_pattern"],
    limit: 12,
  }, store);
  return pack.views
    .filter(view => (view.confidence ?? 0) >= 0.5)
    .filter(view => view.content?.target_view_type === "app.language.learning_pack")
    .map(view => ({
      memory_view_id: view.id,
      original_text: stringValue(view.content?.original_text),
      edited_text: stringValue(view.content?.edited_text),
      reason: stringValue(view.content?.reason),
    }))
    .filter(item => item.original_text || item.edited_text || item.reason)
    .slice(0, 5);
}

function extractVocabulary(records: TextExposure[], minCount: number): VocabularyCandidate[] {
  const byWord = new Map<string, { count: number; examples: string[]; source_records: Set<string> }>();
  for (const record of records) {
    const text = extractText(record);
    const sentences = splitSentences(text);
    for (const raw of text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []) {
      const word = raw.toLowerCase().replace(/^-+|-+$/g, "");
      if (word.length < 4 || STOPWORDS.has(word) || /^[0-9]+$/.test(word)) continue;
      const item = byWord.get(word) ?? { count: 0, examples: [], source_records: new Set<string>() };
      item.count += recordWeight(record);
      for (const id of record.source_records) item.source_records.add(id);
      if (item.examples.length < 3) {
        const sentence = sentences.find(s => s.toLowerCase().includes(word));
        if (sentence) item.examples.push(sentence.slice(0, 240));
      }
      byWord.set(word, item);
    }
  }
  return [...byWord.entries()]
    .filter(([, item]) => item.count >= minCount)
    .map(([word, item]) => ({
      word,
      count: Number(item.count.toFixed(2)),
      score: Number((Math.log2(item.count + 1) + Math.min(2, item.source_records.size * 0.25)).toFixed(3)),
      examples: [...new Set(item.examples)],
      source_records: [...item.source_records],
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word));
}


function recordWeight(record: TextExposure): number {
  let weight = 1.0;
  if (record.schema_name === "observation.browser_text_copied") weight = 3.0;
  else if (record.schema_name === "observation.browser_text_selected") weight = 2.4;
  else if (record.schema_name === "observation.browser_search_query") weight = 2.0;
  else if (record.schema_name === "observation.browser_page_saved") weight = 1.8;
  else if (record.view_type === "extraction.reader_snapshot") weight = 1.2;
  else if (record.schema_name === "observation.browser_page_snapshot") weight = 1.0;
  else if (record.schema_name === "observation.screenpipe_input_event") weight = 1.4;
  else if (record.schema_name === "observation.screenpipe_activity") weight = 0.65;
  const quality = record.payload?.text_quality as any;
  if (quality && typeof quality === "object") {
    const qualityScore = typeof quality.quality_score === "number" ? quality.quality_score : 0.5;
    const englishRatio = typeof quality.english_ratio === "number" ? quality.english_ratio : 0.5;
    weight *= 0.65 + Math.max(0, Math.min(1, qualityScore)) * 0.5;
    if (englishRatio < 0.25) weight *= 0.55;
  }
  if (typeof record.payload?.manual_save_reason === "string" && record.payload.manual_save_reason.trim()) weight *= 1.25;
  return Number(weight.toFixed(3));
}

function recordTextExposure(record: StoredContextRecord): TextExposure {
  return {
    id: record.id,
    kind: "record",
    source_type: record.source.type,
    schema_name: record.schema.name,
    title: record.content?.title,
    text: record.content?.text,
    url: record.content?.url,
    payload: record.payload,
    source_records: [record.id],
  };
}

function viewTextExposure(view: StoredContextView): TextExposure {
  return {
    id: view.id,
    kind: "view",
    source_type: "view",
    view_type: view.view_type,
    title: view.title,
    text: stringValue(view.content?.text) ?? view.summary,
    url: stringValue(view.content?.url),
    payload: view.content,
    source_records: view.source_records?.length ? view.source_records : [view.id],
  };
}

function extractText(record: TextExposure): string {
  return [record.title, record.text, record.url].filter(Boolean).join("\n");
}

function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(s => s.length >= 30).slice(0, 80);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function renderLearningPackSummary(vocabulary: VocabularyCandidate[]): string {
  if (!vocabulary.length) return "No enough repeated English exposure found yet.";
  return `Focus words from your recent context: ${vocabulary.slice(0, 12).map(v => v.word).join(", ")}.`;
}

function buildStoryPrompt(vocabulary: VocabularyCandidate[]): string {
  const words = vocabulary.slice(0, 12).map(v => v.word);
  if (!words.length) return "Collect more English exposure before generating a personalized story.";
  return `Write a short story about the user's current work using these words naturally: ${words.join(", ")}.`;
}

function packTimeRange(days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

import { ContextStore } from "./store.js";
import { buildContextPack } from "./context-broker.js";
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

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "into", "your", "you", "are", "was", "were", "will", "would", "could", "should", "have", "has", "had", "not", "but", "about", "what", "when", "where", "which", "there", "their", "then", "than", "them", "they", "our", "out", "all", "can", "just", "more", "some", "like", "use", "used", "using", "how", "why", "http", "https", "localhost", "function", "const", "return", "import", "export", "type", "interface", "true", "false", "null", "undefined",
  "example", "domain", "page", "browser", "observation", "snapshot", "published", "warning", "cached", "caching", "retry", "source", "title", "visible", "text",
]);

export function runLanguageLearningPlugin(options: LanguageLearningRunOptions = {}, store = new ContextStore()): LanguageLearningRunResult {
  const generatedAt = new Date().toISOString();
  const days = options.days ?? 7;
  const minCount = options.min_count ?? 2;
  const query: ContextQuery = {
    plugin_id: "language-learning",
    mode: "source",
    time_window: { minutes: days * 24 * 60 },
    limit: options.limit ?? 100,
    include_records: true,
    include_views: false,
  };
  const pack = buildContextPack(query, store);
  const textRecords = pack.records.filter(record => extractText(record).length >= 40);
  const vocabulary = extractVocabulary(textRecords, minCount).slice(0, 30);
  const examples = vocabulary.slice(0, 12).flatMap(candidate => candidate.examples.slice(0, 1).map(sentence => ({
    word: candidate.word,
    sentence,
    record_id: candidate.source_records[0],
  })));

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
    id: `memory:language:learning-pack:${dateKey(generatedAt)}`,
    view_type: "memory.language.learning_pack",
    title: `Adaptive language learning pack (${days}d)`,
    summary: renderLearningPackSummary(vocabulary),
    purpose: "User-facing learning material generated from personal context exposure without requiring WorkThread.",
    source_records: vocabularyView.source_records,
    source_views: [vocabularyView.id!],
    content: { examples, story_prompt: buildStoryPrompt(vocabulary), focus_words: vocabulary.slice(0, 12).map(v => v.word) },
    confidence: vocabulary.length ? 0.68 : 0.2,
    stability: "session",
    lossiness: "high",
  };

  const views = options.write ?? true
    ? [store.upsertView(vocabularyView), store.upsertView(learningPackView)]
    : [vocabularyView, learningPackView];

  return {
    ok: true,
    generated_at: generatedAt,
    records_used: textRecords.length,
    vocabulary,
    examples,
    views,
    diagnostics: {
      pack: pack.diagnostics,
      source_count: pack.records.length,
      text_record_count: textRecords.length,
      thread_required: false,
      external_llm_used: false,
    },
  };
}

function extractVocabulary(records: StoredContextRecord[], minCount: number): VocabularyCandidate[] {
  const byWord = new Map<string, { count: number; examples: string[]; source_records: Set<string> }>();
  for (const record of records) {
    const text = extractText(record);
    const sentences = splitSentences(text);
    for (const raw of text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []) {
      const word = raw.toLowerCase().replace(/^-+|-+$/g, "");
      if (word.length < 4 || STOPWORDS.has(word) || /^[0-9]+$/.test(word)) continue;
      const item = byWord.get(word) ?? { count: 0, examples: [], source_records: new Set<string>() };
      item.count += 1;
      item.source_records.add(record.id);
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
      count: item.count,
      score: Number((Math.log2(item.count + 1) + Math.min(2, item.source_records.size * 0.25)).toFixed(3)),
      examples: [...new Set(item.examples)],
      source_records: [...item.source_records],
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word));
}

function extractText(record: StoredContextRecord): string {
  return [record.content?.title, record.content?.text, record.content?.url].filter(Boolean).join("\n");
}

function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(s => s.length >= 30).slice(0, 80);
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

import { createHash } from "node:crypto";
import type { ContextRecord, ContextView, StoredContextRecord } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../../processor-runtime/types.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const YOUTUBE_LEARNING_PROCESSOR_ID = "processor.youtube_learning";
export const YOUTUBE_FRAGMENT_VIEW_TYPE = "learning.youtube_fragment";
export const LANGUAGE_LEARNING_PACK_VIEW_TYPE = "app.language.learning_pack";

export const YOUTUBE_CAPTION_STATE_SCHEMA = "observation.youtube.caption_state";
export const YOUTUBE_CAPTION_FRAGMENT_SCHEMA = "observation.youtube.caption_fragment";
export const YOUTUBE_COMPREHENSION_GAP_SCHEMA = "observation.youtube.comprehension_gap";
export const YOUTUBE_PAUSED_SCHEMA = "observation.youtube.paused";
export const YOUTUBE_PLAYED_SCHEMA = "observation.youtube.played";
export const YOUTUBE_PAUSE_SCHEMA = "observation.youtube.pause";
export const YOUTUBE_PLAY_SCHEMA = "observation.youtube.play";

// ─── Types ─────────────────────────────────────────────────────────────────

export type YouTubeFragment = {
  video_id: string;
  video_title?: string;
  start_seconds: number;
  end_seconds: number;
  caption_text?: string;
  caption_lang?: string;
  is_difficult?: boolean;
  difficulty_reason?: string;
};

export type YouTubeLearningOptions = {
  now?: Date;
  fragmentMinSeconds?: number;
  maxFragmentDuration?: number;
};

export type VideoSessionState = {
  videoId: string;
  videoTitle?: string;
  isPlaying: boolean;
  captionsEnabled: boolean;
  currentTime: number;
  lastEventAt: number;
  captionsSince: number;
  fragmentBuffer: Array<{ start: number; end: number; text: string }>;
};

// ─── Processor Factory ───────────────────────────────────────────────────

export function createYouTubeLearningProcessor(options: YouTubeLearningOptions = {}): ProcessorDefinition {
  return {
    id: YOUTUBE_LEARNING_PROCESSOR_ID,
    title: "YouTube Learning Fragment Capture",
    version: "0.0.1",
    description: "Captures YouTube playback fragments and turns YouTube comprehension gaps into compact Language app learning packs.",
    consumes: {
      observations: [
        `${YOUTUBE_CAPTION_STATE_SCHEMA}`,
        `${YOUTUBE_CAPTION_FRAGMENT_SCHEMA}`,
        `${YOUTUBE_COMPREHENSION_GAP_SCHEMA}`,
        `${YOUTUBE_PAUSED_SCHEMA}`,
        `${YOUTUBE_PLAYED_SCHEMA}`,
        `${YOUTUBE_PAUSE_SCHEMA}`,
        `${YOUTUBE_PLAY_SCHEMA}`,
      ],
    },
    produces: {
      views: [YOUTUBE_FRAGMENT_VIEW_TYPE, LANGUAGE_LEARNING_PACK_VIEW_TYPE],
    },
    runtime: { kind: "local" },
    policy: { speed: "reflex", autonomy: "draft", privacy: "private" },
    handler: youTubeLearningHandler(options),
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export function youTubeLearningHandler(options: YouTubeLearningOptions = {}): ProcessorHandler {
  const fragmentMinSeconds = options.fragmentMinSeconds ?? 5;
  const maxFragmentDuration = options.maxFragmentDuration ?? 300;

  return ({ observation, payload: inputPayload }, context) => {
    const now = options.now ?? new Date();
    const payload = (inputPayload ?? {}) as Record<string, unknown>;

    if (!observation) {
      return { views: [], diagnostics: { reason: "no observation" } };
    }

    const schemaName = observation.schema.name;
    const store = context.store;

    // Dispatch by observation schema
    if (schemaName === YOUTUBE_CAPTION_STATE_SCHEMA) {
      return handleCaptionState(observation, now);
    }
    if (schemaName === YOUTUBE_CAPTION_FRAGMENT_SCHEMA) {
      return handleCaptionFragment(observation, now, store, fragmentMinSeconds, maxFragmentDuration);
    }
    if (schemaName === YOUTUBE_COMPREHENSION_GAP_SCHEMA) {
      return handleComprehensionGap(observation, now);
    }
    if (schemaName === YOUTUBE_PAUSED_SCHEMA || schemaName === YOUTUBE_PAUSE_SCHEMA) {
      return handlePause(observation, now, store, fragmentMinSeconds, maxFragmentDuration);
    }
    if (schemaName === YOUTUBE_PLAYED_SCHEMA || schemaName === YOUTUBE_PLAY_SCHEMA) {
      return handlePlay(observation, now);
    }

    return { views: [], diagnostics: { reason: "unhandled schema", schema: schemaName } };
  };
}

// ─── Caption State ───────────────────────────────────────────────────────────

function handleCaptionState(
  observation: StoredContextRecord,
  now: Date,
): { views: ViewDraft[]; diagnostics: Record<string, unknown> } {
  const enabled = Boolean(observation.payload?.enabled ?? observation.payload?.captions_enabled ?? observation.payload?.caption_enabled);
  const videoId = stringValue(observation.payload?.video_id) ?? "unknown";
  const videoTitle = stringValue(observation.payload?.video_title) ?? observation.content?.title;

  return {
    views: [],
    diagnostics: {
      event: "caption_state",
      video_id: videoId,
      video_title: videoTitle,
      captions_enabled: enabled,
      timestamp: now.toISOString(),
    },
  };
}

// ─── Caption Fragment ──────────────────────────────────────────────────────

function handleCaptionFragment(
  observation: StoredContextRecord,
  now: Date,
  store: import("@info/core").ContextStore,
  fragmentMinSeconds: number,
  maxFragmentDuration: number,
): { views: ViewDraft[]; diagnostics: Record<string, unknown> } {
  const videoId = stringValue(observation.payload?.video_id) ?? "unknown";
  const videoTitle = stringValue(observation.payload?.video_title) ?? observation.content?.title;
  const startSeconds = numberValue(observation.payload?.start_seconds) ?? 0;
  const endSeconds = numberValue(observation.payload?.end_seconds) ?? startSeconds;
  const captionText = stringValue(observation.content?.text) ?? stringValue(observation.payload?.caption_text) ?? "";
  const captionLang = stringValue(observation.payload?.caption_lang);

  const fragment: YouTubeFragment = {
    video_id: videoId,
    video_title: videoTitle,
    start_seconds: startSeconds,
    end_seconds: endSeconds,
    caption_text: captionText,
    caption_lang: captionLang,
  };

  return {
    views: [buildFragmentView(fragment, now, undefined, [observation.id])],
    diagnostics: { event: "caption_fragment", video_id: videoId, fragment },
  };
}

// ─── Comprehension Gap ──────────────────────────────────────────────────────

function handleComprehensionGap(
  observation: StoredContextRecord,
  now: Date,
): { views: ViewDraft[]; diagnostics: Record<string, unknown> } {
  const gap = recordValue(observation.payload?.gap) ?? observation.payload ?? {};
  const videoId = stringValue(gap.video_id) ?? stringValue(observation.payload?.video_id) ?? "unknown";
  const videoTitle = stringValue(gap.video_title) ?? stringValue(observation.payload?.video_title) ?? observation.content?.title;
  const videoUrl = stringValue(gap.video_url) ?? stringValue(observation.payload?.video_url) ?? observation.content?.url;
  const startSeconds = numberValue(gap.start_seconds) ?? 0;
  const endSeconds = numberValue(gap.end_seconds) ?? startSeconds;
  const transcriptSamples = transcriptSampleTexts(gap, observation);
  const sentences = extractLearningSentences(transcriptSamples);
  const examples = extractLearningExamples(sentences, observation.id);
  const focusWords = examples.map(example => example.word);
  const views = sentences.length
    ? [buildLanguageLearningPackView({
      observation,
      now,
      videoId,
      videoTitle,
      videoUrl,
      startSeconds,
      endSeconds,
      transcriptSamples,
      sentences,
      focusWords,
      examples,
    })]
    : [];

  return {
    views,
    diagnostics: {
      event: "comprehension_gap",
      video_id: videoId,
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      caption_sample_count: transcriptSamples.length,
      sentence_count: sentences.length,
      focus_word_count: focusWords.length,
      retained_as_observation: true,
      generated_views: views.length,
      timestamp: now.toISOString(),
    },
  };
}

// ─── Pause / Play ──────────────────────────────────────────────────────────

function handlePause(
  observation: StoredContextRecord,
  now: Date,
  store: import("@info/core").ContextStore,
  fragmentMinSeconds: number,
  maxFragmentDuration: number,
): { views: ViewDraft[]; diagnostics: Record<string, unknown> } {
  const videoId = stringValue(observation.payload?.video_id) ?? "unknown";
  const videoTitle = stringValue(observation.payload?.video_title) ?? observation.content?.title;
  const currentTime = numberValue(observation.payload?.current_time) ?? numberValue(observation.payload?.current_seconds) ?? 0;

  // Look for existing open fragment for this video (within last 30 minutes)
  const recentFragments = store.listViews({
    view_types: [YOUTUBE_FRAGMENT_VIEW_TYPE],
    active_only: true,
    limit: 100,
  }).filter(v => v.content?.video_id === videoId);

  const openFragment = recentFragments
    .filter(v => !v.content?.closed_at)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

  const views: ViewDraft[] = [];

  if (openFragment) {
    // Close the open fragment at the pause point
    const startSeconds = numberValue(openFragment.content?.start_seconds) ?? 0;
    const duration = currentTime - startSeconds;

    if (duration >= fragmentMinSeconds && duration <= maxFragmentDuration) {
      const fragment: YouTubeFragment = {
        video_id: videoId,
        video_title: videoTitle,
        start_seconds: startSeconds,
        end_seconds: currentTime,
        caption_text: stringValue(openFragment.content?.caption_text) ?? undefined,
        caption_lang: stringValue(openFragment.content?.caption_lang) ?? undefined,
      };
      views.push(buildFragmentView(fragment, now, openFragment.id, []));
    }
  }

  const isDifficult = Boolean(observation.payload?.is_difficult);

  return {
    views,
    diagnostics: {
      event: "paused",
      video_id: videoId,
      current_time: currentTime,
      closed_fragment: Boolean(openFragment),
      is_difficult: isDifficult,
    },
  };
}

function handlePlay(
  observation: StoredContextRecord,
  now: Date,
): { views: ViewDraft[]; diagnostics: Record<string, unknown> } {
  const videoId = stringValue(observation.payload?.video_id) ?? "unknown";
  const videoTitle = stringValue(observation.payload?.video_title) ?? observation.content?.title;
  const currentTime = numberValue(observation.payload?.current_time) ?? numberValue(observation.payload?.current_seconds) ?? 0;

  // Start a new playback fragment
  const fragment: YouTubeFragment = {
    video_id: videoId,
    video_title: videoTitle,
    start_seconds: currentTime,
    end_seconds: currentTime,
    caption_text: undefined,
    caption_lang: undefined,
  };

  // The fragment view is open-ended; it will be closed on the next pause
  return {
    views: [buildFragmentView(fragment, now, observation.id, [observation.id])],
    diagnostics: { event: "played", video_id: videoId, current_time: currentTime },
  };
}

// ─── View Builders ─────────────────────────────────────────────────────────

function buildFragmentView(
  fragment: YouTubeFragment,
  now: Date,
  idHint?: string,
  sourceRecords?: string[],
): ViewDraft {
  const duration = fragment.end_seconds - fragment.start_seconds;
  return {
    type: YOUTUBE_FRAGMENT_VIEW_TYPE,
    id: idHint ?? fragmentId(fragment),
    title: fragment.video_title ? `Fragment: ${fragment.video_title}` : "YouTube Fragment",
    summary: `${fragment.video_id} @ ${formatTime(fragment.start_seconds)}-${formatTime(fragment.end_seconds)} (${duration}s)`,
    status: "candidate",
    source_records: sourceRecords ?? [],
    purpose: "Timestamped playback fragment for language learning review.",
    scope: {
      domain: "youtube.com",
      app: "chrome",
    },
    content: {
      video_id: fragment.video_id,
      video_title: fragment.video_title,
      start_seconds: fragment.start_seconds,
      end_seconds: fragment.end_seconds,
      duration_seconds: duration,
      caption_text: fragment.caption_text,
      caption_lang: fragment.caption_lang,
      is_difficult: fragment.is_difficult ?? false,
      generated_at: now.toISOString(),
    },
    confidence: 0.82,
    stability: "session",
    lossiness: "low",
    privacy: {
      level: "private",
      retention: "normal",
      allow_embedding: false,
      allow_llm_summary: true,
      allow_external_llm: false,
      allow_external_reader: false,
    },
    metadata: {
      generated_at: now.toISOString(),
      processor: YOUTUBE_LEARNING_PROCESSOR_ID,
    },
  };
}

type LanguageLearningPackInput = {
  observation: StoredContextRecord;
  now: Date;
  videoId: string;
  videoTitle?: string;
  videoUrl?: string;
  startSeconds: number;
  endSeconds: number;
  transcriptSamples: string[];
  sentences: string[];
  focusWords: string[];
  examples: Array<{ word: string; sentence: string; record_id: string }>;
};

function buildLanguageLearningPackView(input: LanguageLearningPackInput): ViewDraft {
  const title = input.videoTitle ? `YouTube English: ${input.videoTitle}` : "YouTube English Pack";
  const timeRange = `${formatTime(input.startSeconds)}-${formatTime(input.endSeconds)}`;
  return {
    type: LANGUAGE_LEARNING_PACK_VIEW_TYPE,
    id: `app:language:youtube-pack:${stableKey([
      input.videoId,
      input.startSeconds,
      input.endSeconds,
      input.sentences.join("\n"),
    ])}`,
    title,
    summary: input.focusWords.length
      ? `Practice ${input.focusWords.slice(0, 8).join(", ")} from ${timeRange}.`
      : `Practice YouTube sentences from ${timeRange}.`,
    status: "candidate",
    source_records: [input.observation.id],
    purpose: "User-facing English learning material generated from a YouTube comprehension gap observation.",
    scope: {
      domain: "youtube.com",
      app: "chrome",
    },
    content: {
      source: "youtube.comprehension_gap",
      video_id: input.videoId,
      video_title: input.videoTitle,
      video_url: input.videoUrl,
      start_seconds: input.startSeconds,
      end_seconds: input.endSeconds,
      transcript_samples: input.transcriptSamples,
      sentences: input.sentences,
      focus_words: input.focusWords,
      examples: input.examples,
      story_prompt: buildYouTubeStoryPrompt(input.focusWords, input.sentences),
      generated_at: input.now.toISOString(),
    },
    confidence: input.examples.length ? 0.76 : 0.58,
    stability: "session",
    lossiness: "medium",
    privacy: {
      level: "private",
      retention: "normal",
      allow_embedding: false,
      allow_llm_summary: true,
      allow_external_llm: false,
      allow_external_reader: false,
    },
    metadata: {
      generated_at: input.now.toISOString(),
      processor: YOUTUBE_LEARNING_PROCESSOR_ID,
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const LEARNING_STOPWORDS = new Set([
  "about", "after", "again", "also", "because", "been", "being", "between", "both", "came", "come", "could", "does", "doing", "done", "each", "even", "ever", "every", "from", "give", "goes", "going", "have", "here", "into", "just", "keep", "kind", "know", "like", "look", "made", "make", "many", "more", "most", "much", "need", "only", "over", "really", "same", "should", "some", "such", "take", "than", "that", "their", "them", "then", "there", "these", "they", "thing", "this", "those", "through", "very", "want", "were", "what", "when", "where", "which", "while", "will", "with", "work", "would", "your",
]);

function fragmentId(fragment: YouTubeFragment): string {
  return `youtube-fragment:${fragment.video_id}:${fragment.start_seconds}:${fragment.end_seconds}`;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => stringValue(item)).filter((item): item is string => Boolean(item)) : [];
}

function transcriptSampleTexts(gap: Record<string, unknown>, observation: StoredContextRecord): string[] {
  const samples = [
    ...stringArray(gap.transcript_samples),
    ...stringArray(gap.subtitle_samples),
    ...stringArray(gap.caption_texts),
    ...captionSampleTexts(gap.caption_samples),
    stringValue(gap.subtitle_text),
    stringValue(gap.caption_text),
    stringValue(observation.content?.text),
  ].filter((item): item is string => Boolean(item));
  return [...new Set(samples.map(item => item.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 12);
}

function captionSampleTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === "string") return stringValue(item);
      const record = recordValue(item);
      return record ? stringValue(record.text) ?? stringValue(record.caption_text) ?? stringValue(record.subtitle_text) : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function extractLearningSentences(samples: string[]): string[] {
  const sentences = samples.flatMap(sample => splitLearningSentences(sample));
  return [...new Set(sentences)].slice(0, 8);
}

function splitLearningSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || !/[A-Za-z]/.test(normalized)) return [];
  const pieces = normalized.split(/(?<=[.!?])\s+|\n+/);
  const sentences = pieces
    .map(piece => piece.trim())
    .filter(piece => piece.length >= 10 && /[A-Za-z]{3,}/.test(piece))
    .map(piece => piece.slice(0, 240));
  return sentences.length ? sentences : [normalized.slice(0, 240)];
}

function extractLearningExamples(sentences: string[], recordId: string): Array<{ word: string; sentence: string; record_id: string }> {
  const examples: Array<{ word: string; sentence: string; record_id: string }> = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [];
    for (const rawWord of words) {
      const word = rawWord.toLowerCase().replace(/^['-]+|['-]+$/g, "");
      if (word.length < 4 || LEARNING_STOPWORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      examples.push({ word, sentence, record_id: recordId });
      if (examples.length >= 12) return examples;
    }
  }
  return examples;
}

function buildYouTubeStoryPrompt(focusWords: string[], sentences: string[]): string {
  if (focusWords.length) {
    return `Rewrite the YouTube moment as a short, natural English practice paragraph using: ${focusWords.slice(0, 12).join(", ")}.`;
  }
  return `Rewrite this YouTube moment as a short, natural English practice paragraph: ${sentences.slice(0, 2).join(" ")}`;
}

function stableKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

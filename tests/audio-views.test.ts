import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { AI_AUDIO_VIEW_STRATEGY_ID, compileAudioViews, type AudioViewAnalyzer } from "@info/views/audio/index.js";
import { buildEvidenceView } from "@info/views/evidence/index.js";
import { normalizeScreenpipeResult } from "@info/sensors";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-audio-views-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("EvidenceView classifies Screenpipe Audio as audio evidence", () => withStore((store) => {
  const record = store.insertRecord({
    id: "screenpipe:audio:chunk-13977",
    schema: { name: "observation.screenpipe_audio", version: 1 },
    source: { type: "screenpipe", id: "13977", connector: "screenpipe-local-api" },
    time: { observed_at: "2026-05-26T11:13:37.000Z" },
    content: { title: "EarPods Microphone - Audio", text: "比如说我从不同的一个view" },
    payload: {
      content_type: "Audio",
      audio_chunk_id: 13977,
      transcription_id: 13439,
      speaker_label: "speaker:7",
      device_name: "EarPods Microphone",
      start_time: 0.04,
      end_time: 1.31,
      transcription_engine: "WhisperLargeV3TurboQuantized",
    },
    privacy: { level: "private", retention: "normal" },
  });

  const evidence = buildEvidenceView(record);
  const audio = evidence.content?.signals && typeof evidence.content.signals === "object" ? (evidence.content.signals as any).audio : undefined;

  assert.equal(evidence.view_type, "evidence");
  assert.equal(evidence.content?.kind, "audio");
  assert.equal(audio?.transcript, "比如说我从不同的一个view");
  assert.equal(audio?.audio_chunk_id, "13977");
  assert.ok(evidence.content?.claims instanceof Array);
  assert.ok((evidence.content?.claims as string[]).includes("speech_transcribed"));
}));

test("AudioView compiler compresses transcript evidence into semantic AudioView", () => withStore(async (store) => {
  const evidence = store.upsertView({
    id: "evidence:audio:chunk-13977",
    view_type: "evidence",
    title: "EarPods Microphone - Audio",
    source_records: ["screenpipe:audio:chunk-13977"],
    scope: { time_range: { start: "2026-05-26T11:13:37.000Z", end: "2026-05-26T11:13:38.000Z" } },
    content: {
      kind: "audio",
      signals: {
        text: "我们可以从 observation compress 到不同的 view",
        audio: {
          transcript: "我们可以从 observation compress 到不同的 view",
          audio_chunk_id: "13977",
          speaker_label: "speaker:7",
          device_name: "EarPods Microphone",
        },
      },
    },
    confidence: 0.84,
  });
  const analyzer: AudioViewAnalyzer = async (request) => {
    assert.match(request.prompt, /Compile one AudioView/);
    assert.equal(request.evidence_views[0].id, evidence.id);
    return {
      ok: true,
      model: "mock-audio-model",
      base_url: "mock://llm",
      content: {
        title: "Discussing Observation to View compression",
        summary: "用户在讨论 observation 到不同 view 的压缩设计。",
        kind: "transcript_semantics",
        topics: ["memory view design"],
        stated_intents: ["设计可扩展的 view pipeline"],
        decisions: ["先把 audio 作为 ActivityBlock 输入"],
        action_items: ["实现 AudioView"],
        open_questions: [],
        useful_quotes: ["observation compress 到不同的 view"],
        confidence: 0.86,
      },
    };
  };

  const result = await compileAudioViews({ write: true, evidenceViews: [evidence], analyzer }, store);
  const audio = result.views[0];

  assert.equal(result.views.length, 1);
  assert.equal(audio.view_type, "audio");
  assert.equal(audio.compiler?.id, AI_AUDIO_VIEW_STRATEGY_ID);
  assert.equal(audio.content?.kind, "transcript_semantics");
  assert.deepEqual(audio.content?.topics, ["memory view design"]);
  assert.ok(audio.source_views?.includes(evidence.id));
  assert.ok(audio.source_records?.includes("screenpipe:audio:chunk-13977"));
}));

test("AudioView compiler skips empty or too-short transcripts", () => withStore(async (store) => {
  const evidence = store.upsertView({
    id: "evidence:audio:short",
    view_type: "evidence",
    content: { kind: "audio", signals: { audio: { transcript: "好" } } },
    confidence: 0.8,
  });
  let calls = 0;
  const result = await compileAudioViews({ write: true, evidenceViews: [evidence], analyzer: async () => {
    calls += 1;
    return { ok: true, content: {} };
  } }, store);

  assert.equal(result.views.length, 0);
  assert.equal(calls, 0);
}));


test("Screenpipe Audio search results normalize as audio records even when item.type is Audio", () => {
  const record = normalizeScreenpipeResult({
    type: "Audio",
    content: {
      chunk_id: 14901,
      timestamp: "2026-05-26T23:03:46+08:00",
      transcription: "这个之后你在这个任务上跑",
      device_name: "System Audio",
      speaker: { id: 41, name: "" },
    },
  }, 0, "http://localhost:3030");

  assert.equal(record.schema.name, "observation.screenpipe_audio");
  assert.equal(record.content?.text, "这个之后你在这个任务上跑");
  assert.equal(record.payload?.audio_chunk_id, 14901);
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicViewAccessAuthorizer, ExecutionRuntime } from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  SCREENPIPE_AUDIO_FUNCTION,
  SCREENPIPE_TIMELINE_FUNCTION,
  createScreenpipeDerivedTransformation,
  executeScreenpipeAudio,
  executeScreenpipeTimeline,
} from "@info/screenpipe-derived-views";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { exactViewRef, parseViewDraft, type JsonObject, type View, type ViewDraft } from "@info/view";
import { resolveScreenpipeRawWindow } from "../scripts/v1/screenpipe-derived-window.js";

const policy = {
  owner: "user:local",
  visibility: "private" as const,
  privacy: "private" as const,
  retention: "normal" as const,
  allow_external_model: false,
  allow_embedding: false,
  labels: ["screenpipe"],
};

const access = {
  id: "policy:screenpipe-derived-test",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

test("Screenpipe derive command rejects non-loopback endpoints before creating storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-screenpipe-endpoint-"));
  const dataDirectory = join(directory, "must-not-exist");
  try {
    const result = spawnSync(process.execPath, [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "scripts/v1/screenpipe-capture-derived.ts",
      "--",
      "--endpoint",
      "http://example.com:3030",
      "--data-dir",
      dataDirectory,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /explicit HTTP loopback address/);
    assert.equal(existsSync(dataDirectory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Screenpipe Raw Views form searchable Timeline and Audio Derived Views through Execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-screenpipe-derived-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter([
    { reference: SCREENPIPE_TIMELINE_FUNCTION, execute: executeScreenpipeTimeline },
    { reference: SCREENPIPE_AUDIO_FUNCTION, execute: executeScreenpipeAudio },
  ]);
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: deterministicClock() },
  );

  try {
    const frame = await commit(repository, rawScreenpipeView({
      id: "view:screenpipe:frame:42",
      schema: "capture.screenpipe.frame_ocr",
      kind: "screenpipe_frame_ocr",
      observed_at: "2026-07-27T22:00:01.000+08:00",
      item_type: "OCR",
      content: {
        frame_id: 42,
        timestamp: "2026-07-27T22:00:01.000+08:00",
        text: "  Building   Timeline View  ",
        file_path: "/screenpipe/frame-42.png",
        offset_index: 0,
        app_name: "Code",
        window_name: "Metaflow",
        tags: [],
        frame: null,
        frame_name: null,
        browser_url: null,
        focused: true,
        device_name: "Display 1",
        text_source: "ocr",
      },
    }));
    const audio = await commit(repository, rawScreenpipeView({
      id: "view:screenpipe:audio:7",
      schema: "capture.screenpipe.audio",
      kind: "screenpipe_audio_transcription",
      observed_at: "2026-07-27T14:00:02.000Z",
      item_type: "Audio",
      content: {
        chunk_id: 7,
        timestamp: "2026-07-27T14:00:02.000Z",
        transcription: "We need an audio view.",
        text: "We need an audio view.",
        file_path: "/screenpipe/audio-7.mp4",
        offset_index: 0,
        tags: [],
        device_type: "Input",
        device_name: "Microphone",
        speaker: { id: 1, name: "Junjie", metadata: "" },
        speaker_label: "Junjie",
        speaker_source: "speaker_id",
        speaker_confidence: 0.9,
        speaker_provisional: false,
        start_time: 1.5,
        end_time: 3.0,
      },
    }));
    const period = { start: "2026-07-27T14:00:00.000Z", end: "2026-07-27T14:05:00.000Z", timezone: "Asia/Shanghai" };
    const resolvedWindow = await resolveScreenpipeRawWindow({
      repository,
      connection_id: "screenpipe:default",
      content_types: ["ocr", "audio"],
      period,
    });
    assert.deepEqual(resolvedWindow.map(exactViewRef), [exactViewRef(frame), exactViewRef(audio)]);
    const timeline = createScreenpipeDerivedTransformation({
      kind: "timeline",
      views: [audio, frame],
      output_view_id: "view:screenpipe:timeline:2026-07-27",
      expected_view_revision: 0,
      created_at: "2026-07-27T14:05:01.000Z",
      period,
    });
    const timelineResult = await runtime.execute({
      run_id: "run:screenpipe:timeline:1",
      correlation_id: "correlation:screenpipe:timeline:1",
      transformation: timeline,
      access_policy: access,
      access_use: "local_execution",
      idempotency_key: "screenpipe:timeline:1",
    });
    const timelineCandidate = timelineResult.failure?.representation.form === "inline"
      && typeof timelineResult.failure.representation.value === "object"
      && timelineResult.failure.representation.value !== null
      && !Array.isArray(timelineResult.failure.representation.value)
      && typeof timelineResult.failure.representation.value.candidate_artifact === "object"
      && timelineResult.failure.representation.value.candidate_artifact !== null
      && !Array.isArray(timelineResult.failure.representation.value.candidate_artifact)
      ? await repository.get(timelineResult.failure.representation.value.candidate_artifact as { view_id: string; revision: number })
      : undefined;
    assert.equal(timelineResult.run.status, "succeeded", JSON.stringify({ result: timelineResult, candidate: timelineCandidate }));
    assert.deepEqual(timelineResult.outputs[0]?.provenance.inputs, [exactViewRef(audio), exactViewRef(frame)].sort(compareRefs));
    assert.match(JSON.stringify(timelineResult.outputs[0]?.representation), /Building Timeline View/);
    const timelineValue = inlineValue(timelineResult.outputs[0]!);
    assert.deepEqual(
      (timelineValue.entries as Array<{ source: { view_id: string; revision: number } }>).map(entry => entry.source),
      [exactViewRef(frame), exactViewRef(audio)],
    );
    assert.deepEqual((await repository.query({ text: "Timeline View", limit: 10 })).map(exactViewRef), [exactViewRef(timelineResult.outputs[0]!)]);

    const audioTransformation = createScreenpipeDerivedTransformation({
      kind: "audio",
      views: [audio],
      output_view_id: "view:screenpipe:audio:2026-07-27",
      expected_view_revision: 0,
      created_at: "2026-07-27T14:05:02.000Z",
      period,
    });
    const audioResult = await runtime.execute({
      run_id: "run:screenpipe:audio:1",
      correlation_id: "correlation:screenpipe:audio:1",
      transformation: audioTransformation,
      access_policy: access,
      access_use: "local_execution",
      idempotency_key: "screenpipe:audio:1",
    });
    assert.equal(audioResult.run.status, "succeeded", JSON.stringify(audioResult));
    const value = inlineValue(audioResult.outputs[0]!);
    assert.equal(value.transcript, "We need an audio view.");
    assert.deepEqual(value.stats, { source_count: 1, segment_count: 1, input_segments: 1, output_segments: 0 });
    assert.deepEqual(audioResult.outputs[0]?.relations, [{ type: "derived_from", target: exactViewRef(audio), metadata: {} }]);

    const pendingAudio = await commit(repository, rawScreenpipeView({
      id: "view:screenpipe:audio:pending",
      schema: "capture.screenpipe.audio",
      kind: "screenpipe_audio_transcription",
      observed_at: "2026-07-27T14:00:03.000Z",
      item_type: "Audio",
      content: {
        chunk_id: 8,
        timestamp: "2026-07-27T14:00:03.000Z",
        transcription: "",
        text: "",
        file_path: "/screenpipe/audio-8.mp4",
        offset_index: 0,
        tags: [],
        device_type: "Input",
        device_name: "Microphone",
        speaker: null,
        speaker_label: null,
        speaker_source: null,
        speaker_confidence: null,
        speaker_provisional: false,
        start_time: null,
        end_time: null,
      },
    }));
    const pendingResult = await runtime.execute({
      run_id: "run:screenpipe:audio:pending",
      correlation_id: "correlation:screenpipe:audio:pending",
      transformation: createScreenpipeDerivedTransformation({
        kind: "audio",
        views: [pendingAudio],
        output_view_id: "view:screenpipe:audio:pending-output",
        expected_view_revision: 0,
        created_at: "2026-07-27T14:05:03.000Z",
        period,
      }),
      access_policy: access,
      access_use: "local_execution",
      idempotency_key: "screenpipe:audio:pending",
    });
    assert.equal(pendingResult.run.status, "failed");
    assert.equal(pendingResult.run.error?.details.operator_code, "screenpipe_audio_transcript_unavailable");

    const malformedOcr = await commit(repository, rawScreenpipeView({
      id: "view:screenpipe:frame:malformed",
      schema: "capture.screenpipe.frame_ocr",
      kind: "screenpipe_frame_ocr",
      observed_at: "2026-07-27T14:00:04.000Z",
      item_type: "OCR",
      content: {},
    }));
    const malformedResult = await runtime.execute({
      run_id: "run:screenpipe:timeline:malformed",
      correlation_id: "correlation:screenpipe:timeline:malformed",
      transformation: createScreenpipeDerivedTransformation({
        kind: "timeline",
        views: [malformedOcr],
        output_view_id: "view:screenpipe:timeline:malformed-output",
        expected_view_revision: 0,
        created_at: "2026-07-27T14:05:04.000Z",
        period,
      }),
      access_policy: access,
      access_use: "local_execution",
      idempotency_key: "screenpipe:timeline:malformed",
    });
    assert.equal(malformedResult.run.status, "failed");
    assert.equal(malformedResult.run.error?.details.operator_code, "screenpipe_derived_representation_invalid");

    const element = await commit(repository, rawScreenpipeView({
      id: "view:screenpipe:element:9",
      schema: "capture.screenpipe.ui_element",
      kind: "screenpipe_ui_element",
      observed_at: "2026-07-27T14:00:05.000Z",
      item_type: "Element",
      content: {
        id: 9,
        frame_id: 42,
        source: "accessibility",
        role: "button",
        text: "Run",
        parent_id: null,
        depth: 1,
        bounds: { left: 10, top: 20, width: 80, height: 30 },
        confidence: 0.95,
        sort_order: 1,
        on_screen: true,
        state: { focused: true },
      },
    }));
    const activity = await commit(repository, rawScreenpipeView({
      id: "view:screenpipe:activity:1",
      schema: "capture.screenpipe.activity_summary",
      kind: "screenpipe_activity_summary",
      observed_at: "2026-07-27T14:04:00.000Z",
      item_type: "ActivitySummary",
      query: {
        start_time: "2026-07-27T14:00:00.000Z",
        end_time: "2026-07-27T14:04:00.000Z",
      },
      assertion: "source_derived",
      content: {
        edited_files: [],
        audio_summary: null,
        total_frames: 2,
        total_active_minutes: 4,
        time_range: { start: "2026-07-27T14:00:00.000Z", end: "2026-07-27T14:04:00.000Z" },
        data_status: "complete",
        query_status: "complete",
      },
    }));
    const auxiliaryResult = await runtime.execute({
      run_id: "run:screenpipe:timeline:auxiliary",
      correlation_id: "correlation:screenpipe:timeline:auxiliary",
      transformation: createScreenpipeDerivedTransformation({
        kind: "timeline",
        views: [activity, element],
        output_view_id: "view:screenpipe:timeline:auxiliary",
        expected_view_revision: 0,
        created_at: "2026-07-27T14:05:05.000Z",
        period,
      }),
      access_policy: access,
      access_use: "local_execution",
      idempotency_key: "screenpipe:timeline:auxiliary",
    });
    assert.equal(auxiliaryResult.run.status, "succeeded", JSON.stringify(auxiliaryResult));
    assert.deepEqual(
      (inlineValue(auxiliaryResult.outputs[0]!).entries as Array<{ modality: string }>).map(entry => entry.modality),
      ["element", "activity"],
    );
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function rawScreenpipeView(input: {
  id: string;
  schema: string;
  kind: string;
  observed_at: string;
  item_type: string;
  content: JsonObject;
  query?: JsonObject;
  assertion?: "direct" | "source_derived";
  connection_id?: string;
}): ViewDraft {
  return parseViewDraft({
    id: input.id,
    name: input.id,
    purpose: "Captured Screenpipe evidence",
    aliases: [],
    schema: { name: input.schema, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: input.observed_at, created_at: input.observed_at },
    representation: {
      form: "inline",
      kind: input.kind,
      media_type: "application/json",
      value: {
        provider: "screenpipe",
        api_contract_version: "1.0.0",
        item_type: input.item_type,
        ...(input.query ? { query: input.query } : {}),
        content: input.content,
      },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: [],
    provenance: {
      inputs: [],
      capture: {
        connector: "screenpipe",
        connection_id: input.connection_id ?? "screenpipe:default",
        source_id: input.id,
        source_kind: input.item_type,
        identity: "stable_source",
        assertion: input.assertion ?? "direct",
      },
      actor: "capture-ingress",
    },
    policy,
    metadata: {},
  });
}

async function commit(repository: SqliteViewRepository, draft: ViewDraft): Promise<View> {
  return (await repository.commit({ draft, expected_revision: 0 })).view;
}

function inlineValue(view: View): JsonObject {
  assert.equal(view.representation.form, "inline");
  assert.equal(typeof view.representation.value, "object");
  assert.ok(view.representation.value !== null && !Array.isArray(view.representation.value));
  return view.representation.value as JsonObject;
}

function compareRefs(left: { view_id: string; revision: number }, right: { view_id: string; revision: number }): number {
  return left.view_id.localeCompare(right.view_id) || left.revision - right.revision;
}

function deterministicClock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-27T14:05:00.000Z") + tick++).toISOString();
}

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync, backup } from "node:sqlite";
import {
  GrantOperationAuthorizer,
  OperationService,
  RepositoryViewReadAuthorizer,
} from "@info/operations";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { runPersonalizedViewExplorerAcceptance } from "../apps/view-explorer/e2e/personalized-acceptance.js";
import type { ExactViewRef } from "../apps/view-explorer/src/contracts.js";

const sourceDatabase = process.env.METAFLOW_SCREENPIPE_ACCEPTANCE_DB;
const timelineRefValue = process.env.METAFLOW_SCREENPIPE_TIMELINE_REF;
const audioRefValue = process.env.METAFLOW_SCREENPIPE_AUDIO_REF;
const screenshotDirectory = process.env.METAFLOW_SCREENPIPE_SCREENSHOT_DIR;
const enabled = Boolean(sourceDatabase && timelineRefValue && audioRefValue);

test("real Screenpipe SQLite Views cross Operations, Graph Explorer, and exact Renderers", { skip: !enabled }, async () => {
  assert.ok(sourceDatabase && timelineRefValue && audioRefValue);
  assert.equal(existsSync(sourceDatabase), true, `Screenpipe acceptance database does not exist: ${sourceDatabase}`);
  const timelineRef = parseExactRef(timelineRefValue);
  const audioRef = parseExactRef(audioRefValue);
  const directory = await mkdtemp(join(tmpdir(), "metaflow-screenpipe-explorer-live-"));
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    await backup(source, join(directory, "metaflow.sqlite"));
  } finally {
    source.close();
  }

  const views = new SqliteViewRepository(join(directory, "metaflow.sqlite"));
  const reads = new RepositoryViewReadAuthorizer(views);
  const unavailable = unavailablePort();
  const operations = new OperationService({
    views,
    graph: views.search,
    search: unavailable,
    view_reads: reads,
    transformations: unavailable,
    execution: unavailable,
    runs: unavailable,
    feedback: unavailable,
    privacy: unavailable,
    capture: unavailable,
    connector_onboarding: unavailable,
    capture_traces: unavailable,
    authoring: unavailable,
    authorization: new GrantOperationAuthorizer(),
    observer: { async record() {} },
    now: () => "2026-07-28T00:00:00.000Z",
  });
  try {
    const timeline = await views.get(timelineRef);
    const audio = await views.get(audioRef);
    assert.equal(timeline?.schema.name, "metaflow.screenpipe.timeline");
    assert.equal(audio?.schema.name, "metaflow.screenpipe.audio");
    assert.equal(timeline?.representation.form, "inline");
    assert.equal(audio?.representation.form, "inline");
    const timelineValue = inlineValue(timeline?.representation);
    const audioValue = inlineValue(audio?.representation);
    const sourceCount = requiredInteger(requiredRecord(timelineValue.stats, "timeline.stats").source_count, "timeline.stats.source_count");
    const segmentCount = requiredInteger(requiredRecord(audioValue.stats, "audio.stats").segment_count, "audio.stats.segment_count");
    const transcript = requiredString(audioValue.transcript, "audio.transcript");
    assert.ok(sourceCount > 0);
    assert.ok(segmentCount > 0);
    assert.ok(transcript.length > 0);

    const principal = { id: "user:local", grants: ["*"] };
    const timelineEvidence = await runPersonalizedViewExplorerAcceptance({
      operations,
      principal,
      application_space: timelineRef,
      working_state: timelineRef,
      content_assertion: {
        renderer: "renderer.screenpipe.timeline@1@1",
        texts: [`${sourceCount} exact sources`, "Chronological OCR, audio, input, and accessibility evidence"],
      },
      timeout_ms: 60_000,
      ...(screenshotDirectory ? { screenshot_path: join(screenshotDirectory, "screenpipe-timeline.png") } : {}),
    });
    assert.deepEqual(timelineEvidence.renderer.descriptor, {
      id: "renderer.screenpipe.timeline",
      version: 1,
      abi_version: 1,
    });
    assert.ok(timelineEvidence.edge_count > 0);

    const audioEvidence = await runPersonalizedViewExplorerAcceptance({
      operations,
      principal,
      application_space: audioRef,
      working_state: audioRef,
      content_assertion: {
        renderer: "renderer.screenpipe.audio@1@1",
        texts: [`${segmentCount} segments`, transcript.slice(0, Math.min(24, transcript.length))],
      },
      timeout_ms: 60_000,
      ...(screenshotDirectory ? { screenshot_path: join(screenshotDirectory, "screenpipe-audio.png") } : {}),
    });
    assert.deepEqual(audioEvidence.renderer.descriptor, {
      id: "renderer.screenpipe.audio",
      version: 1,
      abi_version: 1,
    });
    assert.ok(audioEvidence.edge_count > 0);
  } finally {
    views.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function parseExactRef(value: string): ExactViewRef {
  const separator = value.lastIndexOf("@");
  const viewId = value.slice(0, separator);
  const revision = Number(value.slice(separator + 1));
  if (!viewId || separator < 1 || !Number.isInteger(revision) || revision < 1) {
    throw new TypeError(`Screenpipe acceptance ref must be exact view_id@revision: ${value}`);
  }
  return { view_id: viewId, revision };
}

function inlineValue(representation: { form: string; value?: unknown } | undefined): Record<string, unknown> {
  if (!representation || representation.form !== "inline") throw new TypeError("Screenpipe acceptance requires inline Representation");
  return requiredRecord(representation.value, "representation.value");
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function unavailablePort(): never {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`Screenpipe View Explorer acceptance accessed an unrelated Operation dependency: ${String(property)}`);
    },
  }) as never;
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepositoryViewReadAuthorizer,
  ViewQueryError,
  ViewQueryRegistry,
  type ViewQueryMethod,
} from "@info/operations";
import {
  ScreenpipeTimelineQueryMethod,
  createScreenpipeTimelineIndexDraft,
} from "@info/screenpipe-derived-views";
import {
  SCREENPIPE_TIMELINE_INDEX_SCHEMA,
  SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
  SCREENPIPE_TIMELINE_QUERY_PROFILE,
} from "@info/view-package-screenpipe-timeline";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { exactViewRef, parseViewDraft, type ViewDraft } from "@info/view";

test("typed View query pages authorized Timeline entries without cursor drift", async () => {
  await withRepository(async repository => {
    const index = (await repository.commit({
      draft: createScreenpipeTimelineIndexDraft({
        schema: SCREENPIPE_TIMELINE_INDEX_SCHEMA,
        connection_id: "screenpipe:test",
        timezone: "Asia/Shanghai",
        owner: "user:local",
        created_at: "2026-07-28T02:00:00.000Z",
      }),
      expected_revision: 0,
    })).view;
    for (const draft of [
      ocr("view:frame:denied", "2026-07-28T03:05:00.000Z", "Private App", "secret", "user:other"),
      ocr("view:frame:3", "2026-07-28T03:04:00.000Z", "Codex", "third"),
      audio("view:audio:2", "2026-07-28T03:03:00.000Z", "second"),
      ocr("view:frame:1", "2026-07-28T03:02:00.000Z", "Chrome", "first"),
    ]) {
      await repository.commit({ draft, expected_revision: 0 });
    }
    const registry = new ViewQueryRegistry([
      new ScreenpipeTimelineQueryMethod(repository, {
        profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
        subject_schema: {
          name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name,
          version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version,
        },
        parameters: SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
      }),
    ]);
    const authorization = new RepositoryViewReadAuthorizer(repository);
    const request = {
      contract_version: 1 as const,
      subject: exactViewRef(index),
      profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
      parameters: {
        period: {
          start: "2026-07-28T00:00:00.000Z",
          end: "2026-07-29T00:00:00.000Z",
          timezone: "Asia/Shanghai",
        },
        filters: {},
        order: "descending",
      },
      page: { limit: 2 },
    };
    const first = await registry.query({ request, subject: index, principal: { id: "user:local" }, authorization });
    assert.deepEqual(first.items.map(item => item.evidence[0]?.view_id), ["view:frame:3", "view:audio:2"]);
    assert.equal(first.redacted_boundary, true);
    assert.ok(first.next_cursor);

    await repository.commit({
      draft: reviseOcr("view:frame:1", "2026-07-28T03:02:00.000Z", "Chrome", "revised after cursor"),
      expected_revision: 1,
    });
    await repository.commit({
      draft: ocr("view:frame:backfill", "2026-07-28T03:02:30.000Z", "Codex", "backfilled after cursor"),
      expected_revision: 0,
    });

    const second = await registry.query({
      request: { ...request, page: { limit: 2, cursor: first.next_cursor } },
      subject: index,
      principal: { id: "user:local" },
      authorization,
    });
    assert.deepEqual(second.items.map(item => item.evidence[0]?.view_id), ["view:frame:1"]);
    assert.equal(second.items[0]?.evidence[0]?.revision, 1);
    assert.equal(second.next_cursor, undefined);

    await assert.rejects(
      registry.query({
        request: {
          ...request,
          parameters: { ...request.parameters, filters: { has_image: true } },
          page: { limit: 2, cursor: first.next_cursor },
        },
        subject: index,
        principal: { id: "user:local" },
        authorization,
      }),
      (error: unknown) => error instanceof ViewQueryError && error.code === "view_query_cursor_mismatch",
    );
    await assert.rejects(
      registry.query({
        request: { ...request, parameters: { ...request.parameters, undeclared: true }, page: { limit: 2 } },
        subject: index,
        principal: { id: "user:local" },
        authorization,
      }),
      (error: unknown) => error instanceof ViewQueryError && error.code === "view_query_parameters_invalid",
    );
  });
});

test("Timeline Method returns a continuation cursor when sparse filters consume one scan budget", async () => {
  await withRepository(async repository => {
    const index = (await repository.commit({
      draft: createScreenpipeTimelineIndexDraft({
        schema: SCREENPIPE_TIMELINE_INDEX_SCHEMA,
        connection_id: "screenpipe:test",
        timezone: "Asia/Shanghai",
        owner: "user:local",
        created_at: "2026-07-28T02:00:00.000Z",
      }),
      expected_revision: 0,
    })).view;
    for (let indexValue = 0; indexValue < 100; indexValue += 1) {
      await repository.commit({
        draft: ocr(`view:frame:other:${indexValue}`, new Date(Date.parse("2026-07-28T05:00:00.000Z") - indexValue * 1_000).toISOString(), "Codex", "other connection", "user:local", "screenpipe:other"),
        expected_revision: 0,
      });
    }
    for (let indexValue = 0; indexValue < 100; indexValue += 1) {
      await repository.commit({
        draft: ocr(`view:frame:noise:${indexValue}`, new Date(Date.parse("2026-07-28T04:00:00.000Z") - indexValue * 1_000).toISOString(), "Chrome", "noise"),
        expected_revision: 0,
      });
    }
    await repository.commit({ draft: ocr("view:frame:match", "2026-07-28T03:00:00.000Z", "Codex", "match"), expected_revision: 0 });
    const registry = new ViewQueryRegistry([new ScreenpipeTimelineQueryMethod(repository, {
      profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
      subject_schema: { name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name, version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version },
      parameters: SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
    }, { max_scan: 100 })]);
    const base = {
      contract_version: 1 as const,
      subject: exactViewRef(index),
      profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
      parameters: {
        period: { start: "2026-07-28T00:00:00.000Z", end: "2026-07-29T00:00:00.000Z", timezone: "Asia/Shanghai" },
        filters: { apps: ["Codex"] },
      },
    };
    const authorization = new RepositoryViewReadAuthorizer(repository);
    const first = await registry.query({ request: { ...base, page: { limit: 10 } }, subject: index, principal: { id: "user:local" }, authorization });
    assert.deepEqual(first.items, []);
    assert.ok(first.next_cursor);
    const second = await registry.query({ request: { ...base, page: { limit: 10, cursor: first.next_cursor } }, subject: index, principal: { id: "user:local" }, authorization });
    assert.deepEqual(second.items.map(item => item.evidence[0]?.view_id), ["view:frame:match"]);
  });
});

test("Timeline Method validates data-specific filters and media projection", async () => {
  await withRepository(async repository => {
    const index = (await repository.commit({
      draft: createScreenpipeTimelineIndexDraft({
        schema: SCREENPIPE_TIMELINE_INDEX_SCHEMA,
        connection_id: "screenpipe:test",
        timezone: "Asia/Shanghai",
        owner: "user:local",
        created_at: "2026-07-28T02:00:00.000Z",
      }),
      expected_revision: 0,
    })).view;
    await repository.commit({ draft: ocr("view:frame:codex", "2026-07-28T03:04:00.000Z", "Codex", "typed query"), expected_revision: 0 });
    await repository.commit({ draft: ocr("view:frame:chrome", "2026-07-28T03:03:00.000Z", "Chrome", "browser"), expected_revision: 0 });
    await repository.commit({ draft: audio("view:audio", "2026-07-28T03:02:00.000Z", "typed query audio"), expected_revision: 0 });
    const registry = new ViewQueryRegistry([new ScreenpipeTimelineQueryMethod(repository, {
      profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
      subject_schema: {
        name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name,
        version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version,
      },
      parameters: SCREENPIPE_TIMELINE_QUERY_METHOD_PARAMETERS,
    })]);
    const response = await registry.query({
      request: {
        contract_version: 1,
        subject: exactViewRef(index),
        profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
        parameters: {
          period: { start: "2026-07-28T00:00:00.000Z", end: "2026-07-29T00:00:00.000Z", timezone: "Asia/Shanghai" },
          filters: { apps: ["Codex"], has_image: true, text: "typed" },
        },
        page: { limit: 20 },
      },
      subject: index,
      principal: { id: "user:local" },
      authorization: new RepositoryViewReadAuthorizer(repository),
    });
    assert.equal(response.items.length, 1);
    const value = response.items[0]!.value as { app?: string; image?: { frame_id?: number } };
    assert.equal(value.app, "Codex");
    assert.equal(value.image?.frame_id, 42);
  });
});

test("View query fails closed when result evidence authorization is incomplete", async () => {
  await withRepository(async repository => {
    const index = (await repository.commit({
      draft: createScreenpipeTimelineIndexDraft({
        schema: SCREENPIPE_TIMELINE_INDEX_SCHEMA,
        connection_id: "screenpipe:test",
        timezone: "Asia/Shanghai",
        owner: "user:local",
        created_at: "2026-07-28T02:00:00.000Z",
      }),
      expected_revision: 0,
    })).view;
    const evidence = (await repository.commit({
      draft: ocr("view:frame:authorization-gap", "2026-07-28T03:04:00.000Z", "Codex", "must not leak"),
      expected_revision: 0,
    })).view;
    const method: ViewQueryMethod = {
      profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
      subject_schema: {
        name: SCREENPIPE_TIMELINE_INDEX_SCHEMA.name,
        version: SCREENPIPE_TIMELINE_INDEX_SCHEMA.version,
      },
      parameters: {
        dialect: "https://json-schema.org/draft/2020-12/schema",
        json_schema: true,
        pagination: { kind: "cursor", max_page_size: 100 },
      },
      async query() {
        const ref = exactViewRef(evidence);
        return {
          items: [{ key: "authorization-gap", evidence: [ref], value: { text: "must not leak" } }],
          redacted_boundary: false,
        };
      },
    };
    const registry = new ViewQueryRegistry([method]);
    await assert.rejects(
      registry.query({
        request: {
          contract_version: 1,
          subject: exactViewRef(index),
          profile: SCREENPIPE_TIMELINE_QUERY_PROFILE,
          parameters: {},
          page: { limit: 10 },
        },
        subject: index,
        principal: { id: "user:local" },
        authorization: { authorize: async () => [] },
      }),
      (error: unknown) => error instanceof ViewQueryError && error.code === "view_query_method_invalid",
    );
  });
});

async function withRepository(run: (repository: SqliteViewRepository) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-query-method-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  try {
    await run(repository);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function ocr(
  id: string,
  observedAt: string,
  appName: string,
  text: string,
  owner = "user:local",
  connectionId = "screenpipe:test",
): ViewDraft {
  return rawDraft({
    id,
    observedAt,
    owner,
    schema: "capture.screenpipe.frame_ocr",
    kind: "screenpipe_frame_ocr",
    sourceId: `frame:${id}`,
    itemType: "OCR",
    content: {
      frame_id: 42,
      text,
      timestamp: observedAt,
      file_path: "/external/screenpipe/frame.jpg",
      offset_index: 0,
      app_name: appName,
      window_name: `${appName} window`,
      tags: [],
      frame: null,
      frame_name: null,
      browser_url: null,
      focused: true,
      device_name: "display",
      text_source: "ocr",
    },
    metadata: { external_media: { kind: "screenpipe_frame", uri: "screenpipe://screenpipe%3Atest/frame/42" } },
    connectionId,
  });
}

function audio(id: string, observedAt: string, transcription: string): ViewDraft {
  return rawDraft({
    id,
    observedAt,
    owner: "user:local",
    schema: "capture.screenpipe.audio",
    kind: "screenpipe_audio_transcription",
    sourceId: `audio:${id}`,
    itemType: "Audio",
    content: {
      chunk_id: 7,
      transcription,
      text: transcription,
      timestamp: observedAt,
      file_path: "/external/screenpipe/audio.mp4",
      offset_index: 0,
      tags: [],
      device_name: "microphone",
      device_type: "Input",
      speaker: null,
      speaker_label: null,
      speaker_source: null,
      speaker_confidence: null,
      speaker_provisional: false,
      start_time: null,
      end_time: null,
    },
  });
}

function reviseOcr(id: string, observedAt: string, appName: string, text: string): ViewDraft {
  const next = ocr(id, observedAt, appName, text);
  return parseViewDraft({
    ...next,
    relations: [{ type: "supersedes", target: { view_id: id, revision: 1 } }],
  });
}

function rawDraft(input: {
  id: string;
  observedAt: string;
  owner: string;
  schema: string;
  kind: string;
  sourceId: string;
  itemType: "OCR" | "Audio";
  content: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  connectionId?: string;
}): ViewDraft {
  return parseViewDraft({
    id: input.id,
    name: input.id,
    purpose: "Timeline query fixture",
    schema: { name: input.schema, version: 1, mode: "freeform" },
    role: "raw",
    time: { observed_at: input.observedAt, created_at: "2026-07-28T03:10:00.000Z" },
    representation: {
      form: "inline",
      kind: input.kind,
      media_type: "application/json",
      value: { provider: "screenpipe", api_contract_version: "1.0.0", item_type: input.itemType, content: input.content },
      metadata: input.metadata ?? {},
    },
    materialization: { primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } } },
    relations: [],
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "screenpipe",
        connection_id: input.connectionId ?? "screenpipe:test",
        source_id: input.sourceId,
        source_kind: input.itemType === "OCR" ? "frame_ocr" : "audio",
        identity: "stable_source",
        assertion: "direct",
      },
    },
    policy: policy(input.owner),
  });
}

function policy(owner: string) {
  return {
    owner,
    visibility: "private" as const,
    privacy: "private" as const,
    retention: "normal" as const,
    allow_external_model: false,
    allow_embedding: false,
    labels: ["timeline-query-fixture"],
  };
}

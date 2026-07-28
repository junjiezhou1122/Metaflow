import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { ViewRepositoryError, parseViewDraft, type ViewDraft } from "@info/view";

function draft(input: {
  id: string;
  schema: string;
  createdAt: string;
  observedAt?: string;
  supersedes?: number;
}): ViewDraft {
  return parseViewDraft({
    id: input.id,
    name: input.id,
    purpose: "Verify precise View query periods",
    schema: { name: input.schema, version: 1, mode: "freeform" },
    role: "derived",
    time: {
      ...(input.observedAt ? { observed_at: input.observedAt } : {}),
      created_at: input.createdAt,
    },
    representation: { form: "inline", kind: "document", value: { id: input.id } },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    relations: input.supersedes === undefined
      ? []
      : [{ type: "supersedes", target: { view_id: input.id, revision: input.supersedes } }],
    provenance: { inputs: [], actor: "test:view-query-time-range" },
    policy: {
      owner: "user:test",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      labels: [],
    },
  });
}

async function withRepository(run: (repository: SqliteViewRepository) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-query-time-range-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  try {
    await run(repository);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("View query matches schema categories inside the half-open observed_at period by epoch", () => withRepository(async repository => {
  const views = [
    draft({
      id: "view:browser:period-start",
      schema: "capture.browser.page",
      observedAt: "2026-11-01T01:30:00.000-04:00",
      createdAt: "2026-11-01T07:00:00.000Z",
    }),
    draft({
      id: "view:audio:inside",
      schema: "capture.audio.segment",
      observedAt: "2026-11-01T01:15:00.000-05:00",
      createdAt: "2026-11-01T07:01:00.000Z",
    }),
    draft({
      id: "view:browser:period-end",
      schema: "capture.browser.page",
      observedAt: "2026-11-01T01:30:00.000-05:00",
      createdAt: "2026-11-01T07:02:00.000Z",
    }),
    draft({
      id: "view:browser:no-observed-time",
      schema: "capture.browser.page",
      createdAt: "2026-11-01T06:00:00.000Z",
    }),
    draft({
      id: "view:other:inside",
      schema: "capture.calendar.event",
      observedAt: "2026-11-01T06:00:00.000Z",
      createdAt: "2026-11-01T07:03:00.000Z",
    }),
  ];
  for (const view of views) await repository.commit({ draft: view, expected_revision: 0 });

  const selected = await repository.query({
    schema_names: ["capture.browser.page", "capture.audio.segment"],
    time_range: {
      basis: "observed_at",
      start: "2026-11-01T05:30:00.000Z",
      end: "2026-11-01T06:30:00.000Z",
    },
  });

  assert.deepEqual(selected.map(view => view.id).sort(), [
    "view:audio:inside",
    "view:browser:period-start",
  ]);
}));

test("created_at periods and ordering compare instants rather than ISO text", () => withRepository(async repository => {
  await repository.commit({
    draft: draft({
      id: "view:older-by-epoch",
      schema: "capture.browser.page",
      createdAt: "2026-11-01T01:45:00.000-04:00",
    }),
    expected_revision: 0,
  });
  await repository.commit({
    draft: draft({
      id: "view:newer-by-epoch",
      schema: "capture.browser.page",
      createdAt: "2026-11-01T01:15:00.000-05:00",
    }),
    expected_revision: 0,
  });

  const selected = await repository.query({
    schema_name: "capture.browser.page",
    time_range: {
      basis: "created_at",
      start: "2026-11-01T05:30:00.000Z",
      end: "2026-11-01T06:30:00.000Z",
    },
  });
  assert.deepEqual(selected.map(view => view.id), ["view:newer-by-epoch", "view:older-by-epoch"]);
}));

test("time ranges preserve latest and all revision selection", () => withRepository(async repository => {
  const first = draft({
    id: "view:evolving",
    schema: "memory.activity",
    observedAt: "2026-07-26T08:30:00.000Z",
    createdAt: "2026-07-26T08:31:00.000Z",
  });
  await repository.commit({ draft: first, expected_revision: 0 });
  await repository.commit({
    draft: draft({
      id: first.id,
      schema: "memory.activity",
      observedAt: "2026-07-26T09:30:00.000Z",
      createdAt: "2026-07-26T09:31:00.000Z",
      supersedes: 1,
    }),
    expected_revision: 1,
  });
  const period = {
    basis: "observed_at" as const,
    start: "2026-07-26T08:00:00.000Z",
    end: "2026-07-26T09:00:00.000Z",
  };

  assert.deepEqual(await repository.query({ schema_names: ["memory.activity"], time_range: period }), []);
  assert.deepEqual(
    (await repository.query({ schema_names: ["memory.activity"], time_range: period, revisions: "all" }))
      .map(view => [view.id, view.revision]),
    [["view:evolving", 1]],
  );
}));

test("View query cursor ordering is stable by observed time, id, and revision", () => withRepository(async repository => {
  for (const [id, observedAt] of [
    ["view:event:c", "2026-07-28T08:03:00.000Z"],
    ["view:event:a", "2026-07-28T08:02:00.000Z"],
    ["view:event:b", "2026-07-28T08:02:00.000Z"],
    ["view:event:d", "2026-07-28T08:01:00.000Z"],
  ] as const) {
    await repository.commit({
      draft: draft({ id, schema: "capture.timeline.event", observedAt, createdAt: "2026-07-28T09:00:00.000Z" }),
      expected_revision: 0,
    });
  }
  const base = {
    schema_name: "capture.timeline.event",
    order: { basis: "observed_at" as const, direction: "descending" as const },
    limit: 2,
  };
  const first = await repository.query(base);
  assert.deepEqual(first.map(view => view.id), ["view:event:c", "view:event:a"]);
  const boundary = first.at(-1)!;
  const second = await repository.query({
    ...base,
    after: {
      timestamp: boundary.time.observed_at!,
      view_id: boundary.id,
      revision: boundary.revision,
    },
  });
  assert.deepEqual(second.map(view => view.id), ["view:event:b", "view:event:d"]);
}));

test("View query snapshots retain the then-latest revision and exclude later backfills", () => withRepository(async repository => {
  await repository.commit({
    draft: draft({
      id: "view:snapshot:evolving",
      schema: "capture.timeline.event",
      observedAt: "2026-07-28T08:02:00.000Z",
      createdAt: "2026-07-28T09:00:00.000Z",
    }),
    expected_revision: 0,
  });
  const snapshot = await repository.getQuerySnapshot();

  await repository.commit({
    draft: draft({
      id: "view:snapshot:evolving",
      schema: "capture.timeline.event",
      observedAt: "2026-07-28T08:03:00.000Z",
      createdAt: "2020-01-01T00:00:00.000Z",
      supersedes: 1,
    }),
    expected_revision: 1,
  });
  await repository.commit({
    draft: draft({
      id: "view:snapshot:backfill",
      schema: "capture.timeline.event",
      observedAt: "2026-07-28T08:04:00.000Z",
      createdAt: "2019-01-01T00:00:00.000Z",
    }),
    expected_revision: 0,
  });

  const frozen = await repository.query({
    schema_name: "capture.timeline.event",
    revisions: "latest",
    snapshot,
    order: { basis: "observed_at", direction: "descending" },
  });
  assert.deepEqual(frozen.map(view => [view.id, view.revision]), [["view:snapshot:evolving", 1]]);

  const current = await repository.query({
    schema_name: "capture.timeline.event",
    revisions: "latest",
    order: { basis: "observed_at", direction: "descending" },
  });
  assert.deepEqual(current.map(view => [view.id, view.revision]), [
    ["view:snapshot:backfill", 1],
    ["view:snapshot:evolving", 2],
  ]);
}));

test("View query rejects ambiguous filters and invalid time ranges", () => withRepository(async repository => {
  const invalidQueries = [
    { schema_names: [] },
    { schema_name: "capture.browser.page", schema_names: ["capture.audio.segment"] },
    { time_range: { basis: "effective_at", start: "2026-07-26T08:00:00.000Z", end: "2026-07-26T09:00:00.000Z" } },
    { time_range: { basis: "observed_at", start: "not-a-time", end: "2026-07-26T09:00:00.000Z" } },
    { time_range: { basis: "created_at", start: "2026-07-26T09:00:00.000Z", end: "2026-07-26T09:00:00.000Z" } },
    { time_range: { basis: "created_at", start: "2026-07-26T10:00:00.000Z", end: "2026-07-26T09:00:00.000Z" } },
    { after: { timestamp: "2026-07-26T09:00:00.000Z", view_id: "view:event", revision: 1 } },
    { order: { basis: "observed_at", direction: "sideways" } },
  ];
  for (const query of invalidQueries) {
    await assert.rejects(
      repository.query(query as never),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "invalid_request"
        && error.details.phase === "validate_input",
    );
  }
}));

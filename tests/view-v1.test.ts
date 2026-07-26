import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureIngress } from "@info/capture";
import { browserCaptureBatch, parseBrowserCaptureEvent } from "@info/browser-capture-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { ViewRepresentationSchema, ViewRepositoryError, parseViewDraft } from "@info/view";

function withRepository(fn: (repository: SqliteViewRepository, directory: string) => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-view-v1-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  return Promise.resolve(fn(repository, directory)).finally(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function viewDraft(id = "view:test") {
  return parseViewDraft({
    id,
    name: "Test View",
    purpose: "Exercise the v1 View integration path",
    schema: { name: "test.view", version: 1, mode: "freeform" },
    role: "derived",
    time: { created_at: "2026-07-25T00:00:00.000Z" },
    representation: { form: "inline", kind: "markdown", media_type: "text/markdown", value: "# Test" },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
    },
    provenance: { inputs: [], actor: "test" },
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

test("View Representation stays open but requires content or a reference", () => {
  assert.equal(ViewRepresentationSchema.safeParse({ form: "inline", kind: "future.custom", value: { value: 1 } }).success, true);
  const invalid = ViewRepresentationSchema.safeParse({ form: "external_reference", kind: "web_page" });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.match(invalid.error.issues[0]?.path.join(".") ?? "", /uri/);
});

test("SQLite repository commits revisions and rejects stale writers", () => withRepository(async repository => {
  const first = await repository.commit({ draft: viewDraft(), expected_revision: 0 });
  assert.equal(first.view.revision, 1);
  const secondDraft = parseViewDraft({
    ...viewDraft(),
    name: "Revised View",
    relations: [{ type: "supersedes", target: { view_id: first.view.id, revision: first.view.revision } }],
  });
  const second = await repository.commit({ draft: secondDraft, expected_revision: 1 });
  assert.equal(second.view.revision, 2);
  await assert.rejects(
    repository.commit({ draft: secondDraft, expected_revision: 1 }),
    (error: unknown) => error instanceof ViewRepositoryError && error.code === "conflict",
  );
}));

test("SQLite repository rejects non-idempotent mutation of Raw evidence", () => withRepository(async repository => {
  const raw = parseViewDraft({
    ...viewDraft("view:raw:test"),
    role: "raw",
    purpose: "Captured one source occurrence",
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "test",
        connection_id: "test:default",
        source_id: "event:1",
        source_kind: "event",
        identity: "occurrence",
        assertion: "direct",
      },
    },
  });
  const first = await repository.commit({ draft: raw, idempotency_key: "raw:test:first", expected_revision: 0 });
  await assert.rejects(
    repository.commit({
      draft: parseViewDraft({
        ...raw,
        name: "Rewritten evidence",
        relations: [{ type: "supersedes", target: { view_id: first.view.id, revision: first.view.revision } }],
      }),
      idempotency_key: "raw:test:rewrite",
      expected_revision: 1,
    }),
    (error: unknown) => error instanceof ViewRepositoryError
      && error.code === "conflict"
      && error.message.includes("new occurrence requires a new View identity"),
  );
}));

test("SQLite repository admits a new immutable revision for stable Raw source state", () => withRepository(async repository => {
  const stableRaw = parseViewDraft({
    ...viewDraft("view:raw:stable-repository"),
    role: "raw",
    purpose: "Preserve source-observed repository state",
    provenance: {
      inputs: [],
      actor: "capture-ingress",
      capture: {
        connector: "github",
        connection_id: "github:default",
        source_id: "openai/codex",
        source_kind: "repository",
        identity: "stable_source",
        assertion: "direct",
      },
    },
  });
  const first = await repository.commit({ draft: stableRaw, expected_revision: 0 });
  const next = parseViewDraft({
    ...stableRaw,
    representation: { form: "inline", kind: "repository", value: { stars: 1000 } },
    relations: [{ type: "supersedes", target: { view_id: first.view.id, revision: first.view.revision } }],
  });
  const second = await repository.commit({ draft: next, expected_revision: 1 });
  assert.equal(second.view.id, first.view.id);
  assert.equal(second.view.revision, 2);
  assert.equal((await repository.get({ view_id: first.view.id, revision: 1 }))?.revision, 1);
}));

test("Capture ingress is idempotent and records observable events", () => withRepository(async repository => {
  const candidate = browserCaptureBatch(parseBrowserCaptureEvent(browserWireEvent({
    event_id: "browser-event:page-1",
    kind: "page",
    action: "page_snapshot",
    page: { title: "Metaflow", url: "https://example.com/metaflow", domain: "example.com" },
    content: {},
  }))).batch.candidates[0]!;
  const events: string[] = [];
  const ingress = new CaptureIngress({ repository, onEvent: event => { events.push(event.type); } });
  const first = await ingress.ingest(candidate);
  const second = await ingress.ingest(candidate);
  assert.equal(first.status, "stored");
  assert.equal(second.status, "stored");
  if (first.status === "stored" && second.status === "stored") {
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.view_id, first.view_id);
  }
  assert.deepEqual(events, ["capture.started", "capture.committed", "capture.started", "capture.committed"]);
  assert.equal(candidate.representation.form, "external_reference");
  if (candidate.representation.form === "external_reference") {
    assert.equal(candidate.representation.uri, "https://example.com/metaflow");
  }
}));

test("Browser selection becomes an inline View rather than a forced page download", () => {
  const candidate = browserCaptureBatch(parseBrowserCaptureEvent(browserWireEvent({
    event_id: "browser-event:selection-1",
    kind: "selection",
    action: "selection",
    page: { title: "Paper", url: "https://example.com/paper", domain: "example.com" },
    content: { selected_text: "View Algebra" },
  }))).batch.candidates[0]!;
  assert.equal(candidate.schema.name, "capture.browser.selection");
  assert.equal(candidate.representation.form, "inline");
  if (candidate.representation.form === "inline") {
    assert.equal(candidate.representation.kind, "selection");
    assert.match(JSON.stringify(candidate.representation.value), /View Algebra/);
  }
});

function browserWireEvent(input: Record<string, unknown>) {
  return {
    version: 1,
    occurred_at: "2026-07-25T01:00:00.000Z",
    captured_at: "2026-07-25T01:00:01.000Z",
    source: { connector: "chrome-extension", connection_id: "chrome:default" },
    browser: {
      tab_id: 1,
      window_id: 1,
      visit_id: "visit-1",
      attention: "focused",
      tab_active: true,
      window_focused: true,
      frame_id: 0,
    },
    facts: {},
    policy: {
      owner: "user:local",
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      allow_local_search: true,
      labels: [],
    },
    ...input,
  };
}

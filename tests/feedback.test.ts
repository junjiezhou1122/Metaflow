import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { ingestFeedback } from "@info/runtime/feedback.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-feedback-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Applications can write feedback Observations without embedding intelligence", async () => withStore(async (store) => {
  store.upsertView({
    id: "analysis:test:view",
    view_type: "analysis.test",
    title: "Analysis test view",
    content: { analysis: "Some derived analysis." },
    privacy: { level: "private", retention: "normal" },
  });

  const result = ingestFeedback({
    type: "analysis.dismissed",
    application_id: "browser.popup",
    view_id: "analysis:test:view",
    value: "dismissed",
    reason: "not relevant now",
    payload: { surface: "popup" },
  }, store);

  assert.equal(result.ok, true);
  assert.equal(result.record.schema.name, "feedback.analysis.dismissed");
  assert.equal(result.record.source.type, "application");
  assert.equal(result.record.source.connector, "browser.popup");
  assert.deepEqual(result.record.relations?.related_to, ["analysis:test:view"]);
  assert.equal(result.record.acquisition?.mode, "manual");
  assert.equal(result.record.acquisition?.actor, "user");
  assert.equal(result.record.payload?.value, "dismissed");
  assert.equal(result.record.payload?.surface, "popup");
  assert.equal(result.record.payload?.target_view_type, "analysis.test");
  assert.equal(result.record.privacy?.level, "private");

  const event = store.listRuntimeEvents({ event_type: "feedback.received", subject_id: result.record.id, limit: 1 })[0];
  assert.ok(event);
  assert.equal(event.actor, "user");
  assert.deepEqual(event.related_views, ["analysis:test:view"]);
}));

test("Feedback target metadata is derived from stored evidence, not client claims", async () => withStore(async (store) => {
  store.upsertView({
    id: "brief:test:research",
    view_type: "brief.research",
    title: "Research brief",
    content: { analysis: "Stored target type should win." },
  });
  store.insertRecord({
    id: "record:test:feedback-target",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser" },
    content: { title: "Browser target" },
  });

  const result = ingestFeedback({
    type: "analysis.useful",
    application_id: "browser.popup",
    view_id: "brief:test:research",
    record_id: "record:test:feedback-target",
    value: "useful",
    payload: {
      target_view_type: "client.wrong",
      target_record_schema: "client.wrong",
    },
  }, store);

  assert.equal(result.record.payload?.target_view_type, "brief.research");
  assert.equal(result.record.payload?.target_record_schema, "observation.browser_ambient_requested");
}));

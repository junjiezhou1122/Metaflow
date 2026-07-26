import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { runLanguageLearningPlugin } from "@info/core";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-language-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Language Learning separates durable memory Views from app data Views", async () => withStore(async (store) => {
  store.insertRecord({
    id: "english-exposure-1",
    schema: { name: "observation.browser_text_selected", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: {
      title: "Architecture notes",
      text: "Architecture vocabulary appears often. Architecture learning improves vocabulary through repeated exposure.",
    },
    payload: { language: "en" },
    privacy: { level: "private", retention: "normal" },
  });

  const result = runLanguageLearningPlugin({ write: false, min_count: 1, limit: 20 }, store);
  const viewTypes = result.views.map(view => view.view_type);

  assert.ok(viewTypes.includes("memory.language.vocabulary_exposure"));
  assert.ok(viewTypes.includes("app.language.learning_pack"));
  assert.equal(viewTypes.includes("memory.language.learning_pack"), false);

  const learningPack = result.views.find(view => view.view_type === "app.language.learning_pack");
  assert.ok(learningPack);
  assert.match(learningPack.id ?? "", /^app:language:learning-pack:/);
  assert.equal(learningPack.stability, "session");
}));

test("Language Learning injects output edit memory as style guidance for app packs", async () => withStore(async (store) => {
  store.insertRecord({
    id: "english-exposure-edit-memory",
    schema: { name: "observation.browser_text_selected", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Runtime architecture",
      text: "Architecture vocabulary appears often. Architecture learning improves vocabulary through repeated exposure.",
    },
    payload: { language: "en" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:language-output-edit-style",
    view_type: "memory.output_edit_pattern",
    title: "Language app output edit pattern",
    content: {
      preference: "edited_output",
      target_view_type: "app.language.learning_pack",
      original_text: "This is too verbose and formal.",
      edited_text: "Make it shorter and natural.",
      reason: "shorter and more natural",
    },
    confidence: 0.82,
    privacy: { level: "private", retention: "normal" },
  });

  const result = runLanguageLearningPlugin({ write: false, min_count: 1, limit: 20 }, store);
  const learningPack = result.views.find(view => view.view_type === "app.language.learning_pack");

  assert.ok(learningPack);
  assert.deepEqual(learningPack.source_views, [
    result.views.find(view => view.view_type === "memory.language.vocabulary_exposure")?.id,
    "memory:language-output-edit-style",
  ]);
  assert.deepEqual(learningPack.content?.style_guidance, [{
    memory_view_id: "memory:language-output-edit-style",
    original_text: "This is too verbose and formal.",
    edited_text: "Make it shorter and natural.",
    reason: "shorter and more natural",
  }]);
}));

test("Language Learning can consume reader extraction Views as text exposure", async () => withStore(async (store) => {
  const source = store.insertRecord({
    id: "english-reader-parent",
    schema: { name: "observation.browser_page_saved", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Reader parent",
      url: "https://example.com/reader",
      text: "saved reader parent",
    },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "extraction:reader-snapshot:english-reader-parent",
    view_type: "extraction.reader_snapshot",
    title: "Reader extraction",
    summary: "Readable extracted article text.",
    source_records: [source.id],
    compiler: { id: "reader.jina", mode: "deterministic" },
    content: {
      text: "Architecture vocabulary appears often. Architecture learning improves vocabulary through repeated exposure.",
      url: "https://example.com/reader",
      ok: true,
    },
    confidence: 0.85,
    privacy: { level: "private", retention: "normal" },
  });

  const result = runLanguageLearningPlugin({ write: false, min_count: 1, limit: 20 }, store);
  const learningPack = result.views.find(view => view.view_type === "app.language.learning_pack");

  assert.ok(learningPack);
  assert.ok(result.vocabulary.some(item => item.word === "architecture"));
  assert.deepEqual(learningPack.source_records, [source.id]);
}));

test("Language Learning excludes output edit memory denied by plugin policy", async () => withStore(async (store) => {
  store.insertRecord({
    id: "english-exposure-denied-edit-memory",
    schema: { name: "observation.browser_text_selected", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Runtime architecture",
      text: "Architecture vocabulary appears often. Architecture learning improves vocabulary through repeated exposure.",
    },
    payload: { language: "en" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "memory:language-output-edit-secret",
    view_type: "memory.output_edit_pattern",
    title: "Secret language app output edit pattern",
    content: {
      preference: "edited_output",
      target_view_type: "app.language.learning_pack",
      original_text: "SECRET STYLE SHOULD NOT LEAK",
      edited_text: "secret rewrite",
      reason: "secret reason",
    },
    confidence: 0.9,
    privacy: { level: "secret", retention: "normal" },
  });

  const result = runLanguageLearningPlugin({ write: false, min_count: 1, limit: 20 }, store);
  const learningPack = result.views.find(view => view.view_type === "app.language.learning_pack");

  assert.ok(learningPack);
  assert.doesNotMatch(JSON.stringify(learningPack), /SECRET STYLE SHOULD NOT LEAK/);
  assert.equal(learningPack.content?.style_guidance, undefined);
}));

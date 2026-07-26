import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { enrichWithJinaReader } from "@info/sensors";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-enrichment-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Jina reader enrichment writes extracted page text as a View, not a derived Record", async () => withStore(async (store) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Readable extracted article text about architecture vocabulary and runtime learning.", { status: 200 });
  try {
    const parent = store.insertRecord({
      id: "record:reader-parent",
      schema: { name: "observation.browser_page_saved", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "example.com" },
      content: { title: "Architecture article", url: "https://example.com/article", text: "saved page" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });

    const view = await enrichWithJinaReader(store, parent);

    assert.ok(view);
    assert.equal(view.view_type, "extraction.reader_snapshot");
    assert.equal(view.compiler?.id, "reader.jina");
    assert.deepEqual(view.source_records, [parent.id]);
    assert.equal(view.content?.url, "https://example.com/article");
    assert.match(String(view.content?.text), /architecture vocabulary/);
    assert.equal(view.privacy?.level, "private");
    assert.equal(store.recent(10).filter(record => record.schema.name === "derived.reader_snapshot").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

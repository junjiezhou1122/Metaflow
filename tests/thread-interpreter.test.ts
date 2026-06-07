import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { interpretThread } from "../src/threads/thread-interpreter.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-thread-interpreter-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Thread interpretation writes display intelligence as a View, not an episode Record", async () => withStore(async (store) => {
  const oldMock = process.env.LLM_MOCK_RESPONSE;
  process.env.LLM_MOCK_RESPONSE = JSON.stringify({
    display_title: "Info Runtime: Thread Display View",
    brief: "The thread is about keeping interpretation as reusable Views.",
    confidence: 0.82,
  });
  try {
    const record = store.insertRecord({
      id: "record:thread-interpret-evidence",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local_project", connector: "runtime-snapshot" },
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: { title: "Info project", text: "Thread interpretation should produce a View." },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertWorkThread({
      id: "thread:interpreter-view",
      title: "raw thread title",
      status: "candidate",
      confidence: 0.7,
      evidence_records: [record.id],
      projects: ["info"],
    });

    const result = await interpretThread({ thread_id: "thread:interpreter-view", write: true, update_thread: true }, store);
    const view = result.written ? store.getView(result.written) : undefined;

    assert.equal(result.ok, true);
    assert.equal(result.written, "view:thread-display:thread:interpreter-view");
    assert.ok(view);
    assert.equal(view.view_type, "thread.display_card");
    assert.equal(view.compiler?.id, "thread-interpreter");
    assert.deepEqual(view.source_records, [record.id]);
    assert.equal(view.content?.display_title, "Info Runtime: Thread Display View");
    assert.equal(store.recent(10).filter(item => item.schema.name === "episode.thread_interpretation").length, 0);
    assert.equal(result.updated_thread?.metadata?.display_title, "Info Runtime: Thread Display View");
  } finally {
    if (oldMock === undefined) delete process.env.LLM_MOCK_RESPONSE;
    else process.env.LLM_MOCK_RESPONSE = oldMock;
  }
}));

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import {
  AI_VISUAL_FRAME_VIEW_STRATEGY_ID,
  compileVisualFrameViews,
  type VisualFrameAnalyzer,
} from "@info/views/visual-frame/index.js";
import {
  AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID,
  compileActivityBlockViews,
  type ActivityBlockAnalyzer,
} from "@info/views/activity-block/index.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-visual-views-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("VisualFrameView compiler extracts screen semantics from frame evidence", () => withStore(async (store) => {
  const evidence = store.upsertView({
    id: "evidence:screen:everos-frame",
    view_type: "evidence",
    title: "VS Code - EverOS memory controller",
    source_records: ["record:frame"],
    scope: {
      app: "Visual Studio Code",
      time_range: { start: "2026-05-26T05:40:00.000Z", end: "2026-05-26T05:40:00.000Z" },
    },
    content: {
      kind: "screen",
      subject: { app: "Visual Studio Code", title: "memory_controller.py" },
      signals: { frame_ids: ["18358"], text: "memory_controller.py" },
    },
    confidence: 0.8,
  });
  const analyzer: VisualFrameAnalyzer = async (request) => {
    assert.equal(request.frame_id, "18358");
    assert.match(request.prompt, /Analyze this representative screen frame/);
    assert.equal(request.evidence_views[0].id, evidence.id);
    return {
      ok: true,
      model: "qwen3-vl-235b-a22b-instruct",
      base_url: "mock://vision",
      content: {
        app: "Visual Studio Code",
        project: "EverOS",
        visible_files: ["memory_controller.py", "memory_models.py"],
        topic: "Memory controller Redis and MongoDB persistence design",
        useful_facts: ["Redis stores hot data with TTL", "MongoDB stores permanent memory records"],
        visible_text_lines: ["RedisLengthCacheManager", "ZREMRANGEBYRANK"],
        confidence: 0.95,
      },
    };
  };

  const result = await compileVisualFrameViews({ write: true, evidenceViews: [evidence], analyzer }, store);
  const visual = result.views[0];

  assert.equal(result.views.length, 1);
  assert.equal(visual.view_type, "visual_frame");
  assert.equal(visual.compiler?.id, AI_VISUAL_FRAME_VIEW_STRATEGY_ID);
  assert.equal(visual.content?.project, "EverOS");
  assert.deepEqual(visual.content?.useful_facts, ["Redis stores hot data with TTL", "MongoDB stores permanent memory records"]);
  assert.ok(visual.source_views?.includes(evidence.id));
}));

test("VisualFrameView compiler dedupes by Screenpipe frame id across evidence sources", () => withStore(async (store) => {
  const evidenceA = store.upsertView({
    id: "evidence:screen:same-frame-a",
    view_type: "evidence",
    title: "VS Code same frame A",
    content: { kind: "screen", subject: { app: "VS Code", title: "A" }, signals: { frame_ids: ["same-frame"], text: "A" } },
    confidence: 0.8,
  });
  const evidenceB = store.upsertView({
    id: "evidence:screen:same-frame-b",
    view_type: "evidence",
    title: "VS Code same frame B",
    content: { kind: "screen", subject: { app: "VS Code", title: "B" }, signals: { frame_ids: ["same-frame"], text: "B" } },
    confidence: 0.8,
  });
  let calls = 0;
  const analyzer: VisualFrameAnalyzer = async () => {
    calls += 1;
    return { ok: true, content: { app: "VS Code", topic: "Same frame", useful_facts: ["same"], confidence: 0.8 } };
  };

  const first = await compileVisualFrameViews({ write: true, evidenceViews: [evidenceA], analyzer, sampleIntervalSeconds: 0 }, store);
  const second = await compileVisualFrameViews({ write: true, evidenceViews: [evidenceB], analyzer, sampleIntervalSeconds: 0 }, store);

  assert.equal(first.views.length, 1);
  assert.equal(second.views.length, 0);
  assert.equal(calls, 1);
  assert.equal(store.listViews({ view_types: ["visual_frame"], active_only: true, limit: 0 }).length, 1);
}));

test("ActivityBlockView compiler aggregates visual frames without creating memory", () => withStore(async (store) => {
  const visual = store.upsertView({
    id: "visual_frame:18358:everos",
    view_type: "visual_frame",
    title: "VS Code - EverOS memory controller",
    source_records: ["record:frame"],
    scope: {
      app: "Visual Studio Code",
      time_range: { start: "2026-05-26T05:40:00.000Z", end: "2026-05-26T05:40:00.000Z" },
    },
    content: {
      kind: "screen_semantics",
      frame_id: "18358",
      app: "Visual Studio Code",
      project: "EverOS",
      topic: "Memory controller Redis and MongoDB persistence design",
      useful_facts: ["Redis stores hot data with TTL"],
    },
    confidence: 0.95,
  });
  const activity = store.upsertView({
    id: "activity:coding:everos",
    view_type: "activity",
    title: "VS Code - EverOS",
    source_views: [visual.id],
    scope: {
      app: "Visual Studio Code",
      time_range: { start: "2026-05-26T05:40:00.000Z", end: "2026-05-26T05:49:00.000Z" },
    },
    content: { kind: "coding", duration_minutes: 9 },
    confidence: 0.9,
  });
  const analyzer: ActivityBlockAnalyzer = async (request) => {
    assert.match(request.prompt, /Compile one 10-minute ActivityBlockView/);
    assert.equal(request.input_views.length, 2);
    return {
      ok: true,
      model: "mock-memory-model",
      base_url: "mock://local",
      content: {
        title: "Researching EverOS memory persistence",
        block_summary: "The user reviewed EverOS memory controller code and Redis/MongoDB persistence notes.",
        primary_work: "Reviewing EverOS memory persistence architecture",
        evidence: ["VisualFrameView identified memory_controller.py and Redis/MongoDB notes"],
        noise: ["No durable completion signal in this block"],
        done_signal: "none",
        continuation_signal: "strong",
        memory_worthiness: 0.72,
        should_create_memory: false,
        confidence: 0.82,
      },
    };
  };

  const result = await compileActivityBlockViews({ write: true, visualFrameViews: [visual], activityViews: [activity], analyzer }, store);
  const block = result.views[0];
  const memories = store.listViews({ view_types: ["memory"], limit: 0 });

  assert.equal(result.views.length, 1);
  assert.equal(block.view_type, "activity_block");
  assert.equal(block.compiler?.id, AI_ACTIVITY_BLOCK_VIEW_STRATEGY_ID);
  assert.equal(block.content?.primary_work, "Reviewing EverOS memory persistence architecture");
  assert.equal(block.content?.should_create_memory, false);
  assert.equal(memories.length, 0);
}));

test("ActivityBlockView normalizes over-10 memory scores and gates unfinished memory", () => withStore(async (store) => {
  const visual = store.upsertView({
    id: "visual_frame:score-gate",
    view_type: "visual_frame",
    title: "Visual score gate",
    scope: { time_range: { start: "2026-05-26T05:40:00.000Z", end: "2026-05-26T05:41:00.000Z" } },
    content: { kind: "screen_semantics", topic: "debugging visual view quality" },
    confidence: 0.8,
  });
  const analyzer: ActivityBlockAnalyzer = async () => ({
    ok: true,
    content: {
      title: "Debug visual view quality",
      primary_work: "Debugging visual view quality and gates",
      done_signal: "none",
      continuation_signal: "strong",
      memory_worthiness: 6,
      should_create_memory: true,
      confidence: 0.78,
    },
  });

  const result = await compileActivityBlockViews({ write: true, visualFrameViews: [visual], activityViews: [], analyzer }, store);
  const block = result.views[0];

  assert.equal(block.content?.memory_worthiness, 0.6);
  assert.equal(block.content?.should_create_memory, false);
}));

test("VisualFrameView compiler analyzes frame candidates in parallel", () => withStore(async (store) => {
  const evidenceA = store.upsertView({
    id: "evidence:screen:frame-a",
    view_type: "evidence",
    title: "Frame A",
    content: {
      kind: "screen",
      subject: { app: "Visual Studio Code", title: "A.ts" },
      signals: { frame_ids: ["frame-a"], text: "A.ts" },
    },
    confidence: 0.8,
  });
  const evidenceB = store.upsertView({
    id: "evidence:screen:frame-b",
    view_type: "evidence",
    title: "Frame B",
    content: {
      kind: "screen",
      subject: { app: "Visual Studio Code", title: "B.ts" },
      signals: { frame_ids: ["frame-b"], text: "B.ts" },
    },
    confidence: 0.8,
  });
  let active = 0;
  let maxActive = 0;
  const analyzer: VisualFrameAnalyzer = async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 30));
    active -= 1;
    return {
      ok: true,
      content: {
        app: "Visual Studio Code",
        project: "info",
        topic: `Topic ${request.frame_id}`,
        useful_facts: [`fact ${request.frame_id}`],
        confidence: 0.8,
      },
    };
  };

  const started = Date.now();
  const result = await compileVisualFrameViews({ write: true, evidenceViews: [evidenceA, evidenceB], analyzer, sampleIntervalSeconds: 0 }, store);
  const elapsed = Date.now() - started;

  assert.equal(result.views.length, 2);
  assert.equal(maxActive, 2);
  assert.ok(elapsed < 55, `expected parallel execution, got ${elapsed}ms`);
}));

test("VisualFrameView compiler samples repeated frames by surface and respects concurrency", () => withStore(async (store) => {
  const evidence = Array.from({ length: 6 }, (_, index) => store.upsertView({
    id: `evidence:screen:repeat-${index}`,
    view_type: "evidence",
    title: "VS Code - visual-views.ts",
    scope: {
      app: "VS Code",
      time_range: {
        start: new Date(Date.parse("2026-05-26T05:40:00.000Z") + index * 20_000).toISOString(),
        end: new Date(Date.parse("2026-05-26T05:40:00.000Z") + index * 20_000).toISOString(),
      },
    },
    content: {
      kind: "screen",
      subject: { app: "VS Code", title: "visual-views.ts" },
      signals: { frame_ids: [`repeat-${index}`], text: "visual-views.ts" },
    },
    confidence: 0.8,
  }));
  let active = 0;
  let maxActive = 0;
  const seen: string[] = [];
  const analyzer: VisualFrameAnalyzer = async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    seen.push(request.frame_id);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return {
      ok: true,
      content: {
        app: "VS Code",
        project: "info",
        topic: `Sampled ${request.frame_id}`,
        useful_facts: [`fact ${request.frame_id}`],
        confidence: 0.8,
      },
    };
  };

  const result = await compileVisualFrameViews({ write: true, evidenceViews: evidence, analyzer, concurrency: 2, sampleIntervalSeconds: 45 }, store);

  assert.equal(result.views.length, 3);
  assert.equal(seen.length, 3);
  assert.ok(maxActive <= 2);
  assert.equal(result.diagnostics.concurrency, 2);
  assert.equal(result.diagnostics.frame_candidates, 3);
}));

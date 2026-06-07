import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { compileEvidenceViews } from "../packages/views/evidence/index.js";
import {
  compileActivityViews,
  compileIntentViews,
  compileMemoryViews,
  compileProposalViews,
  compileResourceViews,
  compileWorkflowViews,
  buildMemoryView,
} from "../packages/views/_shared/memory-views.js";
import { runtimeTick } from "../src/runtime/runtime.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-memory-view-runtime-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("ActivityView composes continuous page EvidenceViews through source_views", () => withStore((store) => {
  const base = Date.now() - 3 * 60_000;
  for (const [index, observedAt] of [
    [0, new Date(base).toISOString()],
    [1, new Date(base + 60_000).toISOString()],
    [2, new Date(base + 150_000).toISOString()],
  ] as const) {
    store.insertRecord({
      id: `record:page-${index}`,
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "Chrome", domain: "youtube.com" },
      time: { observed_at: observedAt },
      content: {
        title: "Lecture 1 - YouTube",
        url: "https://www.youtube.com/watch?v=lecture",
      },
      payload: { dwell_seconds: 60 + index, scroll_depth: 0.4 },
      privacy: { level: "private", retention: "normal" },
    });
  }

  const evidenceResult = compileEvidenceViews({ write: true, minutes: 60 }, store);
  const result = compileActivityViews({ write: true, evidenceViews: evidenceResult.views, mergeGapMinutes: 3 }, store);
  const activities = store.listViews({ view_types: ["activity"], limit: 10 });

  assert.equal(result.views.length, 1);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].content?.kind, "resource_consumption");
  assert.equal((activities[0].content?.resource as Record<string, unknown>).url, "https://www.youtube.com/watch?v=lecture");
  assert.equal((activities[0].content?.evidence_summary as Record<string, unknown>).evidence_views, 3);
  assert.equal(activities[0].source_records?.length, 3);
  assert.equal(activities[0].source_views?.length, 3);
  assert.ok(activities[0].source_views?.every(id => id.startsWith("evidence:")));
}));

test("ProposalView proposes resource, intent, and workflow Views from ActivityViews", () => withStore((store) => {
  const evidence = store.upsertView({
    id: "evidence:test-page",
    view_type: "evidence",
    title: "Lecture 1 - YouTube",
    source_records: ["record:page"],
    content: {
      kind: "page",
      observed_at: "2026-05-25T10:00:00.000Z",
      origin: { schema: "observation.browser_page_heartbeat", source: "browser" },
      subject: { type: "page", app: "Chrome", title: "Lecture 1 - YouTube", url: "https://www.youtube.com/watch?v=lecture", domain: "youtube.com" },
      signals: { duration_seconds: 600 },
      claims: ["url_seen", "resource_seen"],
    },
  });
  const activity = store.upsertView({
    id: "activity:test-watch",
    view_type: "activity",
    title: "Lecture 1 - YouTube",
    source_records: ["record:page"],
    source_views: [evidence.id],
    content: {
      kind: "resource_consumption",
      start: "2026-05-25T10:00:00.000Z",
      end: "2026-05-25T10:10:00.000Z",
      duration_minutes: 10,
      app: "Chrome",
      resource: { type: "url", url: "https://www.youtube.com/watch?v=lecture", title: "Lecture 1 - YouTube", domain: "youtube.com" },
      action: "watching_or_reading",
    },
  });

  const result = compileProposalViews({ write: true, activityViews: [activity] }, store);
  const proposal = result.views[0];
  const proposed = proposal.content?.proposed_views as Array<Record<string, unknown>>;

  assert.equal(proposal.view_type, "proposal");
  assert.equal(proposal.content?.kind, "view_proposal");
  assert.deepEqual(proposal.source_views, [activity.id]);
  assert.ok(proposed.some(item => item.view_type === "resource" && item.kind === "learning_material"));
  assert.ok(proposed.some(item => item.view_type === "intent" && item.kind === "candidate"));
  assert.ok(proposed.some(item => item.view_type === "workflow" && item.kind === "learning_session"));
}));

test("ProposalView defers intent and workflow for passive browser dwell", () => withStore((store) => {
  const activity = store.upsertView({
    id: "activity:passive-browser-dwell",
    view_type: "activity",
    title: "Lecture 1 - YouTube",
    source_records: ["record:page"],
    source_views: ["evidence:page"],
    content: {
      kind: "resource_consumption",
      start: "2026-05-25T10:00:00.000Z",
      end: "2026-05-25T11:00:00.000Z",
      duration_minutes: 60,
      app: "Chrome",
      domain: "youtube.com",
      resource: { type: "url", url: "https://www.youtube.com/watch?v=lecture", title: "Lecture 1 - YouTube", domain: "youtube.com" },
      action: "watching_or_reading",
      evidence_summary: {
        evidence_views: 4,
        kinds: { page: 4 },
        origins: { "observation.browser_page_heartbeat": 4 },
        metrics: {
          active_seconds_sum: 0,
          active_seconds_max: 0,
          scroll_events_sum: 0,
          selection_count_sum: 0,
          selected_text_length_sum: 0,
        },
      },
    },
    confidence: 0.94,
  });

  const proposal = compileProposalViews({ write: true, activityViews: [activity] }, store).views[0];
  const proposed = proposal.content?.proposed_views as Array<Record<string, unknown>>;

  assert.ok(proposed.some(item => item.view_type === "resource" && item.decision === "materialize_now"));
  assert.ok(proposed.some(item => item.view_type === "intent" && item.decision === "defer" && item.confidence === 0.35));
  assert.ok(proposed.some(item => item.view_type === "workflow" && item.decision === "defer" && item.confidence === 0.35));
}));

test("ProposalView does not materialize app-focus-only activity", () => withStore((store) => {
  const activity = store.upsertView({
    id: "activity:app-focus-only",
    view_type: "activity",
    title: "Warp",
    source_records: ["record:focus"],
    source_views: ["evidence:focus"],
    content: {
      kind: "app_focus",
      start: "2026-05-25T10:00:00.000Z",
      end: "2026-05-25T10:05:00.000Z",
      duration_minutes: 5,
      app: "Warp",
      action: "using_app",
    },
    confidence: 0.78,
  });

  const result = compileProposalViews({ write: true, activityViews: [activity] }, store);

  assert.equal(result.views.length, 0);
}));

test("ResourceView materializes low-cost resource proposals with Activity provenance", () => withStore((store) => {
  const activity = store.upsertView({
    id: "activity:resource-materialize",
    view_type: "activity",
    title: "Stanford CS153 Frontier Systems - YouTube",
    source_records: ["record:page"],
    source_views: ["evidence:page"],
    content: {
      kind: "resource_consumption",
      start: "2026-05-25T10:00:00.000Z",
      end: "2026-05-25T10:12:00.000Z",
      duration_minutes: 12,
      app: "Chrome",
      domain: "youtube.com",
      resource: { type: "url", url: "https://www.youtube.com/watch?v=frontier", title: "Stanford CS153 Frontier Systems - YouTube", domain: "youtube.com" },
      action: "watching_or_reading",
      evidence_summary: { evidence_views: 4, kinds: { page: 4 }, origins: { "observation.browser_page_heartbeat": 4 } },
    },
    confidence: 0.9,
  });
  const proposal = compileProposalViews({ write: true, activityViews: [activity] }, store).views[0];

  const result = compileResourceViews({ write: true, proposalViews: [proposal] }, store);
  const resource = result.views[0];

  assert.equal(resource.view_type, "resource");
  assert.equal(resource.content?.kind, "learning_material");
  assert.equal((resource.content?.resource as Record<string, unknown>).url, "https://www.youtube.com/watch?v=frontier");
  assert.deepEqual(resource.source_views, [proposal.id, activity.id]);
  assert.deepEqual(resource.source_records, ["record:page"]);
  assert.equal(resource.lossiness, "low");
}));

test("ResourceView uses canonical URL identity across visits", () => withStore((store) => {
  const makeActivity = (id: string, url: string) => store.upsertView({
    id,
    view_type: "activity",
    title: "A2A docs",
    source_records: [`record:${id}`],
    source_views: [`evidence:${id}`],
    content: {
      kind: "resource_consumption",
      start: "2026-05-25T10:00:00.000Z",
      end: "2026-05-25T10:08:00.000Z",
      duration_minutes: 8,
      app: "Chrome",
      domain: "example.com",
      resource: { type: "url", url, title: "A2A docs", domain: "example.com" },
      action: "watching_or_reading",
      evidence_summary: { metrics: { active_seconds_max: 120 } },
    },
    confidence: 0.9,
  });
  const one = makeActivity("activity:resource-one", "https://example.com/docs?utm_source=x#intro");
  const two = makeActivity("activity:resource-two", "https://example.com/docs");
  const proposals = [
    compileProposalViews({ write: true, activityViews: [one] }, store).views[0],
    compileProposalViews({ write: true, activityViews: [two] }, store).views[0],
  ];

  const result = compileResourceViews({ write: true, proposalViews: proposals }, store);

  assert.equal(new Set(result.views.map(view => view.id)).size, 1);
  assert.equal(store.listViews({ view_types: ["resource"], limit: 10 }).length, 1);
}));

test("IntentView records hypotheses separately from observed Activity evidence", () => withStore((store) => {
  const activity = store.upsertView({
    id: "activity:intent-candidate",
    view_type: "activity",
    title: "Memory systems paper - arXiv",
    source_records: ["record:arxiv"],
    source_views: ["evidence:arxiv"],
    content: {
      kind: "resource_consumption",
      start: "2026-05-25T11:00:00.000Z",
      end: "2026-05-25T11:08:00.000Z",
      duration_minutes: 8,
      app: "Chrome",
      domain: "arxiv.org",
      resource: { type: "url", url: "https://arxiv.org/abs/1234.5678", title: "Memory Systems for Agents", domain: "arxiv.org" },
      action: "watching_or_reading",
      evidence_summary: { evidence_views: 3, kinds: { page: 3 }, origins: { "observation.browser_page_heartbeat": 3 } },
    },
    confidence: 0.88,
  });
  const proposal = compileProposalViews({ write: true, activityViews: [activity] }, store).views[0];

  const result = compileIntentViews({ write: true, proposalViews: [proposal] }, store);
  const intent = result.views[0];

  assert.equal(intent.view_type, "intent");
  assert.equal(intent.content?.kind, "candidate");
  assert.match(String(intent.content?.hypothesis), /studying|researching/i);
  assert.ok((intent.content?.supporting_signals as string[]).some(signal => signal.includes("8 minutes")));
  assert.ok((intent.content?.counter_signals as string[]).some(signal => signal.includes("No explicit")));
  assert.deepEqual(intent.source_views, [proposal.id, activity.id]);
  assert.equal(intent.lossiness, "high");
}));

test("WorkflowView composes ResourceView, IntentView, and ActivityView into a session node", () => withStore((store) => {
  const activity = store.upsertView({
    id: "activity:workflow-source",
    view_type: "activity",
    title: "Stanford CS153 Frontier Systems - YouTube",
    source_records: ["record:workflow-page"],
    source_views: ["evidence:workflow-page"],
    content: {
      kind: "resource_consumption",
      start: "2026-05-25T12:00:00.000Z",
      end: "2026-05-25T12:15:00.000Z",
      duration_minutes: 15,
      app: "Chrome",
      domain: "youtube.com",
      resource: { type: "url", url: "https://www.youtube.com/watch?v=frontier", title: "Stanford CS153 Frontier Systems - YouTube", domain: "youtube.com" },
      action: "watching_or_reading",
      evidence_summary: { evidence_views: 5, kinds: { page: 5 }, origins: { "observation.browser_page_heartbeat": 5 } },
    },
    confidence: 0.9,
  });
  const proposal = compileProposalViews({ write: true, activityViews: [activity] }, store).views[0];
  const resource = compileResourceViews({ write: true, proposalViews: [proposal] }, store).views[0];
  const intent = compileIntentViews({ write: true, proposalViews: [proposal] }, store).views[0];

  const result = compileWorkflowViews({ write: true, intentViews: [intent], resourceViews: [resource] }, store);
  const workflow = result.views[0];

  assert.equal(workflow.view_type, "workflow");
  assert.equal(workflow.content?.kind, "learning_session");
  assert.ok((workflow.content?.phases as string[]).some(phase => phase.includes("watched_or_read")));
  assert.ok((workflow.content?.topic_candidates as string[]).some(topic => topic.includes("Stanford")));
  assert.deepEqual(new Set(workflow.source_views), new Set([intent.id, resource.id, activity.id]));
  assert.equal(workflow.stability, "project");
}));

test("MemoryView compiler promotes repeated WorkflowView topics but ignores single sessions", () => withStore((store) => {
  const one = store.upsertView({
    id: "workflow:memory-systems-1",
    view_type: "workflow",
    title: "Memory systems study session",
    source_views: ["intent:one", "resource:one"],
    content: {
      kind: "learning_session",
      topic_candidates: ["memory systems", "agent workflows"],
      phases: ["watched_or_read resource"],
      open_questions: [],
    },
    confidence: 0.76,
  });
  const single = compileMemoryViews({ write: true, workflowViews: [one] }, store);
  assert.equal(single.views.length, 0);

  const two = store.upsertView({
    id: "workflow:memory-systems-2",
    view_type: "workflow",
    title: "Agent memory architecture session",
    source_views: ["intent:two", "resource:two"],
    content: {
      kind: "learning_session",
      topic_candidates: ["memory systems", "view graph"],
      phases: ["watched_or_read resource", "discussed architecture"],
      open_questions: ["How should View nodes compose?"],
    },
    confidence: 0.78,
  });

  const repeated = compileMemoryViews({ write: true, workflowViews: [one, two] }, store);
  const memory = repeated.views[0];

  assert.equal(memory.view_type, "memory");
  assert.equal(memory.content?.kind, "learning_interest");
  assert.match(String(memory.content?.claim), /memory systems/i);
  assert.ok((memory.content?.future_use as string[]).some(use => use.includes("Surface")));
  assert.deepEqual(new Set(memory.source_views), new Set([one.id, two.id]));
  assert.equal(memory.stability, "long_term");
}));

test("MemoryView captures durable behavior-changing knowledge with provenance", () => {
  const memory = buildMemoryView({
    id: "memory:test-observation-view-pattern",
    title: "Observation to View architecture",
    kind: "project_pattern",
    claim: "Raw observations stay fixed while purpose-specific Views are generated through typed compression.",
    applies_to: ["Info runtime", "memory architecture"],
    future_use: ["Prefer View-based derived state over mutating observations"],
    source_views: ["workflow:test"],
    confidence: 0.84,
  });

  assert.equal(memory.view_type, "memory");
  assert.equal(memory.content?.kind, "project_pattern");
  assert.equal(memory.stability, "project");
  assert.equal(memory.lossiness, "high");
  assert.deepEqual(memory.source_views, ["workflow:test"]);
  assert.match(String(memory.purpose), /future behavior/);
});

test("listViews filters by type before applying the visible limit", () => withStore((store) => {
  store.upsertView({
    id: "memory:older-visible",
    view_type: "memory",
    title: "Older memory",
    content: { kind: "episode", summary: "Older memory" },
    confidence: 0.8,
  });
  for (let index = 0; index < 30; index += 1) {
    store.upsertView({
      id: `activity:newer-${index}`,
      view_type: "activity",
      title: `Newer activity ${index}`,
      content: { kind: "segment" },
      confidence: 0.7,
    });
  }

  const memories = store.listViews({ view_types: ["memory"], active_only: true, limit: 1 });

  assert.equal(memories.length, 1);
  assert.equal(memories[0].id, "memory:older-visible");
}));

test("runtimeTick compiles EvidenceView, ActivityView, and ProposalView families", async () => withStore(async (store) => {
  const base = Date.now() - 20 * 60_000;
  for (const [id, observedAt] of [
    ["record:runtime-memory-view-page-1", new Date(base).toISOString()],
    ["record:runtime-memory-view-page-2", new Date(base + 8 * 60_000).toISOString()],
  ] as const) {
    store.insertRecord({
      id,
      schema: { name: "observation.browser_page_heartbeat", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { project: "info", project_path: "/Users/junjie/info", domain: "youtube.com", app: "Chrome" },
      time: { observed_at: observedAt },
      content: {
        title: "Memory systems lecture - YouTube",
        url: "https://www.youtube.com/watch?v=memory",
        text: "Long-term memory and activity view design.",
      },
      payload: { dwell_seconds: 600, active_seconds: 120, scroll_depth: 0.2, scroll_events: 2 },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
  }

  const result = await runtimeTick({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    force: true,
    window_minutes: 60,
    min_score: 0.1,
  }, store);

  assert.equal(result.ok, true);
  assert.ok(result.compiled_views.some(view => view.view_type === "evidence"));
  assert.ok(result.compiled_views.some(view => view.view_type === "activity"));
  assert.ok(result.compiled_views.some(view => view.view_type === "proposal"));
  assert.ok(result.compiled_views.some(view => view.view_type === "resource"));
  assert.ok(result.compiled_views.some(view => view.view_type === "intent"));
  assert.ok(result.compiled_views.some(view => view.view_type === "workflow"));
  assert.ok(result.compiled_views.some(view => view.view_type === "memory"));
  assert.ok(store.listViews({ view_types: ["evidence"], limit: 10 }).length >= 1);
  assert.ok(store.listViews({ view_types: ["activity"], limit: 10 }).length >= 1);
  assert.ok(store.listViews({ view_types: ["proposal"], limit: 10 }).length >= 1);
  assert.ok(store.listViews({ view_types: ["resource"], limit: 10 }).length >= 1);
  assert.ok(store.listViews({ view_types: ["intent"], limit: 10 }).length >= 1);
  assert.ok(store.listViews({ view_types: ["workflow"], limit: 10 }).length >= 1);
  assert.ok(store.listViews({ view_types: ["memory"], limit: 10 }).length >= 1);
}));

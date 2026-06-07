import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import {
  AI_INTENT_VIEW_STRATEGY,
  AI_MEMORY_VIEW_STRATEGY,
  AI_WORKFLOW_VIEW_STRATEGY,
  compileIntentViewsWithLlm,
  compileMemoryViewsWithLlm,
  compileWorkflowViewsWithLlm,
  type LlmViewCompressor,
} from "../packages/views/_shared/view-compression.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-view-compression-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("LLM IntentView compiler turns ProposalView and ActivityView into an inferred intent", () => withStore(async (store) => {
  const activity = store.upsertView({
    id: "activity:llm-intent-source",
    view_type: "activity",
    title: "EverCore memory extractor files",
    source_records: ["record:evercore"],
    content: {
      kind: "resource_consumption",
      duration_minutes: 14,
      resource: { url: "file:///EverCore/memory_manager.py", title: "memory_manager.py" },
    },
    confidence: 0.88,
  });
  const proposal = store.upsertView({
    id: "proposal:llm-intent",
    view_type: "proposal",
    title: "Intent proposal",
    source_views: [activity.id],
    content: {
      kind: "view_proposal",
      proposed_views: [{ view_type: "intent", kind: "candidate", decision: "defer_or_agent", confidence: 0.68 }],
    },
    confidence: 0.68,
  });
  const compressor: LlmViewCompressor = async (request) => {
    assert.equal(request.strategy.id, AI_INTENT_VIEW_STRATEGY.id);
    assert.match(request.prompt, /Compile one IntentView/);
    assert.match(request.prompt, /EverCore memory extractor files/);
    return {
      ok: true,
      model: "mock-memory-model",
      base_url: "mock://local",
      content: {
        title: "Intent: compare memory extraction architectures",
        summary: "The user is likely studying how EverCore extracts memory.",
        kind: "candidate",
        hypothesis: "The user wants to compare AI memory extraction pipelines and adapt them to Info.",
        supporting_signals: ["Opened EverCore memory manager", "Focused on extractor files for 14 minutes"],
        counter_signals: ["No explicit user confirmation in the activity window"],
        suggested_workflow_kind: "research_session",
        confidence: 0.81,
      },
    };
  };

  const result = await compileIntentViewsWithLlm({ write: true, proposalViews: [proposal], compressor }, store);
  const intent = result.views[0];

  assert.equal(intent.view_type, "intent");
  assert.equal(intent.compiler?.mode, "llm");
  assert.equal(intent.compiler?.id, AI_INTENT_VIEW_STRATEGY.id);
  assert.equal(intent.content?.hypothesis, "The user wants to compare AI memory extraction pipelines and adapt them to Info.");
  assert.deepEqual(new Set(intent.source_views), new Set([proposal.id, activity.id]));
  assert.equal(intent.metadata?.prompt_id, "intent_candidate_v1");
  assert.deepEqual((intent.metadata?.llm as Record<string, unknown>).model, "mock-memory-model");
}));

test("LLM WorkflowView compiler compresses intent, activity, and resource Views into session structure", () => withStore(async (store) => {
  const activity = store.upsertView({
    id: "activity:llm-workflow-source",
    view_type: "activity",
    title: "HyperMem README",
    source_records: ["record:hypermem"],
    content: { kind: "resource_consumption", duration_minutes: 20 },
  });
  const resource = store.upsertView({
    id: "resource:hypermem-readme",
    view_type: "resource",
    title: "HyperMem README",
    source_views: [activity.id],
    content: { kind: "learning_material", resource: { url: "file:///HyperMem/README.md", title: "HyperMem README" } },
  });
  const intent = store.upsertView({
    id: "intent:llm-workflow",
    view_type: "intent",
    title: "Intent: study hypergraph memory",
    source_views: [activity.id],
    content: {
      kind: "candidate",
      hypothesis: "The user is studying HyperMem's topic/episode/fact hierarchy.",
      suggested_workflow_kind: "research_session",
    },
    confidence: 0.82,
  });
  const compressor: LlmViewCompressor = async (request) => {
    assert.equal(request.strategy.id, AI_WORKFLOW_VIEW_STRATEGY.id);
    assert.match(request.prompt, /Compile one WorkflowView/);
    return {
      ok: true,
      model: "mock-memory-model",
      base_url: "mock://local",
      content: {
        title: "Research session: HyperMem and EverCore memory views",
        summary: "The session compared memory extraction systems and mapped them to Info.",
        kind: "research_session",
        phases: ["Read HyperMem hierarchy", "Compared EverCore MemCell extraction", "Mapped ideas to Info Views"],
        decisions: ["Use AI compression for IntentView, WorkflowView, and MemoryView"],
        outputs: ["Compression strategy direction"],
        blockers: [],
        open_questions: ["How should LLM compression be scheduled?"],
        topic_candidates: ["memory views", "AI compression", "HyperMem"],
        confidence: 0.84,
      },
    };
  };

  const result = await compileWorkflowViewsWithLlm({ write: true, intentViews: [intent], resourceViews: [resource], compressor }, store);
  const workflow = result.views[0];

  assert.equal(workflow.view_type, "workflow");
  assert.equal(workflow.compiler?.mode, "llm");
  assert.equal(workflow.content?.kind, "research_session");
  assert.deepEqual(workflow.content?.decisions, ["Use AI compression for IntentView, WorkflowView, and MemoryView"]);
  assert.deepEqual(new Set(workflow.source_views), new Set([intent.id, activity.id, resource.id]));
  assert.equal(workflow.metadata?.prompt_id, "workflow_session_v1");
}));

test("LLM Intent and Workflow compilers consume ActivityBlockView visual evidence", () => withStore(async (store) => {
  const visual = store.upsertView({
    id: "visual_frame:block-source",
    view_type: "visual_frame",
    title: "visual-views.ts type error",
    content: {
      kind: "screen_semantics",
      topic: "TypeScript type error in visual-views.ts",
      useful_facts: ["Property updated_at does not exist on ContextView"],
    },
    confidence: 0.85,
  });
  const block = store.upsertView({
    id: "activity_block:visual:test",
    view_type: "activity_block",
    title: "Debug TypeScript type error",
    source_views: [visual.id],
    content: {
      kind: "visual_activity_block",
      primary_work: "Debugging TypeScript type error in visual-views.ts",
      done_signal: "none",
      continuation_signal: "strong",
      memory_worthiness: 0.62,
      should_create_memory: false,
    },
    confidence: 0.78,
  });
  const compressor: LlmViewCompressor = async (request) => {
    if (request.strategy.id === AI_INTENT_VIEW_STRATEGY.id) {
      assert.match(request.prompt, /ActivityBlockView/);
      assert.match(request.prompt, /TypeScript type error/);
      return {
        ok: true,
        content: {
          title: "Intent: fix VisualFrameView type error",
          summary: "The user is trying to fix the VisualFrameView type error.",
          kind: "candidate",
          hypothesis: "The user is debugging VisualFrameView TypeScript types.",
          supporting_signals: ["Visual evidence shows visual-views.ts type error"],
          counter_signals: ["No explicit completion signal"],
          suggested_workflow_kind: "debugging_session",
          confidence: 0.8,
        },
      };
    }
    assert.equal(request.strategy.id, AI_WORKFLOW_VIEW_STRATEGY.id);
    assert.match(request.prompt, /ActivityBlockView/);
    return {
      ok: true,
      content: {
        title: "Debugging VisualFrameView type error",
        summary: "The block captured debugging of a TypeScript type error in visual-views.ts.",
        kind: "debugging_session",
        phases: ["Observed type error", "Adjusted visual view code"],
        decisions: ["Use safer ContextView updated_at handling"],
        outputs: ["Type fix candidate"],
        blockers: [],
        open_questions: ["Verify typecheck"],
        topic_candidates: ["VisualFrameView", "TypeScript type error"],
        confidence: 0.82,
      },
    };
  };

  const intents = await compileIntentViewsWithLlm({ write: true, proposalViews: [], activityBlockViews: [block], compressor }, store);
  const workflows = await compileWorkflowViewsWithLlm({ write: true, intentViews: intents.views, resourceViews: [], activityBlockViews: [block], compressor }, store);

  assert.equal(intents.views.length, 1);
  assert.equal(intents.views[0].view_type, "intent");
  assert.ok(intents.views[0].source_views?.includes(block.id));
  assert.ok(workflows.views.length >= 1);
  assert.ok(workflows.views.some(view => view.source_views?.includes(block.id)));
  assert.ok(workflows.views.every(view => view.view_type === "workflow"));
}));

test("LLM IntentView compiler skips deferred app-focus proposals", () => withStore(async (store) => {
  const activity = store.upsertView({
    id: "activity:weak-app-focus",
    view_type: "activity",
    title: "Warp",
    content: { kind: "app_focus", app: "Warp", duration_minutes: 12 },
    confidence: 0.78,
  });
  const proposal = store.upsertView({
    id: "proposal:weak-app-focus",
    view_type: "proposal",
    title: "Weak app-focus proposal",
    source_views: [activity.id],
    content: {
      kind: "view_proposal",
      proposed_views: [{ view_type: "intent", kind: "candidate", decision: "defer", confidence: 0.45 }],
    },
    confidence: 0.45,
  });
  let calls = 0;
  const compressor: LlmViewCompressor = async () => {
    calls += 1;
    return { ok: true, content: { title: "Should not exist", hypothesis: "weak", confidence: 0.9 } };
  };

  const result = await compileIntentViewsWithLlm({ write: true, proposalViews: [proposal], compressor }, store);

  assert.equal(calls, 0);
  assert.equal(result.views.length, 0);
  assert.equal(result.diagnostics.candidates_seen, 1);
  assert.equal(result.diagnostics.skipped_by_gate, 1);
}));

test("LLM WorkflowView compiler skips weak app-focus-derived intents", () => withStore(async (store) => {
  const activity = store.upsertView({
    id: "activity:weak-workflow-source",
    view_type: "activity",
    title: "Warp",
    content: { kind: "app_focus", app: "Warp", duration_minutes: 18 },
    confidence: 0.78,
  });
  const intent = store.upsertView({
    id: "intent:weak-workflow",
    view_type: "intent",
    title: "Possible intent: Warp",
    source_views: [activity.id],
    content: {
      kind: "candidate",
      hypothesis: "The user may be using Warp.",
      suggested_workflow_kind: "research_session",
    },
    confidence: 0.5,
  });
  let calls = 0;
  const compressor: LlmViewCompressor = async () => {
    calls += 1;
    return { ok: true, content: { title: "Should not exist", kind: "research_session", confidence: 0.9 } };
  };

  const result = await compileWorkflowViewsWithLlm({ write: true, intentViews: [intent], resourceViews: [], compressor }, store);

  assert.equal(calls, 0);
  assert.equal(result.views.length, 0);
  assert.equal(result.diagnostics.candidates_seen, 1);
  assert.equal(result.diagnostics.skipped_by_gate, 1);
}));

test("LLM WorkflowView compiler does not store defer-like workflow responses", () => withStore(async (store) => {
  const activity = store.upsertView({
    id: "activity:defer-workflow-source",
    view_type: "activity",
    title: "A2A docs",
    content: { kind: "resource_consumption", duration_minutes: 12, resource: { url: "https://example.com/docs", title: "A2A docs" } },
    confidence: 0.9,
  });
  const intent = store.upsertView({
    id: "intent:defer-workflow",
    view_type: "intent",
    title: "Intent: read A2A docs",
    source_views: [activity.id],
    content: { kind: "candidate", hypothesis: "The user may be reading A2A docs.", suggested_workflow_kind: "research_session" },
    confidence: 0.7,
  });
  let calls = 0;
  const compressor: LlmViewCompressor = async () => {
    calls += 1;
    return { ok: true, content: { title: "Wait for more evidence", kind: "defer", summary: "Not enough evidence.", confidence: 0.72 } };
  };

  const result = await compileWorkflowViewsWithLlm({ write: true, intentViews: [intent], resourceViews: [], compressor }, store);

  assert.equal(calls, 1);
  assert.equal(result.views.length, 0);
}));

test("LLM MemoryView compiler can emit multiple memory-family Views from WorkflowViews", () => withStore(async (store) => {
  const workflow = store.upsertView({
    id: "workflow:llm-memory-source",
    view_type: "workflow",
    title: "Memory view architecture discussion",
    source_records: ["record:discussion"],
    source_views: ["intent:discussion", "activity:discussion"],
    content: {
      kind: "research_session",
      decisions: ["MemoryView is a family of agent-consumable views, not only a final long-term artifact"],
      topic_candidates: ["memory view", "agent memory"],
    },
    confidence: 0.84,
  });
  const compressor: LlmViewCompressor = async (request) => {
    assert.equal(request.strategy.id, AI_MEMORY_VIEW_STRATEGY.id);
    assert.match(request.prompt, /MemoryView is a family/);
    return {
      ok: true,
      model: "mock-memory-model",
      base_url: "mock://local",
      content: {
        memories: [
          {
            title: "Episode: memory view architecture correction",
            summary: "The user corrected the design: MemoryView should be a family of agent-consumable views.",
            kind: "episode",
            use_for: ["session recall", "future design discussion"],
            facts: ["AnswerView is out of scope for now"],
            signals: ["explicit user correction"],
            stable: false,
            confidence: 0.8,
          },
          {
            title: "Project context: MemoryView family model",
            summary: "Info should model MemoryView as episode, semantic, user, project, workflow, agent case, agent skill, and surfacing policy memories.",
            kind: "project_context",
            use_for: ["memory architecture implementation"],
            facts: ["MemoryView can be created from meaningful closed units"],
            signals: ["accepted design direction"],
            stable: true,
            confidence: 0.86,
          },
        ],
      },
    };
  };

  const result = await compileMemoryViewsWithLlm({ write: true, workflowViews: [workflow], existingMemoryViews: [], compressor }, store);

  assert.equal(result.views.length, 2);
  assert.deepEqual(result.views.map(view => view.content?.kind), ["episode", "project_context"]);
  assert.equal(result.views[0].status, "candidate");
  assert.equal(result.views[1].status, "accepted");
  assert.equal(result.views[1].stability, "long_term");
  assert.deepEqual(result.views.map(view => view.compiler?.mode), ["llm", "llm"]);
  assert.ok(result.views.every(view => view.source_views?.includes(workflow.id)));
  assert.equal(result.views[0].metadata?.prompt_id, "memory_family_v1");
}));

test("LLM MemoryView compiler does not summarize existing MemoryViews without new WorkflowViews", () => withStore(async (store) => {
  const existing = store.upsertView({
    id: "memory:existing-summary",
    view_type: "memory",
    title: "Existing memory",
    summary: "This memory already exists.",
    content: { kind: "episode", summary: "This memory already exists." },
    confidence: 0.8,
  });
  let calls = 0;
  const compressor: LlmViewCompressor = async () => {
    calls += 1;
    return { ok: true, content: { memories: [{ title: "Duplicate", summary: "This memory already exists.", kind: "episode" }] } };
  };

  const result = await compileMemoryViewsWithLlm({ write: true, workflowViews: [], existingMemoryViews: [existing], compressor }, store);

  assert.equal(calls, 0);
  assert.equal(result.views.length, 0);
  assert.equal(result.source_views_used, 0);
  assert.equal(result.diagnostics.attempted, 0);
}));

test("LLM MemoryView compiler skips premature user profile memories", () => withStore(async (store) => {
  const workflow = store.upsertView({
    id: "workflow:profile-too-early",
    view_type: "workflow",
    title: "Single browsing session",
    source_records: ["record:one"],
    content: { kind: "learning_session", topic_candidates: ["AI economics"], decisions: ["Watched one lecture"] },
    confidence: 0.84,
  });
  const compressor: LlmViewCompressor = async () => ({
    ok: true,
    content: {
      memories: [
        {
          title: "User likes AI economics",
          summary: "The user likes AI economics videos.",
          kind: "user_profile",
          stable: true,
          confidence: 0.9,
        },
      ],
    },
  });

  const result = await compileMemoryViewsWithLlm({ write: true, workflowViews: [workflow], existingMemoryViews: [], compressor }, store);

  assert.equal(result.views.length, 0);
}));

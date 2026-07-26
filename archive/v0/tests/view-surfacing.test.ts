import test from "node:test";
import assert from "node:assert/strict";
import { rankViewsForSurfacing, surfacingPreferencesFromMemoryViews } from "@info/core";
import type { StoredContextView } from "@info/core";

function memory(input: Partial<StoredContextView> & { id: string; content?: Record<string, unknown> }): StoredContextView {
  const now = "2026-05-25T00:00:00.000Z";
  return {
    id: input.id,
    view_type: input.view_type ?? "memory.surfacing_preference",
    title: input.title,
    status: input.status,
    content: input.content ?? {},
    confidence: input.confidence,
    validity: input.validity,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  } as StoredContextView;
}

test("surfacingPreferencesFromMemoryViews only returns effective active memory", () => {
  const preferences = surfacingPreferencesFromMemoryViews([
    memory({
      id: "memory:show-more-agent-task",
      content: { preference: "show_more", target_view_type: "analysis.browser_agent_task" },
      confidence: 0.9,
    }),
    memory({
      id: "memory:show-less-browser",
      content: { preference: "show_less", target_view_type: "analysis.browser_page" },
      confidence: 0.8,
    }),
    memory({
      id: "memory:missing-target",
      content: { preference: "show_less" },
      confidence: 0.9,
    }),
    memory({
      id: "memory:low-confidence",
      content: { preference: "show_more", target_view_type: "analysis.repo" },
      confidence: 0.49,
    }),
    memory({
      id: "memory:archived",
      status: "archived",
      content: { preference: "show_less", target_view_type: "analysis.repo" },
      confidence: 0.9,
    }),
    memory({
      id: "memory:stale",
      validity: { stale_after: "2026-01-01T00:00:00.000Z" },
      content: { preference: "show_less", target_view_type: "analysis.docs" },
      confidence: 0.9,
    }),
  ]);

  assert.deepEqual(preferences, {
    show_more_view_types: ["analysis.browser_agent_task"],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:show-less-browser", "memory:show-more-agent-task"],
  });
});

test("rankViewsForSurfacing applies show_more before neutral before show_less", () => {
  const ranked = rankViewsForSurfacing([
    { id: "browser-newer", view_type: "analysis.browser_page", updated_at: "2026-05-25T00:00:03.000Z" },
    { id: "repo-neutral", view_type: "analysis.repo", updated_at: "2026-05-25T00:00:02.000Z" },
    { id: "agent-task-older", view_type: "analysis.browser_agent_task", updated_at: "2026-05-25T00:00:01.000Z" },
  ], {
    show_more_view_types: ["analysis.browser_agent_task"],
    show_less_view_types: ["analysis.browser_page"],
    source_view_ids: ["memory:show-more-agent-task", "memory:show-less-browser"],
  });

  assert.deepEqual(ranked.map(view => view.id), ["agent-task-older", "repo-neutral", "browser-newer"]);
});

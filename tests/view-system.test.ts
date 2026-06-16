import test from "node:test";
import assert from "node:assert/strict";
import type { StoredContextView } from "@info/core";
import {
  builtinViewSpecs,
  createViewRegistry,
  filterStoredViews,
  legacyViewFamilyToSpec,
  namespaceOf,
} from "@info/view-system";

test("view registry supports dynamic arbitrary view families", () => {
  const registry = createViewRegistry(builtinViewSpecs());

  registry.register({
    view_type: "youtube.caption_fragment",
    title: "YouTube Caption Fragment",
    purpose: "A timestamped caption span captured from a YouTube video.",
    lifecycle: "session",
    subject: {
      description: "Open subject metadata for a video fragment.",
      examples: [{ type: "video", title: "Agent skills talk" }],
    },
    producers: [{ id: "processor.youtube_caption_segmenter", kind: "processor" }],
    consumes: { observations: ["observation.youtube.caption_fragment"] },
    content_schema: { kind: "example-schema-hint" },
    default_query: { view_types: ["youtube.caption_fragment"], limit: 20 },
    examples: [{
      view_type: "youtube.caption_fragment",
      content: { start_seconds: 12, end_seconds: 28, text: "caption text" },
    }],
    tags: ["learning", "youtube"],
  });

  assert.equal(namespaceOf("youtube.caption_fragment"), "youtube");
  assert.equal(registry.get("youtube.caption_fragment")?.title, "YouTube Caption Fragment");
  assert.deepEqual(registry.list({ namespace: "youtube" }).map(spec => spec.view_type), ["youtube.caption_fragment"]);
  assert.equal(registry.has("state.surface"), true);
  assert.equal(registry.get("memory.candidate")?.lifecycle, "session");
  assert.equal(registry.get("agent.case_memory")?.lifecycle, "long_term");
  assert.equal(registry.get("memory.candidate")?.producers?.[0]?.id, "processor.memory_candidate");
});

test("registry can merge legacy catalog-shaped definitions", () => {
  const registry = createViewRegistry();

  registry.mergeLegacy([
    {
      view_type: "legacy.example",
      label: "Legacy Example",
      purpose: "Legacy catalog shape.",
      category: "memory",
      producers: ["compiler"],
      default_page_size: 12,
    },
  ]);

  const spec = registry.get("legacy.example");
  assert.equal(spec?.title, "Legacy Example");
  assert.equal(spec?.lifecycle, "long_term");
  assert.equal(spec?.default_query?.limit, 12);
  assert.equal(legacyViewFamilyToSpec({
    view_type: "project.current_context",
    label: "Project Context",
    purpose: "Legacy project context.",
    category: "project",
  }).lifecycle, "project");
});

test("query helpers filter stored ContextViews without closed categories", () => {
  const views: StoredContextView[] = [
    {
      id: "view-1",
      view_type: "learning.youtube_fragment",
      status: "candidate",
      stability: "session",
      created_at: "2026-06-16T00:00:00.000Z",
      updated_at: "2026-06-16T00:00:00.000Z",
      metadata: {
        labels: ["learning", "youtube"],
        subject: { type: "video", id: "abc" },
      },
      content: { text: "caption" },
    },
    {
      id: "view-2",
      view_type: "memory.preferences",
      status: "accepted",
      stability: "long_term",
      created_at: "2026-06-16T00:00:00.000Z",
      updated_at: "2026-06-16T00:00:00.000Z",
      metadata: {
        labels: ["memory"],
        subject: { type: "user" },
      },
      content: { preference: "quiet inbox" },
    },
  ];

  assert.deepEqual(filterStoredViews(views, { prefix: "learning.", labels: ["youtube"] }).map(view => view.id), ["view-1"]);
  assert.deepEqual(filterStoredViews(views, { subject: { type: "user" }, stability: "long_term" }).map(view => view.id), ["view-2"]);
  assert.deepEqual(filterStoredViews(views, { view_types: ["missing"] }), []);
});

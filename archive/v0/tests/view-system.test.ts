import test from "node:test";
import assert from "node:assert/strict";
import type { StoredContextView } from "@info/core";
import {
  builtinViewSpecs,
  canActorWriteView,
  createViewRegistry,
  filterStoredViews,
  legacyViewFamilyToSpec,
  namespaceOf,
  viewStorageFor,
  viewWritePolicyFor,
} from "@info/view-system";
import {
  VIEW_FAMILY_DEFINITIONS,
  VIEW_FAMILY_ORDER,
  manualViewFamilies,
  viewFamilyDefinition,
} from "@info/views/catalog.js";

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
  assert.equal(registry.get("memory.daily")?.lifecycle, "long_term");
  assert.equal(registry.get("memory.daily")?.producers?.some(producer => producer.kind === "manual"), true);
  assert.equal(registry.get("memory.profile")?.producers?.some(producer => producer.kind === "agent"), true);
  assert.equal(registry.get("memory.daily")?.storage?.kind, "markdown");
  assert.equal(canActorWriteView(registry.get("memory.daily")!, "agent"), true);
  assert.equal(canActorWriteView(registry.get("memory.daily")!, "processor"), true);
  assert.equal(registry.get("agent.case_memory")?.lifecycle, "long_term");
  assert.equal(registry.get("view.promotion_candidates")?.producers?.some(producer => producer.id === "processor.view_promotion_engine"), true);
});

test("view specs default to actor-agnostic inline writes unless a family declares richer storage", () => {
  const registry = createViewRegistry(builtinViewSpecs());
  const surface = registry.get("state.surface")!;
  const daily = registry.get("memory.daily")!;
  const profile = registry.get("memory.profile")!;

  assert.deepEqual(viewStorageFor(surface), { kind: "inline_json" });
  assert.equal(viewStorageFor(daily).kind, "markdown");
  assert.equal(viewStorageFor(profile).path_template, "memory/profile/{subject}.md");

  const policy = viewWritePolicyFor(surface);
  assert.equal(policy.actor_agnostic, true);
  assert.equal(policy.requires_provenance, true);
  for (const actor of ["user", "agent", "processor", "runtime", "plugin", "connector", "system"] as const) {
    assert.equal(policy.allowed_actors.includes(actor), true, `expected ${actor} to be allowed`);
  }
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

test("view catalog is derived from the view-system registry and keeps aliases out of the canonical order", () => {
  const specs = builtinViewSpecs();
  const specTypes = new Set(specs.map(spec => spec.view_type));
  for (const type of [
    "state.surface",
    "work.focus_set",
    "project.current",
    "project.decisions",
    "project.inbox",
    "project.tasks",
    "memory.profile",
    "memory.preferences",
    "learning.youtube_fragment",
    "learning.review_queue",
    "view.promotion_candidates",
  ]) {
    assert.equal(specTypes.has(type), true, `missing builtin spec ${type}`);
  }

  assert.equal(viewFamilyDefinition("research.brief")?.view_type, "brief.research");
  assert.equal(viewFamilyDefinition("writing.advice")?.view_type, "advice.writing_assist");
  assert.equal(viewFamilyDefinition("app.language.review_queue")?.view_type, "learning.review_queue");
  assert.equal(viewFamilyDefinition("memory.daily")?.storage?.kind, "markdown");
  assert.equal(viewFamilyDefinition("memory.profile")?.write_policy?.actor_agnostic, true);
  assert.equal(VIEW_FAMILY_ORDER.includes("research.brief"), false);
  assert.equal(VIEW_FAMILY_ORDER.includes("writing.advice"), false);
  assert.equal(VIEW_FAMILY_ORDER.includes("app.language.review_queue"), false);
  assert.equal(VIEW_FAMILY_DEFINITIONS.length >= specs.length, true);
  assert.equal(manualViewFamilies().some(definition => definition.view_type === "memory.profile"), true);
});

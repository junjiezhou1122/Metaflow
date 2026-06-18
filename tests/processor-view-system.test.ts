import test from "node:test";
import assert from "node:assert/strict";
import { builtinViewSpecs, createViewRegistry, type ViewSpec } from "@info/view-system";
import { buildProcessorViewReport, createSurfaceStateProcessor, createViewPromotionEngineProcessor, type ProcessorDefinition } from "@info/processor-runtime";

const scenarioSpecs: ViewSpec[] = [
  {
    view_type: "writing.advice",
    title: "Writing Advice",
    purpose: "Inline-safe writing suggestion or critique.",
    lifecycle: "ephemeral",
  },
  {
    view_type: "draft.writing_continuation",
    title: "Writing Continuation",
    purpose: "Editable continuation draft.",
    lifecycle: "ephemeral",
  },
  {
    view_type: "learning.youtube_fragment",
    title: "YouTube Learning Fragment",
    purpose: "Timestamped caption fragment for review.",
    lifecycle: "session",
  },
  {
    view_type: "learning.review_queue",
    title: "Learning Review Queue",
    purpose: "Review items prepared from learning fragments.",
    lifecycle: "session",
  },
  {
    view_type: "memory.preferences",
    title: "User Preferences",
    purpose: "Long-term preferences.",
    lifecycle: "long_term",
  },
  {
    view_type: "memory.workflow_patterns",
    title: "Workflow Patterns",
    purpose: "Repeated workflow patterns.",
    lifecycle: "long_term",
  },
  {
    view_type: "automation.plan",
    title: "Automation Plan",
    purpose: "Planned automation steps.",
    lifecycle: "session",
  },
  {
    view_type: "automation.outcome",
    title: "Automation Outcome",
    purpose: "Automation result.",
    lifecycle: "session",
  },
];

const declarationProcessors: ProcessorDefinition[] = [
  {
    id: "processor.writing_ambient",
    consumes: { observations: ["observation.editor.text_changed"] },
    produces: { views: ["writing.advice", "draft.writing_continuation"] },
    runtime: { kind: "llm", provider: "configured" },
    policy: { speed: "glance", autonomy: "suggest", privacy: "private" },
  },
  {
    id: "processor.youtube_learning",
    consumes: { observations: ["observation.youtube.caption_fragment"] },
    produces: { views: ["learning.youtube_fragment", "learning.review_queue"] },
    runtime: { kind: "local" },
    policy: { speed: "glance", autonomy: "draft", privacy: "private" },
  },
  {
    id: "processor.memory_profile_update",
    consumes: { observations: ["feedback.output.edited"], views: ["project.decisions"] },
    produces: { views: ["memory.preferences", "memory.workflow_patterns"] },
    runtime: { kind: "llm", provider: "configured" },
    policy: { speed: "background", autonomy: "draft", privacy: "private" },
  },
  {
    id: "processor.browser_automation",
    consumes: { views: ["state.surface", "automation.plan"] },
    produces: { views: ["automation.outcome"] },
    runtime: { kind: "agent_task", agent: "acp" },
    policy: { speed: "work", autonomy: "sandbox_auto", privacy: "private" },
  },
];

test("processor report maps declarations to registered view specs", () => {
  const registry = createViewRegistry([...builtinViewSpecs(), ...scenarioSpecs, {
    view_type: "project.decisions",
    title: "Project Decisions",
    purpose: "Project decisions.",
    lifecycle: "project",
  }]);
  const report = buildProcessorViewReport([createSurfaceStateProcessor(), createViewPromotionEngineProcessor(), ...declarationProcessors], registry);

  const surface = report.processors.find(processor => processor.id === "processor.surface_state");
  assert.ok(surface);
  assert.deepEqual(surface.produces.views, ["state.surface"]);
  assert.equal(surface.runtime, "local");
  assert.equal(surface.policy.speed, "reflex");

  const writing = report.processors.find(processor => processor.id === "processor.writing_ambient");
  assert.deepEqual(writing?.consumes.observations, ["observation.editor.text_changed"]);
  assert.deepEqual(writing?.produces.views, ["writing.advice", "draft.writing_continuation"]);

  const automation = report.processors.find(processor => processor.id === "processor.browser_automation");
  assert.equal(automation?.runtime, "agent_task");
  assert.equal(automation?.policy.autonomy, "sandbox_auto");

  const promotion = report.processors.find(processor => processor.id === "processor.view_promotion_engine");
  assert.deepEqual(promotion?.produces.views, ["view.promotion_candidates"]);
  assert.equal(promotion?.runtime, "local");
  assert.deepEqual(report.warnings, []);
});

test("processor report warns on unregistered produced views without failing", () => {
  const registry = createViewRegistry(builtinViewSpecs());
  const report = buildProcessorViewReport([
    {
      id: "processor.experimental",
      consumes: { observations: ["observation.any"] },
      produces: { views: ["experimental.unregistered"] },
      runtime: { kind: "local" },
    },
  ], registry);

  assert.equal(report.processors[0]?.warnings[0], "produces unregistered view experimental.unregistered");
  assert.deepEqual(report.warnings, ["processor.experimental: produces unregistered view experimental.unregistered"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createViewRegistry, type ViewSpec } from "@info/view-system";

const scenarioSpecs: ViewSpec[] = [
  {
    view_type: "project.current",
    title: "Project Current",
    purpose: "Current project context for coding work.",
    lifecycle: "project",
    subject: { description: "Open project subject metadata.", examples: [{ name: "info" }] },
    producers: [{ id: "processor.project_current", kind: "processor" }],
    consumes: { observations: ["observation.codex.message", "observation.browser_page_snapshot"] },
  },
  {
    view_type: "advice.writing_assist",
    title: "Writing Assist",
    purpose: "Inline-safe writing suggestion or critique.",
    lifecycle: "ephemeral",
    producers: [{ id: "processor.writing_ambient", kind: "processor" }],
    consumes: { observations: ["observation.editor.text_changed"] },
  },
  {
    view_type: "learning.youtube_fragment",
    title: "YouTube Learning Fragment",
    purpose: "Timestamped caption fragment for review.",
    lifecycle: "session",
    producers: [{ id: "processor.youtube_learning", kind: "processor" }],
    consumes: { observations: ["observation.youtube.caption_state", "observation.youtube.caption_fragment"] },
  },
  {
    view_type: "brief.research",
    title: "Research Brief",
    purpose: "Synthesis from browser research sources.",
    lifecycle: "session",
    producers: [{ id: "processor.research_brief", kind: "processor" }],
    consumes: { observations: ["observation.browser_page_snapshot", "observation.browser_text_selected"] },
  },
  {
    view_type: "memory.preferences",
    title: "User Preferences",
    purpose: "Long-term preferences that change future agent behavior.",
    lifecycle: "long_term",
    producers: [{ id: "processor.memory_profile_update", kind: "processor" }],
    consumes: { observations: ["feedback.output.edited", "observation.codex.message"] },
  },
  {
    view_type: "state.surface",
    title: "Current Surface",
    purpose: "Current focused surface.",
    lifecycle: "ephemeral",
    producers: [{ id: "processor.surface_state", kind: "processor" }],
    consumes: { observations: ["observation.browser_page_heartbeat", "observation.screenpipe_frame"] },
  },
  {
    view_type: "automation.outcome",
    title: "Automation Outcome",
    purpose: "Result of an automation action.",
    lifecycle: "session",
    producers: [{ id: "processor.automation_outcome", kind: "processor" }],
    consumes: { observations: ["task.browser_action", "feedback.automation_result"] },
  },
];

test("view-system registers diverse scenarios without core schema changes", () => {
  const registry = createViewRegistry(scenarioSpecs);

  assert.deepEqual(registry.namespaces(), ["advice", "automation", "brief", "learning", "memory", "project", "state"]);
  assert.equal(registry.get("project.current")?.subject?.examples?.[0]?.name, "info");
  assert.equal(registry.get("advice.writing_assist")?.lifecycle, "ephemeral");
  assert.equal(registry.get("learning.youtube_fragment")?.consumes?.observations?.includes("observation.youtube.caption_fragment"), true);
  assert.equal(registry.get("brief.research")?.purpose, "Synthesis from browser research sources.");
  assert.equal(registry.get("memory.preferences")?.lifecycle, "long_term");
  assert.equal(registry.get("state.surface")?.producers?.[0]?.id, "processor.surface_state");
  assert.equal(registry.get("automation.outcome")?.consumes?.observations?.includes("feedback.automation_result"), true);
});

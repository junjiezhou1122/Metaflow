import test from "node:test";
import assert from "node:assert/strict";
import { validateViewRepresentation } from "@info/view";
import { runViewPackageConformance } from "@info/view-package";
import {
  PERSONAL_AUDIO_RENDERER,
  PERSONAL_AUDIO_SCHEMA,
  PERSONAL_AUDIO_TRANSFORMATION,
  PERSONAL_DAILY_SUMMARY_RENDERER,
  PERSONAL_DAILY_SUMMARY_SCHEMA,
  PERSONAL_DAILY_SUMMARY_TRANSFORMATION,
  PERSONAL_TIMELINE_RENDERER,
  PERSONAL_TIMELINE_SCHEMA,
  PERSONAL_TIMELINE_TRANSFORMATION,
  personalDailySummaryTransformation,
  personalActivityFixtures,
  personalActivityViewPackage,
  personalAudioSchema,
  personalTimelineTransformation,
  personalDailySummarySchema,
  personalTimelineSchema,
} from "../view-packages/personal-activity/index.ts";

const transformations = new Map([
  [`${PERSONAL_AUDIO_TRANSFORMATION.transformation_id}@${PERSONAL_AUDIO_TRANSFORMATION.revision}`, {
    ref: PERSONAL_AUDIO_TRANSFORMATION,
    output_schema: PERSONAL_AUDIO_SCHEMA,
    input_roles: [{ role: "audio_evidence", required: true, schemas: [{ name: "capture.screenpipe.audio", version: 1 }] }],
  }],
  [`${PERSONAL_TIMELINE_TRANSFORMATION.transformation_id}@${PERSONAL_TIMELINE_TRANSFORMATION.revision}`, {
    ref: PERSONAL_TIMELINE_TRANSFORMATION,
    output_schema: PERSONAL_TIMELINE_SCHEMA,
    input_roles: [
      { role: "activity_views", required: true, schemas: [PERSONAL_AUDIO_SCHEMA] },
      { role: "base_timeline", required: false, schemas: [PERSONAL_TIMELINE_SCHEMA] },
    ],
  }],
  [`${PERSONAL_DAILY_SUMMARY_TRANSFORMATION.transformation_id}@${PERSONAL_DAILY_SUMMARY_TRANSFORMATION.revision}`, {
    ref: PERSONAL_DAILY_SUMMARY_TRANSFORMATION,
    output_schema: PERSONAL_DAILY_SUMMARY_SCHEMA,
    input_roles: [
      { role: "timeline", required: true, schemas: [PERSONAL_TIMELINE_SCHEMA] },
      { role: "base_summary", required: false, schemas: [PERSONAL_DAILY_SUMMARY_SCHEMA] },
    ],
  }],
]);

const renderers = new Set([
  `${PERSONAL_AUDIO_RENDERER.id}@${PERSONAL_AUDIO_RENDERER.version}@${PERSONAL_AUDIO_RENDERER.abi_version}`,
  `${PERSONAL_TIMELINE_RENDERER.id}@${PERSONAL_TIMELINE_RENDERER.version}@${PERSONAL_TIMELINE_RENDERER.abi_version}`,
  `${PERSONAL_DAILY_SUMMARY_RENDERER.id}@${PERSONAL_DAILY_SUMMARY_RENDERER.version}@${PERSONAL_DAILY_SUMMARY_RENDERER.abi_version}`,
]);

test("Personal Activity View Package owns strict Audio, Timeline, and Daily Summary product Views", () => {
  const report = runViewPackageConformance({
    package: personalActivityViewPackage,
    fixtures: personalActivityFixtures,
    operations: new Set(["view.get"]),
    renderers,
    transformations,
  });

  assert.deepEqual(report, {
    package_id: "view-package.personal-activity",
    package_version: 1,
    schemas: 3,
    fixtures: 4,
    methods: 3,
    renderers: 3,
    parsers: 0,
    processors: 3,
    evolutions: 0,
  });
  assert.equal(personalActivityViewPackage.processors(PERSONAL_TIMELINE_SCHEMA)[0]?.inputs[0]?.role, "activity_views");
  assert.equal(personalActivityViewPackage.processors(PERSONAL_DAILY_SUMMARY_SCHEMA)[0]?.inputs[0]?.role, "timeline");
  assert.deepEqual(personalTimelineTransformation.operator.reference, { kind: "function", function_id: "personal.activity.timeline", version: 1 });
  assert.deepEqual(personalDailySummaryTransformation.operator.reference, { kind: "function", function_id: "personal.summary.daily", version: 1 });
});

test("product View fixtures reject missing content instead of falling back to generic JSON", () => {
  const [audio, timeline, summary] = personalActivityFixtures;
  validateViewRepresentation(personalAudioSchema, audio.representation);
  validateViewRepresentation(personalTimelineSchema, timeline.representation);
  validateViewRepresentation(personalDailySummarySchema, summary.representation);

  const invalidAudio = structuredClone(audio.representation) as {
    value: Record<string, unknown>;
  };
  delete invalidAudio.value.transcript;
  assert.throws(() => validateViewRepresentation(personalAudioSchema, invalidAudio));
});

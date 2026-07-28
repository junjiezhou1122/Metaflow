import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeterministicViewAccessAuthorizer,
  ExecutionRuntime,
  OperatorExecutionRouter,
} from "@info/execution";
import { FunctionOperatorAdapter } from "@info/function-operator-adapter";
import {
  executePersonalDailySummary,
  executePersonalTimeline,
  PERSONAL_DAILY_SUMMARY_FUNCTION as WORKER_DAILY_SUMMARY_FUNCTION,
  PERSONAL_TIMELINE_FUNCTION as WORKER_TIMELINE_FUNCTION,
} from "@info/personal-activity-operator-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import {
  exactViewRef,
  type ExactViewRef,
  type View,
  type ViewDraft,
  type ViewPolicy,
} from "@info/view";
import {
  PERSONAL_AUDIO_REPRESENTATION,
  PERSONAL_DAILY_SUMMARY_FUNCTION,
  PERSONAL_DAILY_SUMMARY_REPRESENTATION,
  PERSONAL_TIMELINE_FUNCTION,
  PERSONAL_TIMELINE_REPRESENTATION,
  personalActivityFixtures,
  personalAudioSchema,
  personalDailySummaryTransformation,
  personalTimelineTransformation,
} from "@info/view-package-personal-activity";

const POLICY: ViewPolicy = {
  owner: "user:personal-activity",
  visibility: "private",
  privacy: "private",
  retention: "normal",
  allow_external_model: false,
  allow_embedding: false,
  allow_local_search: true,
  labels: ["personal-activity"],
};

const ACCESS_POLICY = {
  id: "policy:test:personal-activity",
  revision: 1,
  configuration: { kind: "view_access" as const, profile: "approve_all" as const, rules: [] },
};

test("Audio View[] forms an evolving Timeline and Daily Summary through the real Execution Runtime", async () => {
  assert.deepEqual(WORKER_TIMELINE_FUNCTION, PERSONAL_TIMELINE_FUNCTION);
  assert.deepEqual(WORKER_DAILY_SUMMARY_FUNCTION, PERSONAL_DAILY_SUMMARY_FUNCTION);
  const directory = mkdtempSync(join(tmpdir(), "metaflow-personal-activity-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter([
    { reference: PERSONAL_TIMELINE_FUNCTION, execute: executePersonalTimeline },
    { reference: PERSONAL_DAILY_SUMMARY_FUNCTION, execute: executePersonalDailySummary },
  ]);
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    new OperatorExecutionRouter([{ kind: "function", port: functions }]),
    undefined,
    { now: deterministicClock(), id: deterministicId() },
  );

  try {
    const design = await commitAudio(repository, "view:personal:audio:design-conversation", "fixture.personal.audio.design-conversation");
    const focus = await commitAudio(repository, "view:personal:audio:implementation-focus", "fixture.personal.audio.implementation-focus");
    const timelineOne = await executeOne(runtime, {
      runId: "run:personal:timeline:1",
      transformation: personalTimelineTransformation,
      invocationInputs: [{ role: "activity_views", views: [exactViewRef(focus), exactViewRef(design)] }],
    });
    assert.equal(timelineOne.id, "view:personal:timeline:2026-07-27");
    assert.equal(timelineOne.revision, 1);
    assert.equal(timelineOne.representation.kind, PERSONAL_TIMELINE_REPRESENTATION);
    assert.deepEqual(timelineOne.provenance.inputs, [exactViewRef(design), exactViewRef(focus)]);
    assert.deepEqual(timelineOne.relations.map(relation => relation.target), [exactViewRef(design), exactViewRef(focus)]);
    const timelineOneValue = inlineValue(timelineOne);
    assert.equal((timelineOneValue.blocks as unknown[]).length, 2);
    assert.equal(timelineOneValue.date, "2026-07-27");

    const summaryOne = await executeOne(runtime, {
      runId: "run:personal:summary:1",
      transformation: personalDailySummaryTransformation,
      invocationInputs: [{ role: "timeline", views: [exactViewRef(timelineOne)] }],
    });
    assert.equal(summaryOne.id, "view:personal:summary:2026-07-27");
    assert.equal(summaryOne.revision, 1);
    assert.equal(summaryOne.representation.kind, PERSONAL_DAILY_SUMMARY_REPRESENTATION);
    assert.deepEqual(inlineValue(summaryOne).source_timeline, exactViewRef(timelineOne));

    const late = await commitAudio(repository, "view:personal:audio:late-review", "fixture.personal.audio.implementation-focus", {
      started_at: "2026-07-27T12:35:00.000Z",
      ended_at: "2026-07-27T12:40:00.000Z",
      summary: "Reviewed the first product View chain.",
    });
    const timelineTwo = await executeOne(runtime, {
      runId: "run:personal:timeline:2",
      transformation: personalTimelineTransformation,
      invocationInputs: [
        { role: "activity_views", views: [exactViewRef(design), exactViewRef(focus), exactViewRef(late)] },
        { role: "base_timeline", views: [exactViewRef(timelineOne)] },
      ],
    });
    assert.equal(timelineTwo.id, timelineOne.id);
    assert.equal(timelineTwo.revision, 2);
    assert.equal((inlineValue(timelineTwo).blocks as unknown[]).length, 3);
    assert.deepEqual(timelineTwo.relations.at(-1), { type: "supersedes", target: exactViewRef(timelineOne), metadata: {} });
    assert.equal((await repository.get(exactViewRef(timelineOne)))?.revision, 1);

    const summaryTwo = await executeOne(runtime, {
      runId: "run:personal:summary:2",
      transformation: personalDailySummaryTransformation,
      invocationInputs: [
        { role: "timeline", views: [exactViewRef(timelineTwo)] },
        { role: "base_summary", views: [exactViewRef(summaryOne)] },
      ],
    });
    assert.equal(summaryTwo.id, summaryOne.id);
    assert.equal(summaryTwo.revision, 2);
    assert.deepEqual(inlineValue(summaryTwo).source_timeline, exactViewRef(timelineTwo));
    assert.deepEqual(summaryTwo.relations.at(-1), { type: "supersedes", target: exactViewRef(summaryOne), metadata: {} });
    assert.equal((await repository.get(exactViewRef(summaryOne)))?.revision, 1);

    const trace = await runtime.replay("run:personal:timeline:2");
    assert.deepEqual(trace.events.map(event => event.type), [
      "run.created",
      "attempt.started",
      "function.started",
      "personal_activity.timeline.formed",
      "function.completed",
      "run.succeeded",
    ]);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Personal Activity Workers fail instead of silently mixing local days or rewriting an unchanged Summary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-personal-activity-failure-"));
  const repository = new SqliteViewRepository(join(directory, "views.sqlite"));
  const functions = new FunctionOperatorAdapter([
    { reference: PERSONAL_TIMELINE_FUNCTION, execute: executePersonalTimeline },
    { reference: PERSONAL_DAILY_SUMMARY_FUNCTION, execute: executePersonalDailySummary },
  ]);
  const runtime = new ExecutionRuntime(
    repository,
    repository,
    new DeterministicViewAccessAuthorizer(),
    functions,
    undefined,
    { now: deterministicClock(), id: deterministicId() },
  );

  try {
    const first = await commitAudio(repository, "view:personal:audio:day-one", "fixture.personal.audio.design-conversation");
    const nextDay = await commitAudio(repository, "view:personal:audio:day-two", "fixture.personal.audio.implementation-focus", {
      started_at: "2026-07-28T09:35:00.000Z",
      ended_at: "2026-07-28T09:40:00.000Z",
    });
    const failed = await runtime.execute({
      run_id: "run:personal:timeline:mixed-days",
      correlation_id: "correlation:personal:timeline:mixed-days",
      transformation: personalTimelineTransformation,
      invocation_inputs: [{ role: "activity_views", views: [exactViewRef(first), exactViewRef(nextDay)] }],
      access_policy: ACCESS_POLICY,
      access_use: "local_execution",
    });
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.run.error?.code, "operator_failed");
    assert.equal(failed.run.error?.details.operator_code, "timeline_multiple_local_days");
    assert.equal(failed.failure?.schema.name, "metaflow.execution.failure");
    assert.deepEqual(failed.run.failure_view, failed.failure ? exactViewRef(failed.failure) : undefined);

    const timeline = await executeOne(runtime, {
      runId: "run:personal:timeline:single-day",
      transformation: personalTimelineTransformation,
      invocationInputs: [{ role: "activity_views", views: [exactViewRef(first)] }],
    });
    const summary = await executeOne(runtime, {
      runId: "run:personal:summary:single-day",
      transformation: personalDailySummaryTransformation,
      invocationInputs: [{ role: "timeline", views: [exactViewRef(timeline)] }],
    });
    const unchanged = await runtime.execute({
      run_id: "run:personal:summary:unchanged",
      correlation_id: "correlation:personal:summary:unchanged",
      transformation: personalDailySummaryTransformation,
      invocation_inputs: [
        { role: "timeline", views: [exactViewRef(timeline)] },
        { role: "base_summary", views: [exactViewRef(summary)] },
      ],
      access_policy: ACCESS_POLICY,
      access_use: "local_execution",
    });
    assert.equal(unchanged.run.status, "failed");
    assert.equal(unchanged.run.error?.code, "operator_failed");
    assert.equal(unchanged.run.error?.details.operator_code, "daily_summary_timeline_unchanged");
    assert.equal(unchanged.failure?.schema.name, "metaflow.execution.failure");
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function executeOne(
  runtime: ExecutionRuntime,
  input: {
    runId: string;
    transformation: typeof personalTimelineTransformation | typeof personalDailySummaryTransformation;
    invocationInputs: Array<{ role: string; views: ExactViewRef[] }>;
  },
): Promise<View> {
  const result = await runtime.execute({
    run_id: input.runId,
    correlation_id: `correlation:${input.runId}`,
    transformation: input.transformation,
    invocation_inputs: input.invocationInputs,
    access_policy: ACCESS_POLICY,
    access_use: "local_execution",
  });
  assert.equal(result.run.status, "succeeded", JSON.stringify(result.run.error));
  assert.equal(result.outputs.length, 1);
  return result.outputs[0]!;
}

async function commitAudio(
  repository: SqliteViewRepository,
  id: string,
  fixtureId: string,
  overrides: Record<string, unknown> = {},
): Promise<View> {
  const fixture = personalActivityFixtures.find(item => item.id === fixtureId);
  if (!fixture) throw new Error(`Missing Personal Activity fixture ${fixtureId}`);
  const representation = structuredClone(fixture.representation) as ViewDraft["representation"];
  if (representation.form !== "inline" || typeof representation.value !== "object" || representation.value === null || Array.isArray(representation.value)) {
    throw new Error(`Personal Activity fixture ${fixtureId} must be an inline object`);
  }
  representation.value = { ...representation.value, ...overrides };
  return (await repository.commit({
    draft: {
      id,
      name: id.split(":").at(-1)!.replaceAll("-", " "),
      purpose: "Semantic Audio View fixture",
      aliases: [],
      schema: personalAudioSchema,
      role: "raw",
      time: { observed_at: (representation.value as { started_at: string }).started_at, created_at: "2026-07-27T00:00:00.000Z" },
      representation,
      materialization: {
        primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
        alternatives: [],
      },
      relations: [],
      provenance: {
        inputs: [],
        actor: "capture-ingress",
        capture: {
          connector: "fixture",
          connection_id: "fixture:personal-activity",
          source_id: id,
          source_kind: "audio_occurrence",
          identity: "occurrence",
          assertion: "direct",
        },
      },
      policy: POLICY,
      metadata: {},
    },
    expected_revision: 0,
  })).view;
}

function inlineValue(view: View): Record<string, unknown> {
  if (view.representation.form !== "inline" || typeof view.representation.value !== "object" || view.representation.value === null || Array.isArray(view.representation.value)) {
    throw new Error(`Expected inline object View ${view.id}@${view.revision}`);
  }
  return view.representation.value;
}

function deterministicClock(): () => string {
  let tick = 0;
  const start = Date.parse("2026-07-27T00:00:00.000Z");
  return () => new Date(start + tick++ * 10).toISOString();
}

function deterministicId(): (kind: string) => string {
  let sequence = 0;
  return kind => `${kind}:personal-activity:${++sequence}`;
}

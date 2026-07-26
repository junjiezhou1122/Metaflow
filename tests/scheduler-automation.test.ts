import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutomationRuntimeError,
  parseAutomationDefinition,
  parseAutomationView,
  type AutomationInvocationResult,
  type ParsedAutomationView,
  type TriggerSignal,
} from "../packages/automation/index.ts";
import {
  SchedulerAutomationAdapterError,
  SchedulerAutomationController,
  SqliteScheduleCursorRepository,
} from "../packages/adapters/scheduler-automation/index.ts";
import { parseView } from "../packages/view/index.ts";
import { dailySummaryAutomationDraft } from "../apps/ambient-daemon/definitions.ts";

test("timezone schedule survives restart and catches up explicit missed periods once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduler-restart-"));
  const path = join(directory, "automation.sqlite");
  let current = new Date("2026-07-26T16:00:10.000Z");
  const calls: TriggerSignal[] = [];
  const automation = dailyAutomation();
  let cursors = new SqliteScheduleCursorRepository(path);
  try {
    const first = controller({ automation, cursors, now: () => current, calls });
    const initial = await first.tick();
    assert.equal(initial.periods.length, 1);
    assert.deepEqual(periodOf(initial.periods[0]!.signal), {
      start: "2026-07-25T16:00:00.000Z",
      end: "2026-07-26T16:00:00.000Z",
    });
    assert.equal(dispatchState(initial.periods[0]!.signal), "on_time");
    first.close();
    cursors.close();

    cursors = new SqliteScheduleCursorRepository(path);
    current = new Date("2026-07-26T16:00:20.000Z");
    const restarted = controller({ automation, cursors, now: () => current, calls });
    assert.equal((await restarted.tick()).periods.length, 0);

    current = new Date("2026-07-29T16:05:00.000Z");
    const caughtUp = await restarted.tick();
    assert.deepEqual(caughtUp.periods.map(item => periodOf(item.signal).end), [
      "2026-07-27T16:00:00.000Z",
      "2026-07-28T16:00:00.000Z",
      "2026-07-29T16:00:00.000Z",
    ]);
    assert.deepEqual(caughtUp.periods.map(item => dispatchState(item.signal)), ["missed", "missed", "delayed"]);
    assert.equal(new Set(calls.map(signal => signal.idempotency_key)).size, calls.length);
  } finally {
    cursors.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a duplicate runtime result advances the durable cursor after a crash window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduler-duplicate-"));
  const path = join(directory, "automation.sqlite");
  const automation = dailyAutomation();
  const current = new Date("2026-07-26T16:00:10.000Z");
  let cursors = new SqliteScheduleCursorRepository(path);
  try {
    const duplicateRuntime = {
      async invoke(): Promise<AutomationInvocationResult> {
        return { status: "duplicate", correlation_id: "existing:correlation", existing_status: "succeeded" };
      },
    };
    const first = new SchedulerAutomationController({
      catalog: { async list() { return [automation]; } },
      cursors,
      runtime: duplicateRuntime,
      now: () => current,
    });
    const result = await first.tick();
    assert.equal(result.periods[0]?.result.status, "duplicate");
    assert.equal(result.periods[0]?.cursor_advanced, true);
    const committedCursor = await cursors.get(result.periods[0]!.schedule_key);
    assert.ok(committedCursor);
    assert.deepEqual(await cursors.advance({
      cursor: { ...committedCursor!, updated_at: "2026-07-26T16:00:11.000Z" },
    }), { advanced: false });
    cursors.close();

    cursors = new SqliteScheduleCursorRepository(path);
    const restarted = new SchedulerAutomationController({
      catalog: { async list() { return [automation]; } },
      cursors,
      runtime: { async invoke() { throw new Error("must not run"); } },
      now: () => new Date("2026-07-26T16:00:30.000Z"),
    });
    assert.equal((await restarted.tick()).periods.length, 0);
  } finally {
    cursors.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a persisted Automation context failure is terminal and advances the schedule cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduler-terminal-failure-"));
  const cursors = new SqliteScheduleCursorRepository(join(directory, "automation.sqlite"));
  const automation = dailyAutomation();
  const events: string[] = [];
  const scheduler = new SchedulerAutomationController({
    catalog: { async list() { return [automation]; } },
    cursors,
    runtime: {
      async invoke() {
        throw new AutomationRuntimeError("Automation context resolution failed", "context_resolution_failed");
      },
    },
    now: () => new Date("2026-07-26T16:00:10.000Z"),
    events: { emit(event) { events.push(event.type); } },
  });
  try {
    const first = await scheduler.tick();
    assert.equal(first.periods[0]?.result.status, "failed");
    assert.equal(first.periods[0]?.cursor_advanced, true);
    assert.ok(events.includes("scheduler.period_failed"));
    assert.ok(events.includes("scheduler.cursor_advanced"));
    assert.equal((await scheduler.tick()).periods.length, 0);
  } finally {
    scheduler.close();
    cursors.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual replay has a new explicit identity and does not move the schedule cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduler-replay-"));
  const cursors = new SqliteScheduleCursorRepository(join(directory, "automation.sqlite"));
  const calls: TriggerSignal[] = [];
  const automation = dailyAutomation();
  try {
    const scheduler = controller({
      automation,
      cursors,
      now: () => new Date("2026-07-26T16:00:10.000Z"),
      calls,
    });
    const normal = await scheduler.tick();
    const replay = await scheduler.replay({
      automation,
      period: periodOf(normal.periods[0]!.signal),
      replay_id: "user-rerun-1",
      reason: "Include the corrected project name",
      parent_signal_id: normal.periods[0]!.signal.id,
    });
    assert.equal(dispatchState(replay.signal), "manual_replay");
    assert.notEqual(replay.signal.idempotency_key, normal.periods[0]!.signal.idempotency_key);
    assert.match(JSON.stringify(replay.signal.payload), /user-rerun-1/);
    assert.equal((await scheduler.tick()).periods.length, 0);
  } finally {
    cursors.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cron periods follow timezone DST and retain half-open adjacent boundaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduler-dst-"));
  const cursors = new SqliteScheduleCursorRepository(join(directory, "automation.sqlite"));
  try {
    const automation = scheduleAutomation({ timezone: "America/New_York", expression: "0 0 * * *", maxPeriods: 7 });
    const scheduler = controller({
      automation,
      cursors,
      now: () => new Date("2026-03-09T04:00:10.000Z"),
      calls: [],
    });
    const period = periodOf((await scheduler.tick()).periods[0]!.signal);
    assert.deepEqual(period, {
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    });
    assert.equal(Date.parse(period.end) - Date.parse(period.start), 23 * 60 * 60 * 1_000);
  } finally {
    cursors.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catch-up fails instead of silently dropping periods beyond the declared bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-scheduler-limit-"));
  const cursors = new SqliteScheduleCursorRepository(join(directory, "automation.sqlite"));
  let current = new Date("2026-07-26T16:00:10.000Z");
  const automation = scheduleAutomation({ timezone: "Asia/Shanghai", expression: "0 0 * * *", maxPeriods: 1 });
  try {
    const scheduler = controller({ automation, cursors, now: () => current, calls: [] });
    await scheduler.tick();
    current = new Date("2026-07-28T16:00:10.000Z");
    await assert.rejects(
      scheduler.tick(),
      (error: unknown) => error instanceof SchedulerAutomationAdapterError && error.code === "catch_up_limit_exceeded",
    );
  } finally {
    cursors.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function controller(input: {
  automation: ParsedAutomationView;
  cursors: SqliteScheduleCursorRepository;
  now: () => Date;
  calls: TriggerSignal[];
}) {
  return new SchedulerAutomationController({
    catalog: { async list() { return [input.automation]; } },
    cursors: input.cursors,
    runtime: {
      async invoke({ signal }): Promise<AutomationInvocationResult> {
        input.calls.push(signal);
        return {
          status: "succeeded",
          correlation_id: `correlation:${signal.id}`,
          occurrence: {} as never,
          run_id: `run:${signal.id}`,
          output_views: [{ view_id: `summary:${signal.id}`, revision: 1 }],
          deliveries: [],
        };
      },
    },
    now: input.now,
  });
}

function dailyAutomation(): ParsedAutomationView {
  return parseAutomationView(parseView({ ...dailySummaryAutomationDraft, revision: 1 }));
}

function scheduleAutomation(input: { timezone: string; expression: string; maxPeriods: number }): ParsedAutomationView {
  const definition = parseAutomationDefinition({
    version: 1,
    enabled: true,
    trigger: {
      id: "summary",
      kind: "schedule",
      source: "scheduler",
      event: "period",
      schedule: {
        format: "cron",
        expression: input.expression,
        timezone: input.timezone,
        misfire: { policy: "catch_up", max_periods: input.maxPeriods },
      },
    },
    target: { kind: "operation", name: "summary", version: 1 },
  });
  return parseAutomationView(parseView({
    ...dailySummaryAutomationDraft,
    id: `automation:test:${input.timezone}`,
    revision: 1,
    representation: { ...dailySummaryAutomationDraft.representation, value: definition },
  }));
}

function periodOf(signal: TriggerSignal): { start: string; end: string } {
  return signal.payload.period as { start: string; end: string };
}

function dispatchState(signal: TriggerSignal): string {
  return (signal.payload.dispatch as { state: string }).state;
}

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CronExpressionParser } from "cron-parser";
import {
  AutomationRuntimeError,
  SchedulePeriodSchema,
  parseAutomationView,
  parseTriggerSignal,
  type AutomationInvocationResult,
  type AutomationRuntime,
  type ParsedAutomationView,
  type SchedulePeriod,
  type TriggerSignal,
} from "@info/automation";
import type { JsonValue, ViewRepository } from "@info/view";

export type ScheduleCursor = {
  key: string;
  automation_view_id: string;
  automation_revision: number;
  trigger_id: string;
  expression: string;
  timezone: string;
  last_period: SchedulePeriod;
  last_signal_id: string;
  updated_at: string;
};

export interface ScheduleCursorRepository {
  get(key: string): Promise<ScheduleCursor | undefined>;
  advance(input: {
    cursor: ScheduleCursor;
    expected_last_period_end?: string;
  }): Promise<{ advanced: boolean }>;
}

export interface SchedulerAutomationCatalog {
  list(): Promise<ParsedAutomationView[]>;
}

export class ViewSchedulerAutomationCatalog implements SchedulerAutomationCatalog {
  constructor(
    private readonly views: Pick<ViewRepository, "query">,
    private readonly limit = 1_000,
  ) {}

  async list(): Promise<ParsedAutomationView[]> {
    const views = await this.views.query({
      schema_name: "metaflow.automation",
      role: "derived",
      revisions: "latest",
      limit: this.limit,
    });
    return views.map(parseAutomationView);
  }
}

export type SchedulerAdapterEvent = {
  type:
    | "scheduler.tick_started"
    | "scheduler.tick_completed"
    | "scheduler.period_detected"
    | "scheduler.period_invoked"
    | "scheduler.period_deferred"
    | "scheduler.period_failed"
    | "scheduler.cursor_advanced"
    | "scheduler.replay_requested";
  occurred_at: string;
  schedule_key?: string;
  automation?: { view_id: string; revision: number };
  signal_id?: string;
  payload: Record<string, JsonValue>;
};

export type SchedulerTickResult = {
  detected_at: string;
  schedules: number;
  periods: Array<{
    schedule_key: string;
    signal: TriggerSignal;
    result: AutomationInvocationResult | SchedulerTerminalInvocationFailure;
    cursor_advanced: boolean;
  }>;
};

export type SchedulerTerminalInvocationFailure = {
  status: "failed";
  scheduler_failure: true;
  code: "context_resolution_failed" | "target_execution_failed";
  error: string;
};

export type SchedulerAutomationControllerOptions = {
  catalog: SchedulerAutomationCatalog;
  cursors: ScheduleCursorRepository;
  runtime: Pick<AutomationRuntime, "invoke">;
  now?: () => Date;
  on_time_grace_ms?: number;
  events?: { emit(event: SchedulerAdapterEvent): void | Promise<void> };
};

export class SchedulerAutomationAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_schedule"
      | "catch_up_limit_exceeded"
      | "automation_invocation_failed"
      | "cursor_conflict"
      | "invalid_replay",
    readonly details: Record<string, JsonValue> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchedulerAutomationAdapterError";
  }
}

export class SchedulerAutomationController {
  private readonly now: () => Date;
  private readonly graceMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly options: SchedulerAutomationControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.graceMs = options.on_time_grace_ms ?? 60_000;
    if (!Number.isInteger(this.graceMs) || this.graceMs < 0) {
      throw new Error("Scheduler on_time_grace_ms must be a non-negative integer");
    }
  }

  async tick(): Promise<SchedulerTickResult> {
    if (this.ticking) throw new Error("Scheduler tick is already running");
    this.ticking = true;
    const detectedAt = this.now();
    try {
      await this.emit({ type: "scheduler.tick_started", occurred_at: detectedAt.toISOString(), payload: {} });
      const automations = (await this.options.catalog.list())
        .filter(item => item.definition.enabled && item.definition.trigger.kind === "schedule");
      const periods: SchedulerTickResult["periods"] = [];
      for (const automation of automations) {
        periods.push(...await this.invokeDuePeriods(automation, detectedAt));
      }
      await this.emit({
        type: "scheduler.tick_completed",
        occurred_at: this.now().toISOString(),
        payload: { schedules: automations.length, periods: periods.length },
      });
      return { detected_at: detectedAt.toISOString(), schedules: automations.length, periods };
    } finally {
      this.ticking = false;
    }
  }

  async replay(input: {
    automation: ParsedAutomationView;
    period: SchedulePeriod;
    replay_id: string;
    reason: string;
    parent_signal_id?: string;
  }): Promise<{ signal: TriggerSignal; result: AutomationInvocationResult }> {
    const trigger = input.automation.definition.trigger;
    if (trigger.kind !== "schedule") {
      throw new SchedulerAutomationAdapterError("Manual schedule replay requires a schedule Automation", "invalid_replay");
    }
    const period = SchedulePeriodSchema.parse(input.period);
    assertAdjacentCronPeriod(trigger.schedule.expression, trigger.schedule.timezone, period);
    const now = this.now().toISOString();
    const signal = scheduleSignal({
      automation: input.automation,
      period,
      detected_at: now,
      state: "manual_replay",
      replay: {
        id: requiredText(input.replay_id, "replay_id"),
        reason: requiredText(input.reason, "reason"),
        ...(input.parent_signal_id ? { parent_signal_id: input.parent_signal_id } : {}),
      },
    });
    await this.emit({
      type: "scheduler.replay_requested",
      occurred_at: now,
      schedule_key: scheduleKey(input.automation),
      automation: exactAutomationRef(input.automation),
      signal_id: signal.id,
      payload: { period, replay_id: input.replay_id, reason: input.reason },
    });
    return { signal, result: await this.options.runtime.invoke({ automation: input.automation, signal }) };
  }

  async start(input: {
    interval_ms?: number;
    on_error(error: unknown): void;
  }): Promise<void> {
    if (this.timer) throw new Error("Scheduler is already started");
    const intervalMs = input.interval_ms ?? 30_000;
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error("Scheduler interval_ms must be an integer of at least 1000");
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch(input.on_error);
    }, intervalMs);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async invokeDuePeriods(
    automation: ParsedAutomationView,
    detectedAt: Date,
  ): Promise<SchedulerTickResult["periods"]> {
    const trigger = automation.definition.trigger;
    if (trigger.kind !== "schedule") return [];
    const key = scheduleKey(automation);
    let cursor = await this.options.cursors.get(key);
    const periodEnds = duePeriodEnds({
      expression: trigger.schedule.expression,
      timezone: trigger.schedule.timezone,
      detected_at: detectedAt,
      after: cursor?.last_period.end,
    });
    if (periodEnds.length > trigger.schedule.misfire.max_periods) {
      throw new SchedulerAutomationAdapterError(
        `Schedule catch-up exceeds ${trigger.schedule.misfire.max_periods} periods`,
        "catch_up_limit_exceeded",
        { schedule_key: key, due_periods: periodEnds.length, cursor_end: cursor?.last_period.end ?? null },
      );
    }

    const output: SchedulerTickResult["periods"] = [];
    for (const [index, end] of periodEnds.entries()) {
      const period = previousPeriod(trigger.schedule.expression, trigger.schedule.timezone, end);
      const state = scheduleState({
        detected_at: detectedAt,
        period_end: end,
        has_later_due_period: index < periodEnds.length - 1,
        grace_ms: this.graceMs,
      });
      const signal = scheduleSignal({ automation, period, detected_at: detectedAt.toISOString(), state });
      await this.emit({
        type: "scheduler.period_detected",
        occurred_at: detectedAt.toISOString(),
        schedule_key: key,
        automation: exactAutomationRef(automation),
        signal_id: signal.id,
        payload: { period, state, cursor_end: cursor?.last_period.end ?? null },
      });

      let result: AutomationInvocationResult | SchedulerTerminalInvocationFailure;
      let terminalRuntimeFailure = false;
      try {
        result = await this.options.runtime.invoke({ automation, signal });
      } catch (error) {
        await this.emit({
          type: "scheduler.period_failed",
          occurred_at: this.now().toISOString(),
          schedule_key: key,
          automation: exactAutomationRef(automation),
          signal_id: signal.id,
          payload: { code: "automation_invocation_failed", message: errorMessage(error), period },
        });
        if (isPersistedTerminalRuntimeFailure(error)) {
          terminalRuntimeFailure = true;
          result = {
            status: "failed",
            scheduler_failure: true,
            code: error.code,
            error: errorMessage(error),
          };
        } else {
          throw new SchedulerAutomationAdapterError(
            `Scheduled Automation invocation failed for ${signal.id}`,
            "automation_invocation_failed",
            { schedule_key: key, signal_id: signal.id },
            { cause: error },
          );
        }
      }
      if (!terminalRuntimeFailure) {
        await this.emit({
          type: result.status === "skipped" || result.status === "ignored"
            ? "scheduler.period_deferred"
            : "scheduler.period_invoked",
          occurred_at: this.now().toISOString(),
          schedule_key: key,
          automation: exactAutomationRef(automation),
          signal_id: signal.id,
          payload: { status: result.status, period },
        });
      }

      const terminal = result.status === "succeeded" || result.status === "failed" || result.status === "duplicate";
      let cursorAdvanced = false;
      if (terminal) {
        const nextCursor: ScheduleCursor = {
          key,
          automation_view_id: automation.view.id,
          automation_revision: automation.view.revision,
          trigger_id: trigger.id,
          expression: trigger.schedule.expression,
          timezone: trigger.schedule.timezone,
          last_period: period,
          last_signal_id: signal.id,
          updated_at: this.now().toISOString(),
        };
        try {
          const advanced = await this.options.cursors.advance({
            cursor: nextCursor,
            ...(cursor ? { expected_last_period_end: cursor.last_period.end } : {}),
          });
          cursorAdvanced = advanced.advanced;
        } catch (error) {
          throw new SchedulerAutomationAdapterError(
            `Failed to advance Scheduler cursor for ${signal.id}`,
            "cursor_conflict",
            { schedule_key: key, signal_id: signal.id },
            { cause: error },
          );
        }
        cursor = nextCursor;
        await this.emit({
          type: "scheduler.cursor_advanced",
          occurred_at: nextCursor.updated_at,
          schedule_key: key,
          automation: exactAutomationRef(automation),
          signal_id: signal.id,
          payload: { period, advanced: cursorAdvanced },
        });
      }
      output.push({ schedule_key: key, signal, result, cursor_advanced: cursorAdvanced });
      if (!terminal) break;
    }
    return output;
  }

  private async emit(event: SchedulerAdapterEvent): Promise<void> {
    await this.options.events?.emit(event);
  }
}

function isPersistedTerminalRuntimeFailure(
  error: unknown,
): error is AutomationRuntimeError & { code: "context_resolution_failed" | "target_execution_failed" } {
  return error instanceof AutomationRuntimeError
    && (error.code === "context_resolution_failed" || error.code === "target_execution_failed");
}

type ScheduleCursorRow = {
  schedule_key: string;
  automation_view_id: string;
  automation_revision: number;
  trigger_id: string;
  expression: string;
  timezone: string;
  last_period_start: string;
  last_period_end: string;
  last_signal_id: string;
  updated_at: string;
};

export class SqliteScheduleCursorRepository implements ScheduleCursorRepository {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      create table if not exists scheduler_cursors_v1 (
        schedule_key text primary key,
        automation_view_id text not null,
        automation_revision integer not null check (automation_revision > 0),
        trigger_id text not null,
        expression text not null,
        timezone text not null,
        last_period_start text not null,
        last_period_end text not null,
        last_signal_id text not null,
        updated_at text not null
      ) strict
    `);
  }

  async get(key: string): Promise<ScheduleCursor | undefined> {
    this.assertOpen();
    const row = this.db.prepare("select * from scheduler_cursors_v1 where schedule_key = ?").get(requiredText(key, "key")) as ScheduleCursorRow | undefined;
    return row ? cursorFromRow(row) : undefined;
  }

  async advance(input: {
    cursor: ScheduleCursor;
    expected_last_period_end?: string;
  }): Promise<{ advanced: boolean }> {
    this.assertOpen();
    const cursor = parseCursor(input.cursor);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = this.db.prepare("select * from scheduler_cursors_v1 where schedule_key = ?").get(cursor.key) as ScheduleCursorRow | undefined;
      const existing = existingRow ? cursorFromRow(existingRow) : undefined;
      if (existing && sameCursor(existing, cursor)) {
        this.db.exec("COMMIT");
        return { advanced: false };
      }
      if ((existing?.last_period.end) !== input.expected_last_period_end) {
        throw new Error(
          `Scheduler cursor compare-and-swap conflict: expected ${input.expected_last_period_end ?? "empty"}, found ${existing?.last_period.end ?? "empty"}`,
        );
      }
      if (existing && Date.parse(cursor.last_period.end) <= Date.parse(existing.last_period.end)) {
        throw new Error("Scheduler cursor cannot move backwards");
      }
      this.db.prepare(`
        insert into scheduler_cursors_v1 (
          schedule_key, automation_view_id, automation_revision, trigger_id,
          expression, timezone, last_period_start, last_period_end,
          last_signal_id, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(schedule_key) do update set
          last_period_start = excluded.last_period_start,
          last_period_end = excluded.last_period_end,
          last_signal_id = excluded.last_signal_id,
          updated_at = excluded.updated_at
      `).run(
        cursor.key,
        cursor.automation_view_id,
        cursor.automation_revision,
        cursor.trigger_id,
        cursor.expression,
        cursor.timezone,
        cursor.last_period.start,
        cursor.last_period.end,
        cursor.last_signal_id,
        cursor.updated_at,
      );
      this.db.exec("COMMIT");
      return { advanced: true };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Scheduler cursor repository is closed");
  }
}

function duePeriodEnds(input: {
  expression: string;
  timezone: string;
  detected_at: Date;
  after?: string;
}): Date[] {
  try {
    if (!input.after) {
      return [previousOccurrence(input.expression, input.timezone, new Date(input.detected_at.getTime() + 1))];
    }
    const interval = CronExpressionParser.parse(input.expression, {
      currentDate: input.after,
      endDate: input.detected_at,
      tz: input.timezone,
      hashSeed: cronHashSeed(input.expression, input.timezone),
    });
    const output: Date[] = [];
    while (interval.hasNext()) {
      const next = interval.next().toDate();
      if (next.getTime() > input.detected_at.getTime()) break;
      output.push(next);
    }
    return output;
  } catch (error) {
    throw new SchedulerAutomationAdapterError(
      `Invalid or unbounded cron schedule: ${input.expression} (${input.timezone})`,
      "invalid_schedule",
      { expression: input.expression, timezone: input.timezone },
      { cause: error },
    );
  }
}

function previousPeriod(expression: string, timezone: string, end: Date): SchedulePeriod {
  return SchedulePeriodSchema.parse({
    start: previousOccurrence(expression, timezone, end).toISOString(),
    end: end.toISOString(),
  });
}

function previousOccurrence(expression: string, timezone: string, before: Date): Date {
  return CronExpressionParser.parse(expression, {
    currentDate: before,
    tz: timezone,
    hashSeed: cronHashSeed(expression, timezone),
  }).prev().toDate();
}

function assertAdjacentCronPeriod(expression: string, timezone: string, period: SchedulePeriod): void {
  try {
    const end = new Date(period.end);
    const parser = CronExpressionParser.parse(expression, {
      currentDate: end,
      tz: timezone,
      hashSeed: cronHashSeed(expression, timezone),
    });
    if (!parser.includesDate(end)) throw new Error("period end is not a cron occurrence");
    const expectedStart = previousOccurrence(expression, timezone, end).toISOString();
    if (period.start !== expectedStart) throw new Error(`period start must be ${expectedStart}`);
  } catch (error) {
    throw new SchedulerAutomationAdapterError(
      "Manual replay period is not one exact adjacent cron period",
      "invalid_replay",
      { expression, timezone, period },
      { cause: error },
    );
  }
}

function scheduleSignal(input: {
  automation: ParsedAutomationView;
  period: SchedulePeriod;
  detected_at: string;
  state: "on_time" | "delayed" | "missed" | "manual_replay";
  replay?: { id: string; reason: string; parent_signal_id?: string };
}): TriggerSignal {
  const trigger = input.automation.definition.trigger;
  if (trigger.kind !== "schedule") throw new Error("scheduleSignal requires a schedule Trigger");
  const replayIdentity = input.replay ? `:replay:${input.replay.id}` : "";
  const identity = `${input.automation.view.id}@${input.automation.view.revision}:${trigger.id}:${input.period.end}${replayIdentity}`;
  const digest = createHash("sha256").update(identity).digest("hex");
  return parseTriggerSignal({
    id: `schedule-signal:${digest}`,
    kind: "schedule",
    source: trigger.source,
    event: trigger.event,
    occurred_at: input.detected_at,
    idempotency_key: `schedule-period:${digest}`,
    payload: {
      schedule: { expression: trigger.schedule.expression, timezone: trigger.schedule.timezone },
      period: input.period,
      dispatch: {
        mode: input.replay ? "manual_replay" : "scheduled",
        state: input.state,
        detected_at: input.detected_at,
      },
      ...(input.replay ? { replay: input.replay } : {}),
    },
  });
}

function scheduleState(input: {
  detected_at: Date;
  period_end: Date;
  has_later_due_period: boolean;
  grace_ms: number;
}): "on_time" | "delayed" | "missed" {
  if (input.has_later_due_period) return "missed";
  return input.detected_at.getTime() - input.period_end.getTime() <= input.grace_ms ? "on_time" : "delayed";
}

function scheduleKey(automation: ParsedAutomationView): string {
  const trigger = automation.definition.trigger;
  if (trigger.kind !== "schedule") throw new Error("scheduleKey requires a schedule Trigger");
  const identity = `${automation.view.id}@${automation.view.revision}:${trigger.id}:${trigger.schedule.expression}:${trigger.schedule.timezone}`;
  return `schedule:${createHash("sha256").update(identity).digest("hex")}`;
}

function cronHashSeed(expression: string, timezone: string): string {
  return createHash("sha256").update(`${expression}:${timezone}`).digest("hex");
}

function exactAutomationRef(automation: ParsedAutomationView) {
  return { view_id: automation.view.id, revision: automation.view.revision };
}

function parseCursor(cursor: ScheduleCursor): ScheduleCursor {
  if (!cursor.key.trim() || !cursor.automation_view_id.trim() || !cursor.trigger_id.trim()) {
    throw new Error("Scheduler cursor identity fields are required");
  }
  if (!Number.isInteger(cursor.automation_revision) || cursor.automation_revision < 1) {
    throw new Error("Scheduler cursor automation_revision must be positive");
  }
  SchedulePeriodSchema.parse(cursor.last_period);
  if (!Number.isFinite(Date.parse(cursor.updated_at))) throw new Error("Scheduler cursor updated_at must be a timestamp");
  return cursor;
}

function cursorFromRow(row: ScheduleCursorRow): ScheduleCursor {
  return parseCursor({
    key: row.schedule_key,
    automation_view_id: row.automation_view_id,
    automation_revision: row.automation_revision,
    trigger_id: row.trigger_id,
    expression: row.expression,
    timezone: row.timezone,
    last_period: { start: row.last_period_start, end: row.last_period_end },
    last_signal_id: row.last_signal_id,
    updated_at: row.updated_at,
  });
}

function sameCursor(left: ScheduleCursor, right: ScheduleCursor): boolean {
  return left.key === right.key
    && left.automation_view_id === right.automation_view_id
    && left.automation_revision === right.automation_revision
    && left.trigger_id === right.trigger_id
    && left.expression === right.expression
    && left.timezone === right.timezone
    && left.last_period.start === right.last_period.start
    && left.last_period.end === right.last_period.end
    && left.last_signal_id === right.last_signal_id;
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { ContextStore } from "@info/core";
import {
  SCHEDULED_AI_BATCH_PROCESSOR_ID,
  runScheduledAiBatch,
  type ScheduledAiBatchOptions,
  type ScheduledAiBatchResult,
} from "@info/processor-runtime";

export const SCHEDULED_AI_BATCH_STATE_KEY = "scheduled_ai_batch";

export type RuntimeScheduledAiBatchOptions = ScheduledAiBatchOptions & {
  enabled?: boolean;
  interval_seconds?: number;
  force?: boolean;
};

export type RuntimeScheduledAiBatchResult =
  | ScheduledAiBatchResult
  | {
      ok: true;
      mode: "scheduled";
      generated_at: string;
      skipped: true;
      reason: string;
      next_run_after?: string;
      diagnostics: Record<string, unknown>;
    };

export async function processScheduledAiBatch(
  options: RuntimeScheduledAiBatchOptions = {},
  store = new ContextStore(),
): Promise<RuntimeScheduledAiBatchResult> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const enabled = options.enabled ?? true;
  const intervalSeconds = options.interval_seconds ?? 15 * 60;
  const state = store.getRuntimeState(SCHEDULED_AI_BATCH_STATE_KEY)?.value ?? {};
  const lastRunAt = stringValue(state.last_run_at);
  const due = options.mode !== "scheduled" || options.force || !lastRunAt || secondsBetween(lastRunAt, generatedAt) >= intervalSeconds;

  if (!enabled) {
    return skipped(generatedAt, "disabled", lastRunAt, intervalSeconds);
  }
  if (!due) {
    return skipped(generatedAt, "interval_not_due", lastRunAt, intervalSeconds);
  }

  const result = await runScheduledAiBatch({
    ...options,
    mode: options.mode ?? "scheduled",
    now,
  }, store);

  if (options.write ?? true) {
    store.setRuntimeState(SCHEDULED_AI_BATCH_STATE_KEY, {
      last_run_at: generatedAt,
      last_view_id: result.views_written[0] ?? ("id" in result.view ? result.view.id : undefined),
      interval_seconds: intervalSeconds,
      mode: result.mode,
      records_scanned: result.records_scanned,
      route_candidates_used: result.route_candidates_used,
      focus_sets_used: result.focus_sets_used,
      main_work_count: result.main_work.length,
      interruption_count: result.interruptions.length,
      diagnostics: result.diagnostics,
    });
  }

  return result;
}

function skipped(generatedAt: string, reason: string, lastRunAt: string | undefined, intervalSeconds: number): RuntimeScheduledAiBatchResult {
  return {
    ok: true,
    mode: "scheduled",
    generated_at: generatedAt,
    skipped: true,
    reason,
    next_run_after: lastRunAt ? new Date(Date.parse(lastRunAt) + intervalSeconds * 1000).toISOString() : undefined,
    diagnostics: {
      processor_id: SCHEDULED_AI_BATCH_PROCESSOR_ID,
      last_run_at: lastRunAt,
      interval_seconds: intervalSeconds,
    },
  };
}

function secondsBetween(start: string, end: string): number {
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

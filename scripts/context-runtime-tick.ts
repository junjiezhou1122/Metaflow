import { ContextStore } from "@info/core";
import type { RuntimeEvent, StoredContextRecord } from "@info/core";
import { compileWorkThreadView, workThreadViewToMarkdown } from "../src/runtime/work-thread-view.js";
import { BUILTIN_CONTEXT_TRIGGERS, decisionsToRuntimeEvents, evaluateTriggers } from "../src/runtime/triggers.js";

const argv = process.argv.slice(2);
const options: any = { write: true };
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--minutes") options.minutes = Number(argv[++i]);
  else if (arg === "--limit") options.limit = Number(argv[++i]);
  else if (arg === "--min-score") options.min_score = Number(argv[++i]);
  else if (arg === "--max-threads") options.max_threads = Number(argv[++i]);
  else if (arg === "--dry-run") options.write = false;
  else if (arg === "--markdown") options.markdown = true;
  else if (arg === "--event") options.event_type = argv[++i];
}

const store = new ContextStore();
const minutes = options.minutes ?? 180;
const recent = store.recent(options.limit ?? 80, undefined, { minutes });
const latest = recent[0];
const event = buildTickEvent(options.event_type ?? "schedule_tick", latest, minutes);
const evaluation = evaluateTriggers(event, BUILTIN_CONTEXT_TRIGGERS, latest ? { record: latest } : {});

if (options.write) {
  const storedEvent = store.appendRuntimeEvent(event);
  for (const triggerEvent of decisionsToRuntimeEvents({ ...evaluation, event: storedEvent })) store.appendRuntimeEvent(triggerEvent);
}

const shouldCompile = evaluation.decisions.some(decision => decision.action.kind === "compile_view" && decision.action.id === "builtin.work-thread-view");
const result = shouldCompile
  ? compileWorkThreadView(options, store)
  : undefined;

const output = {
  ok: true,
  mode: "context_runtime_tick",
  event,
  trigger_decisions: evaluation.decisions.map(decision => ({
    trigger_id: decision.trigger.id,
    action: decision.action,
    reason: decision.reason,
  })),
  skipped: evaluation.skipped,
  result,
  markdown: options.markdown && result ? workThreadViewToMarkdown(result.view) : undefined,
};

console.log(JSON.stringify(output, null, 2));

function buildTickEvent(eventType: string, latest: StoredContextRecord | undefined, minutes: number): RuntimeEvent {
  if (eventType === "record_ingested" && latest) {
    return {
      event_type: "record_ingested",
      actor: "system",
      status: "completed",
      subject_type: "record",
      subject_id: latest.id,
      related_records: [latest.id],
      payload: {
        synthetic: true,
        reason: "context-runtime-tick replayed latest record for trigger evaluation",
        schema: latest.schema,
        source: latest.source,
      },
    };
  }
  return {
    event_type: "schedule_tick",
    actor: "system",
    status: "completed",
    subject_type: "runtime",
    payload: {
      synthetic: true,
      minutes,
      latest_record_id: latest?.id,
      latest_schema: latest?.schema.name,
    },
  };
}

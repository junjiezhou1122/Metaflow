import { ContextStore } from "@info/core";
import { InProcessIiiRuntimeClient, VIEW_WORKER_FUNCTIONS, registerInfoIiiRuntime } from "@info/iii-runtime";

const argv = process.argv.slice(2);
const options: any = {};
let mode: "activity" | "observations" | "project" = "activity";
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--mode") mode = argv[++i] as any;
  else if (arg === "--observations") mode = "observations";
  else if (arg === "--activity") mode = "activity";
  else if (arg === "--project-timeline") mode = "project";
  else if (arg === "--project-path") options.project_path = argv[++i];
  else if (arg === "--project") options.project = argv[++i];
  else if (arg === "--minutes") options.minutes = Number(argv[++i]);
  else if (arg === "--limit") options.limit = Number(argv[++i]);
  else if (arg === "--event-limit") options.eventLimit = Number(argv[++i]);
  else if (arg === "--bucket-minutes") options.bucketMinutes = Number(argv[++i]);
  else if (arg === "--dry-run") options.write = false;
  else if (arg === "--no-events") options.includeRuntimeEvents = false;
}
const store = new ContextStore();
const iii = new InProcessIiiRuntimeClient();
await registerInfoIiiRuntime(iii, { store, workerName: "info-timeline-cli" });
const functionId = mode === "observations"
  ? VIEW_WORKER_FUNCTIONS.observationTimeline
  : mode === "project"
    ? VIEW_WORKER_FUNCTIONS.projectTimeline
    : VIEW_WORKER_FUNCTIONS.activityTimeline;
const workerResult = await iii.trigger({ function_id: functionId, payload: options }) as { ok?: boolean; views?: any[]; diagnostics?: Record<string, unknown> };
const view = workerResult.views?.[0];
const result = {
  ok: workerResult.ok === true,
  view,
  records_used: workerResult.diagnostics?.records_used,
  buckets: Array.isArray(view?.content?.buckets) ? view.content.buckets : [],
  iii_processing: workerResult,
};
console.log(JSON.stringify(result, null, 2));

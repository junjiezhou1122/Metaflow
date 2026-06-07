import { compileActivityTimeline } from "@info/views/timeline/activity-timeline.js";
import { compileObservationTimeline } from "@info/views/timeline/timeline.js";
import { compileProjectTimeline } from "@info/views/timeline/project-timeline.js";

const argv = process.argv.slice(2);
const options: any = {};
let mode: "activity" | "observations" | "project" = "activity";
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--mode") mode = argv[++i] as any;
  else if (arg === "--observations") mode = "observations";
  else if (arg === "--activity") mode = "activity";
  else if (arg === "--project-timeline") mode = "project";
  else if (arg === "--project-path") options.projectPath = argv[++i];
  else if (arg === "--project") options.project = argv[++i];
  else if (arg === "--minutes") options.minutes = Number(argv[++i]);
  else if (arg === "--limit") options.limit = Number(argv[++i]);
  else if (arg === "--event-limit") options.eventLimit = Number(argv[++i]);
  else if (arg === "--bucket-minutes") options.bucketMinutes = Number(argv[++i]);
  else if (arg === "--dry-run") options.write = false;
  else if (arg === "--no-events") options.includeRuntimeEvents = false;
}
const result = mode === "observations" ? compileObservationTimeline(options) : mode === "project" ? compileProjectTimeline(options) : compileActivityTimeline(options);
console.log(JSON.stringify(result, null, 2));

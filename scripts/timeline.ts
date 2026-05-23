import { compileObservationTimeline } from "../src/runtime/timeline.js";

const argv = process.argv.slice(2);
const options: any = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--minutes") options.minutes = Number(argv[++i]);
  else if (arg === "--limit") options.limit = Number(argv[++i]);
  else if (arg === "--dry-run") options.write = false;
}
console.log(JSON.stringify(compileObservationTimeline(options), null, 2));

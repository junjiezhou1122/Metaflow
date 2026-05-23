import { ContextStore } from "../src/core/store.js";

const argv = process.argv.slice(2);
const options: any = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--limit") options.limit = Number(argv[++i]);
  else if (arg === "--type") options.event_type = argv[++i];
  else if (arg === "--types") options.event_types = argv[++i].split(",").map((s: string) => s.trim()).filter(Boolean);
  else if (arg === "--plugin") options.plugin_id = argv[++i];
  else if (arg === "--actor") options.actor = argv[++i];
  else if (arg === "--actors") options.actor_types = argv[++i].split(",").map((s: string) => s.trim()).filter(Boolean);
  else if (arg === "--minutes") options.timeWindow = { ...(options.timeWindow ?? {}), minutes: Number(argv[++i]) };
  else if (arg === "--subject-type") options.subject_type = argv[++i];
  else if (arg === "--subject-id") options.subject_id = argv[++i];
}

const store = new ContextStore();
console.log(JSON.stringify({ ok: true, events: store.listRuntimeEvents(options) }, null, 2));

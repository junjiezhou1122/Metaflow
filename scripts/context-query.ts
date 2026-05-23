import { buildContextPack } from "../src/context-broker.js";
import type { ContextQuery } from "../src/types.js";

function parseArgs(argv: string[]): ContextQuery {
  const query: ContextQuery = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") query.mode = argv[++i] as ContextQuery["mode"];
    else if (arg === "--goal") query.goal = argv[++i];
    else if (arg === "--query" || arg === "-q") query.query = argv[++i];
    else if (arg === "--plugin") query.plugin_id = argv[++i];
    else if (arg === "--thread") query.thread_id = argv[++i];
    else if (arg === "--project") query.scope = { ...(query.scope ?? {}), project: argv[++i] };
    else if (arg === "--project-path") query.scope = { ...(query.scope ?? {}), project_path: argv[++i] };
    else if (arg === "--schemas") query.schemas = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (arg === "--sources") query.sources = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (arg === "--view-types") query.view_types = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (arg === "--minutes") query.time_window = { ...(query.time_window ?? {}), minutes: Number(argv[++i]) };
    else if (arg === "--limit") query.limit = Number(argv[++i]);
    else if (arg === "--no-records") query.include_records = false;
    else if (arg === "--no-views") query.include_views = false;
  }
  return query;
}

console.log(JSON.stringify(buildContextPack(parseArgs(process.argv.slice(2))), null, 2));

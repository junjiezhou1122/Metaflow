import { buildContextPack } from "@info/core";
import type { ContextQuery } from "@info/core";

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
    else if (arg === "--event-types") query.event_types = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (arg === "--actors") query.actor_types = argv[++i].split(",").map(s => s.trim()).filter(Boolean) as any;
    else if (arg === "--no-records") query.include_records = false;
    else if (arg === "--no-views") query.include_views = false;
    else if (arg === "--events") query.include_events = true;
    else if (arg === "--no-events") query.include_events = false;
    else if (arg === "--markdown") (query as any).__markdown = true;
  }
  return query;
}

const query = parseArgs(process.argv.slice(2));
const markdownOnly = Boolean((query as any).__markdown);
delete (query as any).__markdown;
const pack = buildContextPack(query);
console.log(markdownOnly ? pack.markdown : JSON.stringify(pack, null, 2));

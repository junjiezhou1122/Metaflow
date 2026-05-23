import { runtimeTick, type RuntimeTickRequest } from "../src/runtime/runtime.js";

function parseArgs(argv: string[]): RuntimeTickRequest {
  const req: RuntimeTickRequest = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--window" || arg === "--minutes") req.window_minutes = Number(argv[++i]);
    else if (arg === "--project") req.project_hints = [...(req.project_hints ?? []), argv[++i]];
    else if (arg === "--no-screenpipe") req.include_screenpipe = false;
    else if (arg === "--no-ai-sessions") req.include_ai_sessions = false;
    else if (arg === "--no-git") req.include_git = false;
    else if (arg === "--dry-run") req.write = false;
    else if (arg === "--force") req.force = true;
    else if (arg === "--min-score") req.min_score = Number(argv[++i]);
    else if (arg === "--max-threads") req.max_threads = Number(argv[++i]);
    else if (arg === "--project-snapshot-interval") req.project_snapshot_interval_seconds = Number(argv[++i]);
    else if (arg === "--ai-session-interval") req.ai_session_interval_seconds = Number(argv[++i]);
  }
  if (process.env.RUNTIME_PROJECT) req.project_hints = [...(req.project_hints ?? []), process.env.RUNTIME_PROJECT];
  if (process.env.RUNTIME_WINDOW_MINUTES) req.window_minutes = Number(process.env.RUNTIME_WINDOW_MINUTES);
  if (process.env.RUNTIME_DRY_RUN === "1") req.write = false;
  if (process.env.RUNTIME_FORCE === "1") req.force = true;
  return req;
}

const result = await runtimeTick(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));

import { ContextStore } from "../src/core/store.js";
import { runtimeStatus, runtimeTick, type RuntimeTickRequest } from "../src/runtime/runtime.js";
import { interpretThread, shouldInterpretThread } from "../src/threads/thread-interpreter.js";

function parseArgs(argv: string[]): RuntimeTickRequest & { interval_seconds?: number; once?: boolean; interpret?: boolean; interpret_force?: boolean; interpret_interval_seconds?: number } {
  const req: RuntimeTickRequest & { interval_seconds?: number; once?: boolean; interpret?: boolean; interpret_force?: boolean; interpret_interval_seconds?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--interval") req.interval_seconds = Number(argv[++i]);
    else if (arg === "--window" || arg === "--minutes") req.window_minutes = Number(argv[++i]);
    else if (arg === "--project") req.project_hints = [...(req.project_hints ?? []), argv[++i]];
    else if (arg === "--no-screenpipe") req.include_screenpipe = false;
    else if (arg === "--no-ai-sessions") req.include_ai_sessions = false;
    else if (arg === "--no-git") req.include_git = false;
    else if (arg === "--dry-run") req.write = false;
    else if (arg === "--force") req.force = true;
    else if (arg === "--once") req.once = true;
    else if (arg === "--interpret") req.interpret = true;
    else if (arg === "--interpret-force") req.interpret_force = true;
    else if (arg === "--interpret-interval") req.interpret_interval_seconds = Number(argv[++i]);
    else if (arg === "--project-snapshot-interval") req.project_snapshot_interval_seconds = Number(argv[++i]);
    else if (arg === "--ai-session-interval") req.ai_session_interval_seconds = Number(argv[++i]);
  }
  if (process.env.RUNTIME_PROJECT) req.project_hints = [...(req.project_hints ?? []), process.env.RUNTIME_PROJECT];
  if (process.env.RUNTIME_INTERVAL_SECONDS) req.interval_seconds = Number(process.env.RUNTIME_INTERVAL_SECONDS);
  if (process.env.RUNTIME_WINDOW_MINUTES) req.window_minutes = Number(process.env.RUNTIME_WINDOW_MINUTES);
  if (process.env.RUNTIME_INTERPRET === "1") req.interpret = true;
  if (process.env.RUNTIME_INTERPRET_FORCE === "1") req.interpret_force = true;
  if (process.env.RUNTIME_INTERPRET_INTERVAL_SECONDS) req.interpret_interval_seconds = Number(process.env.RUNTIME_INTERPRET_INTERVAL_SECONDS);
  return req;
}

const { interval_seconds = 30, once, interpret, interpret_force, interpret_interval_seconds = 300, ...tickReq } = parseArgs(process.argv.slice(2));
const store = new ContextStore();

async function runOnce() {
  const result = await runtimeTick(tickReq, store);
  const top: any = result.top_thread;
  let interpretation: Record<string, unknown> | undefined;
  const topId = top?.id ?? top?.thread_id;
  if (interpret && topId) {
    const thread = store.getWorkThread(topId);
    if (thread) {
      const gate = shouldInterpretThread(thread, { force: interpret_force, min_interval_seconds: interpret_interval_seconds });
      if (gate.ok) {
        const interpreted = await interpretThread({ thread_id: thread.id, write: tickReq.write !== false, update_thread: tickReq.write !== false }, store);
        interpretation = {
          attempted: true,
          reason: gate.reason,
          ok: interpreted.ok,
          display_title: interpreted.interpretation?.display_title,
          written: interpreted.written,
          error: interpreted.error,
          llm: interpreted.llm,
        };
      } else {
        interpretation = { attempted: false, reason: gate.reason };
      }
    } else {
      interpretation = { attempted: false, reason: `thread not persisted: ${topId}` };
    }
  }
  console.log(JSON.stringify({
    ok: result.ok,
    at: result.generated_at,
    workspace: result.active_workspace?.project_path,
    top_thread: top ? { id: top.id ?? top.thread_id, title: top.title, confidence: top.confidence } : undefined,
    evidence: result.evidence,
    screenpipe: (result.diagnostics.screenpipe as any)?.ok ?? "skipped",
    throttle: result.diagnostics.throttle,
    interpretation,
  }, null, 2));
}

if (once) {
  await runOnce();
  process.exit(0);
}

console.log(`[runtime-daemon] starting interval=${interval_seconds}s interpret=${Boolean(interpret)} status=${JSON.stringify(runtimeStatus(store).active_thread ?? {})}`);
await runOnce();
setInterval(() => {
  runOnce().catch(error => {
    console.error("[runtime-daemon] tick failed", error);
  });
}, interval_seconds * 1000);

import { ContextStore } from "@info/core";
import { runtimeStatus, runtimeTick, type RuntimeTickRequest } from "../src/runtime/runtime.js";
import { compileObservationTimeline } from "@info/views/timeline/timeline.js";
import { interpretThread, shouldInterpretThread } from "@info/views/threads/thread-interpreter.js";

function parseArgs(argv: string[]): RuntimeTickRequest & { interval_seconds?: number; once?: boolean; interpret?: boolean; interpret_force?: boolean; interpret_interval_seconds?: number; timeline?: boolean; timeline_interval_seconds?: number; timeline_minutes?: number; timeline_limit?: number } {
  const req: RuntimeTickRequest & { interval_seconds?: number; once?: boolean; interpret?: boolean; interpret_force?: boolean; interpret_interval_seconds?: number; timeline?: boolean; timeline_interval_seconds?: number; timeline_minutes?: number; timeline_limit?: number } = {};
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
    else if (arg === "--timeline") req.timeline = true;
    else if (arg === "--no-timeline") req.timeline = false;
    else if (arg === "--timeline-interval") req.timeline_interval_seconds = Number(argv[++i]);
    else if (arg === "--timeline-minutes") req.timeline_minutes = Number(argv[++i]);
    else if (arg === "--timeline-limit") req.timeline_limit = Number(argv[++i]);
    else if (arg === "--project-snapshot-interval") req.project_snapshot_interval_seconds = Number(argv[++i]);
    else if (arg === "--ai-session-interval") req.ai_session_interval_seconds = Number(argv[++i]);
    else if (arg === "--no-compile-views") req.compile_views = false;
    else if (arg === "--compile-views") req.compile_views = true;
    else if (arg === "--ai-view-compression") req.ai_view_compression = true;
    else if (arg === "--no-ai-view-compression") req.ai_view_compression = false;
    else if (arg === "--visual-view-compression") req.visual_view_compression = true;
    else if (arg === "--no-visual-view-compression") req.visual_view_compression = false;
    else if (arg === "--view-compile-interval") req.view_compile_interval_seconds = Number(argv[++i]);
    else if (arg === "--work-thread-minutes") req.work_thread_view_minutes = Number(argv[++i]);
    else if (arg === "--activity-minutes") req.activity_timeline_minutes = Number(argv[++i]);
    else if (arg === "--project-timeline-minutes") req.project_timeline_minutes = Number(argv[++i]);
    else if (arg === "--background-tasks") req.process_background_tasks = true;
    else if (arg === "--no-background-tasks") req.process_background_tasks = false;
    else if (arg === "--background-task-limit") req.background_task_limit = Number(argv[++i]);
    else if (arg === "--toolsmith-artifacts") req.process_toolsmith_artifacts = true;
    else if (arg === "--no-toolsmith-artifacts") req.process_toolsmith_artifacts = false;
    else if (arg === "--toolsmith-artifact-limit") req.toolsmith_artifact_limit = Number(argv[++i]);
    else if (arg === "--toolsmith-artifact-output-dir") req.toolsmith_artifact_output_dir = argv[++i];
  }
  if (process.env.RUNTIME_PROJECT) req.project_hints = [...(req.project_hints ?? []), process.env.RUNTIME_PROJECT];
  if (process.env.RUNTIME_INTERVAL_SECONDS) req.interval_seconds = Number(process.env.RUNTIME_INTERVAL_SECONDS);
  if (process.env.RUNTIME_WINDOW_MINUTES) req.window_minutes = Number(process.env.RUNTIME_WINDOW_MINUTES);
  if (process.env.RUNTIME_INTERPRET === "1") req.interpret = true;
  if (process.env.RUNTIME_INTERPRET_FORCE === "1") req.interpret_force = true;
  if (process.env.RUNTIME_INTERPRET_INTERVAL_SECONDS) req.interpret_interval_seconds = Number(process.env.RUNTIME_INTERPRET_INTERVAL_SECONDS);
  if (process.env.RUNTIME_TIMELINE === "1") req.timeline = true;
  if (process.env.RUNTIME_TIMELINE === "0") req.timeline = false;
  if (process.env.RUNTIME_COMPILE_VIEWS === "0") req.compile_views = false;
  if (process.env.RUNTIME_COMPILE_VIEWS === "1") req.compile_views = true;
  if (process.env.RUNTIME_AI_VIEW_COMPRESSION === "0") req.ai_view_compression = false;
  if (process.env.RUNTIME_AI_VIEW_COMPRESSION === "1") req.ai_view_compression = true;
  if (process.env.RUNTIME_VISUAL_VIEW_COMPRESSION === "0") req.visual_view_compression = false;
  if (process.env.RUNTIME_VISUAL_VIEW_COMPRESSION === "1") req.visual_view_compression = true;
  if (process.env.RUNTIME_VIEW_COMPILE_INTERVAL_SECONDS) req.view_compile_interval_seconds = Number(process.env.RUNTIME_VIEW_COMPILE_INTERVAL_SECONDS);
  if (process.env.RUNTIME_TIMELINE_INTERVAL_SECONDS) req.timeline_interval_seconds = Number(process.env.RUNTIME_TIMELINE_INTERVAL_SECONDS);
  if (process.env.RUNTIME_TIMELINE_MINUTES) req.timeline_minutes = Number(process.env.RUNTIME_TIMELINE_MINUTES);
  if (process.env.RUNTIME_TIMELINE_LIMIT) req.timeline_limit = Number(process.env.RUNTIME_TIMELINE_LIMIT);
  if (process.env.RUNTIME_BACKGROUND_TASKS === "1") req.process_background_tasks = true;
  if (process.env.RUNTIME_BACKGROUND_TASKS === "0") req.process_background_tasks = false;
  if (process.env.RUNTIME_BACKGROUND_TASK_LIMIT) req.background_task_limit = Number(process.env.RUNTIME_BACKGROUND_TASK_LIMIT);
  if (process.env.RUNTIME_TOOLSMITH_ARTIFACTS === "1") req.process_toolsmith_artifacts = true;
  if (process.env.RUNTIME_TOOLSMITH_ARTIFACTS === "0") req.process_toolsmith_artifacts = false;
  if (process.env.RUNTIME_TOOLSMITH_ARTIFACT_LIMIT) req.toolsmith_artifact_limit = Number(process.env.RUNTIME_TOOLSMITH_ARTIFACT_LIMIT);
  if (process.env.TOOLSMITH_SANDBOX_DIR) req.toolsmith_artifact_output_dir = process.env.TOOLSMITH_SANDBOX_DIR;
  return req;
}

const { interval_seconds = 30, once, interpret, interpret_force, interpret_interval_seconds = 300, timeline, timeline_interval_seconds = 300, timeline_minutes = 24 * 60, timeline_limit = 200, ...tickReq } = parseArgs(process.argv.slice(2));
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
  const timelineState = maybeCompileTimeline();
  console.log(JSON.stringify({
    ok: result.ok,
    at: result.generated_at,
    workspace: result.active_workspace?.project_path,
    top_thread: top ? { id: top.id ?? top.thread_id, title: top.title, confidence: top.confidence } : undefined,
    evidence: result.evidence,
    screenpipe: (result.diagnostics.screenpipe as any)?.ok ?? "skipped",
    throttle: result.diagnostics.throttle,
    interpretation,
    compiled_views: result.compiled_views,
    timeline: timelineState,
  }, null, 2));
}

function maybeCompileTimeline(): Record<string, unknown> | undefined {
  if (!timeline) return undefined;
  const last = store.getRuntimeState("last_timeline_compile")?.value ?? {};
  const lastAt = typeof last.generated_at === "string" ? last.generated_at : undefined;
  if (lastAt && (Date.now() - Date.parse(lastAt)) / 1000 < timeline_interval_seconds) {
    return { attempted: false, reason: "throttled", last_generated_at: lastAt, interval_seconds: timeline_interval_seconds };
  }
  const compiled = compileObservationTimeline({
    minutes: timeline_minutes,
    limit: timeline_limit,
    write: tickReq.write !== false,
  }, store);
  if (tickReq.write !== false) {
    store.setRuntimeState("last_timeline_compile", {
      generated_at: new Date().toISOString(),
      view_id: compiled.view.id,
      records_used: compiled.records_used,
      bucket_count: compiled.buckets.length,
    });
  }
  return { attempted: true, ok: compiled.ok, view_id: compiled.view.id, records_used: compiled.records_used, buckets: compiled.buckets.length };
}

if (once) {
  await runOnce();
  process.exit(0);
}

console.log(`[runtime-daemon] starting interval=${interval_seconds}s interpret=${Boolean(interpret)} timeline=${Boolean(timeline)} status=${JSON.stringify(runtimeStatus(store).active_thread ?? {})}`);
await runOnce();
setInterval(() => {
  runOnce().catch(error => {
    console.error("[runtime-daemon] tick failed", error);
  });
}, interval_seconds * 1000);

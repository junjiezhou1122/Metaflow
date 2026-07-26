import type { RuntimeTickRequest, RuntimeTickResult } from "@info/runtime/runtime.js";
import { III_RUNTIME_FUNCTIONS, InProcessIiiRuntimeClient, registerInfoIiiRuntime } from "@info/iii-runtime";
import { ContextStore } from "@info/core";

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
  if (process.env.RUNTIME_WINDOW_MINUTES) req.window_minutes = Number(process.env.RUNTIME_WINDOW_MINUTES);
  if (process.env.RUNTIME_DRY_RUN === "1") req.write = false;
  if (process.env.RUNTIME_FORCE === "1") req.force = true;
  if (process.env.RUNTIME_COMPILE_VIEWS === "0") req.compile_views = false;
  if (process.env.RUNTIME_COMPILE_VIEWS === "1") req.compile_views = true;
  if (process.env.RUNTIME_AI_VIEW_COMPRESSION === "0") req.ai_view_compression = false;
  if (process.env.RUNTIME_AI_VIEW_COMPRESSION === "1") req.ai_view_compression = true;
  if (process.env.RUNTIME_VISUAL_VIEW_COMPRESSION === "0") req.visual_view_compression = false;
  if (process.env.RUNTIME_VISUAL_VIEW_COMPRESSION === "1") req.visual_view_compression = true;
  if (process.env.RUNTIME_VIEW_COMPILE_INTERVAL_SECONDS) req.view_compile_interval_seconds = Number(process.env.RUNTIME_VIEW_COMPILE_INTERVAL_SECONDS);
  if (process.env.RUNTIME_WORK_THREAD_MINUTES) req.work_thread_view_minutes = Number(process.env.RUNTIME_WORK_THREAD_MINUTES);
  if (process.env.RUNTIME_ACTIVITY_TIMELINE_MINUTES) req.activity_timeline_minutes = Number(process.env.RUNTIME_ACTIVITY_TIMELINE_MINUTES);
  if (process.env.RUNTIME_PROJECT_TIMELINE_MINUTES) req.project_timeline_minutes = Number(process.env.RUNTIME_PROJECT_TIMELINE_MINUTES);
  if (process.env.RUNTIME_BACKGROUND_TASKS === "1") req.process_background_tasks = true;
  if (process.env.RUNTIME_BACKGROUND_TASKS === "0") req.process_background_tasks = false;
  if (process.env.RUNTIME_BACKGROUND_TASK_LIMIT) req.background_task_limit = Number(process.env.RUNTIME_BACKGROUND_TASK_LIMIT);
  if (process.env.RUNTIME_TOOLSMITH_ARTIFACTS === "1") req.process_toolsmith_artifacts = true;
  if (process.env.RUNTIME_TOOLSMITH_ARTIFACTS === "0") req.process_toolsmith_artifacts = false;
  if (process.env.RUNTIME_TOOLSMITH_ARTIFACT_LIMIT) req.toolsmith_artifact_limit = Number(process.env.RUNTIME_TOOLSMITH_ARTIFACT_LIMIT);
  if (process.env.TOOLSMITH_SANDBOX_DIR) req.toolsmith_artifact_output_dir = process.env.TOOLSMITH_SANDBOX_DIR;
  return req;
}

async function runRuntimeTickViaIii(req: RuntimeTickRequest): Promise<RuntimeTickResult> {
  const store = new ContextStore();
  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-runtime-tick-cli" });
  const response = await iii.trigger({ function_id: III_RUNTIME_FUNCTIONS.tick, payload: req }) as { result?: RuntimeTickResult };
  return (response.result ?? response) as RuntimeTickResult;
}

const result = await runRuntimeTickViaIii(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));

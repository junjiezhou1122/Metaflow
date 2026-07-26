import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import type { RuntimeTickRequest, RuntimeTickResult } from "@info/runtime/runtime.js";
import { III_RUNTIME_FUNCTIONS, InProcessIiiRuntimeClient, registerInfoIiiRuntime } from "@info/iii-runtime";
import { compileWorkThreadView } from "@info/views/timeline/work-thread-view.js";
import { compileActivityTimeline } from "@info/views/timeline/activity-timeline.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-runtime-tick-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function runtimeTickViaIii(req: RuntimeTickRequest, store: ContextStore): Promise<RuntimeTickResult> {
  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-runtime-tick-test" });
  const response = await iii.trigger({ function_id: III_RUNTIME_FUNCTIONS.tick, payload: req }) as { result?: RuntimeTickResult };
  return (response.result ?? response) as RuntimeTickResult;
}

test("runtimeTick writes WorkThread state and Views without episode candidate Records", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:runtime-tick-local-project",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
    content: {
      title: "Local project snapshot: info",
      path: "/Users/junjie/info",
      text: "TypeScript project. Runtime tick should maintain work thread candidates as views.",
    },
    payload: { root: "/Users/junjie/info", files_touched: ["src/runtime/runtime.ts"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:runtime-tick-browser",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "info", project_path: "/Users/junjie/info", domain: "github.com", app: "chrome" },
    content: {
      title: "info runtime docs",
      url: "https://github.com/example/info",
      text: "Context runtime docs mention work_thread views and candidate thread routing.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runtimeTickViaIii({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    force: true,
    window_minutes: 60,
    min_score: 0.2,
  }, store);

  assert.equal(result.ok, true);
  assert.ok(result.candidate_threads.length >= 1);
  assert.ok(result.written_threads.length >= 1);
  assert.equal(result.evidence.written_records.some(id => id.startsWith("runtime:")), false);
  assert.equal(store.recent(20).filter(record => record.schema.name === "episode.candidate_thread").length, 0);
  assert.ok(store.listViews({ view_types: ["work_thread"], limit: 5 })[0]);
  assert.ok(store.listViews({ view_types: ["state.surface"], limit: 5 })[0]);
  assert.ok(store.recent(20).some(record => record.schema.name === "observation.route_candidate"));
  assert.ok(store.listViews({ view_types: ["work.focus_set"], limit: 5 })[0]);
  assert.ok(store.listViews({ view_types: ["project.current"], limit: 5 })[0]);
  assert.ok(store.listViews({ view_types: ["memory.daily"], limit: 5 })[0]);
  assert.ok(store.listViews({ view_types: ["summary.project_work_episode"], limit: 5 })[0]);
  assert.ok(result.compiled_views.some(view => view.view_type === "work.focus_set"));
  assert.ok(result.compiled_views.some(view => view.view_type === "project.current"));
  assert.ok(result.compiled_views.some(view => view.view_type === "state.surface"));
  assert.ok(result.compiled_views.some(view => view.view_type === "memory.daily"));
  assert.ok(result.compiled_views.some(view => view.view_type === "summary.project_work_episode"));
  assert.equal(store.getRuntimeState("active_thread")?.value?.thread_id, result.written_threads[0]);
}));

test("runtimeTick without iii keeps compiled state.surface and writes local episode summary", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:runtime-tick-no-iii-browser",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { project: "info", project_path: "/Users/junjie/info", domain: "github.com", app: "chrome" },
    content: {
      title: "Runtime no iii",
      url: "https://github.com/example/info",
      text: "Runtime tick should keep local surface and episode views when iii is absent.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertWorkThread({
    id: "thread:runtime-tick-no-iii",
    title: "Runtime no iii episode",
    status: "candidate",
    confidence: 0.72,
    evidence_records: [record.id],
    projects: ["info"],
    apps: ["chrome"],
    reasons: ["browser evidence should compile into a local episode summary"],
  });

  const { runtimeTick } = await import("@info/runtime/runtime.js");
  const result = await runtimeTick({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    force: true,
    window_minutes: 60,
    min_score: 0.2,
  }, store);

  assert.equal(result.ok, true);
  assert.ok(result.compiled_views.some(view => view.view_type === "state.surface" && view.view_count === 1));
  assert.ok(result.compiled_views.some(view => view.view_type === "summary.project_work_episode" && view.view_count === 1));
  assert.ok(result.compiled_views.some(view => view.view_type === "iii_runtime"));
  assert.ok(store.listViews({ view_types: ["state.surface"], limit: 5 })[0]);
  assert.ok(store.listViews({ view_types: ["summary.project_work_episode"], limit: 5 })[0]);
}));

test("runtimeTick writes automation.outcome views from agent action events", async () => withStore(async (store) => {
  store.appendRuntimeEvent({
    id: "event:runtime-action-outcome",
    event_type: "agent_task.completed",
    actor: "agent",
    status: "completed",
    subject_type: "action",
    subject_id: "task:agent:runtime-action",
    plugin_id: "capability.agent_task.submit",
    related_views: ["task:agent:runtime-action"],
    payload: {
      request_id: "task:agent:runtime-action",
      action_type: "agent_task",
      reason: "completed by local mock",
      started_at: "2026-05-25T01:00:00.000Z",
      finished_at: "2026-05-25T01:00:02.000Z",
    },
  });

  const { runtimeTick } = await import("@info/runtime/runtime.js");
  const result = await runtimeTick({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    force: true,
    window_minutes: 60,
  }, store);

  const outcome = store.getView("automation:outcome:event:runtime-action-outcome");
  assert.ok(result.compiled_views.some(view => view.view_type === "automation.outcome" && view.view_count === 1));
  assert.ok(outcome);
  assert.equal(outcome.view_type, "automation.outcome");
  assert.equal(outcome.content?.request_id, "task:agent:runtime-action");
  assert.equal((outcome.content?.outcome as Record<string, unknown>)?.ok, true);
}));

test("runtimeTick dry run does not persist memory candidates or durable memories", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:runtime-tick-dry-memory",
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "dry-memory" },
    content: { title: "Codex memory work", text: "用户说：不要只讲架构，直接实现。" },
    payload: { cwd: "/Users/junjie/info", session_id: "dry-memory", commands_run: ["pnpm typecheck"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runtimeTickViaIii({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    write: false,
    force: true,
    window_minutes: 60,
    min_score: 0.2,
  }, store);

  assert.equal(result.ok, true);
  assert.equal(store.recent(20).some(record => record.schema.name === "observation.route_candidate"), false);
  assert.equal(store.listViews({ view_types: ["memory.candidate"], limit: 5 }).length, 0);
  assert.equal(store.listViews({ view_types: ["memory.agent_collaboration_style", "memory.workflow_patterns", "project.memory"], limit: 5 }).length, 0);
  assert.ok(result.compiled_views.some(view => view.view_type === "memory.candidate"));
}));

test("runtimeTick repeated runs do not duplicate durable project memories", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:runtime-tick-memory-idempotent",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
    content: {
      title: "Local project snapshot: info memory",
      path: "/Users/junjie/info",
      text: "Project current should become a durable project memory without duplicates.",
    },
    payload: { root: "/Users/junjie/info", files_touched: ["packages/views/memory/gate.ts"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const req: RuntimeTickRequest = {
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    write: true,
    force: true,
    window_minutes: 60,
    min_score: 0.2,
  };

  await runtimeTickViaIii(req, store);
  await runtimeTickViaIii(req, store);

  const memories = store.listViews({ view_types: ["project.memory"], limit: 20 })
    .filter(view => String(view.content?.claim ?? "").includes("Local project snapshot: info memory"));
  assert.equal(memories.length, 1);
  assert.ok((memories[0]?.content?.evidence_count as number) >= 1);
}));

test("runtimeTick persists Screenpipe observations so activity timeline can display them", async () => withStore(async (store) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SCREENPIPE_API_KEY;
  process.env.SCREENPIPE_API_KEY = "test-screenpipe-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === "/activity-summary") {
      return Response.json({
        time_range: { end: new Date().toISOString() },
        windows: [{
          app_name: "Warp",
          window_name: "info",
          browser_url: "",
          minutes: 3.5,
          frame_count: 4,
        }],
      });
    }
    if (url.pathname === "/elements") return Response.json([]);
    if (url.pathname === "/search") {
      if (url.searchParams.get("content_type") === "input") return Response.json([]);
      if (url.searchParams.get("content_type") === "audio") {
        return Response.json({
          data: [{
            type: "Audio",
            content: {
              chunk_id: 14901,
              timestamp: new Date().toISOString(),
              transcription: "讨论 audio view 应该完整展示",
              device_name: "EarPods Microphone",
            },
          }],
        });
      }
      return Response.json({
        data: [{
          type: "ocr",
          content: {
            frame_id: 9466,
            timestamp: new Date().toISOString(),
            app_name: "Warp",
            window_name: "info",
            text: "/Users/junjie/info pnpm build",
          },
        }],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const result = await runtimeTickViaIii({
      include_screenpipe: true,
      include_ai_sessions: false,
      include_git: false,
      compile_views: false,
      force: true,
      window_minutes: 15,
    }, store);
    const persisted = store.recent(20).filter(record => record.source.type === "screenpipe");
    const timeline = compileActivityTimeline({ minutes: 60, write: false }, store);

    assert.equal(result.ok, true);
    assert.equal(result.evidence.screenpipe_records, 3);
    assert.deepEqual(new Set(result.evidence.written_records), new Set(persisted.map(record => record.id)));
    assert.ok(persisted.some(record => record.schema.name === "observation.screenpipe_activity_summary"));
    assert.ok(persisted.some(record => record.schema.name === "observation.screenpipe_activity"));
    assert.ok(persisted.some(record => record.schema.name === "observation.screenpipe_audio"));
    assert.ok(timeline.buckets.flatMap(bucket => bucket.items).some(item => item.source.startsWith("screenpipe/")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SCREENPIPE_API_KEY;
    else process.env.SCREENPIPE_API_KEY = originalApiKey;
  }
}));

test("runtimeTick can process proactive background research task Views asynchronously", async () => withStore(async (store) => {
  const oldRuntime = process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
  process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const record = store.insertRecord({
      id: "record:runtime-background-task-source",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local_project", connector: "runtime-snapshot" },
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: {
        title: "Local project snapshot: info",
        path: "/Users/junjie/info",
        text: "Info should proactively run background research tasks.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const task = store.upsertView({
      id: "task:background-research:runtime-test",
      view_type: "task.background_research",
      title: "Background research task: runtime background tasks",
      summary: "Find supporting material for ambient background task processing.",
      source_records: [record.id],
      source_views: [],
      compiler: { id: "program.proactive_research", version: "0.1.0", mode: "hybrid" },
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: {
        focus: "ambient background task processing",
        goal: "Prepare background research for ambient task processing.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
      confidence: 0.8,
    });

    const result = await runtimeTickViaIii({
      include_screenpipe: false,
      include_ai_sessions: false,
      include_git: false,
      compile_views: false,
      process_background_tasks: true,
      background_task_limit: 2,
      force: true,
    }, store);
    const completedTask = store.getView(task.id);
    const brief = store.listViews({ view_types: ["brief.background_research"], source_view_id: task.id, limit: 1 })[0];
    const diagnostics = result.diagnostics.background_tasks as { processed?: number; tasks?: Array<{ task_view_id?: string; status?: string; written_views?: string[] }> } | undefined;

    assert.equal(result.ok, true);
    assert.equal(diagnostics?.processed, 1);
    assert.equal(diagnostics?.tasks?.[0]?.task_view_id, task.id);
    assert.equal(diagnostics?.tasks?.[0]?.status, "completed");
    assert.ok(brief);
    assert.equal(brief.compiler?.id, "capability.agent_task.submit");
    assert.equal((completedTask?.content?.background_task as Record<string, unknown> | undefined)?.status, "completed");
    assert.deepEqual((completedTask?.content?.background_task as Record<string, unknown> | undefined)?.written_views, [brief.id]);
    assert.ok(store.listRuntimeEvents({ event_type: "background_task.processed", plugin_id: "runtime.background_tasks", limit: 1 })[0]);
  } finally {
    if (oldRuntime === undefined) delete process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
    else process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("runtimeTick skips proactive background tasks when no task runtime is configured", async () => withStore(async (store) => {
  const oldRuntime = process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
  delete process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
  try {
    const record = store.insertRecord({
      id: "record:runtime-background-task-skip-source",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local_project", connector: "runtime-snapshot" },
      content: { title: "Local project snapshot", text: "Background task skip source." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const task = store.upsertView({
      id: "task:background-research:runtime-skip",
      view_type: "task.background_research",
      title: "Background research task: skip",
      source_records: [record.id],
      content: { goal: "This should not run without a configured runtime." },
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });

    const result = await runtimeTickViaIii({
      include_screenpipe: false,
      include_ai_sessions: false,
      include_git: false,
      compile_views: false,
      process_background_tasks: true,
      force: true,
    }, store);
    const diagnostics = result.diagnostics.background_tasks as { processed?: number; skipped?: number; tasks?: Array<{ task_view_id?: string; status?: string }> } | undefined;

    assert.equal(diagnostics?.processed, 0);
    assert.equal(diagnostics?.skipped, 1);
    assert.equal(diagnostics?.tasks?.[0]?.status, "skipped");
    assert.equal(store.listViews({ view_types: ["brief.background_research"], source_view_id: task.id, limit: 1 }).length, 0);
    assert.equal(store.getView(task.id)?.content?.background_task, undefined);
  } finally {
    if (oldRuntime === undefined) delete process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
    else process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("runtimeTick can compile toolsmith prototype Views into sandbox artifacts without project edits", async () => withStore(async (store) => {
  const outputDir = mkdtempSync(join(tmpdir(), "info-toolsmith-artifacts-"));
  try {
    const record = store.insertRecord({
      id: "record:runtime-toolsmith-artifact-source",
      schema: { name: "observation.local_project", version: 1 },
      source: { type: "local_project", connector: "runtime-snapshot" },
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: { title: "Workflow source", text: "Repeated manual issue summary workflow." },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const draft = store.upsertView({
      id: "draft.tool_prototype:runtime-artifact-test",
      view_type: "draft.tool_prototype",
      title: "Tool prototype draft: issue summary helper",
      summary: "Create a small CLI that turns selected issue context into a markdown summary.",
      source_records: [record.id],
      source_views: [],
      compiler: { id: "capability.agent_task.submit", version: "0.1.0", mode: "hybrid" },
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: {
        focus: "issue summary helper",
        draft_text: "CLI: info-issue-summary --view <id>. Output markdown only.",
        suggestions: ["input: View id", "output: markdown summary"],
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
      confidence: 0.82,
    });

    const result = await runtimeTickViaIii({
      include_screenpipe: false,
      include_ai_sessions: false,
      include_git: false,
      compile_views: false,
      process_toolsmith_artifacts: true,
      toolsmith_artifact_limit: 2,
      toolsmith_artifact_output_dir: outputDir,
      force: true,
    }, store);
    const diagnostics = result.diagnostics.toolsmith_artifacts as { processed?: number; artifacts?: Array<{ artifact_id?: string; artifact_view_id?: string; uri?: string }> } | undefined;
    const artifactInfo = diagnostics?.artifacts?.[0];
    const artifact = artifactInfo?.artifact_id ? store.getArtifact(artifactInfo.artifact_id) : undefined;
    const artifactView = artifactInfo?.artifact_view_id ? store.getView(artifactInfo.artifact_view_id) : undefined;
    const source = store.getView(draft.id);
    const path = artifact?.uri.startsWith("file://") ? new URL(artifact.uri).pathname : "";

    assert.equal(diagnostics?.processed, 1);
    assert.ok(artifact);
    assert.equal(artifact.kind, "file");
    assert.equal(artifact.mime_type, "text/markdown");
    assert.ok(path.startsWith(outputDir));
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf8"), /No project files were modified/);
    assert.ok(artifactView);
    assert.equal(artifactView.view_type, "tool.prototype_artifact");
    assert.equal(artifactView.content?.sandbox_only, true);
    assert.equal((source?.content?.toolsmith_artifact as Record<string, unknown> | undefined)?.status, "completed");
    assert.ok(store.listRuntimeEvents({ event_type: "toolsmith_artifact.created", plugin_id: "runtime.toolsmith_artifacts", limit: 1 })[0]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}));

test("WorkThread suppresses passive Warp focus while timeline keeps inspectable Screenpipe evidence", () => withStore((store) => {
  store.insertRecord({
    id: "record:noise-local-project",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
    content: {
      title: "Local project snapshot: info",
      path: "/Users/junjie/info",
      text: "Working on VisualFrameView ActivityBlockView WorkflowView MemoryView quality.",
    },
    payload: { root: "/Users/junjie/info", cwd: "/Users/junjie/info" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:noise-warp-focus",
    schema: { name: "observation.screenpipe_activity_summary", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-activity-summary" },
    scope: { app: "Warp" },
    content: { title: "Warp - ⠋ info", text: "" },
    payload: { app_name: "Warp", window_name: "⠋ info", browser_url: "", minutes: 6, frame_count: 40 },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:noise-terminal-ocr",
    schema: { name: "observation.screenpipe_activity", version: 1 },
    source: { type: "screenpipe", connector: "screenpipe-local-api" },
    scope: { app: "Terminal" },
    content: { title: "Terminal - OCR", text: "random terminal prompt with no useful work signal" },
    payload: { app_name: "Terminal", window_name: "Terminal - OCR", content_type: "OCR" },
    privacy: { level: "private", retention: "normal" },
  });

  const workThread = compileWorkThreadView({ minutes: 60, write: false, min_score: 0.1 }, store);
  const timeline = compileActivityTimeline({ minutes: 60, write: false }, store);
  const debugTimeline = compileActivityTimeline({ minutes: 60, write: false, includeLowLevelScreenpipe: true }, store);

  assert.deepEqual(workThread.view.source_records, ["record:noise-local-project"]);
  assert.doesNotMatch(JSON.stringify(workThread.view.content), /record:noise-warp-focus|record:noise-terminal-ocr/);
  assert.equal(timeline.buckets.flatMap(bucket => bucket.items).some(item => item.record_ids?.includes("record:noise-warp-focus")), true);
  assert.equal(timeline.buckets.flatMap(bucket => bucket.items).some(item => item.record_ids?.includes("record:noise-terminal-ocr")), true);
  assert.ok(debugTimeline.buckets.flatMap(bucket => bucket.items).some(item => item.record_ids?.includes("record:noise-terminal-ocr")));
}));


test("WorkThread View compiler ignores legacy derived and episode Records as evidence", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:work-thread-raw-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Raw Info project page",
      url: "https://github.com/example/info",
      text: "Raw observation about context runtime work_thread views and plugin routing.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:work-thread-derived-legacy",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy-compiler" },
    content: {
      title: "Legacy derived memory",
      text: "LEGACY DERIVED RECORD SHOULD NOT BECOME WORK_THREAD EVIDENCE even if it mentions github.com pnpm runtime context.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:work-thread-episode-legacy",
    schema: { name: "episode.project_work", version: 1 },
    source: { type: "plugin", connector: "legacy-episode" },
    content: {
      title: "Legacy project episode",
      text: "LEGACY EPISODE RECORD SHOULD NOT BECOME WORK_THREAD EVIDENCE even if it mentions github.com pnpm runtime context.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runtimeTickViaIii({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: true,
    force: true,
    window_minutes: 60,
    min_score: 0.1,
  }, store);
  const view = store.listViews({ view_types: ["work_thread"], limit: 1 })[0];

  assert.equal(result.ok, true);
  assert.ok(view);
  assert.deepEqual(view.source_records, ["record:work-thread-raw-source"]);
  assert.doesNotMatch(JSON.stringify(view.content), /LEGACY DERIVED RECORD SHOULD NOT BECOME/);
  assert.doesNotMatch(JSON.stringify(view.content), /LEGACY EPISODE RECORD SHOULD NOT BECOME/);
}));

test("WorkThread View compiler ignores newer legacy Records before limiting", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:work-thread-legacy-starvation-visible",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Visible Info project page after legacy filtering",
      url: "https://github.com/example/info",
      text: "Raw observation about context runtime work_thread views and plugin routing.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 3; index++) {
    store.insertRecord({
      id: `record:work-thread-legacy-starvation-newer-${index}`,
      schema: { name: "derived.project_memory", version: 1 },
      source: { type: "plugin", connector: "legacy-compiler" },
      content: {
        title: `NEWER LEGACY WORK THREAD SOURCE SHOULD NOT STARVE RAW OBSERVATION ${index}`,
        text: "LEGACY DERIVED RECORD SHOULD NOT BECOME WORK_THREAD EVIDENCE even if it mentions github.com pnpm runtime context.",
      },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
  }

  const result = compileWorkThreadView({
    minutes: 60,
    limit: 1,
    write: false,
    min_score: 0.1,
  }, store);
  const view = result.view;

  assert.equal(result.ok, true);
  assert.ok(view);
  assert.deepEqual(view.source_records, ["record:work-thread-legacy-starvation-visible"]);
  assert.doesNotMatch(JSON.stringify(view.content), /NEWER LEGACY WORK THREAD SOURCE/);
  assert.doesNotMatch(JSON.stringify(view.content), /LEGACY DERIVED RECORD SHOULD NOT BECOME/);
}));

test("runtimeTick ignores legacy derived and episode Records when building candidate threads", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:runtime-raw-thread-source",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: {
      title: "Raw runtime project page",
      url: "https://github.com/example/info",
      text: "Raw observation about context runtime thread routing and work_thread views.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:runtime-raw-local-project",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
    content: {
      title: "Raw local project snapshot",
      path: "/Users/junjie/info",
      text: "Raw local project observation about runtime thread routing and work_thread views.",
    },
    payload: { root: "/Users/junjie/info", files_touched: ["src/runtime/runtime.ts"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:runtime-derived-legacy",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy-compiler" },
    content: {
      title: "Legacy derived runtime memory",
      text: "LEGACY DERIVED RUNTIME RECORD SHOULD NOT BECOME CANDIDATE THREAD EVIDENCE github.com pnpm runtime context.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.insertRecord({
    id: "record:runtime-episode-legacy",
    schema: { name: "episode.project_work", version: 1 },
    source: { type: "plugin", connector: "legacy-episode" },
    content: {
      title: "Legacy runtime episode",
      text: "LEGACY EPISODE RUNTIME RECORD SHOULD NOT BECOME CANDIDATE THREAD EVIDENCE github.com pnpm runtime context.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await runtimeTickViaIii({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: false,
    force: true,
    window_minutes: 60,
    min_score: 0.1,
  }, store);

  assert.equal(result.ok, true);
  assert.ok(result.candidate_threads.length >= 1);
  assert.deepEqual(new Set(result.candidate_threads[0].records.map(record => record.id)), new Set(["record:runtime-raw-thread-source", "record:runtime-raw-local-project"]));
  assert.equal(result.written_threads.length, 1);
  const thread = store.listWorkThreads("candidate")[0];
  assert.deepEqual(new Set(thread.evidence_records), new Set(["record:runtime-raw-thread-source", "record:runtime-raw-local-project"]));
  assert.doesNotMatch(JSON.stringify(thread.metadata), /LEGACY DERIVED RUNTIME RECORD SHOULD NOT BECOME/);
  assert.doesNotMatch(JSON.stringify(thread.metadata), /LEGACY EPISODE RUNTIME RECORD SHOULD NOT BECOME/);
}));

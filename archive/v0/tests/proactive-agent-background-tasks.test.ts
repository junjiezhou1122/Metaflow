import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { processAmbientBackgroundTasks } from "@info/runtime/background-tasks.js";
import { buildAgentTaskList, updateAgentTaskLifecycle } from "@info/runtime/agent-tasks.js";
import type { BackgroundTaskIiiClient } from "@info/runtime/background-tasks.js";
import { III_RUNTIME_FUNCTIONS, InProcessIiiRuntimeClient, registerInfoIiiRuntime } from "@info/iii-runtime";
import type { RuntimeTickRequest, RuntimeTickResult } from "@info/runtime/runtime.js";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-proactive-agent-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function runtimeTickViaIii(req: RuntimeTickRequest, store: ContextStore): Promise<RuntimeTickResult> {
  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-proactive-agent-test" });
  const response = await iii.trigger({ function_id: III_RUNTIME_FUNCTIONS.tick, payload: req }) as { result?: RuntimeTickResult };
  return (response.result ?? response) as RuntimeTickResult;
}

test("background task layer queues project.current into a provenance-backed task View", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:proactive-project-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { title: "Runtime work", text: "Implement proactive background agent execution." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "view:project_current:proactive",
    view_type: "project.current",
    title: "Project current: info",
    summary: "Need stronger proactive background task execution.",
    source_records: [record.id],
    content: { focus: "background agent task layer", next_actions: ["add tests"] },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    confidence: 0.8,
  });

  const result = await processAmbientBackgroundTasks({ mode: "queue", write: true }, store);
  const taskId = result.tasks[0]?.task_view_id;
  const task = taskId ? store.getView(taskId) : undefined;

  assert.equal(result.queued, 1);
  assert.equal(result.processed, 0);
  assert.equal(task?.view_type, "task.background_research");
  assert.deepEqual(task?.source_records, [record.id]);
  assert.ok(task?.source_views?.includes("view:project_current:proactive"));
  assert.equal(task?.content?.forbidden_actions instanceof Array && task.content.forbidden_actions.includes("write_legacy_records"), true);
  assert.equal(store.recent(20).some(item => item.id === task?.id), false);
  const taskList = store.getView("agent:task_list:current");
  assert.equal(taskList?.view_type, "agent.task_list");
  assert.equal((taskList?.content?.counts as Record<string, number> | undefined)?.candidate, 1);
}));

test("agent task list summarizes queued and processed AgentTask Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:agent-task-list-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "Agent task list source" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:background-research:list",
    view_type: "task.background_research",
    title: "Queued research",
    source_records: [record.id],
    content: { goal: "Summarize queued task", speed: "background", autonomy: "suggest" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const before = buildAgentTaskList({ write: true }, store);
  assert.equal(before.items.length, 1);
  assert.equal(before.counts.candidate, 1);
  assert.equal(before.latest_view?.view_type, "agent.task_list");

  const iii = new InProcessIiiRuntimeClient();
  await registerInfoIiiRuntime(iii, { store, workerName: "info-agent-task-list-test" });
  await processAmbientBackgroundTasks({ mode: "process", iii, runtime: "local_mock", write: true }, store);
  const after = buildAgentTaskList({ write: false }, store);
  assert.equal(after.counts.completed, 1);
  assert.equal(after.items[0]?.runtime, "local_mock");
}));

test("agent task lifecycle can cancel and retry task Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:agent-task-lifecycle-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project" },
    content: { title: "Agent task lifecycle source" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:background-research:lifecycle",
    view_type: "task.background_research",
    title: "Lifecycle research",
    source_records: [record.id],
    content: { goal: "Test lifecycle" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const cancelled = updateAgentTaskLifecycle("task:background-research:lifecycle", "cancel", { reason: "no longer needed" }, store);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task_list?.counts.cancelled, 1);
  assert.equal(store.getView("task:background-research:lifecycle")?.content?.background_task?.status, "cancelled");

  const skipped = await processAmbientBackgroundTasks({ mode: "process", runtime: "local_mock", write: true }, store);
  assert.equal(skipped.processed, 0);

  const retried = updateAgentTaskLifecycle("task:background-research:lifecycle", "retry", { reason: "try again" }, store);
  assert.equal(retried.ok, true);
  assert.equal(retried.task_list?.counts.queued, 1);
  assert.equal(store.getView("task:background-research:lifecycle")?.content?.background_task?.status, "queued");
  assert.ok(store.listRuntimeEvents({ event_type: "agent_task.cancelled", subject_id: "task:background-research:lifecycle", limit: 1 })[0]);
  assert.ok(store.listRuntimeEvents({ event_type: "agent_task.retried", subject_id: "task:background-research:lifecycle", limit: 1 })[0]);
}));

test("background task layer refuses source Views without provenance", async () => withStore(async (store) => {
  store.upsertView({
    id: "view:project_current:no-provenance",
    view_type: "project.current",
    title: "Project current: orphan",
    summary: "No source records or source views.",
    content: { focus: "orphan work" },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
    confidence: 0.8,
  });

  const result = await processAmbientBackgroundTasks({ mode: "queue", write: true }, store);

  assert.equal(result.queued, 0);
  assert.equal(result.skipped, 0);
  assert.equal(store.listViews({ view_types: ["task.background_research"], limit: 5 }).length, 0);
}));

test("runtimeTick processes task.background_research with local_mock into brief View only", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:proactive-task-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: "/Users/junjie/info" },
    content: { title: "Background source", text: "Run safe local mock background research." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const task = store.upsertView({
    id: "task:background-research:local-mock",
    view_type: "task.background_research",
    title: "Background research task: local mock",
    source_records: [record.id],
    content: { focus: "local mock background research", goal: "Prepare a brief from local context." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    confidence: 0.8,
  });

  const result = await runtimeTickViaIii({
    include_screenpipe: false,
    include_ai_sessions: false,
    include_git: false,
    compile_views: false,
    process_background_tasks: true,
    background_task_mode: "process",
    background_task_runtime: "local_mock",
    force: true,
  }, store);
  const diagnostics = result.diagnostics.background_tasks as { processed?: number; tasks?: Array<{ status?: string; written_views?: string[] }> };
  const completedTask = store.getView(task.id);
  const brief = store.listViews({ view_types: ["brief.background_research"], source_view_id: task.id, limit: 1 })[0];

  assert.equal(diagnostics.processed, 1);
  assert.equal(diagnostics.tasks?.[0]?.status, "completed");
  assert.ok(brief);
  assert.equal(brief.compiler?.id, "capability.agent_task.submit");
  assert.equal((brief.content?.agent_task as { runtime?: string } | undefined)?.runtime, "local_mock");
  assert.deepEqual(brief.source_records, [record.id]);
  assert.ok(brief.source_views?.includes(task.id));
  assert.equal(store.recent(20).some(item => item.schema.name === "agent_task.result"), false);
  assert.equal((completedTask?.content?.background_task as Record<string, unknown> | undefined)?.status, "completed");
}));

test("background task dry-run calls capability but does not write briefs or mark tasks", async () => withStore(async (store) => {
  let calls = 0;
  const iii: BackgroundTaskIiiClient = {
    trigger(input) {
      calls += 1;
      assert.equal(input.function_id, "capability::agent_task_submit");
      const payload = input.payload as { dry_run?: boolean; payload?: { task?: { runtime?: string } } };
      assert.equal(payload.dry_run, true);
      assert.equal(payload.payload?.task?.runtime, "local_mock");
      return { result: { ok: true, written_views: ["brief:dry-run-should-not-exist"] } };
    },
  };
  const record = store.insertRecord({
    id: "record:proactive-dry-run-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    content: { title: "Dry run source", text: "Dry run background task." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  const task = store.upsertView({
    id: "task:background-research:dry-run",
    view_type: "task.background_research",
    title: "Background research task: dry run",
    source_records: [record.id],
    content: { goal: "Dry run only." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await processAmbientBackgroundTasks({ mode: "process", iii, runtime: "local_mock", dry_run: true, write: true }, store);

  assert.equal(calls, 1);
  assert.equal(result.processed, 1);
  assert.deepEqual(result.written_views, ["brief:dry-run-should-not-exist"]);
  assert.equal(store.getView("brief:dry-run-should-not-exist"), undefined);
  assert.equal(store.getView(task.id)?.content?.background_task, undefined);
}));

test("background task processing ignores retired toolsmith prototype task Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "record:proactive-autonomy-source",
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    content: { title: "Toolsmith source", text: "Prototype requires draft autonomy." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });
  store.upsertView({
    id: "task:toolsmith-prototype:autonomy",
    view_type: "task.toolsmith_prototype",
    title: "Toolsmith prototype task",
    source_records: [record.id],
    content: { focus: "tool prototype", goal: "Draft a prototype." },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
  });

  const result = await processAmbientBackgroundTasks({ mode: "process", runtime: "local_mock", autonomy: "suggest", write: true }, store);
  const list = buildAgentTaskList({ write: true }, store);

  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.tasks.length, 0);
  assert.equal(list.items.length, 0);
  assert.equal(store.listViews({ view_types: ["draft.tool_prototype"], limit: 5 }).length, 0);
}));

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import {
  createProjectInboxProcessor,
  PROJECT_INBOX_PROCESSOR_ID,
  PROJECT_INBOX_VIEW_TYPE,
  createProjectTasksProcessor,
  PROJECT_TASKS_PROCESSOR_ID,
  PROJECT_TASKS_VIEW_TYPE,
  createProjectDecisionExtractorProcessor,
  PROJECT_DECISION_EXTRACTOR_PROCESSOR_ID,
  PROJECT_DECISIONS_VIEW_TYPE,
  ProcessorRuntime,
} from "@info/processor-runtime";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-proc-project-views-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// project_inbox

test("createProjectInboxProcessor has correct id and produces project.inbox", () => {
  const processor = createProjectInboxProcessor();
  assert.equal(processor.id, PROJECT_INBOX_PROCESSOR_ID);
  assert.equal(processor.id, "processor.project_inbox");
  assert.deepEqual(processor.produces.views, [PROJECT_INBOX_VIEW_TYPE]);
  assert.equal(processor.runtime.kind, "local");
  assert.ok(processor.consumes.observations?.includes("observation.codex.message"));
});

test("project_inbox processor writes project.inbox view from codex observations", async () => withStore(async (store) => {
  const obs = store.insertRecord({
    id: "obs:codex:1",
    schema: { name: "observation.codex.message", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    content: { title: "Review ViewSpec API" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createProjectInboxProcessor({ now: new Date("2026-06-18T10:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);

  assert.equal(result.ok, true);
  assert.ok(result.processors_matched.includes("processor.project_inbox"));
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  const inbox = written.find(v => v?.view_type === PROJECT_INBOX_VIEW_TYPE);
  assert.ok(inbox, "project.inbox view should be written");
  assert.equal(inbox?.compiler?.id, "processor.project_inbox");
  assert.ok((inbox?.content?.item_count as number) >= 1);
}));

test("project_inbox processor produces empty inbox when no relevant observations exist", async () => withStore(async (store) => {
  const obs = store.insertRecord({
    id: "obs:other:1",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome" },
    content: { title: "Some page" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createProjectInboxProcessor({ now: new Date("2026-06-18T10:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);
  assert.equal(result.ok, true);
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  assert.ok(written.some(v => v?.view_type === PROJECT_INBOX_VIEW_TYPE));
}));

// project_tasks

test("createProjectTasksProcessor has correct id and produces project.tasks", () => {
  const processor = createProjectTasksProcessor();
  assert.equal(processor.id, PROJECT_TASKS_PROCESSOR_ID);
  assert.equal(processor.id, "processor.project_tasks");
  assert.deepEqual(processor.produces.views, [PROJECT_TASKS_VIEW_TYPE]);
  assert.equal(processor.runtime.kind, "local");
  assert.ok(processor.consumes.views?.includes("project.current"));
  assert.ok(processor.consumes.views?.includes("project.inbox"));
});

test("project_tasks processor writes project.tasks view from codex messages", async () => withStore(async (store) => {
  const obs = store.insertRecord({
    id: "obs:codex:tasks:1",
    schema: { name: "observation.codex.message", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    content: { title: "Implement mf view CLI" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createProjectTasksProcessor({ now: new Date("2026-06-18T10:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);

  assert.equal(result.ok, true);
  assert.ok(result.processors_matched.includes("processor.project_tasks"));
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  const tasks = written.find(v => v?.view_type === PROJECT_TASKS_VIEW_TYPE);
  assert.ok(tasks, "project.tasks view should be written");
  assert.equal(tasks?.compiler?.id, "processor.project_tasks");
}));

// project_decision_extractor

test("createProjectDecisionExtractorProcessor has correct id and produces project.decisions", () => {
  const processor = createProjectDecisionExtractorProcessor();
  assert.equal(processor.id, PROJECT_DECISION_EXTRACTOR_PROCESSOR_ID);
  assert.equal(processor.id, "processor.project_decision_extractor");
  assert.deepEqual(processor.produces.views, [PROJECT_DECISIONS_VIEW_TYPE]);
  assert.equal(processor.runtime.kind, "local");
  assert.ok(processor.consumes.observations?.includes("observation.codex.message"));
  assert.ok(processor.consumes.observations?.includes("observation.claude.message"));
});

test("project_decision_extractor processor writes project.decisions view", async () => withStore(async (store) => {
  const obs = store.insertRecord({
    id: "obs:codex:decision:1",
    schema: { name: "observation.codex.message", version: 1 },
    source: { type: "ai_session", connector: "codex" },
    content: { title: "Decision: add project_inbox processor.", text: "Decision: Project is a built-in view family." },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createProjectDecisionExtractorProcessor({ now: new Date("2026-06-18T10:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);

  assert.equal(result.ok, true);
  assert.ok(result.processors_matched.includes("processor.project_decision_extractor"));
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  const decisions = written.find(v => v?.view_type === PROJECT_DECISIONS_VIEW_TYPE);
  assert.ok(decisions, "project.decisions view should be written");
  assert.equal(decisions?.compiler?.id, "processor.project_decision_extractor");
}));

test("project_decision_extractor produces decisions view even with no decision-text observations", async () => withStore(async (store) => {
  const obs = store.insertRecord({
    id: "obs:claude:1",
    schema: { name: "observation.claude.message", version: 1 },
    source: { type: "ai_session", connector: "claude" },
    content: { title: "General conversation", text: "Hello world" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProcessorRuntime({ store, processors: [createProjectDecisionExtractorProcessor({ now: new Date("2026-06-18T10:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);
  assert.equal(result.ok, true);
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  assert.ok(written.some(v => v?.view_type === PROJECT_DECISIONS_VIEW_TYPE));
}));

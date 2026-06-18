import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { buildCandidateRoutes, buildRouteCandidateRecord, createProjectCurrentProcessor, PROJECT_CURRENT_COMPILER_ID, PROJECT_CURRENT_VIEW_TYPE, ProcessorRuntime } from "@info/processor-runtime";
import { compileWorkFocusSet } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-proc-project-current-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sourceRecord(id: string, schemaName: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    schema: { name: schemaName, version: 1 },
    source: { type: "ai_session" as const, connector: "codex" },
    privacy: { level: "private" as const, retention: "normal" as const },
    ...extra,
  };
}

function routeCandidateFor(record: ReturnType<typeof sourceRecord>) {
  const features = {
    source_type: record.source?.type ?? "ai_session",
    schema_name: record.schema.name,
    project_path: (record as any).scope?.project_path,
    project: (record as any).scope?.project,
    session_id: (record as any).scope?.session,
    file_paths: (record as any).payload?.files_touched ?? [],
    command_tokens: (record as any).payload?.commands_run ?? [],
  };
  const routes = buildCandidateRoutes(features as any);
  return buildRouteCandidateRecord(record as any, routes, features as any);
}

test("createProjectCurrentProcessor has correct id and produces project.current", () => {
  const processor = createProjectCurrentProcessor();
  assert.equal(processor.id, PROJECT_CURRENT_COMPILER_ID);
  assert.equal(processor.id, "processor.project_current");
  assert.deepEqual(processor.produces.views, [PROJECT_CURRENT_VIEW_TYPE]);
  assert.equal(processor.runtime.kind, "local");
  assert.ok(processor.consumes.views?.includes("work.focus_set"));
});

test("project_current processor generates project.current view from focus set observation", async () => withStore(async (store) => {
  const source = sourceRecord("obs:ai:info", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: { title: "Work on processor builtins", text: "Decision: add project_current processor." },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["packages/processor-runtime/builtins/project-current.ts"] },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:00:00.000Z") }, store);

  const runtime = new ProcessorRuntime({ store, processors: [createProjectCurrentProcessor({ now: new Date("2026-06-16T10:01:00.000Z") })] });
  const result = await runtime.processObservation(store.insertRecord(source));

  assert.equal(result.ok, true);
  assert.ok(result.processors_matched.includes("processor.project_current"));
  const written = result.views_written.map((id: string) => store.getView(id)).filter(Boolean);
  assert.ok(written.length >= 1);
  assert.ok(written.every(v => v?.view_type === PROJECT_CURRENT_VIEW_TYPE));
}));

test("project_current processor returns empty views when no focus set exists", async () => withStore(async (store) => {
  const obs = store.insertRecord(sourceRecord("obs:ai:empty", "observation.local_project", {
    scope: { project: "ghost", project_path: "/tmp/ghost" },
    content: { title: "Ghost project" },
    payload: {},
  }));
  const runtime = new ProcessorRuntime({ store, processors: [createProjectCurrentProcessor({ now: new Date("2026-06-16T10:00:00.000Z") })] });
  const result = await runtime.processObservation(obs);
  assert.equal(result.ok, true);
  assert.equal(result.views_written.length, 0);
}));

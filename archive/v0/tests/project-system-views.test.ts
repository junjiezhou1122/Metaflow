import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore, type StoredContextRecord } from "@info/core";
import { buildCandidateRoutes, buildRouteCandidateRecord, extractRouteFeatures } from "@info/processor-runtime";
import { compileProjectCurrent, compileWorkFocusSet, PROJECT_CURRENT_VIEW_TYPE } from "@info/views";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-project-system-views-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---- project.inbox captures unresolved items ----

test("project.inbox captures unresolved items from project.current content", () => withStore((store) => {
  const source = sourceRecord("obs:ai:inbox", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-inbox" },
    content: {
      title: "Inbox item discovery",
      text: "Should we use SQLite or LMDB for the view store?\nDecision: adopt rule-hit routing for now.\nHow should the memory gate threshold work?",
    },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-inbox" },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  const focus = compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:05:00.000Z") }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [source], write: false, now: new Date("2026-06-16T10:06:00.000Z") }, store);
  assert.equal(result.views.length, 1);

  const view = result.views[0];
  assert.equal(view.view_type, PROJECT_CURRENT_VIEW_TYPE);

  // project.inbox is derived from open_questions + decisions without resolution
  const inbox = [
    ...((view.content?.open_questions as string[]) ?? []),
    ...((view.content?.decisions as string[]) ?? []),
  ];
  assert.ok(inbox.length >= 2, "inbox must capture unresolved items");
  assert.ok(
    (view.content?.open_questions as string[]).some(q => q.includes("SQLite") || q.includes("LMDB")),
    "inbox should include the architecture question",
  );
  assert.ok(
    (view.content?.open_questions as string[]).some(q => q.includes("memory gate") || q.includes("threshold")),
    "inbox should include the memory gate question",
  );
  assert.ok(
    (view.content?.decisions as string[]).some(d => d.includes("Decision")),
    "inbox should include the routing decision",
  );
}));

// ---- project.tasks extracts actionable tasks ----

test("project.tasks extracts actionable tasks with source provenance", () => withStore((store) => {
  const source = sourceRecord("obs:ai:tasks", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-tasks" },
    content: {
      title: "Task extraction session",
      text: "Need to implement project.current compiler.",
    },
    payload: {
      cwd: "/Users/junjie/info",
      session_id: "codex-tasks",
      files_touched: ["packages/views/project/current.ts", "packages/views/work-router/focus-set.ts"],
      commands_run: ["pnpm typecheck"],
    },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  const focus = compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:05:00.000Z") }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [source], write: false, now: new Date("2026-06-16T10:06:00.000Z") }, store);
  const view = result.views[0];

  // project.tasks is derived from next_actions + active_files
  const tasks = (view.content?.next_actions as string[]) ?? [];
  const activeFiles = (view.content?.active_files as string[]) ?? [];

  assert.ok(tasks.length >= 1, "tasks should have at least one next_action");
  assert.ok(activeFiles.length >= 1, "tasks should reference active_files");

  // Tasks reference the files being worked on
  assert.ok(
    activeFiles.some(f => f.includes("project/current.ts")),
    "active_files should include the project current compiler file",
  );

  // Source provenance is preserved
  assert.ok(view.source_records.includes("obs:ai:tasks"), "tasks view should carry source record provenance");
  assert.ok(
    (view.content?.supporting_sources as any[]).some(s => s.id === "obs:ai:tasks"),
    "supporting_sources should trace back to the originating record",
  );
}));

// ---- project.decisions extracts decisions ----

test("project.decisions extracts decisions with rationale", () => withStore((store) => {
  const source = sourceRecord("obs:ai:decisions", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-decisions" },
    content: {
      title: "Architecture decisions",
      text: "Decision: use view-first compilation pipeline.\nDecision: adopt rule-hit routing for realtime processing over LLM classification.\nWe should prefer deterministic compilers when confidence is high.",
    },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-decisions" },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  const focus = compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:05:00.000Z") }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [source], write: false, now: new Date("2026-06-16T10:06:00.000Z") }, store);
  const view = result.views[0];

  const decisions = (view.content?.decisions as string[]) ?? [];
  assert.ok(decisions.length >= 2, "should extract at least two decisions");

  assert.ok(
    decisions.some(d => d.includes("view-first") || d.includes("compilation pipeline")),
    "decisions should include the view-first pipeline decision",
  );
  assert.ok(
    decisions.some(d => d.includes("rule-hit") || d.includes("realtime")),
    "decisions should include the routing decision with rationale",
  );
  assert.ok(
    decisions.some(d => /should prefer/i.test(d)),
    "decisions should capture 'we should' statements with rationale",
  );
}));

// ---- Unrelated pages do not enter project views ----

test("unrelated pages do not enter project views unless routed through work.focus_set", () => withStore((store) => {
  const project = sourceRecord("obs:ai:proj", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-proj" },
    content: { title: "Active project work", text: "Working on view system." },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-proj", files_touched: ["packages/views/index.ts"] },
  });
  const weather = sourceRecord("obs:weather:unrelated", "observation.browser_page_snapshot", {
    scope: { app: "chrome", domain: "weather.com" },
    content: { title: "Weather forecast", url: "https://weather.com/today", text: "Sunny 72F today. Should we go hiking?" },
  });
  const recipe = sourceRecord("obs:recipe:unrelated", "observation.browser_page_snapshot", {
    scope: { app: "chrome", domain: "recipes.com" },
    content: { title: "Best pasta recipe", url: "https://recipes.com/pasta", text: "Decision: use more garlic." },
  });

  const routeProject = store.insertRecord(routeCandidateFor(project));
  const routeWeather = store.insertRecord(routeCandidateFor(weather));
  const routeRecipe = store.insertRecord(routeCandidateFor(recipe));

  const focus = compileWorkFocusSet({
    records: [project, weather, recipe, routeProject, routeWeather, routeRecipe],
    write: true,
    now: new Date("2026-06-16T10:05:00.000Z"),
  }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [project, weather, recipe], write: false }, store);

  for (const view of result.views) {
    assert.equal((view.content as any).focus?.includes("Weather"), false, "project view should not include weather focus");
    assert.equal(JSON.stringify(view.content).includes("Best pasta recipe"), false, "project view should not include recipe content");
    assert.equal(view.source_records?.includes("obs:weather:unrelated"), false, "project view source_records should not include weather");
    assert.equal(view.source_records?.includes("obs:recipe:unrelated"), false, "project view source_records should not include recipe");
  }
}));

// ---- Multi-project scenario ----

test("two projects produce separate project views with distinct inbox/tasks/decisions", () => withStore((store) => {
  const infoSource = sourceRecord("obs:ai:info-multi", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-info" },
    content: {
      title: "Info project work",
      text: "Decision: consolidate view compilers into pipeline.\nHow to handle cross-project state?",
    },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-info", files_touched: ["packages/views/processors.ts"] },
  });
  const paperclipSource = sourceRecord("obs:ai:paperclip-multi", "observation.ai_session_locator_result", {
    scope: { project: "paperclip", project_path: "/Users/junjie/paperclip", session: "codex-paperclip" },
    content: {
      title: "Paperclip project work",
      text: "Decision: implement task queue with priority.\nShould we use Redis for dedup?",
    },
    payload: { cwd: "/Users/junjie/paperclip", session_id: "codex-paperclip", files_touched: ["src/queue.ts"] },
  });

  const routeInfo = store.insertRecord(routeCandidateFor(infoSource));
  const routePaperclip = store.insertRecord(routeCandidateFor(paperclipSource));
  const focus = compileWorkFocusSet({
    records: [infoSource, paperclipSource, routeInfo, routePaperclip],
    write: true,
    now: new Date("2026-06-16T10:05:00.000Z"),
  }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [infoSource, paperclipSource], write: false }, store);
  assert.equal(result.views.length, 2, "should produce two separate project views");

  const projectPaths = result.views.map(v => v.scope?.project_path).sort();
  assert.deepEqual(projectPaths, ["/Users/junjie/info", "/Users/junjie/paperclip"]);

  const infoView = result.views.find(v => v.scope?.project === "info");
  const paperclipView = result.views.find(v => v.scope?.project === "paperclip");

  assert.ok(infoView, "info project view should exist");
  assert.ok(paperclipView, "paperclip project view should exist");

  // Info project view contains info-specific content
  assert.ok(
    (infoView?.content?.decisions as string[]).some(d => d.includes("consolidate") || d.includes("pipeline")),
    "info view should have its own decision",
  );
  assert.ok(
    (infoView?.content?.open_questions as string[]).some(q => q.includes("cross-project")),
    "info view should have its own question",
  );
  assert.ok(
    (infoView?.content?.active_files as string[]).some(f => f.includes("processors.ts")),
    "info view should reference its own files",
  );

  // Paperclip project view contains paperclip-specific content
  assert.ok(
    (paperclipView?.content?.decisions as string[]).some(d => d.includes("task queue") || d.includes("priority")),
    "paperclip view should have its own decision",
  );
  assert.ok(
    (paperclipView?.content?.open_questions as string[]).some(q => q.includes("Redis") || q.includes("dedup")),
    "paperclip view should have its own question",
  );
  assert.ok(
    (paperclipView?.content?.active_files as string[]).some(f => f.includes("queue.ts")),
    "paperclip view should reference its own files",
  );

  // Cross-contamination check
  assert.equal(
    (infoView?.content?.active_files as string[]).some(f => f.includes("queue.ts")),
    false,
    "info view should not contain paperclip files",
  );
  assert.equal(
    (paperclipView?.content?.active_files as string[]).some(f => f.includes("processors.ts")),
    false,
    "paperclip view should not contain info files",
  );
}));

// ---- Project continuity artifacts ----

test("project.current answers current work decisions next actions and related artifacts from mixed signals", () => withStore((store) => {
  const codex = sourceRecord("obs:system:codex", "observation.ai_session_locator_result", {
    source: { type: "ai_session", connector: "codex" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-system-view" },
    content: {
      title: "Codex Project View implementation",
      text: "Decision: project remains a view family.\nWhat should project.current surface first?",
    },
    payload: {
      cwd: "/Users/junjie/info",
      session_id: "codex-system-view",
      tool: "codex",
      files_touched: ["packages/views/project/current.ts"],
    },
  });
  const claude = sourceRecord("obs:system:claude", "observation.ai_session_locator_result", {
    source: { type: "ai_session", connector: "claude-code" },
    scope: { project: "info", project_path: "/Users/junjie/info", session: "claude-system-view" },
    content: {
      title: "Claude interruption notes",
      text: "Interrupted after writing tests. Resume from browser docs and project.current artifact assertions.",
    },
    payload: {
      cwd: "/Users/junjie/info",
      session_id: "claude-system-view",
      tool: "claude-code",
      interrupted: true,
      files_touched: ["tests/project-system-views.test.ts"],
    },
  });
  const docs = sourceRecord("obs:system:browser-docs", "observation.browser_page_snapshot", {
    scope: { project: "info", project_path: "/Users/junjie/info", domain: "nodejs.org" },
    content: {
      title: "Node test runner docs",
      url: "https://nodejs.org/api/test.html",
      text: "Reference docs for deterministic node:test assertions.",
    },
    payload: { project_path: "/Users/junjie/info" },
  });
  const otherProject = sourceRecord("obs:system:paperclip", "observation.ai_session_locator_result", {
    scope: { project: "paperclip", project_path: "/Users/junjie/paperclip", session: "codex-paperclip-system" },
    content: { title: "Paperclip task work", text: "Decision: do not mix paperclip and info artifacts." },
    payload: { cwd: "/Users/junjie/paperclip", session_id: "codex-paperclip-system", files_touched: ["src/tasks.ts"] },
  });
  const records = [codex, claude, docs, otherProject];
  const routes = records.map(record => store.insertRecord(routeCandidateFor(record)));
  const focus = compileWorkFocusSet({
    records: [...records, ...routes],
    write: true,
    now: new Date("2026-06-16T10:05:00.000Z"),
  }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records, write: false, now: new Date("2026-06-16T10:06:00.000Z") }, store);
  const infoView = result.views.find(v => v.scope?.project_path === "/Users/junjie/info");
  const paperclipView = result.views.find(v => v.scope?.project_path === "/Users/junjie/paperclip");
  assert.ok(infoView, "info view should exist");
  assert.ok(paperclipView, "paperclip view should exist");

  assert.match(String(infoView?.content?.focus), /Codex Project View implementation|Claude interruption notes/);
  assert.ok((infoView?.content?.decisions as string[]).some(d => d.includes("view family")));
  assert.ok((infoView?.content?.open_questions as string[]).some(q => q.includes("surface first")));
  assert.ok((infoView?.content?.next_actions as string[]).some(action => /Resume from the latest interruption/i.test(action)));
  assert.deepEqual(infoView?.content?.active_webpages, ["https://nodejs.org/api/test.html"]);
  assert.ok((infoView?.content?.active_conversations as string[]).includes("obs:system:codex"));
  assert.ok((infoView?.content?.active_conversations as string[]).includes("obs:system:claude"));
  assert.ok((infoView?.content?.active_files as string[]).includes("packages/views/project/current.ts"));
  assert.ok((infoView?.content?.active_files as string[]).includes("tests/project-system-views.test.ts"));
  assert.ok(((infoView?.content?.interruptions as any[]) ?? []).some(item => item.id === "obs:system:claude"));

  const artifacts = infoView?.content?.project_artifacts as any;
  assert.equal(artifacts.webpages[0].url, "https://nodejs.org/api/test.html");
  assert.ok(artifacts.conversations.some((conversation: any) => conversation.tool === "codex"));
  assert.ok(artifacts.conversations.some((conversation: any) => conversation.tool === "claude"));
  assert.ok(artifacts.files.some((file: any) => file.id === "packages/views/project/current.ts"));

  assert.equal(JSON.stringify(infoView?.content).includes("src/tasks.ts"), false);
  assert.deepEqual((paperclipView?.content?.active_webpages as string[]) ?? [], []);
}));

// ---- Views are traceable ----

test("project views have correct source_records and compiler metadata", () => withStore((store) => {
  const source = sourceRecord("obs:ai:trace", "observation.ai_session_locator_result", {
    scope: { project: "info", project_path: "/Users/junjie/info", session: "codex-trace" },
    content: { title: "Traceable project work", text: "Implementing traceability for project views." },
    payload: { cwd: "/Users/junjie/info", session_id: "codex-trace", files_touched: ["packages/views/project/current.ts"] },
  });
  const route = store.insertRecord(routeCandidateFor(source));
  const focus = compileWorkFocusSet({ records: [source, route], write: true, now: new Date("2026-06-16T10:05:00.000Z") }, store).view as any;

  const result = compileProjectCurrent({ focusSetViews: [focus], records: [source], write: false, now: new Date("2026-06-16T10:06:00.000Z") }, store);
  const view = result.views[0];

  // source_records
  assert.ok(Array.isArray(view.source_records), "view must have source_records array");
  assert.ok(view.source_records.includes("obs:ai:trace"), "source_records must include the originating record id");

  // source_views
  assert.ok(Array.isArray(view.source_views), "view must have source_views array");
  assert.ok(view.source_views.includes(focus.id), "source_views must include the focus_set view id");

  // compiler metadata
  assert.ok(view.compiler, "view must have compiler metadata");
  assert.equal(view.compiler.id, "processor.project_current", "compiler id must match project current compiler");
  assert.equal(view.compiler.version, "0.0.1", "compiler version must be present");
  assert.equal(view.compiler.mode, "deterministic", "compiler mode should be deterministic for non-LLM path");

  // scope provenance
  assert.equal(view.scope?.project, "info", "scope.project must match source record project");
  assert.equal(view.scope?.project_path, "/Users/junjie/info", "scope.project_path must match source record path");

  // gating metadata
  assert.equal(view.metadata?.gated_by, "work.focus_set", "metadata must indicate gating by work.focus_set");
  assert.equal(view.metadata?.algorithm, "project-current-from-focus-set-v1", "metadata must record the algorithm identifier");

  // content generated_at
  assert.ok(view.content?.generated_at, "content must have generated_at timestamp");
}));

// ---- helpers ----

function routeCandidateFor(source: StoredContextRecord) {
  const features = extractRouteFeatures(source);
  return buildRouteCandidateRecord(source, features, buildCandidateRoutes(features), new Date("2026-06-16T10:00:00.000Z"));
}

function sourceRecord(id: string, schemaName: string, overrides: Partial<StoredContextRecord>): StoredContextRecord {
  const now = "2026-06-16T10:00:00.000Z";
  return {
    id,
    schema: { name: schemaName, version: 1 },
    source: { type: schemaName.includes("browser") ? "browser" : schemaName.includes("screenpipe") ? "screenpipe" : "ai_session" },
    scope: {},
    time: { observed_at: now, captured_at: now },
    content: {},
    payload: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { ProgramRuntime } from "../src/programs/runner.js";
import { browserAmbientExploreCapability, browserAmbientProgram } from "../src/programs/builtins/browser-ambient.js";
import { projectAmbientProgram } from "../src/programs/builtins/project-ambient.js";
import { routingLearningProgram } from "../src/programs/builtins/routing-learning.js";
import { feedbackLearningProgram } from "../src/programs/builtins/feedback-learning.js";
import { dailySummaryProgram } from "../src/programs/builtins/daily-summary.js";
import { researchShadowProgram } from "../src/programs/builtins/research-shadow.js";
import { proactiveResearchProgram, toolsmithAmbientProgram, writingAmbientProgram } from "../src/programs/builtins/proactive-ambient.js";
import { agentTaskSubmitCapability } from "../src/programs/capabilities/agent-task-submit.js";
import { createDefaultProgramRuntime, listDefaultCapabilities } from "../src/programs/registry.js";
import { agentOutputFromDiagnostics } from "../src/programs/view-kinds.js";
import type { Capability, Program } from "../src/programs/types.js";
import type { ContextRecord } from "@info/core";

function withStore(fn: (store: ContextStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "info-runtime-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function githubRecord(id = "browser-record-1"): ContextRecord {
  return {
    id,
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "github.com" },
    time: { observed_at: "2026-05-24T10:00:00.000Z", captured_at: "2026-05-24T10:00:01.000Z" },
    content: {
      title: "example/repo",
      url: "https://github.com/example/repo",
      text: "Example repository README. TypeScript project with local-first ambient runtime notes.",
    },
    acquisition: { mode: "manual", actor: "user", reason: "ambient explore button" },
    signal: { importance: 0.98, confidence: 0.9, status: "inbox" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    payload: { request: { kind: "ambient_explore" } },
  };
}

function localProjectRecord(id = "local-project-record"): ContextRecord {
  const projectPath = "/Users/junjie/info";
  return {
    id,
    schema: { name: "observation.local_project", version: 1 },
    source: { type: "local_project", connector: "runtime-snapshot" },
    scope: { project: "info", project_path: projectPath, app: "terminal" },
    content: {
      title: "Local project snapshot: info",
      path: projectPath,
      text: [
        "branch: main",
        "status:\n M src/programs/runner.ts",
        "diff stat:\n src/programs/runner.ts | 12 +++++++++",
        "recent files:\nsrc/programs/runner.ts\ntests/program-runtime.test.ts",
        "README.md:\nInfo is a local-first ambient context runtime.",
      ].join("\n\n---\n\n"),
    },
    acquisition: { mode: "sync", actor: "system", reason: "runtime tick project snapshot" },
    signal: { importance: 0.85, confidence: 0.95, status: "accepted" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    payload: {
      root: projectPath,
      branch: "main",
      status: " M src/programs/runner.ts",
      diffStat: " src/programs/runner.ts | 12 +++++++++",
      recentFiles: ["src/programs/runner.ts", "tests/program-runtime.test.ts"],
      doc_names: ["README.md"],
    },
  };
}

function githubIssueRecord(id = "github-issue-record"): ContextRecord {
  return {
    id,
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: {
      title: "Issue #7: connect ambient runtime views",
      url: "https://github.com/example/repo/issues/7",
      text: "Project context should include browser, git, agent, issue, terminal, and code project analysis evidence.",
    },
    acquisition: { mode: "sync", actor: "connector", reason: "GitHub issue sync" },
    signal: { importance: 0.82, confidence: 0.92, status: "accepted" },
    privacy: { level: "private", retention: "normal", allow_external_llm: false },
    payload: { number: 7, state: "open", labels: ["runtime", "project-ambient"] },
  };
}

test("Default Program registry exposes reusable Capabilities", () => {
  const runtime = createDefaultProgramRuntime();
  const capabilities = listDefaultCapabilities();

  assert.ok(runtime.listPrograms().some(program => program.id === "program.feedback_learning"));
  assert.ok(runtime.listPrograms().some(program => program.id === "program.daily_summary"));
  assert.ok(runtime.listPrograms().some(program => program.id === "program.research_shadow"));
  assert.ok(runtime.listPrograms().some(program => program.id === "program.proactive_research"));
  assert.ok(runtime.listPrograms().some(program => program.id === "program.writing_ambient"));
  assert.ok(runtime.listPrograms().some(program => program.id === "program.toolsmith_ambient"));
  assert.ok(runtime.listCapabilities().some(capability => capability.id === "capability.browser_ambient.explore"));
  assert.ok(runtime.listCapabilities().some(capability => capability.id === "capability.agent_task.submit"));
  assert.ok(capabilities.some(capability => capability.id === "capability.browser_ambient.explore"));
  assert.ok(capabilities.some(capability => capability.id === "capability.agent_task.submit"));
  assert.equal(capabilities.find(capability => capability.id === "capability.browser_ambient.explore")?.mode, "agent");
  assert.equal(capabilities.find(capability => capability.id === "capability.agent_task.submit")?.mode, "agent");
  assert.equal(capabilities.some(capability => capability.id === "capability.pdf.extract_text"), false);
  assert.equal(capabilities.some(capability => capability.id === "capability.github.inspect_repo"), false);
  assert.equal(capabilities.some(capability => capability.id === "capability.github.inspect_issue"), false);
  assert.equal(capabilities.some(capability => capability.id === "capability.code.inspect_project"), false);
});

test("Default Program runtime considers proactive ambient Programs without explicit routing", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "default-runtime-writing-record",
    schema: { name: "observation.editor.text_changed", version: 1 },
    source: { type: "editor", connector: "vscode" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "vscode" },
    content: {
      title: "docs/proactive-ambient.md",
      path: "/Users/junjie/info/docs/proactive-ambient.md",
      text: "Info should proactively help while I am writing about project focus, background research, and workflow tools.",
    },
    signal: { confidence: 0.88, importance: 0.7, status: "inbox" },
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = createDefaultProgramRuntime(store);

  const result = await runtime.processObject(record);
  const writtenViews = result.runs.flatMap(run => run.written_views).map(id => store.getView(id)).filter(Boolean);
  const selectedProgramIds = result.diagnostics.selected_program_ids as string[];

  assert.ok(selectedProgramIds.includes("program.writing_ambient"));
  assert.ok(selectedProgramIds.includes("program.toolsmith_ambient"));
  assert.ok(result.runs.some(run => run.program_id === "program.writing_ambient" && run.ok));
  assert.equal(writtenViews.filter(view => view?.compiler?.id === "program.writing_ambient").length, 0);
}));

test("ProgramRuntime filters to a requested program id", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord());
  const shouldNotRun: Program = {
    id: "program.should_not_run",
    title: "Should Not Run",
    purpose: "Test sentinel",
    attention: () => ({ action: "run", reason: "sentinel", confidence: 1 }),
    run: () => ({ ok: true, reason: "sentinel", views: [{ id: "view:sentinel", view_type: "analysis.sentinel" }] }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(browserAmbientExploreCapability).registerProgram(shouldNotRun).registerProgram(browserAmbientProgram);
  const result = await runtime.processObject(record, { program_id: "program.browser_ambient", dry_run: true });

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.browser_ambient"]);
  assert.equal(result.diagnostics.candidate_program_count, 1);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].program_id, "program.browser_ambient");
}));

test("Research Shadow turns research-like analysis Views into reusable research briefs", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:research-shadow-browser",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Agent Runtime Architecture Paper", text: "Source browser observation for research shadow." },
    privacy: { level: "private", retention: "normal" },
  });
  const source = store.upsertView({
    id: "analysis:research-shadow-browser",
    view_type: "analysis.browser_page",
    title: "Browser analysis: Agent Runtime Architecture Paper",
    summary: "A PDF paper about agent runtime architecture and context graphs.",
    source_records: ["record:research-shadow-browser"],
    scope: { domain: "example.com" },
    content: {
      analysis: "The paper explains agent runtime architecture, context graph design, and ambient research workflows.",
      key_points: ["Context graph", "Program attention", "Reusable research brief"],
      tags: ["agent runtime", "research", "pdf"],
    },
    confidence: 0.86,
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = new ProgramRuntime(store).registerProgram(researchShadowProgram);

  const result = await runtime.processObject(source, { program_id: "program.research_shadow" });
  const brief = store.getView(result.runs[0].written_views[0]);

  assert.ok(brief);
  assert.equal(brief.view_type, "brief.research");
  assert.equal(brief.compiler?.id, "program.research_shadow");
  assert.deepEqual(brief.source_views, [source.id]);
  assert.deepEqual(brief.source_records, source.source_records);
  assert.equal(brief.content?.source_view_type, "analysis.browser_page");
  assert.deepEqual(brief.content?.key_points, ["Context graph", "Program attention", "Reusable research brief"]);
  assert.equal(Object.hasOwn(brief.content ?? {}, "next_actions"), false);
  assert.equal(Object.hasOwn(brief.content ?? {}, "suggestions"), false);
}));

test("Research Shadow consumes generic AgentTask analysis Views without hardcoded view types", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:research-shadow-generic-agent-task",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Agent Runtime Paper", text: "Source observation for generic AgentTask research analysis." },
    privacy: { level: "private", retention: "normal" },
  });
  const source = store.upsertView({
    id: "analysis:agent-task-research-custom",
    view_type: "analysis.agent_task_custom",
    title: "AgentTask research analysis: Agent Runtime Paper",
    summary: "AgentTask identified research paper context about agent runtime architecture.",
    source_records: ["record:research-shadow-generic-agent-task"],
    compiler: { id: "capability.agent_task.submit", mode: "hybrid" },
    scope: { domain: "example.com" },
    content: {
      agent_task: { runtime: "local_mock", goal: "Analyze research paper" },
      agent_output: {
        analysis: "Generic AgentTask output identifies paper architecture, context routing, and ambient research workflows.",
        key_points: ["Generic AgentTask research View", "Research Shadow should consume it"],
      },
    },
    metadata: { agent_runtime: "local_mock" },
    confidence: 0.8,
  });
  const runtime = new ProgramRuntime(store).registerProgram(researchShadowProgram);

  const result = await runtime.processObject(source, { program_id: "program.research_shadow" });
  const brief = store.getView(result.runs[0].written_views[0]);

  assert.equal(result.runs[0].ok, true);
  assert.ok(brief);
  assert.equal(brief.view_type, "brief.research");
  assert.equal(brief.content?.source_view_type, "analysis.agent_task_custom");
  assert.match(String(brief.content?.analysis), /context routing/i);
}));

test("Research Shadow turns generic browser AgentTask Views into reusable research briefs", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:research-shadow-agent-task",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Agent Runtime Architecture Paper", text: "Source observation for browser AgentTask analysis." },
    privacy: { level: "private", retention: "normal" },
  });
  const source = store.upsertView({
    id: "analysis:research-shadow-browser-agent-task",
    view_type: "analysis.browser_agent_task",
    title: "Browser agent analysis: Agent Runtime Architecture Paper",
    summary: "Generic AgentTask analysis of an agent runtime architecture paper.",
    source_records: ["record:research-shadow-agent-task"],
    scope: { domain: "example.com" },
    content: {
      analysis: "The AgentTask analysis identifies context routing, runtime boundaries, and ambient research workflows.",
      key_points: ["Context routing", "Runtime boundaries", "Ambient research"],
      agent_task: { runtime: "local_mock", goal: "Analyze paper" },
    },
    confidence: 0.81,
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = new ProgramRuntime(store).registerProgram(researchShadowProgram);

  const result = await runtime.processObject(source, { program_id: "program.research_shadow" });
  const brief = store.getView(result.runs[0].written_views[0]);

  assert.ok(brief);
  assert.equal(brief.view_type, "brief.research");
  assert.equal(brief.compiler?.id, "program.research_shadow");
  assert.deepEqual(brief.source_views, [source.id]);
  assert.deepEqual(brief.source_records, source.source_records);
  assert.equal(brief.content?.source_view_type, "analysis.browser_agent_task");
  assert.match(String(brief.content?.analysis), /context routing/i);
  assert.deepEqual(brief.content?.key_points, ["Context routing", "Runtime boundaries", "Ambient research"]);
}));

test("Research Shadow turns PDF text extraction Views into reusable research briefs", async () => withStore(async (store) => {
  store.insertRecord({
    id: "record:pdf-research-shadow",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Agent Runtime Architecture Paper PDF", text: "Source observation for PDF text extraction." },
    privacy: { level: "private", retention: "normal" },
  });
  const source = store.upsertView({
    id: "extraction:pdf-text:research-shadow",
    view_type: "extraction.pdf_text",
    title: "PDF text: Agent Runtime Architecture Paper",
    summary: "Agent runtime architecture paper text.",
    source_records: ["record:pdf-research-shadow"],
    scope: { domain: "example.com" },
    content: {
      title: "Agent Runtime Architecture Paper",
      url: "https://example.com/agent-runtime-paper.pdf",
      text: "Agent runtime architecture paper text. Context graphs and program attention make ambient systems composable.",
    },
    confidence: 0.74,
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = new ProgramRuntime(store).registerProgram(researchShadowProgram);

  const result = await runtime.processObject(source, { program_id: "program.research_shadow" });
  const brief = store.getView(result.runs[0].written_views[0]);

  assert.ok(brief);
  assert.equal(brief.view_type, "brief.research");
  assert.equal(brief.content?.source_view_type, "extraction.pdf_text");
  assert.match(String(brief.content?.analysis), /Context graphs and program attention/);
  assert.deepEqual(brief.source_views, [source.id]);
  assert.deepEqual(brief.source_records, ["record:pdf-research-shadow"]);
}));

test("Proactive Research queues background research when a project focus View appears", async () => withStore(async (store) => {
  const oldRuntime = process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
  process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const record = store.insertRecord({
      ...localProjectRecord("proactive-research-project-record"),
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const focus = store.upsertView({
      id: "thread:active-work:proactive-research",
      view_type: "thread.active_work",
      title: "Active work: agent runtime adapter package",
      summary: "User is focused on agent runtime architecture, ACP docs, package boundaries, and ambient workflow improvement.",
      source_records: [record.id],
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: {
        focus: "agent runtime adapter package and proactive ambient workflow improvement",
        key_points: ["ACP docs", "agent runtime adapter", "ambient background research"],
      },
      confidence: 0.86,
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const runtime = new ProgramRuntime(store)
      .registerCapability(agentTaskSubmitCapability)
      .registerProgram(proactiveResearchProgram);

    const result = await runtime.processObject(focus, { program_id: "program.proactive_research" });
    const task = store.getView(result.runs[0].written_views.find(id => id.startsWith("task:background-research:")) ?? "");
    const advice = store.getView(result.runs[0].written_views.find(id => id.startsWith("advice:research:")) ?? "");
    const brief = store.getView(result.runs[0].written_views.find(id => id.startsWith("brief.background_research:")) ?? "");

    assert.equal(result.runs[0].ok, true);
    assert.ok(task);
    assert.equal(task.view_type, "task.background_research");
    assert.equal(task.content?.speed, "background");
    assert.deepEqual(task.content?.forbidden_actions, ["modify_files", "post_or_send", "mutate_remote_systems"]);
    assert.ok(advice);
    assert.equal(advice.view_type, "advice.research");
    assert.equal(advice.content?.task_view_id, task.id);
    assert.ok(brief);
    assert.equal(brief.view_type, "brief.background_research");
    assert.equal(brief.compiler?.id, "capability.agent_task.submit");
  } finally {
    if (oldRuntime === undefined) delete process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME;
    else process.env.PROACTIVE_RESEARCH_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Writing Ambient does not surface scaffold writing advice by default", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "writing-ambient-record",
    schema: { name: "observation.editor.text_changed", version: 1 },
    source: { type: "editor", connector: "vscode" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "vscode" },
    content: {
      title: "docs/ambient-runtime-contract.md",
      path: "/Users/junjie/info/docs/ambient-runtime-contract.md",
      text: "I want Info to become a proactive ambient system that can notice project focus, search in the background, and help while writing.",
    },
    signal: { confidence: 0.9, importance: 0.8, status: "inbox" },
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = new ProgramRuntime(store).registerProgram(writingAmbientProgram);

  const result = await runtime.processObject(record, { program_id: "program.writing_ambient" });

  assert.equal(result.runs[0].ok, true);
  assert.deepEqual(result.runs[0].written_views, []);
  assert.equal(result.runs[0].diagnostics?.generated, false);
}));

test("Toolsmith Ambient proposes small tools and requests no-file-edit prototype drafts", async () => withStore(async (store) => {
  const oldRuntime = process.env.TOOLSMITH_AGENT_TASK_RUNTIME;
  process.env.TOOLSMITH_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const record = store.insertRecord({
      ...localProjectRecord("toolsmith-project-record"),
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const workflow = store.upsertView({
      id: "workflow:repeated-research-doc-generation",
      view_type: "workflow",
      title: "Repeated workflow: research docs and issue drafting",
      summary: "User repeatedly searches docs, extracts evidence, creates issues, and drafts architecture notes.",
      source_records: [record.id],
      scope: { project: "info", project_path: "/Users/junjie/info" },
      content: {
        kind: "research_session",
        workflow_count: 3,
        key_points: ["search docs", "extract evidence", "draft issue/doc"],
      },
      confidence: 0.82,
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const runtime = new ProgramRuntime(store)
      .registerCapability(agentTaskSubmitCapability)
      .registerProgram(toolsmithAmbientProgram);

    const result = await runtime.processObject(workflow, { program_id: "program.toolsmith_ambient" });
    const opportunity = store.getView(result.runs[0].written_views.find(id => id.startsWith("opportunity:tool:")) ?? "");
    const task = store.getView(result.runs[0].written_views.find(id => id.startsWith("task:toolsmith-prototype:")) ?? "");
    const draft = store.getView(result.runs[0].written_views.find(id => id.startsWith("draft.tool_prototype:")) ?? "");

    assert.equal(result.runs[0].ok, true);
    assert.ok(opportunity);
    assert.equal(opportunity.view_type, "opportunity.tool");
    assert.match(String(opportunity.content?.autonomy_boundary), /file edits require sandbox_auto/);
    assert.ok(task);
    assert.equal(task.view_type, "task.toolsmith_prototype");
    assert.deepEqual(task.content?.constraints, {
      no_file_edits: true,
      prototype_only: true,
      require_user_approval_before_implementation: true,
    });
    assert.ok(draft);
    assert.equal(draft.view_type, "draft.tool_prototype");
    assert.equal(draft.compiler?.id, "capability.agent_task.submit");
  } finally {
    if (oldRuntime === undefined) delete process.env.TOOLSMITH_AGENT_TASK_RUNTIME;
    else process.env.TOOLSMITH_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Daily Summary compresses timeline Views and reuses project Views", async () => withStore(async (store) => {
  const browserRecord = store.insertRecord(githubRecord("daily-summary-browser-record"));
  const timeline = store.upsertView({
    id: "timeline:activity:daily-summary",
    view_type: "timeline.activity",
    title: "Activity timeline today",
    source_records: [browserRecord.id],
    content: {
      signals: {
        top_sources: ["browser", "git"],
        top_projects: ["info"],
      },
      buckets: [
        { label: "2026-05-24T10:00", summary: "Worked on ambient runtime", count: 2 },
      ],
    },
    privacy: { level: "private", retention: "normal" },
  });
  const project = store.upsertView({
    id: "project:daily-summary-context",
    view_type: "project.current_context",
    title: "Project context: Info runtime",
    summary: "Project Ambient connected browser analysis with git diff.",
    source_records: [browserRecord.id],
    content: { analysis: "Info runtime project context." },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProgramRuntime(store).registerProgram(dailySummaryProgram);
  const result = await runtime.processObject(timeline, { program_id: "program.daily_summary" });
  const summaryId = result.runs[0].written_views.find(id => id.startsWith("summary:daily:"));
  const tomorrowId = result.runs[0].written_views.find(id => id.startsWith("brief:tomorrow:"));
  const memoryId = result.runs[0].written_views.find(id => id.startsWith("memory:routine-patterns:"));
  assert.ok(summaryId);
  assert.ok(tomorrowId);
  assert.ok(memoryId);
  const summary = store.getView(summaryId);
  const tomorrow = store.getView(tomorrowId);
  const memory = store.getView(memoryId);

  assert.ok(summary);
  assert.equal(summary.view_type, "summary.daily");
  assert.equal(summary.compiler?.id, "program.daily_summary");
  assert.deepEqual(summary.source_views, [timeline.id, project.id]);
  assert.deepEqual(summary.source_records, [browserRecord.id]);
  assert.equal(summary.content?.timeline_view_id, timeline.id);
  assert.deepEqual(summary.content?.project_view_ids, [project.id]);
  assert.match(summary.summary ?? "", /1 timeline buckets/);
  assert.ok(tomorrow);
  assert.equal(tomorrow.view_type, "brief.tomorrow");
  assert.equal(tomorrow.compiler?.id, "program.daily_summary");
  assert.deepEqual(tomorrow.source_views, [timeline.id, project.id, summary.id]);
  assert.equal(tomorrow.content?.daily_summary_view_id, summary.id);
  assert.equal(Object.hasOwn(tomorrow.content ?? {}, "next_actions"), false);
  assert.equal(Object.hasOwn(tomorrow.content ?? {}, "suggestions"), false);
  assert.ok(memory);
  assert.equal(memory.view_type, "memory.routine_patterns");
  assert.equal(memory.compiler?.id, "program.daily_summary");
  assert.deepEqual(memory.source_views, [timeline.id, summary.id]);
  assert.deepEqual(memory.content?.top_sources, ["browser", "git"]);
  assert.deepEqual(memory.content?.top_projects, ["info"]);
}));

test("dry_run returns proposed Views without writing them", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord());
  const runtime = new ProgramRuntime(store).registerCapability(browserAmbientExploreCapability).registerProgram(browserAmbientProgram);

  const result = await runtime.processObject(record, { program_id: "program.browser_ambient", dry_run: true });
  const viewId = result.runs[0].written_views[0];

  assert.match(viewId, /^analysis:browser-page:[a-f0-9]+$/);
  assert.equal(store.getView(viewId), undefined);
}));

test("Browser Ambient circulates AgentTask analysis View when delegation succeeds", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord(),
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });
  const oldRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability).registerCapability(browserAmbientExploreCapability).registerProgram(browserAmbientProgram);

    const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
    const viewId = result.runs[0].written_views[0];
    const view = store.getView(viewId);

    assert.ok(view);
    assert.equal(view.view_type, "analysis.browser_agent_task");
    assert.equal(view.compiler?.id, "capability.agent_task.submit");
    assert.deepEqual(view.source_records?.slice(0, 1), [record.id]);
    assert.equal((result.runs[0].diagnostics?.agent_task as { ok?: boolean } | undefined)?.ok, true);
    assert.equal((result.runs[0].diagnostics as { fallback_used?: boolean } | undefined)?.fallback_used, false);
    assert.ok(store.listRuntimeEvents({ event_type: "capability.run.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0]);
    assert.equal(store.listRuntimeEvents({ event_type: "capability.run.completed", plugin_id: "capability.browser_ambient.explore", limit: 1 }).length, 0);
    assert.equal(Object.hasOwn(view.content ?? {}, "next_actions"), false);
    assert.equal(Object.hasOwn(view.content ?? {}, "suggestions"), false);
    assert.equal(store.listViews({ view_types: ["analysis.browser_page"], source_record_id: record.id }).length, 0);
  } finally {
    if (oldRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Project Ambient consumes GitHub issue analysis Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("project-ambient-issue-record"));
  const issueView = store.upsertView({
    id: "analysis:github-issue:fixture",
    view_type: "analysis.github_issue",
    title: "Issue #7: connect ambient runtime views",
    summary: "Project context should include browser, git, agent, issue, terminal, and code project analysis evidence.",
    source_records: [record.id],
    compiler: { id: "fixture.installed_plugin.github_issue", version: "0.1.0", mode: "deterministic" },
    scope: { repo: "example/repo", project_path: "/Users/junjie/info", domain: "github.com" },
    content: {
      analysis: "Project context should include browser, git, agent, issue, terminal, and code project analysis evidence.",
      key_points: ["GitHub issue View supplied by explicit plugin/test fixture"],
    },
    confidence: 0.82,
  });
  const runtime = new ProgramRuntime(store).registerProgram(projectAmbientProgram);

  const result = await runtime.processObject(issueView, { program_id: "program.project_ambient" });
  const projectViewId = result.runs[0].written_views.find(id => id.startsWith("project:current-context:"));
  const projectView = store.getView(projectViewId ?? "");

  assert.ok(projectView);
  assert.equal(projectView.view_type, "project.current_context");
  assert.equal(projectView.compiler?.id, "program.project_ambient");
  assert.deepEqual(projectView.source_views, [issueView.id]);
  assert.ok(projectView.source_records?.includes(record.id));
  assert.equal(projectView.scope?.repo, "example/repo");
  assert.equal(projectView.content?.source_view_type, "analysis.github_issue");
  assert.match(String(projectView.content?.analysis), /Project context should include browser/);
}));

test("Project Ambient consumes code project analysis Views", async () => withStore(async (store) => {
  const record = store.insertRecord(localProjectRecord("project-ambient-code-record"));
  const codeView = store.upsertView({
    id: "analysis:code-project:fixture",
    view_type: "analysis.code_project",
    title: "Local project snapshot: info",
    summary: "TypeScript project implementing a local-first ambient context runtime.",
    source_records: [record.id],
    compiler: { id: "fixture.installed_plugin.code_project", version: "0.1.0", mode: "deterministic" },
    scope: { project: "info", project_path: "/Users/junjie/info", app: "terminal" },
    content: {
      analysis: "TypeScript project implementing a local-first ambient context runtime.",
      key_points: ["Code project View supplied by explicit plugin/test fixture"],
    },
    confidence: 0.84,
  });
  const runtime = new ProgramRuntime(store).registerProgram(projectAmbientProgram);

  const result = await runtime.processObject(codeView, { program_id: "program.project_ambient" });
  const projectViewId = result.runs[0].written_views.find(id => id.startsWith("project:current-context:"));
  const projectView = store.getView(projectViewId ?? "");

  assert.ok(projectView);
  assert.equal(projectView.view_type, "project.current_context");
  assert.equal(projectView.compiler?.id, "program.project_ambient");
  assert.deepEqual(projectView.source_views, [codeView.id]);
  assert.ok(projectView.source_records?.includes(record.id));
  assert.equal(projectView.scope?.project_path, "/Users/junjie/info");
  assert.equal(projectView.content?.source_view_type, "analysis.code_project");
  assert.match(String(projectView.content?.analysis), /local-first ambient context runtime/);
}));

test("Browser Ambient delegates repository pages to generic AgentTask instead of selecting GitHub skills", async () => withStore(async (store) => {
  const oldRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const record = store.insertRecord(githubRecord("browser-github-repo-ambient-record"));
    const runtime = new ProgramRuntime(store)
      .registerCapability(agentTaskSubmitCapability)
      .registerCapability(browserAmbientExploreCapability)
      .registerProgram(browserAmbientProgram);

    const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
    const repo = store.listViews({ view_types: ["analysis.repo"], source_record_id: record.id })[0];
    const agentTaskViewId = (result.runs[0].diagnostics?.agent_task as { written_views?: string[] } | undefined)?.written_views?.[0];
    const agentTaskView = store.getView(agentTaskViewId ?? "");

    assert.equal(result.runs[0].ok, true);
    assert.equal(repo, undefined);
    assert.ok(agentTaskView);
    assert.equal(agentTaskView.compiler?.id, "capability.agent_task.submit");
    assert.equal(Object.hasOwn(agentTaskView.content?.agent_task as object, "skills"), false);
    assert.equal(Object.hasOwn(result.runs[0].diagnostics ?? {}, "github_repo"), false);
    assert.equal(Object.hasOwn(result.runs[0].diagnostics ?? {}, "pdf_extraction"), false);
  } finally {
    if (oldRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Browser Ambient delegates PDF pages to generic AgentTask instead of selecting PDF skills", async () => withStore(async (store) => {
  const oldRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  const record = store.insertRecord({
    id: "browser-pdf-ambient-record",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "example.com" },
    content: {
      title: "Agent Runtime Architecture Paper",
      url: "https://example.com/agent-runtime-paper.pdf",
      text: "Agent runtime architecture paper text. Context graphs and program attention make ambient systems composable.",
    },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });
  try {
    const runtime = new ProgramRuntime(store)
      .registerCapability(agentTaskSubmitCapability)
      .registerCapability(browserAmbientExploreCapability)
      .registerProgram(browserAmbientProgram);

    const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
    const extraction = store.listViews({ view_types: ["extraction.pdf_text"], source_record_id: record.id })[0];
    const analysis = store.getView(result.runs[0].written_views[0]);
    const agentTaskViewId = (result.runs[0].diagnostics?.agent_task as { written_views?: string[] } | undefined)?.written_views?.[0];
    const agentTaskView = store.getView(agentTaskViewId ?? "");

    assert.equal(result.runs[0].ok, true);
    assert.equal(extraction, undefined);
    assert.ok(analysis);
    assert.equal(analysis.view_type, "analysis.browser_agent_task");
    assert.ok(agentTaskView);
    assert.equal(agentTaskView.id, analysis.id);
    assert.equal(agentTaskView.view_type, "analysis.browser_agent_task");
    assert.equal(Object.hasOwn(agentTaskView.content?.agent_task as object, "skills"), false);
    assert.equal(Object.hasOwn(result.runs[0].diagnostics ?? {}, "pdf_extraction"), false);
  } finally {
    if (oldRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Browser Ambient can delegate explicit exploration to a generic AgentTask", async () => withStore(async (store) => {
  const oldRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const record = store.insertRecord(githubRecord("browser-agent-task-program-record"));
    const runtime = new ProgramRuntime(store)
      .registerCapability(agentTaskSubmitCapability)
      .registerCapability(browserAmbientExploreCapability)
      .registerProgram(browserAmbientProgram);

    const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
    const analysis = store.getView(result.runs[0].written_views[0]);
    const agentTaskViewId = (result.runs[0].diagnostics?.agent_task as { written_views?: string[] } | undefined)?.written_views?.[0];
    const agentTaskView = store.getView(agentTaskViewId ?? "");

    assert.equal(result.runs[0].ok, true);
    assert.ok(analysis);
    assert.equal(analysis.view_type, "analysis.browser_agent_task");
    assert.ok(agentTaskView);
    assert.equal(agentTaskView.id, analysis.id);
    assert.equal(agentTaskView.view_type, "analysis.browser_agent_task");
    assert.equal(agentTaskView.compiler?.id, "capability.agent_task.submit");
    assert.equal(agentTaskView.metadata?.requested_by_program, "program.browser_ambient");
    assert.equal((agentTaskView.content?.agent_task as { runtime?: string; skills?: unknown }).runtime, "local_mock");
    assert.equal(Object.hasOwn(agentTaskView.content?.agent_task as object, "skills"), false);
    assert.match(String(agentTaskView.content?.context_pack_markdown_excerpt), /Context Broker Pack/);
  } finally {
    if (oldRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Browser Ambient builds external-AgentTask context without denied privacy provenance", async () => withStore(async (store) => {
  const oldRuntime = process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
  process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = "local_mock";
  try {
    const record = store.insertRecord({
      ...githubRecord("browser-external-context-source"),
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    store.insertRecord({
      id: "browser-external-context-denied-record",
      schema: { name: "observation.browser_page_snapshot", version: 1 },
      source: { type: "browser", connector: "chrome-extension" },
      scope: { app: "chrome", domain: "github.com" },
      content: { title: "Denied snapshot", url: "https://github.com/example/repo", text: "DENIED SNAPSHOT SHOULD NOT ENTER AGENT TASK PACK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    store.upsertView({
      id: "analysis:browser-denied-for-agent-task",
      view_type: "analysis.browser_page",
      title: "Denied browser page analysis",
      source_records: ["browser-external-context-denied-record"],
      content: { analysis: "DENIED VIEW SHOULD NOT ENTER AGENT TASK PACK" },
      privacy: { level: "private", retention: "normal", allow_external_llm: false },
    });
    const runtime = new ProgramRuntime(store)
      .registerCapability(agentTaskSubmitCapability)
      .registerCapability(browserAmbientExploreCapability)
      .registerProgram(browserAmbientProgram);

    const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
    const view = store.getView(result.runs[0].written_views[0]);
    const excerpt = String(view?.content?.context_pack_markdown_excerpt ?? "");

    assert.equal(result.runs[0].ok, true);
    assert.equal(view?.view_type, "analysis.browser_agent_task");
    assert.doesNotMatch(excerpt, /DENIED SNAPSHOT SHOULD NOT ENTER AGENT TASK PACK/);
    assert.doesNotMatch(excerpt, /DENIED VIEW SHOULD NOT ENTER AGENT TASK PACK/);
    assert.equal((result.runs[0].diagnostics?.agent_task as any)?.diagnostics?.context_source_count, 1);
  } finally {
    if (oldRuntime === undefined) delete process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME;
    else process.env.BROWSER_AMBIENT_AGENT_TASK_RUNTIME = oldRuntime;
  }
}));

test("Browser Ambient declares generic agent capability dependency for routing diagnostics", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("browser-capability-diagnostics-record"));
  const runtime = new ProgramRuntime(store)
    
    .registerCapability(browserAmbientExploreCapability)
    .registerProgram(browserAmbientProgram);

  const result = await runtime.processObject(record, { program_id: "program.browser_ambient", dry_run: true });

  assert.deepEqual(result.decisions[0].capability_ids, ["capability.agent_task.submit", "capability.browser_ambient.explore"]);
  assert.deepEqual(result.diagnostics.requested_capability_ids, ["capability.agent_task.submit", "capability.browser_ambient.explore"]);
}));

test("Browser Ambient missing generic AgentTask capability falls back to local deterministic analysis", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("browser-program-private-agent-record"));
  const runtime = new ProgramRuntime(store)
    
    .registerCapability(browserAmbientExploreCapability)
    .registerProgram(browserAmbientProgram);

  const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
  const view = store.getView(result.runs[0].written_views[0]);
  const failed = store.listRuntimeEvents({ event_type: "capability.run.failed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];

  assert.equal(result.runs[0].ok, true);
  assert.ok(view);
  assert.equal(view.view_type, "analysis.browser_page");
  assert.equal(view.metadata?.local_agent, "deterministic");
  assert.ok(failed);
  assert.match(String(failed.payload?.reason), /capability not found/);
  assert.equal((result.runs[0].diagnostics?.agent_task as { ok?: boolean; reason?: string } | undefined)?.ok, false);
  assert.match(String((result.runs[0].diagnostics?.agent_task as { reason?: string } | undefined)?.reason), /capability not found/);
  assert.deepEqual(result.diagnostics.capability_failures, [
    {
      program_id: "program.browser_ambient",
      capability_id: "capability.agent_task.submit",
      reason: "capability not found: capability.agent_task.submit",
    },
  ]);
}));

test("Browser Ambient fallback excludes nearby records whose scope conflicts with the output View", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("browser-fallback-scope-source"));
  const otherDomain = store.insertRecord({
    id: "browser-fallback-scope-other-domain",
    schema: { name: "observation.browser_page_heartbeat", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { app: "chrome", domain: "www.youtube.com" },
    time: { observed_at: record.time?.observed_at },
    content: { title: "Different domain", url: "https://www.youtube.com/watch?v=test" },
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = new ProgramRuntime(store)
    .registerCapability(browserAmbientExploreCapability)
    .registerProgram(browserAmbientProgram);

  const result = await runtime.processObject(record, { program_id: "program.browser_ambient" });
  const view = store.getView(result.runs[0].written_views[0]);

  assert.equal(result.runs[0].ok, true);
  assert.ok(view);
  assert.equal(view.view_type, "analysis.browser_page");
  assert.ok(view.source_records?.includes(record.id));
  assert.equal(view.source_records?.includes(otherDomain.id), false);
}));

test("Browser Ambient show_more surfacing memory can wake weak browser observations", async () => withStore(async (store) => {
  const record = store.insertRecord({
    id: "browser-show-more-weak-observation",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "example.com" },
    content: { title: "Personal notes", url: "https://example.com/notes", text: "A weakly classified page." },
    privacy: { level: "private", retention: "normal" },
  });
  const weakSignal = {
    object_id: record.id!,
    object_kind: "observation" as const,
    object_type: record.schema.name,
    source: record.source.type,
    title: record.content?.title,
    text_preview: record.content?.text,
    url: record.content?.url,
    domain: record.scope?.domain,
  };
  assert.equal(browserAmbientProgram.attention(weakSignal, store).action, "defer");

  store.upsertView({
    id: "memory:browser-show-more-agent-task",
    view_type: "memory.surfacing_preference",
    title: "Show more browser AgentTask analysis",
    scope: { domain: "example.com" },
    content: {
      preference: "show_more",
      target_view_type: "analysis.browser_agent_task",
    },
    confidence: 0.86,
    privacy: { level: "private", retention: "normal" },
  });

  const decision = browserAmbientProgram.attention(weakSignal, store);
  assert.equal(decision.action, "run");
  assert.match(decision.reason ?? "", /surfacing memory prefers more/);
  assert.equal(decision.capability_ids?.includes("capability.agent_task.submit"), true);

  const runtime = new ProgramRuntime(store)
    .registerCapability(agentTaskSubmitCapability)
    .registerCapability(browserAmbientExploreCapability)
    .registerProgram(browserAmbientProgram);
  const result = await runtime.processObject(record, { dry_run: true });

  assert.deepEqual(result.diagnostics.attention_influences, [
    {
      program_id: "program.browser_ambient",
      kind: "memory.surfacing_preference",
      view_id: "memory:browser-show-more-agent-task",
      preference: "show_more",
      target_view_type: "analysis.browser_agent_task",
    },
  ]);
  assert.deepEqual(result.decisions[0].attention_influences, result.diagnostics.attention_influences);
}));

test("Browser Ambient capability falls back to deterministic analysis when source privacy disallows external LLM", async () => withStore(async (store) => {
  const oldAgent = process.env.BROWSER_AMBIENT_AGENT;
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.BROWSER_AMBIENT_AGENT = "claude";
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-test";
  try {
    const record = store.insertRecord(githubRecord("browser-private-agent-record"));
    const runtime = new ProgramRuntime(store).registerCapability(browserAmbientExploreCapability);
    const result = await runtime.runCapability("capability.browser_ambient.explore", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
      },
    });

    assert.equal(result.ok, true);
    assert.equal((result.diagnostics?.agent as { used?: boolean; mode?: string; error?: string } | undefined)?.used, false);
    assert.equal((result.diagnostics?.agent as { used?: boolean; mode?: string; error?: string } | undefined)?.mode, "deterministic");
    assert.equal((result.diagnostics?.agent as { used?: boolean; mode?: string; error?: string } | undefined)?.error, undefined);
  } finally {
    if (oldAgent === undefined) delete process.env.BROWSER_AMBIENT_AGENT;
    else process.env.BROWSER_AMBIENT_AGENT = oldAgent;
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
  }
}));

test("Browser Ambient explore capability does not bypass generic AgentTask with a direct Claude agent", async () => withStore(async (store) => {
  const oldAgent = process.env.BROWSER_AMBIENT_AGENT;
  const oldInfoAgent = process.env.INFO_BROWSER_AMBIENT_AGENT;
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.BROWSER_AMBIENT_AGENT = "claude";
  process.env.INFO_BROWSER_AMBIENT_AGENT = "claude";
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-browser-explore";
  try {
    const record = store.insertRecord({
      ...githubRecord("browser-no-direct-claude-agent"),
      privacy: { level: "private", retention: "normal", allow_external_llm: true },
    });
    const runtime = new ProgramRuntime(store).registerCapability(browserAmbientExploreCapability);
    const result = await runtime.runCapability("capability.browser_ambient.explore", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics?.agent, { used: false, mode: "deterministic" });
  } finally {
    if (oldAgent === undefined) delete process.env.BROWSER_AMBIENT_AGENT;
    else process.env.BROWSER_AMBIENT_AGENT = oldAgent;
    if (oldInfoAgent === undefined) delete process.env.INFO_BROWSER_AMBIENT_AGENT;
    else process.env.INFO_BROWSER_AMBIENT_AGENT = oldInfoAgent;
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
  }
}));

test("Project Ambient consumes browser analysis Views and writes project context", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord());
  const diff = store.insertRecord({
    id: "git-diff-project-ambient",
    schema: { name: "observation.git.diff", version: 1 },
    source: { type: "git", connector: "local" },
    scope: { domain: "github.com" },
    time: { observed_at: "2026-05-24T10:00:02.000Z" },
    content: {
      title: "Git diff for ambient runtime",
      path: "/Users/junjie/info/src/programs/builtins/project-ambient.ts",
      text: "diff --git a/src/programs/builtins/project-ambient.ts b/src/programs/builtins/project-ambient.ts",
    },
    privacy: { level: "private", retention: "normal" },
  });
  const runtime = new ProgramRuntime(store)
    
    .registerCapability(browserAmbientExploreCapability)
    .registerProgram(browserAmbientProgram)
    .registerProgram(projectAmbientProgram);

  const browserResult = await runtime.processObject(record, { program_id: "program.browser_ambient" });
  const browserView = store.getView(browserResult.runs[0].written_views[0]);
  assert.ok(browserView);

  const projectResult = await runtime.processObject(browserView, { program_id: "program.project_ambient" });
  const projectViewId = projectResult.runs[0].written_views.find(id => id.startsWith("project:current-context:"));
  const threadViewId = projectResult.runs[0].written_views.find(id => id.startsWith("thread:active-work:"));
  const briefViewId = projectResult.runs[0].written_views.find(id => id.startsWith("brief:project-next-state:"));
  const memoryViewId = projectResult.runs[0].written_views.find(id => id.startsWith("memory:project-patterns:"));
  assert.ok(projectViewId);
  assert.ok(threadViewId);
  assert.ok(briefViewId);
  assert.ok(memoryViewId);
  const projectView = store.getView(projectViewId);
  const threadView = store.getView(threadViewId);
  const briefView = store.getView(briefViewId);
  const memoryView = store.getView(memoryViewId);

  assert.ok(projectView);
  assert.equal(projectView.view_type, "project.current_context");
  assert.equal(projectView.compiler?.id, "program.project_ambient");
  assert.deepEqual(projectView.source_views, [browserView.id]);
  assert.ok(projectView.source_records?.includes(record.id));
  assert.ok(projectView.source_records?.includes(diff.id));
  assert.equal(projectView.scope?.domain, "github.com");
  assert.equal(projectResult.runs[0].diagnostics?.context_record_count, 2);
  assert.deepEqual(
    (projectView.content?.related_records as Array<{ id: string; schema: string; source: string; title?: string }>).map(item => ({ id: item.id, schema: item.schema, source: item.source })),
    [
      { id: diff.id, schema: "observation.git.diff", source: "git" },
      { id: record.id, schema: "observation.browser_ambient_requested", source: "browser" },
    ],
  );
  assert.match(projectView.summary ?? "", /example\/repo/);
  assert.equal(Object.hasOwn(projectView.content ?? {}, "next_actions"), false);
  assert.equal(Object.hasOwn(projectView.content ?? {}, "suggestions"), false);
  assert.ok(threadView);
  assert.equal(threadView.view_type, "thread.active_work");
  assert.equal(threadView.compiler?.id, "program.project_ambient");
  assert.deepEqual(threadView.source_views, [browserView.id, projectView.id]);
  assert.ok(threadView.source_records?.includes(record.id));
  assert.ok(threadView.source_records?.includes(diff.id));
  assert.equal(threadView.content?.project_context_view_id, projectView.id);
  assert.deepEqual(threadView.content?.evidence_record_ids, [diff.id, record.id]);
  assert.ok(briefView);
  assert.equal(briefView.view_type, "brief.project_next_state");
  assert.equal(briefView.compiler?.id, "program.project_ambient");
  assert.deepEqual(briefView.source_views, [browserView.id, projectView.id, threadView.id]);
  assert.equal(briefView.content?.project_context_view_id, projectView.id);
  assert.equal(briefView.content?.active_work_thread_view_id, threadView.id);
  assert.equal(Object.hasOwn(briefView.content ?? {}, "next_actions"), false);
  assert.equal(Object.hasOwn(briefView.content ?? {}, "suggestions"), false);
  assert.ok(memoryView);
  assert.equal(memoryView.view_type, "memory.project.patterns");
  assert.equal(memoryView.compiler?.id, "program.project_ambient");
  assert.deepEqual(memoryView.source_views, [browserView.id, projectView.id, threadView.id, briefView.id]);
  assert.ok(memoryView.source_records?.includes(record.id));
  assert.ok(memoryView.source_records?.includes(diff.id));
  assert.deepEqual(memoryView.content?.observed_sources, ["browser", "git"]);
  assert.equal(Object.hasOwn(memoryView.content ?? {}, "next_actions"), false);
  assert.equal(Object.hasOwn(memoryView.content ?? {}, "suggestions"), false);
}));

test("Project Ambient consumes generic AgentTask analysis Views without hardcoded view types", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("project-generic-agent-task-source-record"));
  const agentTaskView = store.upsertView({
    id: "analysis:agent-task-project-custom",
    view_type: "analysis.agent_task_custom",
    title: "AgentTask project analysis: example/repo",
    summary: "AgentTask identified repository architecture context for the Info project.",
    status: "candidate",
    source_records: [record.id],
    compiler: { id: "capability.agent_task.submit", mode: "hybrid" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: {
      agent_task: { runtime: "local_mock", goal: "Analyze project architecture" },
      agent_output: {
        analysis: "Generic AgentTask output says this repository architecture is relevant to current project context.",
        key_points: ["Generic AgentTask View", "Project context should consume it"],
      },
    },
    metadata: { agent_runtime: "local_mock" },
    confidence: 0.76,
  });
  const runtime = new ProgramRuntime(store).registerProgram(projectAmbientProgram);

  const result = await runtime.processObject(agentTaskView, { program_id: "program.project_ambient" });
  const projectViewId = result.runs[0].written_views.find(id => id.startsWith("project:current-context:"));
  const projectView = store.getView(projectViewId ?? "");

  assert.equal(result.runs[0].ok, true);
  assert.ok(projectView);
  assert.equal(projectView.content?.source_view_type, "analysis.agent_task_custom");
  assert.match(String(projectView.content?.analysis), /repository architecture/);
}));

test("Project Ambient consumes generic browser AgentTask Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("project-agent-task-source-record"));
  const agentTaskView = store.upsertView({
    id: "analysis:browser-agent-task-project",
    view_type: "analysis.browser_agent_task",
    title: "Browser agent analysis: example/repo",
    summary: "Generic agent says this repository is relevant to Info project work.",
    status: "candidate",
    source_records: [record.id],
    compiler: { id: "capability.agent_task.submit", mode: "hybrid" },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    content: {
      analysis: "The repository shows a runtime pattern that should circulate into project context.",
      key_points: ["AgentTask produced reusable browser analysis", "Project Ambient should consume generic Views"],
      agent_task: { runtime: "local_mock", goal: "Analyze browser page" },
    },
    confidence: 0.72,
  });
  const runtime = new ProgramRuntime(store).registerProgram(projectAmbientProgram);

  const result = await runtime.processObject(agentTaskView, { program_id: "program.project_ambient" });
  const projectViewId = result.runs[0].written_views.find(id => id.startsWith("project:current-context:"));
  const projectView = store.getView(projectViewId ?? "");

  assert.equal(result.runs[0].ok, true);
  assert.ok(projectView);
  assert.equal(projectView.view_type, "project.current_context");
  assert.deepEqual(projectView.source_views, [agentTaskView.id]);
  assert.ok(projectView.source_records?.includes(record.id));
  assert.equal(projectView.content?.source_view_type, "analysis.browser_agent_task");
  assert.match(String(projectView.content?.analysis), /runtime pattern/);
  assert.deepEqual(projectView.content?.key_points, ["AgentTask produced reusable browser analysis", "Project Ambient should consume generic Views"]);
}));

test("Project Ambient ignores inactive source Views", async () => withStore(async (store) => {
  const archived = store.upsertView({
    id: "analysis:project-ambient-archived",
    view_type: "analysis.browser_page",
    title: "Archived browser analysis",
    status: "archived",
    scope: { domain: "github.com" },
    content: { analysis: "Should not continue circulating." },
    confidence: 0.9,
  });
  const stale = store.upsertView({
    id: "analysis:project-ambient-stale",
    view_type: "analysis.browser_page",
    title: "Stale browser analysis",
    status: "candidate",
    validity: { stale_after: "2026-01-01T00:00:00.000Z" },
    scope: { domain: "github.com" },
    content: { analysis: "Should not continue circulating either." },
    confidence: 0.9,
  });
  const runtime = new ProgramRuntime(store).registerProgram(projectAmbientProgram);

  const archivedResult = await runtime.processObject(archived, { program_id: "program.project_ambient" });
  const staleResult = await runtime.processObject(stale, { program_id: "program.project_ambient" });

  assert.equal(archivedResult.decisions[0].action, "ignore");
  assert.match(archivedResult.decisions[0].reason ?? "", /inactive/i);
  assert.equal(archivedResult.runs.length, 0);
  assert.equal(staleResult.decisions[0].action, "ignore");
  assert.match(staleResult.decisions[0].reason ?? "", /inactive/i);
  assert.equal(staleResult.runs.length, 0);
}));

test("Project Ambient combines project-scoped git, agent, GitHub issue, and terminal Observations", async () => withStore(async (store) => {
  const projectPath = "/Users/junjie/info";
  store.insertRecord({
    id: "record:browser-multisource",
    schema: { name: "observation.browser_page_snapshot", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "github.com", repo: "example/repo", project_path: projectPath },
    content: { title: "example/repo", text: "Browser source observation for project ambient multisource." },
    privacy: { level: "private", retention: "normal" },
  });
  const browserAnalysis = store.upsertView({
    id: "analysis:project-ambient-multisource-browser",
    view_type: "analysis.browser_page",
    title: "Browser analysis: example/repo",
    scope: { domain: "github.com", repo: "example/repo", project_path: projectPath },
    source_records: ["record:browser-multisource"],
    content: { analysis: "GitHub repository page appears related to Info ambient runtime." },
    confidence: 0.88,
  });
  store.insertRecord({
    id: "record:project-multisource-git",
    schema: { name: "observation.git.diff", version: 1 },
    source: { type: "git", connector: "local" },
    scope: { project_path: projectPath },
    content: { title: "Git diff", path: `${projectPath}/src/programs/builtins/project-ambient.ts`, text: "diff --git project ambient multisource" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:project-multisource-codex",
    schema: { name: "observation.codex.message", version: 1 },
    source: { type: "agent", connector: "codex" },
    scope: { project_path: projectPath },
    content: { title: "Codex session note", text: "User is implementing Project Ambient multi-source synthesis." },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:project-multisource-terminal",
    schema: { name: "observation.terminal.command", version: 1 },
    source: { type: "terminal", connector: "zsh" },
    scope: { project_path: projectPath },
    content: { title: "Terminal command", text: "pnpm test -- tests/program-runtime.test.ts" },
    privacy: { level: "private", retention: "normal" },
  });
  store.insertRecord({
    id: "record:project-multisource-issue",
    schema: { name: "observation.github.issue", version: 1 },
    source: { type: "github", connector: "issues" },
    scope: { project_path: projectPath, domain: "github.com", repo: "example/repo" },
    content: { title: "Issue: connect ambient runtime views", url: "https://github.com/example/repo/issues/7", text: "Project context should include browser, git, agent, issue, and terminal evidence." },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProgramRuntime(store).registerProgram(projectAmbientProgram);
  const result = await runtime.processObject(browserAnalysis, { program_id: "program.project_ambient" });
  const projectViewId = result.runs[0].written_views.find(id => id.startsWith("project:current-context:"));
  assert.ok(projectViewId);
  const projectView = store.getView(projectViewId);
  assert.ok(projectView);

  assert.ok(projectView.source_records?.includes("record:project-multisource-git"));
  assert.ok(projectView.source_records?.includes("record:project-multisource-codex"));
  assert.ok(projectView.source_records?.includes("record:project-multisource-terminal"));
  assert.ok(projectView.source_records?.includes("record:project-multisource-issue"));
  assert.deepEqual(
    new Set((projectView.content?.related_records as Array<{ schema: string }>).map(record => record.schema)),
    new Set(["observation.browser_page_snapshot", "observation.git.diff", "observation.codex.message", "observation.terminal.command", "observation.github.issue"]),
  );
}));

test("ProgramRuntime uses routing.shortcut Views to pick candidate programs", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord());
  store.upsertView({
    id: "routing:shortcut:browser-github-to-project",
    view_type: "routing.shortcut",
    title: "Route GitHub browser observations to project ambient",
    summary: "Repeated confirmations show GitHub browser pages should wake Project Ambient.",
    compiler: { id: "test", version: "0.1.0", mode: "deterministic" },
    scope: { domain: "github.com", plugin_id: "program.project_ambient" },
    content: {
      program_id: "program.project_ambient",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
      reason: "learned browser GitHub project relevance",
    },
    confidence: 0.92,
    stability: "long_term",
    privacy: { level: "private", retention: "normal" },
  });

  const sentinel: Program = {
    id: "program.sentinel",
    title: "Sentinel",
    purpose: "Should be skipped when routing shortcut narrows candidates",
    attention: () => ({ action: "run", reason: "sentinel", confidence: 1 }),
    run: () => ({ ok: true, views: [{ id: "view:sentinel", view_type: "analysis.sentinel" }] }),
  };
  const projectProbe: Program = {
    id: "program.project_ambient",
    title: "Project Probe",
    purpose: "Probe routing shortcut",
    attention: () => ({ action: "ignore", reason: "probe only", confidence: 1 }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(sentinel).registerProgram(projectProbe);
  const result = await runtime.processObject(record);
  const signalEvent = store.listRuntimeEvents({ event_type: "program_runtime.signal_received", limit: 1 })[0];

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.project_ambient"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, "routing:shortcut:browser-github-to-project");
  assert.ok(signalEvent);
  assert.deepEqual(signalEvent.payload?.selected_program_ids, ["program.project_ambient"]);
  assert.equal(signalEvent.payload?.routing_shortcut_view_id, "routing:shortcut:browser-github-to-project");
  assert.equal(result.diagnostics.candidate_program_count, 1);
  assert.equal(result.runs.length, 0);
}));

test("ProgramRuntime routing shortcut is not starved by newer invalid routing Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("routing-starvation-record"));
  store.upsertView({
    id: "routing:shortcut:starvation-valid",
    view_type: "routing.shortcut",
    title: "Older valid route",
    content: {
      program_id: "program.available_route",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.91,
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 30; index++) {
    store.upsertView({
      id: `routing:shortcut:starvation-invalid-${index}`,
      view_type: "routing.shortcut",
      title: `Newer invalid route ${index}`,
      content: {
        program_id: "not-a-program-id",
        match: { object_kind: "observation", source: "browser", domain: "github.com" },
      },
      confidence: 0.99,
      privacy: { level: "private", retention: "normal" },
    });
  }
  const available: Program = {
    id: "program.available_route",
    title: "Available Route",
    purpose: "Should be selected by older valid shortcut",
    attention: () => ({ action: "ignore", reason: "available route", confidence: 1 }),
    run: () => ({ ok: true }),
  };
  const fallback: Program = {
    id: "program.fallback_route",
    title: "Fallback Route",
    purpose: "Should be skipped when valid shortcut is found",
    attention: () => ({ action: "ignore", reason: "fallback route", confidence: 1 }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(fallback).registerProgram(available);
  const result = await runtime.processObject(record);

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.available_route"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, "routing:shortcut:starvation-valid");
  assert.deepEqual(result.diagnostics.selected_program_ids, ["program.available_route"]);
}));


test("ProgramRuntime ignores routing.shortcut Views with invalid provenance", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("routing-dirty-provenance-record"));
  store.insertRecord({
    id: "record:routing-dirty-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "other.example" },
    content: { title: "DIRTY ROUTING SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "routing:shortcut:dirty-provenance",
    view_type: "routing.shortcut",
    title: "Dirty route should not control runtime",
    source_records: ["record:routing-dirty-source"],
    scope: { domain: "github.com" },
    content: {
      program_id: "program.dirty_route",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.99,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "routing:shortcut:valid-provenance",
    view_type: "routing.shortcut",
    title: "Valid route should control runtime",
    content: {
      program_id: "program.valid_route",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.8,
    privacy: { level: "private", retention: "normal" },
  });

  const dirty: Program = {
    id: "program.dirty_route",
    title: "Dirty Route",
    purpose: "Should not be selected",
    attention: () => ({ action: "run", reason: "dirty", confidence: 1 }),
    run: () => ({ ok: true, reason: "dirty ran" }),
  };
  const valid: Program = {
    id: "program.valid_route",
    title: "Valid Route",
    purpose: "Should be selected",
    attention: () => ({ action: "ignore", reason: "valid", confidence: 1 }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(dirty).registerProgram(valid);
  const result = await runtime.processObject(record);

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.valid_route"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, "routing:shortcut:valid-provenance");
  assert.doesNotMatch(JSON.stringify(result), /dirty ran|DIRTY ROUTING/);
}));

test("ProgramRuntime prefers the highest-confidence matching routing.shortcut", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("routing-confidence-record"));
  store.upsertView({
    id: "routing:shortcut:high-confidence",
    view_type: "routing.shortcut",
    title: "High confidence route",
    content: {
      program_id: "program.high_confidence",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.91,
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "routing:shortcut:low-confidence",
    view_type: "routing.shortcut",
    title: "Low confidence route",
    content: {
      program_id: "program.low_confidence",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.61,
    privacy: { level: "private", retention: "normal" },
  });

  const low: Program = {
    id: "program.low_confidence",
    title: "Low Confidence",
    purpose: "Should be skipped",
    attention: () => ({ action: "ignore", reason: "low", confidence: 1 }),
    run: () => ({ ok: true }),
  };
  const high: Program = {
    id: "program.high_confidence",
    title: "High Confidence",
    purpose: "Should be selected",
    attention: () => ({ action: "ignore", reason: "high", confidence: 1 }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(low).registerProgram(high);
  const result = await runtime.processObject(record);

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.high_confidence"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, "routing:shortcut:high-confidence");
}));

test("ProgramRuntime falls back when routing.shortcut targets a missing Program", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("routing-missing-target-record"));
  store.upsertView({
    id: "routing:shortcut:missing-target",
    view_type: "routing.shortcut",
    title: "Missing target route",
    content: {
      program_id: "program.missing_target",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.95,
    privacy: { level: "private", retention: "normal" },
  });
  const fallback: Program = {
    id: "program.fallback",
    title: "Fallback",
    purpose: "Should run when shortcut target is missing",
    attention: () => ({ action: "run", reason: "fallback", confidence: 1 }),
    run: () => ({ ok: true, reason: "fallback ran" }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(fallback);
  const result = await runtime.processObject(record);
  const event = store.listRuntimeEvents({ event_type: "program_runtime.routing_target_missing", limit: 1 })[0];

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.fallback"]);
  assert.equal(result.runs[0].reason, "fallback ran");
  assert.equal(result.diagnostics.routing_shortcut_view_id, undefined);
  assert.ok(event);
  assert.equal(event.payload?.routing_shortcut_view_id, "routing:shortcut:missing-target");
  assert.equal(event.payload?.program_id, "program.missing_target");
}));

test("ProgramRuntime uses next matching routing.shortcut when highest-confidence target is missing", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("routing-next-available-record"));
  store.upsertView({
    id: "routing:shortcut:missing-highest",
    view_type: "routing.shortcut",
    title: "Missing highest route",
    content: {
      program_id: "program.missing_highest",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.95,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "routing:shortcut:available-second",
    view_type: "routing.shortcut",
    title: "Available second route",
    content: {
      program_id: "program.available_second",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  const fallback: Program = {
    id: "program.fallback",
    title: "Fallback",
    purpose: "Should not run when second shortcut is available",
    attention: () => ({ action: "run", reason: "fallback", confidence: 1 }),
    run: () => ({ ok: true, reason: "fallback ran" }),
  };
  const available: Program = {
    id: "program.available_second",
    title: "Available Second",
    purpose: "Should be selected after missing route",
    attention: () => ({ action: "ignore", reason: "available", confidence: 1 }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(fallback).registerProgram(available);
  const result = await runtime.processObject(record);
  const event = store.listRuntimeEvents({ event_type: "program_runtime.routing_target_missing", limit: 1 })[0];

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.available_second"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, "routing:shortcut:available-second");
  assert.deepEqual(result.diagnostics.selected_program_ids, ["program.available_second"]);
  assert.equal(result.diagnostics.routing_missing_target_count, 1);
  assert.deepEqual(result.diagnostics.routing_missing_target_view_ids, ["routing:shortcut:missing-highest"]);
  assert.deepEqual(result.diagnostics.routing_missing_target_program_ids, ["program.missing_highest"]);
  assert.ok(event);
  assert.equal(event.payload?.routing_shortcut_view_id, "routing:shortcut:missing-highest");
}));

test("ProgramRuntime records attention failures and continues to later Programs", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("attention-failure-record"));
  const broken: Program = {
    id: "program.attention_throws",
    title: "Attention Throws",
    purpose: "Verify attention failure provenance",
    attention: () => {
      throw new Error("attention boom");
    },
    run: () => ({ ok: true }),
  };
  const later: Program = {
    id: "program.later",
    title: "Later Program",
    purpose: "Should still be considered",
    attention: () => ({ action: "run", reason: "later still runs", confidence: 1 }),
    run: () => ({ ok: true, reason: "later ran" }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(broken).registerProgram(later);
  const result = await runtime.processObject(record);
  const failed = store.listRuntimeEvents({ event_type: "program.attention_failed", plugin_id: "program.attention_throws", limit: 1 })[0];

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.attention_throws", "program.later"]);
  assert.deepEqual(result.decisions.map(decision => decision.action), ["ignore", "run"]);
  assert.deepEqual(result.diagnostics.skipped_program_ids, ["program.attention_throws"]);
  assert.deepEqual(result.diagnostics.skipped_programs, [{
    program_id: "program.attention_throws",
    action: "ignore",
    reason: "attention boom",
  }]);
  assert.equal(result.runs[0].program_id, "program.later");
  assert.equal(result.runs[0].ok, true);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.match(String(failed.payload?.error), /attention boom/);
}));

test("ProgramRuntime ignores inactive or expired routing.shortcut Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("expired-routing-record"));
  store.upsertView({
    id: "routing:shortcut:expired",
    view_type: "routing.shortcut",
    title: "Expired shortcut",
    status: "archived",
    content: {
      program_id: "program.project_ambient",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.99,
    validity: { valid_until: "2026-01-01T00:00:00.000Z" },
  });

  const sentinel: Program = {
    id: "program.sentinel",
    title: "Sentinel",
    purpose: "Should still be considered when shortcut is inactive",
    attention: () => ({ action: "ignore", reason: "sentinel checked", confidence: 1 }),
    run: () => ({ ok: true }),
  };
  const projectProbe: Program = {
    id: "program.project_ambient",
    title: "Project Probe",
    purpose: "Would be shortcut target if active",
    attention: () => ({ action: "ignore", reason: "project checked", confidence: 1 }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(sentinel).registerProgram(projectProbe);
  const result = await runtime.processObject(record);

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.sentinel", "program.project_ambient"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, undefined);
  assert.equal(result.diagnostics.candidate_program_count, 2);
}));

test("Program run input can invoke registered Capabilities through the Runtime", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-capability-record"));
  const capability: Capability = {
    id: "capability.test.program_used",
    title: "Program Used Capability",
    purpose: "Verify program-to-capability bridge",
    mode: "deterministic",
    run: ({ signal }) => ({
      ok: true,
      reason: "capability used by program",
      views: [{
        id: "analysis:test:program-capability",
        view_type: "analysis.test",
        title: "Program capability output",
        source_records: [signal.object_id],
      }],
    }),
  };
  const program: Program = {
    id: "program.uses_capability",
    title: "Uses Capability",
    purpose: "Verify programs do not bypass Runtime for capabilities",
    attention: () => ({ action: "run", reason: "test", confidence: 1, capability_ids: ["capability.test.program_used"] }),
    run: async ({ signal, runCapability }) => {
      const result = await runCapability("capability.test.program_used", { signal });
      return { ok: result.ok, reason: result.reason };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.uses_capability" });

  assert.deepEqual(result.decisions[0].capability_ids, ["capability.test.program_used"]);
  assert.deepEqual(result.diagnostics.requested_capability_ids, ["capability.test.program_used"]);
  assert.equal(result.runs[0].ok, true);
  assert.ok(store.getView("analysis:test:program-capability"));
  const completed = store.listRuntimeEvents({ event_type: "capability.run.completed", plugin_id: "capability.test.program_used", limit: 1 })[0];
  assert.ok(completed);
  assert.equal(completed.payload?.program_id, "program.uses_capability");
  assert.deepEqual(completed.related_records, [record.id]);
  assert.deepEqual(completed.related_views, ["analysis:test:program-capability"]);
}));

test("ProgramRuntime exposes policy denial diagnostics from Program-invoked Capabilities", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-policy-denial-record"));
  const capability: Capability = {
    id: "capability.test.requires_full_auto",
    title: "Requires Full Auto",
    purpose: "Verify policy denial is visible at ProgramRuntime level",
    mode: "external",
    default_autonomy: "full_auto",
    run: () => ({ ok: true }),
  };
  const program: Program = {
    id: "program.policy_denial_probe",
    title: "Policy Denial Probe",
    purpose: "Calls a capability above the requested autonomy level",
    default_autonomy: "suggest",
    attention: () => ({ action: "run", reason: "probe policy diagnostics", confidence: 1, capability_ids: ["capability.test.requires_full_auto"] }),
    run: async ({ runCapability }) => {
      const denied = await runCapability("capability.test.requires_full_auto");
      return { ok: denied.ok, reason: denied.reason, diagnostics: { denied } };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.policy_denial_probe" });

  assert.equal(result.runs[0].ok, false);
  assert.equal(result.runs[0].diagnostics?.denied?.diagnostics?.policy_denied, true);
  assert.equal(result.runs[0].diagnostics?.denied?.diagnostics?.program_id, "program.policy_denial_probe");
  assert.deepEqual(result.diagnostics.policy_denials, [
    {
      program_id: "program.policy_denial_probe",
      capability_id: "capability.test.requires_full_auto",
      policy: "autonomy",
      reason: "denied: capability capability.test.requires_full_auto requires full_auto autonomy, got suggest",
      requested_autonomy: "suggest",
      required_autonomy: "full_auto",
    },
  ]);
}));

test("Program can submit a generic AgentTask without selecting skills and receive a View", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("agent-task-source-issue"));
  const program: Program = {
    id: "program.agent_task_probe",
    title: "Agent Task Probe",
    purpose: "Verify Info delegates a task to an agent runtime adapter instead of owning domain skills.",
    default_autonomy: "suggest",
    attention: () => ({ action: "run", reason: "delegate to agent runtime", confidence: 1, capability_ids: ["capability.agent_task.submit"] }),
    run: async ({ signal, buildContextPack, runCapability }) => {
      const pack = buildContextPack({
        goal: "Context for a generic agent task",
        include_records: true,
        include_views: false,
        limit: 4,
      });
      const result = await runCapability("capability.agent_task.submit", {
        signal,
        payload: {
          task: {
            runtime: "local_mock",
            goal: "Analyze this issue against current project context.",
            context_pack: {
              markdown: pack.markdown,
              sources: pack.sources,
              diagnostics: pack.diagnostics,
            },
            constraints: { write_policy: "views_only" },
            output_contract: {
              view_type: "analysis.agent_task_issue",
              title: "Agent task issue analysis",
              purpose: "Agent runtime output stored as a reusable View.",
            },
          },
        },
      });
      return { ok: result.ok, reason: result.reason, diagnostics: { agent_task_view_ids: result.written_views } };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.agent_task_probe" });
  const viewId = (result.runs[0].diagnostics?.agent_task_view_ids as string[])[0];
  const view = store.getView(viewId);

  assert.equal(result.runs[0].ok, true);
  assert.ok(view);
  assert.equal(view.view_type, "analysis.agent_task_issue");
  assert.equal(view.compiler?.id, "capability.agent_task.submit");
  assert.deepEqual(view.source_records, [record.id]);
  assert.equal(view.scope?.repo, "example/repo");
  assert.equal(view.scope?.project_path, "/Users/junjie/info");
  assert.equal(view.metadata?.agent_runtime, "local_mock");
  assert.equal(view.metadata?.requested_by_program, "program.agent_task_probe");
  assert.equal((view.content?.agent_task as { runtime?: string; goal?: string; skills?: unknown }).runtime, "local_mock");
  assert.equal(Object.hasOwn(view.content?.agent_task as object, "skills"), false);
  assert.match(String(view.content?.context_pack_markdown_excerpt), /Context Broker Pack/);

  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const completed = store.listRuntimeEvents({ event_type: "capability.run.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const submittedTask = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const completedTask = store.listRuntimeEvents({ event_type: "agent_task.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  assert.ok(started);
  assert.ok(completed);
  assert.ok(submittedTask);
  assert.ok(completedTask);
  assert.equal((started.payload?.capability_input as any)?.task?.runtime, "local_mock");
  assert.equal((started.payload?.capability_input as any)?.task?.skills, undefined);
  assert.deepEqual(completed.related_views, [view.id]);
  assert.equal(submittedTask.payload?.runtime, "local_mock");
  assert.equal(submittedTask.payload?.goal, "Analyze this issue against current project context.");
  assert.equal((submittedTask.payload as any)?.skills, undefined);
  assert.deepEqual(submittedTask.related_records, [record.id]);
  assert.deepEqual(completedTask.related_views, [view.id]);
  assert.equal(completedTask.payload?.output_view_type, "analysis.agent_task_issue");
  assert.equal(completedTask.payload?.output_view_id, view.id);
  assert.equal((completedTask.payload as any)?.agent_output, undefined);
}));

test("AgentTask rejects caller-supplied skills and tools without leaking them into events", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("agent-task-skills-tools-record"));
  const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

  const result = await runtime.runCapability("capability.agent_task.submit", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
    payload: {
      task: {
        runtime: "local_mock",
        goal: "Analyze without caller-selected skills.",
        skills: ["github.inspect_repo"],
        tools: ["pdf.extract"],
        output_contract: { view_type: "analysis.agent_task_with_skills", title: "Invalid skillful task" },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /must not include skills or tools/);
  assert.deepEqual(result.written_views, []);
  assert.equal(store.listViews({ view_types: ["analysis.agent_task_with_skills"] }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const failed = store.listRuntimeEvents({ event_type: "capability.run.failed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  assert.ok(started);
  assert.ok(failed);
  const serializedEvents = JSON.stringify([started.payload, failed.payload]);
  assert.doesNotMatch(serializedEvents, /github\.inspect_repo|pdf\.extract/);
  assert.equal((started.payload?.capability_input as any)?.task?.skills, undefined);
  assert.equal((started.payload?.capability_input as any)?.task?.tools, undefined);
}));

test("AgentTask runtime events summarize Context Packs without storing full markdown", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("agent-task-event-context-pack-record"));
  const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);
  const secretMarkdown = "# Context Broker Pack\nThis full pack includes EVENT_ONLY_SECRET_CONTEXT that should not be stored in runtime events.";

  const result = await runtime.runCapability("capability.agent_task.submit", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
    payload: {
      task: {
        runtime: "local_mock",
        goal: "Analyze while keeping runtime events compact.",
        context_pack: {
          markdown: secretMarkdown,
          sources: [
            { id: record.id, kind: "record" },
            { id: "missing-event-context-pack-source", kind: "record" },
          ],
          diagnostics: { source_count: 1 },
        },
        output_contract: { view_type: "analysis.agent_task_event_pack", title: "Event-safe AgentTask" },
      },
    },
  });

  assert.equal(result.ok, true);
  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const completed = store.listRuntimeEvents({ event_type: "capability.run.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  assert.ok(started);
  assert.ok(completed);
  const serializedEvents = JSON.stringify([started.payload, completed.payload]);
  assert.doesNotMatch(serializedEvents, /EVENT_ONLY_SECRET_CONTEXT/);
  assert.equal((started.payload?.capability_input as any)?.task?.context_pack?.markdown, undefined);
  assert.equal((completed.payload?.capability_input as any)?.task?.context_pack?.markdown, undefined);
  assert.equal((started.payload?.capability_input as any)?.task?.context_pack?.markdown_length, secretMarkdown.length);
  assert.equal((started.payload?.capability_input as any)?.task?.context_pack?.source_ids, undefined);
  assert.doesNotMatch(serializedEvents, /missing-event-context-pack-source/);
  const submitted = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  assert.deepEqual(submitted.related_records, [record.id]);
}));

test("AgentTask rejects record-like output_contract view types", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("agent-task-invalid-view-type-record"));
  const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

  const result = await runtime.runCapability("capability.agent_task.submit", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
      title: record.content?.title,
      text_preview: record.content?.text,
      url: record.content?.url,
    },
    payload: {
      task: {
        runtime: "local_mock",
        goal: "Do not let AgentTask write legacy record schemas as Views.",
        context_pack: { markdown: "# Context Broker Pack\nObservation text" },
        output_contract: { view_type: "derived.project_memory", title: "Invalid derived output" },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /must be a View type/);
  assert.deepEqual(result.written_views, []);
  assert.equal(store.listViews({ view_types: ["derived.project_memory"] }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
}));

test("AgentTask rejects malformed output_contract view types", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("agent-task-malformed-view-type-record"));
  const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

  const result = await runtime.runCapability("capability.agent_task.submit", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
    payload: {
      task: {
        runtime: "local_mock",
        goal: "Do not let malformed View types become View ids.",
        output_contract: { view_type: "analysis/bad type", title: "Malformed output" },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /view_type is invalid/);
  assert.deepEqual(result.written_views, []);
}));

test("AgentTask output provenance includes Context Pack record and View sources", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubIssueRecord("agent-task-provenance-source"),
    privacy: { level: "public", retention: "normal", allow_external_llm: true, allow_external_reader: true },
  });
  const supportingRecord = store.insertRecord({
    id: "record:agent-task-supporting-context",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    content: { title: "Supporting browser context", text: "Context Pack supporting record used by agent runtime." },
    privacy: { level: "secret", retention: "archive", allow_external_llm: false, allow_external_reader: true },
  });
  const supportingView = store.upsertView({
    id: "analysis:agent-task-supporting-view",
    view_type: "analysis.browser_page",
    title: "Supporting analysis View",
    source_records: [supportingRecord.id],
    content: { analysis: "Context Pack supporting View used by agent runtime." },
    privacy: { level: "private", retention: "normal", allow_external_llm: true, allow_external_reader: false },
  });
  const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

  const result = await runtime.runCapability("capability.agent_task.submit", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
      title: record.content?.title,
      text_preview: record.content?.text,
    },
    payload: {
      task: {
        runtime: "local_mock",
        goal: "Analyze with explicit Context Pack provenance.",
        context_pack: {
          markdown: "# Context Broker Pack\nPrimary and supporting context.",
          sources: [
            { id: record.id, kind: "record" },
            { id: supportingView.id, kind: "view" },
            { id: "missing-context-source", kind: "record" },
          ],
        },
        output_contract: {
          view_type: "analysis.agent_task_provenance",
          title: "AgentTask provenance analysis",
        },
      },
    },
  });

  const view = store.getView(result.written_views?.[0] ?? "");
  const submitted = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
  const completed = store.listRuntimeEvents({ event_type: "agent_task.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics?.context_source_count, 2);
  assert.ok(view);
  assert.deepEqual(view.source_records, [record.id]);
  assert.deepEqual(view.source_views, [supportingView.id]);
  assert.deepEqual(view.privacy, {
    level: "secret",
    retention: "archive",
    allow_external_llm: false,
    allow_external_reader: false,
  });
  assert.deepEqual(submitted.related_records, [record.id]);
  assert.deepEqual(submitted.related_views, [supportingView.id]);
  assert.deepEqual(completed.related_records, [record.id]);
  assert.deepEqual(completed.related_views, [supportingView.id, view.id]);
}));

test("AgentTask claude_code dry_run returns a prompt preview without calling Claude Code", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-dry-run";
  try {
    const record = store.insertRecord(githubIssueRecord("agent-task-claude-dry-run"));
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      dry_run: true,
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code.",
          context_pack: {
            markdown: "# Context Broker Pack\nObservation text",
            sources: [
              { id: record.id, kind: "record", uri: "https://client.example/forged-source", title: "CLIENT SUPPLIED SOURCE METADATA SHOULD NOT PASS" },
              { id: "missing-claude-prompt-source", kind: "record", uri: "context://records/missing-claude-prompt-source" },
            ],
          },
          constraints: { no_file_edits: true },
          output_contract: { view_type: "analysis.claude_agent_task", title: "Claude Code task analysis" },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.written_views?.length, 0);
    assert.equal(result.diagnostics?.runtime, "claude_code");
    assert.equal(result.diagnostics?.dry_run, true);
    assert.match(String(result.diagnostics?.prompt_preview), /Analyze with local Claude Code/);
    assert.match(String(result.diagnostics?.prompt_preview), /You own your runtime tools and skills/);
    assert.match(String(result.diagnostics?.prompt_preview), /Do not return next_actions/);
    assert.match(String(result.diagnostics?.prompt_preview), new RegExp(`context://records/${record.id}`));
    assert.doesNotMatch(String(result.diagnostics?.prompt_preview), /CLIENT SUPPLIED SOURCE METADATA/);
    assert.doesNotMatch(String(result.diagnostics?.prompt_preview), /client\.example\/forged-source/);
    assert.doesNotMatch(String(result.diagnostics?.prompt_preview), /missing-claude-prompt-source/);
    assert.deepEqual(result.diagnostics?.tool_policy, {
      tools: "default",
      permission_mode: "dangerously-skip-permissions",
      allowed_tools: [],
      disallowed_tools: [],
      reason: "local experiment trusts Claude Code as the external agent runtime with full tool permissions; task prompt still carries behavioral constraints",
    });
    assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
    const completed = store.listRuntimeEvents({ event_type: "capability.run.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    assert.ok(completed);
    assert.match(String(result.diagnostics?.prompt_preview), /Observation text/);
    const serializedEvent = JSON.stringify(completed.payload);
    assert.doesNotMatch(serializedEvent, /Observation text/);
    assert.equal((completed.payload?.diagnostics as any)?.prompt_preview, undefined);
    assert.equal((completed.payload?.diagnostics as any)?.prompt_preview_length, String(result.diagnostics?.prompt_preview).length);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
  }
}));

test("AgentTask defaults to local Claude Code runtime when runtime is omitted", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const oldDefault = process.env.AGENT_TASK_DEFAULT_RUNTIME;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-default-dry-run";
  delete process.env.AGENT_TASK_DEFAULT_RUNTIME;
  try {
    const record = store.insertRecord(githubIssueRecord("agent-task-default-runtime"));
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      dry_run: true,
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          goal: "Analyze with the default local agent runtime.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.default_agent_task", title: "Default runtime task analysis" },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.written_views?.length, 0);
    assert.equal(result.diagnostics?.runtime, "claude_code");
    assert.equal(result.diagnostics?.dry_run, true);
    assert.match(String(result.diagnostics?.prompt_preview), /Analyze with the default local agent runtime/);
    assert.match(String(result.diagnostics?.prompt_preview), new RegExp(`context://records/${record.id}`));
    assert.deepEqual(result.diagnostics?.tool_policy, {
      tools: "default",
      permission_mode: "dangerously-skip-permissions",
      allowed_tools: [],
      disallowed_tools: [],
      reason: "local experiment trusts Claude Code as the external agent runtime with full tool permissions; task prompt still carries behavioral constraints",
    });
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    if (oldDefault === undefined) delete process.env.AGENT_TASK_DEFAULT_RUNTIME;
    else process.env.AGENT_TASK_DEFAULT_RUNTIME = oldDefault;
  }
}));

test("AgentTask claude_code execution is denied when provenance disallows external LLM use", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "info-agent-task-privacy-denial-"));
  const fakeClaude = join(dir, "claude");
  const marker = join(dir, "claude-was-called");
  const successOutput = JSON.stringify({ result: JSON.stringify({ summary: "Should not run", analysis: "Denied source should not reach Claude Code." }) });
  writeFileSync(fakeClaude, `#!/bin/sh
printf called > ${JSON.stringify(marker)}
printf '%s\n' ${JSON.stringify(successOutput)}
`);
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_CODE_BIN = fakeClaude;
  try {
    const record = store.insertRecord(githubIssueRecord("agent-task-claude-privacy-denied"));
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code, unless privacy blocks it.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.claude_privacy_denied", title: "Claude privacy denied" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /privacy denied/i);
    assert.equal(result.diagnostics?.policy, "privacy.external_llm");
    assert.deepEqual(result.written_views, []);
    assert.equal(existsSync(marker), false);
    assert.equal(store.listViews({ view_types: ["analysis.claude_privacy_denied"] }).length, 0);
    assert.equal(store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 }).length, 0);
    const failed = store.listRuntimeEvents({ event_type: "capability.run.failed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    assert.ok(failed);
    assert.equal((failed.payload?.diagnostics as any)?.policy, "privacy.external_llm");
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("AgentTask claude_code missing binary fails cleanly without writing Views", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = "definitely-missing-claude-for-agent-task";
  try {
    const recordInput = githubIssueRecord("agent-task-claude-missing-bin");
    recordInput.privacy = { level: "private", retention: "normal", allow_external_llm: true };
    const record = store.insertRecord(recordInput);
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.claude_agent_task", title: "Claude Code task analysis" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Claude Code agent task failed/i);
    assert.deepEqual(result.written_views, []);
    assert.equal(store.listViews({ view_types: ["analysis.claude_agent_task"] }).length, 0);
    const submitted = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    const failed = store.listRuntimeEvents({ event_type: "agent_task.failed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    assert.ok(submitted);
    assert.ok(failed);
    assert.equal(submitted.payload?.runtime, "claude_code");
    assert.deepEqual(failed.related_records, [record.id]);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
  }
}));

test("AgentTask claude_code passes prompt as a positional argument after variadic tool options", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "info-agent-task-claude-args-"));
  const fakeClaude = join(dir, "claude");
  const argsFile = join(dir, "args.json");
  const successOutput = JSON.stringify({ result: JSON.stringify({ summary: "Valid Claude summary", analysis: "Structured analysis.", key_points: ["Prompt arrived"], confidence: 0.8 }) });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(successOutput)});
`);
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_CODE_BIN = fakeClaude;
  try {
    const recordInput = githubIssueRecord("agent-task-claude-args");
    recordInput.privacy = { level: "private", retention: "normal", allow_external_llm: true };
    const record = store.insertRecord(recordInput);
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code and preserve the prompt argument.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          constraints: { no_file_edits: true },
          output_contract: { view_type: "analysis.claude_args", title: "Claude args task" },
        },
      },
    });
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const view = store.getView(result.written_views?.[0] ?? "");

    assert.equal(result.ok, true);
    assert.ok(view);
    assert.equal(view.view_type, "analysis.claude_args");
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--tools=default"));
    assert.equal(args.some(arg => arg.startsWith("--allowedTools=")), false);
    assert.equal(args.some(arg => arg.startsWith("--disallowedTools=")), false);
    assert.equal(args.includes("--tools"), false);
    assert.match(args.at(-1) ?? "", /Analyze with local Claude Code and preserve the prompt argument/);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("AgentTask claude_code accepts JSON wrapped in a markdown code fence", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "info-agent-task-fenced-json-"));
  const fakeClaude = join(dir, "claude");
  const fencedOutput = JSON.stringify({
    result: [
      "```json",
      "{",
      '  "summary": "Fenced Claude summary",',
      '  "analysis": "Structured analysis from fenced JSON.",',
      '  "key_points": ["Fence stripped"],',
      '  "confidence": 0.7',
      "}",
      "```",
    ].join("\n"),
  });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(fencedOutput)});
`);
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_CODE_BIN = fakeClaude;
  try {
    const recordInput = githubIssueRecord("agent-task-claude-fenced-json");
    recordInput.privacy = { level: "private", retention: "normal", allow_external_llm: true };
    const record = store.insertRecord(recordInput);
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code and tolerate fenced JSON.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.claude_fenced_json", title: "Claude fenced JSON task" },
        },
      },
    });
    const view = store.getView(result.written_views?.[0] ?? "");

    assert.equal(result.ok, true);
    assert.ok(view);
    assert.equal(view.summary, "Fenced Claude summary");
    assert.deepEqual(view.content?.key_points, ["Fence stripped"]);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("AgentTask can ingest evidence Views returned by an agent-owned skill", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "info-agent-task-evidence-views-"));
  const fakeClaude = join(dir, "claude");
  const agentOutput = JSON.stringify({
    result: JSON.stringify({
      summary: "Claude analyzed the page after using its own reader tool.",
      analysis: "The agent-owned reader evidence is returned as a View for Info to persist.",
      key_points: ["Agent owns tools", "Info owns Views"],
      confidence: 0.83,
      views: [{
        view_type: "extraction.reader_snapshot",
        title: "Agent reader snapshot",
        summary: "Readable article evidence returned by the agent.",
        content: {
          url: "https://example.com/agent-reader",
          text: "Readable article evidence returned by the agent-owned reader skill.",
          provider: "agent_skill",
        },
        confidence: 0.78,
      }],
    }),
  });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(agentOutput)});
`);
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_CODE_BIN = fakeClaude;
  try {
    const recordInput = githubIssueRecord("agent-task-evidence-views");
    recordInput.privacy = { level: "private", retention: "normal", allow_external_llm: true };
    const record = store.insertRecord(recordInput);
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code and return evidence Views from agent-owned tools.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.agent_owned_reader", title: "Agent-owned reader analysis" },
        },
      },
    });
    const evidence = store.getView(result.written_views?.[0] ?? "");
    const analysis = store.getView(result.written_views?.[1] ?? "");

    assert.equal(result.ok, true);
    assert.equal(result.written_views?.length, 2);
    assert.ok(evidence);
    assert.ok(analysis);
    assert.equal(evidence.view_type, "extraction.reader_snapshot");
    assert.equal(evidence.content?.provider, "agent_skill");
    assert.deepEqual(evidence.source_records, [record.id]);
    assert.equal(evidence.metadata?.agent_returned_view, true);
    assert.equal(analysis.view_type, "analysis.agent_owned_reader");
    assert.ok(analysis.source_views?.includes(evidence.id));
    assert.equal(result.diagnostics?.evidence_view_count, 1);

    const completedTask = store.listRuntimeEvents({ event_type: "agent_task.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    assert.deepEqual(completedTask.payload?.output_view_ids, [evidence.id, analysis.id]);
    assert.equal(completedTask.payload?.evidence_view_count, 1);
    assert.deepEqual(completedTask.related_views, [evidence.id, analysis.id]);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("AgentTask claude_code rejects action-shaped agent output without writing Views", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "info-agent-task-action-output-"));
  const fakeClaude = join(dir, "claude");
  const actionOutput = JSON.stringify({ result: JSON.stringify({ summary: "Valid summary", next_actions: ["Open a PR"] }) });
  writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\n' ${JSON.stringify(actionOutput)}
`);
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_CODE_BIN = fakeClaude;
  try {
    const recordInput = githubIssueRecord("agent-task-claude-action-output");
    recordInput.privacy = { level: "private", retention: "normal", allow_external_llm: true };
    const record = store.insertRecord(recordInput);
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze only; do not return actions.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.claude_action_output", title: "Claude action output" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /unsupported agent output field: next_actions/);
    assert.deepEqual(result.written_views, []);
    assert.equal(store.listViews({ view_types: ["analysis.claude_action_output"] }).length, 0);
    const completed = store.listRuntimeEvents({ event_type: "agent_task.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    const failed = store.listRuntimeEvents({ event_type: "agent_task.failed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    assert.equal(completed, undefined);
    assert.ok(failed);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("AgentTask claude_code rejects incomplete agent output without writing Views", async () => withStore(async (store) => {
  const oldBin = process.env.CLAUDE_CODE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "info-agent-task-invalid-output-"));
  const fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"{}\"}'\n");
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_CODE_BIN = fakeClaude;
  try {
    const recordInput = githubIssueRecord("agent-task-claude-invalid-output");
    recordInput.privacy = { level: "private", retention: "normal", allow_external_llm: true };
    const record = store.insertRecord(recordInput);
    const runtime = new ProgramRuntime(store).registerCapability(agentTaskSubmitCapability);

    const result = await runtime.runCapability("capability.agent_task.submit", {
      autonomy: "suggest",
      signal: {
        object_id: record.id,
        object_kind: "observation",
        object_type: record.schema.name,
        source: record.source.type,
        title: record.content?.title,
        text_preview: record.content?.text,
        url: record.content?.url,
      },
      payload: {
        task: {
          runtime: "claude_code",
          goal: "Analyze with local Claude Code.",
          context_pack: { markdown: "# Context Broker Pack\nObservation text" },
          output_contract: { view_type: "analysis.claude_invalid_output", title: "Claude invalid output" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /missing non-empty summary/);
    assert.deepEqual(result.written_views, []);
    assert.equal(store.listViews({ view_types: ["analysis.claude_invalid_output"] }).length, 0);
    const submitted = store.listRuntimeEvents({ event_type: "agent_task.submitted", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    const completed = store.listRuntimeEvents({ event_type: "agent_task.completed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    const failed = store.listRuntimeEvents({ event_type: "agent_task.failed", plugin_id: "capability.agent_task.submit", limit: 1 })[0];
    assert.ok(submitted);
    assert.equal(completed, undefined);
    assert.ok(failed);
    assert.deepEqual(failed.related_records, [record.id]);
  } finally {
    if (oldBin === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("ProgramRuntime writes started and completed provenance for Program runs", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-run-events-record"));
  const program: Program = {
    id: "program.run_events",
    title: "Run Events",
    purpose: "Verify program run provenance",
    default_speed: "think",
    default_autonomy: "suggest",
    attention: () => ({ action: "run", reason: "test run provenance", confidence: 1 }),
    run: ({ signal }) => ({
      ok: true,
      reason: "program ran",
      views: [{
        id: "analysis:test:program-run-events",
        view_type: "analysis.test",
        title: "Program run event output",
        source_records: [signal.object_id],
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.run_events" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.run_events", limit: 1 })[0];
  const completed = store.listRuntimeEvents({ event_type: "program.run.completed", plugin_id: "program.run_events", limit: 1 })[0];

  assert.equal(result.runs[0].ok, true);
  assert.ok(started);
  assert.ok(completed);
  assert.deepEqual(started.related_records, [record.id]);
  assert.deepEqual(started.related_views, []);
  assert.equal(started.payload?.speed, "think");
  assert.equal(started.payload?.autonomy, "suggest");
  assert.deepEqual(completed.related_records, [record.id]);
  assert.deepEqual(completed.related_views, ["analysis:test:program-run-events"]);
}));

test("ProgramRuntime uses policy.autonomy_profile View when Program autonomy is not explicit", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-policy-record"));
  store.upsertView({
    id: "policy:autonomy:program-default",
    view_type: "policy.autonomy_profile",
    title: "Program default autonomy policy",
    content: { default_autonomy: "sandbox_auto" },
    confidence: 0.9,
    stability: "long_term",
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.policy_autonomy",
    title: "Policy Autonomy",
    purpose: "Verify Program autonomy policy",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test policy", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.policy_autonomy" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.policy_autonomy", limit: 1 })[0];

  assert.equal(result.runs[0].reason, "autonomy:sandbox_auto");
  assert.equal(started.payload?.autonomy, "sandbox_auto");
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:program-default");
}));

test("ProgramRuntime autonomy policy is not starved by newer invalid policy Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-policy-starvation-record"));
  store.upsertView({
    id: "policy:autonomy:program-starvation-valid",
    view_type: "policy.autonomy_profile",
    title: "Older valid Program autonomy policy",
    content: { default_autonomy: "sandbox_auto" },
    confidence: 0.9,
    stability: "long_term",
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 20; index++) {
    store.upsertView({
      id: `policy:autonomy:program-starvation-invalid-${index}`,
      view_type: "policy.autonomy_profile",
      title: `Newer invalid Program autonomy policy ${index}`,
      content: { note: "missing default_autonomy" },
      confidence: 0.9,
      privacy: { level: "private", retention: "normal" },
    });
  }
  const program: Program = {
    id: "program.policy_starvation",
    title: "Policy Starvation",
    purpose: "Verify Program autonomy policy candidate window",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test policy starvation", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.policy_starvation" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.policy_starvation", limit: 1 })[0];

  assert.equal(result.runs[0].reason, "autonomy:sandbox_auto");
  assert.equal(started.payload?.autonomy, "sandbox_auto");
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:program-starvation-valid");
}));


test("ProgramRuntime ignores autonomy policy Views with invalid provenance", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-dirty-policy-record"));
  store.insertRecord({
    id: "record:program-dirty-policy-source",
    schema: { name: "observation.browser_ambient_requested", version: 1 },
    source: { type: "browser", connector: "chrome-extension" },
    scope: { domain: "other.example" },
    content: { title: "DIRTY AUTONOMY POLICY SOURCE SHOULD NOT LEAK" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "policy:autonomy:program-dirty-provenance",
    view_type: "policy.autonomy_profile",
    title: "Dirty autonomy policy",
    source_records: ["record:program-dirty-policy-source"],
    scope: { domain: "github.com" },
    content: { program_ids: ["program.dirty_policy"], default_autonomy: "full_auto" },
    confidence: 0.99,
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.dirty_policy",
    title: "Dirty Policy",
    purpose: "Dirty policy must not raise autonomy",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test dirty policy", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.dirty_policy" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.dirty_policy", limit: 1 })[0];

  assert.equal(result.runs[0].reason, "autonomy:manual");
  assert.equal(started.payload?.autonomy, "manual");
  assert.equal(started.payload?.autonomy_policy_view_id, undefined);
}));

test("ProgramRuntime explicit autonomy overrides policy.autonomy_profile View", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-explicit-autonomy-record"));
  store.upsertView({
    id: "policy:autonomy:program-explicit-override",
    view_type: "policy.autonomy_profile",
    title: "Program policy that should be overridden",
    content: { default_autonomy: "full_auto" },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.explicit_autonomy",
    title: "Explicit Autonomy",
    purpose: "Verify explicit autonomy wins",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test explicit autonomy", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.explicit_autonomy", autonomy: "suggest" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.explicit_autonomy", limit: 1 })[0];

  assert.equal(result.runs[0].reason, "autonomy:suggest");
  assert.equal(started.payload?.autonomy, "suggest");
  assert.equal(started.payload?.autonomy_policy_view_id, undefined);
}));

test("ProgramRuntime prefers Program-scoped autonomy policy over global policy", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-scoped-policy-record"));
  store.upsertView({
    id: "policy:autonomy:program-scoped",
    view_type: "policy.autonomy_profile",
    title: "Program scoped autonomy policy",
    content: { program_ids: ["program.scoped_policy"], default_autonomy: "draft" },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "policy:autonomy:global",
    view_type: "policy.autonomy_profile",
    title: "Global autonomy policy",
    content: { default_autonomy: "manual" },
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.scoped_policy",
    title: "Scoped Policy",
    purpose: "Verify scoped policy priority",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test scoped policy", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.scoped_policy" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.scoped_policy", limit: 1 })[0];

  assert.equal(result.runs[0].reason, "autonomy:draft");
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:program-scoped");
}));

test("ProgramRuntime ignores inactive autonomy policy Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-inactive-policy-record"));
  store.upsertView({
    id: "policy:autonomy:program-archived",
    view_type: "policy.autonomy_profile",
    title: "Archived autonomy policy",
    status: "archived",
    content: { program_ids: ["program.inactive_policy"], default_autonomy: "full_auto" },
    confidence: 0.99,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "policy:autonomy:program-expired",
    view_type: "policy.autonomy_profile",
    title: "Expired autonomy policy",
    content: { program_ids: ["program.inactive_policy"], default_autonomy: "sandbox_auto" },
    confidence: 0.99,
    validity: { valid_until: "2026-01-01T00:00:00.000Z" },
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.inactive_policy",
    title: "Inactive Policy",
    purpose: "Verify inactive policies are ignored",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test inactive policy", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.inactive_policy" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.inactive_policy", limit: 1 })[0];

  assert.equal(result.runs[0].reason, "autonomy:manual");
  assert.equal(started.payload?.autonomy_policy_view_id, undefined);
}));

test("ProgramRuntime ignores low-confidence autonomy policy Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-low-confidence-policy-record"));
  store.upsertView({
    id: "policy:autonomy:program-low-confidence",
    view_type: "policy.autonomy_profile",
    title: "Low-confidence autonomy policy",
    content: { program_ids: ["program.low_confidence_policy"], default_autonomy: "full_auto" },
    confidence: 0.49,
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.low_confidence_policy",
    title: "Low Confidence Policy",
    purpose: "Verify low confidence policies are ignored",
    default_autonomy: "manual",
    attention: () => ({ action: "run", reason: "test low confidence policy", confidence: 1 }),
    run: ({ autonomy }) => ({ ok: true, reason: `autonomy:${autonomy}` }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.low_confidence_policy" });

  assert.equal(result.runs[0].reason, "autonomy:manual");
}));

test("ProgramRuntime writes provenance for attached Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-attach-record"));
  const program: Program = {
    id: "program.attach_view",
    title: "Attach View",
    purpose: "Verify attach provenance",
    default_speed: "glance",
    attention: ({ object_id }) => ({
      action: "attach",
      reason: "attach derived view",
      confidence: 1,
      view: {
        id: "analysis:test:attached-view",
        view_type: "analysis.test",
        title: "Attached view",
        source_records: [object_id],
      },
    }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.attach_view" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.attach_view", limit: 1 })[0];
  const completed = store.listRuntimeEvents({ event_type: "program.run.completed", plugin_id: "program.attach_view", limit: 1 })[0];

  assert.equal(result.runs[0].ok, true);
  assert.ok(store.getView("analysis:test:attached-view"));
  assert.ok(started);
  assert.ok(completed);
  assert.equal(started.payload?.action, "attach");
  assert.deepEqual(started.related_records, [record.id]);
  assert.deepEqual(completed.related_records, [record.id]);
  assert.deepEqual(completed.related_views, ["analysis:test:attached-view"]);
}));

test("ProgramRuntime rejects Program Views with record-like view types", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-invalid-view-type-record"));
  const program: Program = {
    id: "program.invalid_view_type",
    title: "Invalid View Type",
    purpose: "Verify runtime View type boundary",
    attention: () => ({ action: "run", reason: "write invalid view", confidence: 1 }),
    run: () => ({
      ok: true,
      views: [{
        id: "derived:program-invalid-view-type",
        view_type: "derived.project_memory",
        title: "Invalid derived View",
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.invalid_view_type" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /View type must not use record-like prefix/);
  assert.equal(store.getView("derived:program-invalid-view-type"), undefined);
}));

test("ProgramRuntime rejects Program Records with non-raw schemas", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-invalid-record-schema-source"));
  const program: Program = {
    id: "program.invalid_record_schema",
    title: "Invalid Record Schema",
    purpose: "Verify runtime Record schema boundary",
    attention: () => ({ action: "run", reason: "write invalid record", confidence: 1 }),
    run: () => ({
      ok: true,
      records: [{
        id: "record:program-derived-should-not-exist",
        schema: { name: "derived.project_memory", version: 1 },
        source: { type: "plugin", connector: "test" },
        content: { text: "DERIVED PROGRAM RECORD SHOULD NOT PERSIST" },
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.invalid_record_schema" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /Record schema must be raw observation\/feedback/);
  assert.equal(store.getRecord("record:program-derived-should-not-exist"), undefined);
}));

test("ProgramRuntime rejects Program Views with missing or legacy source_records", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-invalid-view-provenance-source"));
  store.insertRecord({
    id: "record:program-legacy-view-source",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { text: "LEGACY PROGRAM VIEW SOURCE SHOULD NOT BE REFERENCED" },
  });
  const program: Program = {
    id: "program.invalid_view_provenance",
    title: "Invalid View Provenance",
    purpose: "Verify runtime View provenance boundary",
    attention: () => ({ action: "run", reason: "write invalid provenance views", confidence: 1 }),
    run: () => ({
      ok: true,
      views: [
        {
          id: "analysis:test:missing-source-record",
          view_type: "analysis.test",
          title: "Missing source record",
          source_records: ["record:program-missing-view-source"],
        },
        {
          id: "analysis:test:legacy-source-record",
          view_type: "analysis.test",
          title: "Legacy source record",
          source_records: ["record:program-legacy-view-source"],
        },
      ],
    }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.invalid_view_provenance" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /View source_record must reference an existing raw observation\/feedback Record/);
  assert.equal(store.getView("analysis:test:missing-source-record"), undefined);
  assert.equal(store.getView("analysis:test:legacy-source-record"), undefined);
}));

test("ProgramRuntime rejects Program Views whose scope conflicts with source_records", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubIssueRecord("program-conflicting-view-scope-record"),
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
  });
  const program: Program = {
    id: "program.conflicting_view_scope",
    title: "Conflicting View Scope",
    purpose: "Verify runtime View scope cannot contradict provenance",
    attention: () => ({ action: "run", reason: "write conflicting scope", confidence: 1 }),
    run: () => ({
      ok: true,
      views: [{
        id: "analysis:test:program-conflicting-scope",
        view_type: "analysis.test",
        title: "Conflicting scope",
        source_records: [record.id],
        scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.conflicting_view_scope" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /View scope conflicts with provenance/);
  assert.equal(store.getView("analysis:test:program-conflicting-scope"), undefined);
}));

test("ProgramRuntime rejects Program Events with missing or legacy related_records", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-invalid-event-source"));
  store.insertRecord({
    id: "record:program-event-legacy-related",
    schema: { name: "derived.project_memory", version: 1 },
    source: { type: "plugin", connector: "legacy" },
    content: { text: "LEGACY EVENT RELATED RECORD SHOULD NOT BE REFERENCED" },
  });
  const program: Program = {
    id: "program.invalid_event_provenance",
    title: "Invalid Event Provenance",
    purpose: "Verify runtime Event provenance boundary",
    attention: () => ({ action: "run", reason: "write invalid events", confidence: 1 }),
    run: () => ({
      ok: true,
      events: [
        {
          event_type: "test.invalid_missing_event_ref",
          actor: "system",
          status: "completed",
          related_records: ["record:program-event-missing-related"],
        },
        {
          event_type: "test.invalid_legacy_event_ref",
          actor: "system",
          status: "completed",
          related_records: ["record:program-event-legacy-related"],
        },
      ],
    }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.invalid_event_provenance" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /Event related_record must reference an existing raw observation\/feedback Record/);
  assert.equal(store.listRuntimeEvents({ event_type: "test.invalid_missing_event_ref", limit: 1 }).length, 0);
  assert.equal(store.listRuntimeEvents({ event_type: "test.invalid_legacy_event_ref", limit: 1 }).length, 0);
}));

test("ProgramRuntime rejects attached Views with malformed view types", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-invalid-attached-view-type-record"));
  const program: Program = {
    id: "program.invalid_attached_view_type",
    title: "Invalid Attached View Type",
    purpose: "Verify runtime attach View type boundary",
    attention: () => ({
      action: "attach",
      reason: "attach invalid view",
      confidence: 1,
      view: {
        id: "analysis:test:invalid-attached-view",
        view_type: "analysis/bad",
        title: "Invalid attached view",
      },
    }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.invalid_attached_view_type" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /invalid View type/);
  assert.equal(store.getView("analysis:test:invalid-attached-view"), undefined);
}));

test("ProgramRuntime uses policy.autonomy_profile View for attached Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-attach-policy-record"));
  store.upsertView({
    id: "policy:autonomy:attach-default",
    view_type: "policy.autonomy_profile",
    title: "Attach default autonomy policy",
    content: { default_autonomy: "draft" },
    confidence: 0.9,
    stability: "long_term",
    privacy: { level: "private", retention: "normal" },
  });
  const program: Program = {
    id: "program.attach_policy",
    title: "Attach Policy",
    purpose: "Verify attach autonomy policy",
    default_autonomy: "manual",
    attention: ({ object_id }) => ({
      action: "attach",
      reason: "attach policy view",
      confidence: 1,
      view: {
        id: "analysis:test:attached-policy-view",
        view_type: "analysis.test",
        title: "Attached policy view",
        source_records: [object_id],
      },
    }),
    run: () => ({ ok: true }),
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.attach_policy" });
  const started = store.listRuntimeEvents({ event_type: "program.run.started", plugin_id: "program.attach_policy", limit: 1 })[0];

  assert.equal(result.runs[0].ok, true);
  assert.equal(started.payload?.autonomy, "draft");
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:attach-default");
}));

test("runCapability rejects Capability Views with record-like view types", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("capability-invalid-view-type-record"));
  const capability: Capability = {
    id: "capability.invalid_view_type",
    title: "Invalid View Type Capability",
    purpose: "Verify capability View type boundary",
    mode: "deterministic",
    run: () => ({
      ok: true,
      views: [{
        id: "observation:capability-invalid-view-type",
        view_type: "observation.browser_page_snapshot",
        title: "Invalid observation View",
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.invalid_view_type", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /View type must not use record-like prefix/);
  assert.equal(store.getView("observation:capability-invalid-view-type"), undefined);
}));

test("runCapability rejects Capability Records with non-raw schemas", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("capability-invalid-record-schema-source"));
  const capability: Capability = {
    id: "capability.invalid_record_schema",
    title: "Invalid Record Schema Capability",
    purpose: "Verify capability Record schema boundary",
    mode: "deterministic",
    run: () => ({
      ok: true,
      records: [{
        id: "record:capability-derived-should-not-exist",
        schema: { name: "episode.project_work", version: 1 },
        source: { type: "plugin", connector: "test" },
        content: { text: "EPISODE CAPABILITY RECORD SHOULD NOT PERSIST" },
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.invalid_record_schema", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /Record schema must be raw observation\/feedback/);
  assert.equal(store.getRecord("record:capability-derived-should-not-exist"), undefined);
}));

test("runCapability rejects Capability Views with missing source_views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("capability-invalid-view-source-source"));
  const capability: Capability = {
    id: "capability.invalid_view_source",
    title: "Invalid View Source Capability",
    purpose: "Verify capability View source boundary",
    mode: "deterministic",
    run: () => ({
      ok: true,
      views: [{
        id: "analysis:test:missing-source-view",
        view_type: "analysis.test",
        title: "Missing source view",
        source_views: ["analysis:test:does-not-exist"],
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.invalid_view_source", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /View source_view must reference an existing View/);
  assert.equal(store.getView("analysis:test:missing-source-view"), undefined);
}));

test("runCapability rejects Capability Views whose scope conflicts with source_views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("capability-conflicting-view-scope-record"));
  const sourceView = store.upsertView({
    id: "analysis:test:capability-scope-source",
    view_type: "analysis.test",
    title: "Scope source",
    source_records: [record.id],
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
  });
  const capability: Capability = {
    id: "capability.conflicting_view_scope",
    title: "Conflicting View Scope Capability",
    purpose: "Verify capability View scope cannot contradict provenance",
    mode: "deterministic",
    run: () => ({
      ok: true,
      views: [{
        id: "analysis:test:capability-conflicting-scope",
        view_type: "analysis.test",
        title: "Conflicting capability scope",
        source_views: [sourceView.id],
        scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.conflicting_view_scope", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
      domain: record.scope?.domain,
      repo: record.scope?.repo,
      project_path: record.scope?.project_path,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /View scope conflicts with provenance/);
  assert.equal(store.getView("analysis:test:capability-conflicting-scope"), undefined);
}));

test("runCapability rejects Capability Events with missing related_views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("capability-invalid-event-source"));
  const capability: Capability = {
    id: "capability.invalid_event_provenance",
    title: "Invalid Event Provenance Capability",
    purpose: "Verify capability Event provenance boundary",
    mode: "deterministic",
    run: () => ({
      ok: true,
      events: [{
        event_type: "test.invalid_capability_event_ref",
        actor: "system",
        status: "completed",
        related_views: ["analysis:test:missing-event-view"],
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.invalid_event_provenance", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /Event related_view must reference an existing View/);
  assert.equal(store.listRuntimeEvents({ event_type: "test.invalid_capability_event_ref", limit: 1 }).length, 0);
}));

test("ProgramRuntime records failed provenance when a Program throws", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-throws-record"));
  const program: Program = {
    id: "program.throws",
    title: "Throws",
    purpose: "Verify program exception provenance",
    attention: () => ({ action: "run", reason: "test exception", confidence: 1 }),
    run: () => {
      throw new Error("program boom");
    },
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.throws" });
  const failed = store.listRuntimeEvents({ event_type: "program.run.failed", plugin_id: "program.throws", limit: 1 })[0];

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /program boom/);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.match(String(failed.payload?.error), /program boom/);
  assert.deepEqual(failed.related_records, [record.id]);
}));

test("Program run input can request a brokered Context Pack", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("program-context-pack-record"));
  store.upsertView({
    id: "analysis:test:program-context-pack",
    view_type: "analysis.test",
    title: "Program context input",
    source_records: [record.id],
    content: { analysis: "Reusable context assembled through the broker." },
    scope: { domain: "github.com" },
    privacy: { level: "private", retention: "normal" },
  });

  const program: Program = {
    id: "program.uses_context_pack",
    title: "Uses Context Pack",
    purpose: "Verify programs ask the broker for context instead of ad-hoc querying",
    attention: () => ({ action: "run", reason: "test", confidence: 1 }),
    run: ({ signal, buildContextPack }) => {
      const pack = buildContextPack({
        goal: "Use analysis view while handling this signal",
        view_types: ["analysis.test"],
        include_views: true,
        include_records: true,
        limit: 4,
      });
      return {
        ok: true,
        views: [{
          id: "analysis:test:program-context-pack-output",
          view_type: "analysis.test.output",
          title: "Program context pack output",
          source_records: [signal.object_id],
          source_views: pack.views.map(view => view.id),
          content: {
            packed_view_ids: pack.views.map(view => view.id),
            packed_record_ids: pack.records.map(item => item.id),
          },
        }],
      };
    },
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.uses_context_pack" });
  const output = store.getView("analysis:test:program-context-pack-output");

  assert.equal(result.runs[0].ok, true);
  assert.ok(output);
  assert.deepEqual(output.content?.packed_view_ids, ["analysis:test:program-context-pack"]);
  assert.deepEqual(output.content?.packed_record_ids, [record.id]);
  assert.ok(store.listRuntimeEvents({ event_type: "context_query_completed", plugin_id: "program.uses_context_pack", limit: 1 })[0]);
}));

test("Program Context Pack defaults to the signal repo scope", async () => withStore(async (store) => {
  const record = store.insertRecord(githubIssueRecord("program-context-pack-repo-record"));
  const unrelatedRecord = store.insertRecord({
    ...githubIssueRecord("program-context-pack-other-repo-record"),
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    content: {
      title: "Issue #9: unrelated repo",
      url: "https://github.com/other/repo/issues/9",
      text: "This other repository context should not be packed by default.",
    },
  });
  store.upsertView({
    id: "analysis:test:program-context-pack-same-repo",
    view_type: "analysis.test",
    title: "Same repo context",
    source_records: [record.id],
    content: { analysis: "Same repository context." },
    scope: { domain: "github.com", repo: "example/repo", project_path: "/Users/junjie/info" },
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "analysis:test:program-context-pack-other-repo",
    view_type: "analysis.test",
    title: "Other repo context",
    source_records: [unrelatedRecord.id],
    content: { analysis: "Other repository context must not leak into this pack." },
    scope: { domain: "github.com", repo: "other/repo", project_path: "/Users/junjie/info" },
    privacy: { level: "private", retention: "normal" },
  });

  const program: Program = {
    id: "program.repo_scoped_context_pack",
    title: "Repo Scoped Context Pack",
    purpose: "Verify default Program context is scoped to the signal repository",
    attention: () => ({ action: "run", reason: "test", confidence: 1 }),
    run: ({ buildContextPack }) => {
      const pack = buildContextPack({
        goal: "Use same-repo analysis only",
        view_types: ["analysis.test"],
        include_views: true,
        include_records: true,
        limit: 8,
      });
      return {
        ok: true,
        diagnostics: {
          packed_view_ids: pack.views.map(view => view.id),
          packed_record_ids: pack.records.map(item => item.id),
          effective_scope: pack.diagnostics.effective_query?.scope,
        },
      };
    },
  };

  const runtime = new ProgramRuntime(store).registerProgram(program);
  const result = await runtime.processObject(record, { program_id: "program.repo_scoped_context_pack" });
  const diagnostics = result.runs[0].diagnostics as Record<string, unknown>;

  assert.deepEqual(diagnostics.packed_view_ids, ["analysis:test:program-context-pack-same-repo"]);
  assert.deepEqual(diagnostics.packed_record_ids, [record.id]);
  assert.deepEqual(diagnostics.effective_scope, { domain: "github.com", project_path: "/Users/junjie/info", repo: "example/repo" });
}));

test("runCapability writes provenance events and generated Views", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord());
  const capability: Capability = {
    id: "capability.test.analysis",
    title: "Test Analysis",
    purpose: "Produce a reusable test analysis View",
    mode: "deterministic",
    produces: ["analysis.test"],
    run: ({ signal }) => ({
      ok: true,
      reason: "capability completed",
      views: [{
        id: "analysis:test:capability",
        view_type: "analysis.test",
        title: "Capability analysis",
        source_records: [signal.object_id],
        compiler: { id: "capability.test.analysis", version: "0.1.0", mode: "deterministic" },
        content: { analysis: "capability output" },
      }],
    }),
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.analysis", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
      domain: record.scope?.domain,
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.written_views, ["analysis:test:capability"]);
  assert.ok(store.getView("analysis:test:capability"));

  const events = store.listRuntimeEvents({ event_types: ["capability.run.started", "capability.run.completed"], plugin_id: "capability.test.analysis", limit: 10 });
  assert.deepEqual(events.map(event => event.event_type).sort(), ["capability.run.completed", "capability.run.started"]);
  const completed = events.find(event => event.event_type === "capability.run.completed");
  assert.deepEqual(completed?.related_records, [record.id]);
  assert.deepEqual(completed?.related_views, ["analysis:test:capability"]);
}));

test("runCapability records failed provenance when a Capability throws", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("capability-throws-record"));
  const capability: Capability = {
    id: "capability.test.throws",
    title: "Capability Throws",
    purpose: "Verify capability exception provenance",
    mode: "deterministic",
    run: () => {
      throw new Error("capability boom");
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.throws", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });
  const failed = store.listRuntimeEvents({ event_type: "capability.run.failed", plugin_id: "capability.test.throws", limit: 1 })[0];

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /capability boom/);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.match(String(failed.payload?.error), /capability boom/);
  assert.deepEqual(failed.related_records, [record.id]);
}));

test("runCapability records failed provenance when a Capability is missing", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("missing-capability-record"));
  const runtime = new ProgramRuntime(store);
  const result = await runtime.runCapability("capability.test.missing", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });
  const failed = store.listRuntimeEvents({ event_type: "capability.run.failed", plugin_id: "capability.test.missing", limit: 1 })[0];

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not found/);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.match(String(failed.payload?.reason), /not found/);
  assert.deepEqual(failed.related_records, [record.id]);
}));

test("runCapability denies capabilities above the requested autonomy level", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord());
  let called = false;
  const capability: Capability = {
    id: "capability.test.external_action",
    title: "External Action",
    purpose: "Should require explicit external autonomy",
    mode: "external",
    default_autonomy: "full_auto",
    run: () => {
      called = true;
      return { ok: true, records: [{ schema: { name: "observation.should_not_exist", version: 1 }, source: { type: "test" } }] };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.external_action", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /denied/i);
  assert.equal(called, false);
  assert.deepEqual(result.written_records, []);
  assert.deepEqual(result.diagnostics, {
    policy_denied: true,
    policy: "autonomy",
    requested_autonomy: "suggest",
    required_autonomy: "full_auto",
  });

  const denied = store.listRuntimeEvents({ event_type: "policy.denied_action", plugin_id: "capability.test.external_action", limit: 1 })[0];
  assert.ok(denied);
  assert.equal(denied.status, "denied");
  assert.equal(denied.payload?.requested_autonomy, "suggest");
  assert.equal(denied.payload?.required_autonomy, "full_auto");
}));

test("runCapability dry_run does not execute external capabilities", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("external-dry-run-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  let called = false;
  const capability: Capability = {
    id: "capability.test.external_dry_run",
    title: "External Dry Run",
    purpose: "Should not execute side effects during dry run",
    mode: "external",
    default_autonomy: "full_auto",
    run: () => {
      called = true;
      return { ok: true, records: [{ schema: { name: "observation.external_side_effect", version: 1 }, source: { type: "test" } }] };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.external_dry_run", {
    autonomy: "full_auto",
    dry_run: true,
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(called, false);
  assert.deepEqual(result.written_records, []);
  assert.ok(store.listRuntimeEvents({ event_type: "capability.run.skipped", plugin_id: "capability.test.external_dry_run", limit: 1 })[0]);
}));

test("runCapability uses policy.autonomy_profile View when autonomy is not explicit", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("policy-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  store.upsertView({
    id: "policy:autonomy:default",
    view_type: "policy.autonomy_profile",
    title: "Default autonomy policy",
    content: { default_autonomy: "sandbox_auto" },
    confidence: 0.9,
    stability: "long_term",
    privacy: { level: "private", retention: "normal" },
  });

  let called = false;
  const capability: Capability = {
    id: "capability.test.sandbox",
    title: "Sandbox Action",
    purpose: "Should be allowed by policy View",
    mode: "external",
    default_autonomy: "sandbox_auto",
    run: () => {
      called = true;
      return { ok: true, reason: "allowed by policy view" };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.sandbox", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(called, true);
  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.test.sandbox", limit: 1 })[0];
  assert.equal(started.payload?.autonomy, "sandbox_auto");
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:default");
}));

test("runCapability explicit autonomy overrides policy.autonomy_profile View", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("capability-explicit-autonomy-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  store.upsertView({
    id: "policy:autonomy:capability-explicit-override",
    view_type: "policy.autonomy_profile",
    title: "Capability policy that should be overridden",
    content: { default_autonomy: "full_auto" },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  let called = false;
  const capability: Capability = {
    id: "capability.test.explicit_autonomy",
    title: "Explicit Capability Autonomy",
    purpose: "Verify explicit autonomy wins",
    mode: "external",
    default_autonomy: "suggest",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.explicit_autonomy", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });
  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.test.explicit_autonomy", limit: 1 })[0];

  assert.equal(result.ok, true);
  assert.equal(called, true);
  assert.equal(started.payload?.autonomy, "suggest");
  assert.equal(started.payload?.autonomy_policy_view_id, undefined);
}));

test("runCapability prefers Capability-scoped autonomy policy over global policy", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("capability-scoped-policy-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  store.upsertView({
    id: "policy:autonomy:capability-scoped",
    view_type: "policy.autonomy_profile",
    title: "Capability scoped autonomy policy",
    content: { capability_ids: ["capability.test.scoped_policy"], default_autonomy: "sandbox_auto" },
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  store.upsertView({
    id: "policy:autonomy:capability-global",
    view_type: "policy.autonomy_profile",
    title: "Capability global autonomy policy",
    content: { default_autonomy: "manual" },
    privacy: { level: "private", retention: "normal" },
  });
  let called = false;
  const capability: Capability = {
    id: "capability.test.scoped_policy",
    title: "Scoped Capability Policy",
    purpose: "Verify scoped policy priority",
    mode: "external",
    default_autonomy: "sandbox_auto",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.scoped_policy", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });
  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.test.scoped_policy", limit: 1 })[0];

  assert.equal(result.ok, true);
  assert.equal(called, true);
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:capability-scoped");
}));

test("runCapability autonomy policy is not starved by newer invalid policy Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("capability-policy-starvation-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  store.upsertView({
    id: "policy:autonomy:capability-starvation-valid",
    view_type: "policy.autonomy_profile",
    title: "Capability valid autonomy policy",
    content: { capability_ids: ["capability.test.policy_starvation"], default_autonomy: "sandbox_auto" },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 30; index++) {
    store.upsertView({
      id: `policy:autonomy:capability-starvation-invalid-${index}`,
      view_type: "policy.autonomy_profile",
      title: `Capability invalid autonomy policy ${index}`,
      content: { capability_ids: ["capability.test.policy_starvation"], default_autonomy: "not-an-autonomy-profile" },
      confidence: 0.99,
      privacy: { level: "private", retention: "normal" },
    });
  }
  let called = false;
  const capability: Capability = {
    id: "capability.test.policy_starvation",
    title: "Capability Policy Starvation",
    purpose: "Verify older valid policy is still found",
    mode: "external",
    default_autonomy: "sandbox_auto",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.policy_starvation", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });
  const started = store.listRuntimeEvents({ event_type: "capability.run.started", plugin_id: "capability.test.policy_starvation", limit: 1 })[0];

  assert.equal(result.ok, true);
  assert.equal(called, true);
  assert.equal(started.payload?.autonomy_policy_view_id, "policy:autonomy:capability-starvation-valid");
}));

test("runCapability ignores inactive autonomy policy Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("capability-inactive-policy-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  store.upsertView({
    id: "policy:autonomy:capability-archived",
    view_type: "policy.autonomy_profile",
    title: "Capability archived autonomy policy",
    status: "archived",
    content: { capability_ids: ["capability.test.inactive_policy"], default_autonomy: "full_auto" },
    confidence: 0.99,
    privacy: { level: "private", retention: "normal" },
  });
  store.upsertView({
    id: "policy:autonomy:capability-expired",
    view_type: "policy.autonomy_profile",
    title: "Capability expired autonomy policy",
    content: { capability_ids: ["capability.test.inactive_policy"], default_autonomy: "sandbox_auto" },
    confidence: 0.99,
    validity: { valid_until: "2026-01-01T00:00:00.000Z" },
    privacy: { level: "private", retention: "normal" },
  });
  let called = false;
  const capability: Capability = {
    id: "capability.test.inactive_policy",
    title: "Inactive Capability Policy",
    purpose: "Verify inactive policies are ignored",
    mode: "external",
    default_autonomy: "sandbox_auto",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.inactive_policy", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(called, false);
  assert.match(result.reason ?? "", /requires sandbox_auto/);
}));

test("runCapability ignores low-confidence autonomy policy Views", async () => withStore(async (store) => {
  const record = store.insertRecord({
    ...githubRecord("capability-low-confidence-policy-record"),
    privacy: { level: "private", retention: "normal", allow_external_reader: true },
  });
  store.upsertView({
    id: "policy:autonomy:capability-low-confidence",
    view_type: "policy.autonomy_profile",
    title: "Capability low-confidence autonomy policy",
    content: { capability_ids: ["capability.test.low_confidence_policy"], default_autonomy: "sandbox_auto" },
    confidence: 0.49,
    privacy: { level: "private", retention: "normal" },
  });
  let called = false;
  const capability: Capability = {
    id: "capability.test.low_confidence_policy",
    title: "Low Confidence Capability Policy",
    purpose: "Verify low confidence policies are ignored",
    mode: "external",
    default_autonomy: "sandbox_auto",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.low_confidence_policy", {
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(called, false);
  assert.match(result.reason ?? "", /requires sandbox_auto/);
}));

test("runCapability denies external LLM capabilities when source privacy disallows it", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("private-browser-record"));
  let called = false;
  const capability: Capability = {
    id: "capability.test.llm",
    title: "External LLM",
    purpose: "Should respect source privacy",
    mode: "llm",
    default_autonomy: "suggest",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.llm", {
    autonomy: "suggest",
    signal: {
      object_id: record.id,
      object_kind: "observation",
      object_type: record.schema.name,
      source: record.source.type,
      privacy_level: record.privacy?.level,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /privacy/i);
  assert.equal(called, false);
  assert.equal(result.diagnostics?.policy_denied, true);
  assert.equal(result.diagnostics?.policy, "privacy.external_llm");
  assert.deepEqual(result.diagnostics?.related_records, [record.id]);

  const denied = store.listRuntimeEvents({ event_type: "policy.denied_action", plugin_id: "capability.test.llm", limit: 1 })[0];
  assert.ok(denied);
  assert.equal(denied.payload?.policy, "privacy.external_llm");
  assert.deepEqual(denied.related_records, [record.id]);
}));

test("runCapability denies external LLM capabilities when a source record behind a View disallows it", async () => withStore(async (store) => {
  const record = store.insertRecord(githubRecord("private-source-behind-view"));
  const view = store.upsertView({
    id: "analysis:test:private-source-view",
    view_type: "analysis.test",
    title: "Derived view over private source",
    source_records: [record.id],
    content: { analysis: "Derived analysis over a private browser observation." },
    privacy: { level: "private", retention: "normal", allow_external_llm: true },
  });
  let called = false;
  const capability: Capability = {
    id: "capability.test.llm_from_view",
    title: "External LLM From View",
    purpose: "Should respect provenance privacy",
    mode: "llm",
    default_autonomy: "suggest",
    run: () => {
      called = true;
      return { ok: true };
    },
  };

  const runtime = new ProgramRuntime(store).registerCapability(capability);
  const result = await runtime.runCapability("capability.test.llm_from_view", {
    autonomy: "suggest",
    signal: {
      object_id: view.id,
      object_kind: "view",
      object_type: view.view_type,
      source_records: view.source_records,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /privacy/i);
  assert.equal(called, false);

  const denied = store.listRuntimeEvents({ event_type: "policy.denied_action", plugin_id: "capability.test.llm_from_view", limit: 1 })[0];
  assert.ok(denied);
  assert.equal(denied.payload?.policy, "privacy.external_llm");
  assert.deepEqual(denied.related_records, [record.id]);
  assert.deepEqual(denied.related_views, [view.id]);
}));

test("Routing Learning turns positive feedback Observations into routing.shortcut Views", async () => withStore(async (store) => {
  const source = store.insertRecord(githubRecord("browser-record-feedback"));
  const feedback = store.insertRecord({
    id: "feedback-route-1",
    schema: { name: "feedback.routing.confirmed", version: 1 },
    source: { type: "user", connector: "test" },
    scope: { domain: "github.com" },
    content: { title: "User confirmed route", text: "GitHub browser pages should wake Project Ambient." },
    relations: { related_to: [source.id] },
    payload: {
      program_id: "program.project_ambient",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
      reason: "user confirmed GitHub browser project relevance",
    },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProgramRuntime(store).registerProgram(routingLearningProgram);
  const result = await runtime.processObject(feedback, { program_id: "program.routing_learning" });
  const viewId = result.runs[0].written_views[0];
  const shortcut = store.getView(viewId);

  assert.ok(shortcut);
  assert.equal(shortcut.view_type, "routing.shortcut");
  assert.equal(shortcut.compiler?.id, "program.routing_learning");
  assert.deepEqual(shortcut.source_records, [feedback.id, source.id]);
  assert.equal(shortcut.content?.program_id, "program.project_ambient");
  assert.deepEqual(shortcut.content?.match, { object_kind: "observation", source: "browser", domain: "github.com" });
  assert.equal(shortcut.stability, "long_term");
}));

test("Routing Learning rejects empty match feedback to avoid global shortcuts", async () => withStore(async (store) => {
  const source = store.insertRecord(githubRecord("browser-record-empty-routing-feedback"));
  const feedback = store.insertRecord({
    id: "feedback-route-empty-match",
    schema: { name: "feedback.routing.confirmed", version: 1 },
    source: { type: "user", connector: "test" },
    relations: { related_to: [source.id] },
    payload: {
      program_id: "program.project_ambient",
      match: {},
      reason: "empty match should not become a match-everything shortcut",
    },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProgramRuntime(store).registerProgram(routingLearningProgram);
  const result = await runtime.processObject(feedback, { program_id: "program.routing_learning" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /match must include at least one condition/);
  assert.deepEqual(result.runs[0].written_views, []);
  assert.equal(store.listViews({ view_types: ["routing.shortcut"] }).length, 0);
}));

test("Routing Learning increases confidence for repeated positive routing feedback", async () => withStore(async (store) => {
  const source = store.insertRecord(githubRecord("browser-record-feedback-repeat"));
  const match = { object_kind: "observation", source: "browser", domain: "github.com" };
  const firstFeedback = store.insertRecord({
    id: "feedback-route-repeat-1",
    schema: { name: "feedback.routing.confirmed", version: 1 },
    source: { type: "user", connector: "test" },
    scope: { domain: "github.com" },
    content: { title: "User confirmed route", text: "Wake Project Ambient for this pattern." },
    relations: { related_to: [source.id] },
    payload: { program_id: "program.project_ambient", match, reason: "useful route" },
    privacy: { level: "private", retention: "normal" },
  });
  const secondFeedback = store.insertRecord({
    id: "feedback-route-repeat-2",
    schema: { name: "feedback.routing.confirmed", version: 1 },
    source: { type: "user", connector: "test" },
    scope: { domain: "github.com" },
    content: { title: "User confirmed route again", text: "Still useful." },
    relations: { related_to: [source.id] },
    payload: { program_id: "program.project_ambient", match, reason: "still useful" },
    privacy: { level: "private", retention: "normal" },
  });

  const runtime = new ProgramRuntime(store).registerProgram(routingLearningProgram);
  const firstResult = await runtime.processObject(firstFeedback, { program_id: "program.routing_learning" });
  const firstShortcut = store.getView(firstResult.runs[0].written_views[0]);
  assert.ok(firstShortcut);

  const secondResult = await runtime.processObject(secondFeedback, { program_id: "program.routing_learning" });
  const secondShortcut = store.getView(secondResult.runs[0].written_views[0]);

  assert.ok(secondShortcut);
  assert.equal(secondShortcut.id, firstShortcut.id);
  assert.ok((secondShortcut.confidence ?? 0) > (firstShortcut.confidence ?? 0));
  assert.deepEqual(secondShortcut.source_records, [firstFeedback.id, source.id, secondFeedback.id]);
  assert.equal(secondShortcut.content?.evidence_count, 3);
}));

test("Routing Learning turns negative feedback into a rejected routing.shortcut", async () => withStore(async (store) => {
  store.upsertView({
    id: "routing:shortcut:c88c5750",
    view_type: "routing.shortcut",
    title: "Routing shortcut: program.project_ambient",
    status: "candidate",
    content: {
      program_id: "program.project_ambient",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
    },
    confidence: 0.9,
    privacy: { level: "private", retention: "normal" },
  });
  const feedback = store.insertRecord({
    id: "feedback-route-rejected-1",
    schema: { name: "feedback.routing.rejected", version: 1 },
    source: { type: "user", connector: "test" },
    scope: { domain: "github.com" },
    content: { title: "User rejected route", text: "Do not wake Project Ambient for this pattern." },
    payload: {
      program_id: "program.project_ambient",
      match: { object_kind: "observation", source: "browser", domain: "github.com" },
      reason: "not relevant",
    },
    privacy: { level: "private", retention: "normal" },
  });

  const learningRuntime = new ProgramRuntime(store).registerProgram(routingLearningProgram);
  const learningResult = await learningRuntime.processObject(feedback, { program_id: "program.routing_learning" });
  const shortcut = store.getView(learningResult.runs[0].written_views[0]);

  assert.ok(shortcut);
  assert.equal(shortcut.id, "routing:shortcut:c88c5750");
  assert.equal(shortcut.status, "rejected");
  assert.equal(shortcut.confidence, 0.2);

  const record = store.insertRecord(githubRecord("browser-record-after-route-rejection"));
  const fallback: Program = {
    id: "program.fallback_after_rejection",
    title: "Fallback After Rejection",
    purpose: "Should be considered because rejected shortcut is inactive",
    attention: () => ({ action: "ignore", reason: "fallback considered", confidence: 1 }),
    run: () => ({ ok: true }),
  };
  const project: Program = {
    id: "program.project_ambient",
    title: "Project Ambient Probe",
    purpose: "Would have been narrowed by active shortcut",
    attention: () => ({ action: "ignore", reason: "project considered", confidence: 1 }),
    run: () => ({ ok: true }),
  };
  const runtime = new ProgramRuntime(store).registerProgram(fallback).registerProgram(project);
  const result = await runtime.processObject(record);

  assert.deepEqual(result.decisions.map(decision => decision.program_id), ["program.fallback_after_rejection", "program.project_ambient"]);
  assert.equal(result.diagnostics.routing_shortcut_view_id, undefined);
}));

test("Feedback Learning turns dismissed analysis into surfacing memory that lowers future ambient priority", async () => withStore(async (store) => {
  const source = store.insertRecord(githubRecord("feedback-learning-source-record"));
  const analysis = store.upsertView({
    id: "analysis:feedback-learning-browser",
    view_type: "analysis.browser_page",
    title: "Dismissed browser analysis",
    source_records: [source.id],
    scope: { domain: "github.com" },
    content: { analysis: "Dismissed by user" },
    confidence: 0.8,
  });
  const feedback = store.insertRecord({
    id: "feedback-learning-dismissed",
    schema: { name: "feedback.analysis.dismissed", version: 1 },
    source: { type: "application", connector: "browser.sidebar" },
    content: { title: "Feedback: dismissed", text: "not useful for GitHub repo pages" },
    relations: { related_to: [analysis.id] },
    privacy: { level: "private", retention: "normal" },
    payload: { value: "dismissed", view_id: analysis.id, application_id: "browser.sidebar" },
  });

  const learningRuntime = new ProgramRuntime(store).registerProgram(feedbackLearningProgram);
  const learningResult = await learningRuntime.processObject(feedback, { program_id: "program.feedback_learning" });
  const memoryId = learningResult.runs[0].written_views[0];
  const memory = store.getView(memoryId);

  assert.ok(memory);
  assert.equal(memory.view_type, "memory.surfacing_preference");
  assert.equal(memory.content?.preference, "show_less");
  assert.equal(memory.content?.target_view_type, "analysis.browser_page");
  assert.equal(memory.scope?.domain, "github.com");
  assert.deepEqual(memory.source_records, [feedback.id]);
  assert.deepEqual(memory.source_views, [analysis.id]);

  const futureRecord = store.insertRecord({
    ...githubRecord("feedback-learning-future-browser"),
    schema: { name: "observation.browser_page_saved", version: 1 },
  });
  const browserRuntime = new ProgramRuntime(store)
    .registerCapability(browserAmbientExploreCapability)
    .registerProgram(browserAmbientProgram);
  const futureResult = await browserRuntime.processObject(futureRecord, { program_id: "program.browser_ambient" });

  assert.equal(futureResult.decisions[0].action, "defer");
  assert.match(futureResult.decisions[0].reason ?? "", /surfacing memory/);
  assert.equal(futureResult.runs.length, 0);
}));

test("Feedback Learning turns useful analysis into surfacing memory that raises future context priority", async () => withStore(async (store) => {
  const analysis = store.upsertView({
    id: "analysis:feedback-learning-useful-browser",
    view_type: "analysis.browser_agent_task",
    title: "Useful browser AgentTask analysis",
    scope: { domain: "github.com" },
    content: { analysis: "Useful project analysis" },
    confidence: 0.82,
    privacy: { level: "private", retention: "normal" },
  });
  const feedback = store.insertRecord({
    id: "feedback-learning-useful",
    schema: { name: "feedback.analysis.useful", version: 1 },
    source: { type: "application", connector: "browser.popup" },
    content: { title: "Feedback: useful", text: "this was helpful" },
    relations: { related_to: [analysis.id] },
    privacy: { level: "private", retention: "normal" },
    payload: { value: "useful", view_id: analysis.id, target_view_type: "analysis.browser_agent_task", application_id: "browser.popup" },
  });

  const learningRuntime = new ProgramRuntime(store).registerProgram(feedbackLearningProgram);
  const learningResult = await learningRuntime.processObject(feedback, { program_id: "program.feedback_learning" });
  const memory = store.getView(learningResult.runs[0].written_views[0]);

  assert.ok(memory);
  assert.equal(memory.view_type, "memory.surfacing_preference");
  assert.equal(memory.content?.preference, "show_more");
  assert.equal(memory.content?.target_view_type, "analysis.browser_agent_task");
  assert.equal(memory.content?.feedback_value, "useful");
  assert.deepEqual(memory.source_records, [feedback.id]);
  assert.deepEqual(memory.source_views, [analysis.id]);
}));

test("Feedback Learning turns edited output into reusable taste memory", async () => withStore(async (store) => {
  const draft = store.upsertView({
    id: "app:feedback-learning-draft",
    view_type: "app.language.learning_pack",
    title: "Draft learning card",
    content: { text: "This is too verbose and formal." },
    scope: { app: "language-learning" },
    privacy: { level: "private", retention: "normal" },
  });
  const feedback = store.insertRecord({
    id: "feedback-learning-edited",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application", connector: "language.learning.app" },
    content: { title: "Feedback: edited output", text: "make it shorter and more natural" },
    relations: { related_to: [draft.id] },
    privacy: { level: "private", retention: "normal" },
    payload: {
      value: "edited",
      view_id: draft.id,
      application_id: "language.learning.app",
      original_text: "This is too verbose and formal.",
      edited_text: "Make it shorter and natural.",
    },
  });

  const runtime = new ProgramRuntime(store).registerProgram(feedbackLearningProgram);
  const result = await runtime.processObject(feedback, { program_id: "program.feedback_learning" });
  const memory = store.getView(result.runs[0].written_views[0]);

  assert.ok(memory);
  assert.equal(memory.view_type, "memory.output_edit_pattern");
  assert.equal(memory.content?.preference, "edited_output");
  assert.equal(memory.content?.target_view_type, "app.language.learning_pack");
  assert.equal(memory.content?.original_text, "This is too verbose and formal.");
  assert.equal(memory.content?.edited_text, "Make it shorter and natural.");
  assert.deepEqual(memory.source_records, [feedback.id]);
  assert.deepEqual(memory.source_views, [draft.id]);
}));

test("Feedback Learning rejects empty output edits instead of writing taste memory", async () => withStore(async (store) => {
  const draft = store.upsertView({
    id: "app:feedback-learning-empty-edit-draft",
    view_type: "app.language.learning_pack",
    title: "Draft learning card",
    content: { text: "Original draft." },
    scope: { app: "language-learning" },
    privacy: { level: "private", retention: "normal" },
  });
  const feedback = store.insertRecord({
    id: "feedback-learning-empty-edit",
    schema: { name: "feedback.output.edited", version: 1 },
    source: { type: "application", connector: "language.learning.app" },
    content: { title: "Feedback: empty edited output", text: "empty edit should not train memory" },
    relations: { related_to: [draft.id] },
    privacy: { level: "private", retention: "normal" },
    payload: {
      value: "edited",
      view_id: draft.id,
      application_id: "language.learning.app",
      original_text: "Original draft.",
      edited_text: "   ",
    },
  });

  const runtime = new ProgramRuntime(store).registerProgram(feedbackLearningProgram);
  const result = await runtime.processObject(feedback, { program_id: "program.feedback_learning" });

  assert.equal(result.runs[0].ok, false);
  assert.match(result.runs[0].reason ?? "", /requires non-empty original_text and edited_text/);
  assert.deepEqual(result.runs[0].written_views, []);
  assert.equal(store.listViews({ view_types: ["memory.output_edit_pattern"] }).length, 0);
}));
